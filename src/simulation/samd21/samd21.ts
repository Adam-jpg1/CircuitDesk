// The Microchip SAMD21 (ATSAMD21G18 / E18), on rp2040js's Cortex-M0+ core.
//
// The SAMD21 and the RP2040 have the same CPU — an ARMv6-M Cortex-M0+ with the
// same NVIC, SysTick and system control block — and nothing else in common.
// rp2040js exports its chip class but not its core, so this subclasses the
// chip and takes over the whole memory map: the core, the NVIC and SysTick
// (the private peripheral bus at 0xE000E000) are rp2040js's, and every address
// below that is the SAMD21's, modelled from the datasheet (DS40001882) and the
// CMSIS headers the Arduino core is compiled against.
//
// Modelled: flash and the NVM calibration row, SRAM, the PORT controller with
// its single-cycle IOBUS alias, the clock blocks' ready and sync flags that
// startup waits on, NVMCTRL's ready flag, and SysTick at 48 MHz, which is what
// millis() counts. Everything else reads back what was written — so a status
// bit nobody sets makes the firmware wait visibly instead of continuing on
// invented data.

import { RP2040 } from 'rp2040js';
import { RegisterBlock } from './registerBlock';
import { Samd21Timer, TIMER_FUNCTION_E, TIMER_FUNCTION_F, type TimerHost } from './timers';
import { Samd21Usb } from './usb';

export { RegisterBlock } from './registerBlock';

export const SAMD21_FLASH_BYTES = 256 * 1024;
export const SAMD21_SRAM_BYTES = 32 * 1024;
const SRAM_BASE = 0x20000000;
const NVM_CALIBRATION_BASE = 0x00800000;
const IOBUS_PORT = 0x60000000;
const PORT_BASE = 0x41004400;
const PPB_PAGE = 0xe000e;

/** What the Arduino core clocks the CPU at: the DFLL locked to 48 MHz. */
export const SAMD21_CPU_HZ = 48_000_000;

/** NVIC lines (datasheet table 11-3). */
export const SAMD21_IRQ = {
  EIC: 4,
  USB: 7,
  SERCOM0: 9,
  ADC: 23,
} as const;

/** What a SERCOM in I2C master mode drives: start, address, bytes, stop. */
export interface Samd21I2cBus {
  start(repeated: boolean): void;
  /** True when a device acknowledged the address. */
  connect(address: number, write: boolean): boolean;
  /** True when the device acknowledged the byte. */
  writeByte(value: number): boolean;
  readByte(ack: boolean): number;
  stop(): void;
}

/** One of the PORT controller's two 32-pin groups. */
interface PortGroup {
  dir: number;
  out: number;
  pincfg: Uint8Array;
  pmux: Uint8Array;
  /** Levels driven from outside (the canvas), per pin; undefined = not driven. */
  external: (boolean | undefined)[];
}

/**
 * The EXTINT line on each pad, from the datasheet's I/O multiplexing table:
 * mostly the pad number modulo 16, with the exceptions listed. PA08 is the
 * NMI instead, so it has none here.
 */
const EXTINT: Record<number, number> = (() => {
  const map: Record<number, number> = {};
  for (let bit = 0; bit < 24; bit++) if (bit !== 8) map[bit] = bit % 16;
  Object.assign(map, { 24: 12, 25: 13, 27: 15, 28: 8, 30: 10, 31: 11 });
  for (let bit = 0; bit < 24; bit++) map[32 + bit] = bit % 16;
  Object.assign(map, { [32 + 30]: 14, [32 + 31]: 15 });
  return map;
})();
const SENSE_RISE = 1;
const SENSE_FALL = 2;
const SENSE_BOTH = 3;
const SENSE_HIGH = 4;
const SENSE_LOW = 5;

const PINCFG_PMUXEN = 1 << 0;
const PINCFG_INEN = 1 << 1;
const PINCFG_PULLEN = 1 << 2;

export class Samd21 extends RP2040 {
  readonly flashMemory = new Uint8Array(SAMD21_FLASH_BYTES).fill(0xff);
  readonly ram = new Uint8Array(SAMD21_SRAM_BYTES);
  private readonly ramView = new DataView(this.ram.buffer);
  private readonly nvmView = new DataView(this.flashMemory.buffer);
  private readonly blocks: RegisterBlock[] = [];
  readonly groups: PortGroup[] = [0, 1].map(() => ({
    dir: 0,
    out: 0,
    pincfg: new Uint8Array(32),
    pmux: new Uint8Array(16),
    external: new Array(32).fill(undefined),
  }));
  /** Pin index (group * 32 + bit), and whether it now reads high. */
  onPinChange: ((pin: number, high: boolean) => void) | null = null;
  private lastLevels = [0, 0];

  private readonly timers: Samd21Timer[] = [];
  private readonly sercoms: {
    mode(): number;
    isUsart(): boolean;
    ctrla(): number;
    receive(byte: number): boolean;
    baud(): number | undefined;
  }[] = [];
  /** The I2C bus Wire's transactions reach; nothing attached NACKs every address. */
  i2cHandler: Samd21I2cBus | null = null;
  /** One SPI byte exchanged: MOSI in, MISO out. */
  onSpiTransfer: ((mosi: number, mode: 0 | 1 | 2 | 3, lsbFirst: boolean) => number) | null = null;
  /** Bytes the firmware sends out of a SERCOM USART (Serial1). */
  onUartByte: ((byte: number) => void) | null = null;
  /** Volts on each ADC input, for analogRead. */
  readonly adcVolts = new Float64Array(20);
  /** The native USB port, which is Serial on every SAMD21 board here. */
  readonly usb: Samd21Usb;

  constructor() {
    super();
    // The private peripheral bus is rp2040js's; its SysTick is told what this
    // chip's CPU clock is, because that is what SysTick_Config divides.
    (this as unknown as { clkSys: number }).clkSys = SAMD21_CPU_HZ;
    const ppb = (this as unknown as { ppb: { systickTimer: { frequency: number } } }).ppb;
    ppb.systickTimer.frequency = SAMD21_CPU_HZ;
    const clock = (this as unknown as { clock: { createAlarm(cb: () => void): { schedule(ns: number): void } } }).clock;
    this.usb = new Samd21Usb({
      readRam: (address) => this.readAt(address, 1),
      writeRam: (address, value) => this.writeAt(address, value, 1),
      setInterrupt: (pending) => this.setInterrupt(SAMD21_IRQ.USB, pending),
      after: (ns, fn) => clock.createAlarm(fn).schedule(ns),
    });
    this.buildPeripherals();
  }

  // ------------------------------------------------------------- the map

  private blockAt(address: number): RegisterBlock | undefined {
    for (const b of this.blocks) if (address >= b.base && address < b.base + b.size) return b;
    return undefined;
  }

  private readAt(address: number, width: 1 | 2 | 4): number {
    // RP2040's constructor resets the core, which reads the vector table,
    // before this class's own fields exist. Nothing is loaded yet either way.
    if (!this.nvmView) return 0;
    address >>>= 0;
    if (address < SAMD21_FLASH_BYTES) {
      return width === 4 ? this.nvmView.getUint32(address, true) : width === 2 ? this.nvmView.getUint16(address, true) : this.flashMemory[address];
    }
    if (address >= SRAM_BASE && address < SRAM_BASE + SAMD21_SRAM_BYTES) {
      const o = address - SRAM_BASE;
      return width === 4 ? this.ramView.getUint32(o, true) : width === 2 ? this.ramView.getUint16(o, true) : this.ram[o];
    }
    // The NVM user and calibration rows read as unprogrammed, which every
    // reader in the Arduino core treats as "use the default".
    if (address >= NVM_CALIBRATION_BASE && address < NVM_CALIBRATION_BASE + 0x10000) {
      return width === 4 ? 0xffffffff : width === 2 ? 0xffff : 0xff;
    }
    if (address >>> 12 === PPB_PAGE) {
      const ppb = (this as unknown as { ppb: { readUint32(o: number): number } }).ppb;
      const word = ppb.readUint32(address & 0xffc);
      return width === 4 ? word : (word >>> (8 * (address & 3))) & (width === 1 ? 0xff : 0xffff);
    }
    if (address >= IOBUS_PORT && address < IOBUS_PORT + 0x100) return this.readAt(PORT_BASE + (address - IOBUS_PORT), width);
    const block = this.blockAt(address);
    if (block) return block.read(address - block.base, width);
    return 0;
  }

  private writeAt(address: number, value: number, width: 1 | 2 | 4): void {
    address >>>= 0;
    if (address >= SRAM_BASE && address < SRAM_BASE + SAMD21_SRAM_BYTES) {
      const o = address - SRAM_BASE;
      if (width === 4) this.ramView.setUint32(o, value >>> 0, true);
      else if (width === 2) this.ramView.setUint16(o, value & 0xffff, true);
      else this.ram[o] = value & 0xff;
      return;
    }
    if (address >>> 12 === PPB_PAGE) {
      const ppb = (this as unknown as { ppb: { writeUint32(o: number, v: number): void } }).ppb;
      ppb.writeUint32(address & 0xffc, value >>> 0);
      return;
    }
    if (address >= IOBUS_PORT && address < IOBUS_PORT + 0x100) {
      this.writeAt(PORT_BASE + (address - IOBUS_PORT), value, width);
      return;
    }
    const block = this.blockAt(address);
    if (block) block.write(address - block.base, value, width);
    // Flash is written through NVMCTRL, not by stores; a stray store does nothing.
  }

  override readUint32(address: number): number {
    return this.readAt(address, 4);
  }
  override readUint16(address: number): number {
    return this.readAt(address, 2);
  }
  override readUint8(address: number): number {
    return this.readAt(address, 1);
  }
  override writeUint32(address: number, value: number): void {
    this.writeAt(address, value, 4);
  }
  override writeUint16(address: number, value: number): void {
    this.writeAt(address, value, 2);
  }
  override writeUint8(address: number, value: number): void {
    this.writeAt(address, value, 1);
  }

  // ------------------------------------------------------------ peripherals

  private add(block: RegisterBlock): RegisterBlock {
    this.blocks.push(block);
    return block;
  }

  private buildPeripherals(): void {
    // Bus A
    const pm = this.add(new RegisterBlock('PM', 0x40000400, 0x400));
    pm.on(0x38, { width: 1, read: () => 0x01 }); // RCAUSE: power-on reset
    const sysctrl = this.add(new RegisterBlock('SYSCTRL', 0x40000800, 0x400));
    // PCLKSR: every oscillator ready, the DFLL locked coarse and fine, BOD33 and
    // the regulator ready. Startup spins on these and the model has no
    // oscillator to wait for.
    sysctrl.on(0x0c, { width: 4, read: () => 0b0000_1110_1101_1111 });
    const gclk = this.add(new RegisterBlock('GCLK', 0x40000c00, 0x400));
    gclk.on(0x00, { width: 1, read: () => 0 }); // CTRL: SWRST completes at once
    gclk.on(0x01, { width: 1, read: () => 0 }); // STATUS: never SYNCBUSY
    this.add(new RegisterBlock('WDT', 0x40001000, 0x400));
    this.add(new RegisterBlock('RTC', 0x40001400, 0x400));
    this.buildEic();
    // Bus B
    this.add(new RegisterBlock('PAC1', 0x41000000, 0x400));
    this.add(new RegisterBlock('DSU', 0x41002000, 0x2000));
    const nvmctrl = this.add(new RegisterBlock('NVMCTRL', 0x41004000, 0x400));
    nvmctrl.on(0x14, { width: 1, read: () => 0x01 }); // INTFLAG.READY
    // PARAM: 4096 pages of 64 bytes, 256 KB.
    nvmctrl.on(0x08, { width: 4, read: () => (3 << 16) | 4096 });
    this.buildPort();
    this.add(new RegisterBlock('DMAC', 0x41004800, 0x400));
    this.add(this.usb.block);
    this.add(new RegisterBlock('MTB', 0x41006000, 0x1000));
    // Bus C
    this.add(new RegisterBlock('PAC2', 0x42000000, 0x400));
    this.add(new RegisterBlock('EVSYS', 0x42000400, 0x400));
    for (let i = 0; i < 6; i++) this.buildSercom(i, 0x42000800 + i * 0x400);
    const clock = (this as unknown as { clock: { createAlarm: TimerHost['createAlarm']; nanos: number } }).clock;
    const host: TimerHost = {
      clockHz: SAMD21_CPU_HZ,
      createAlarm: (callback) => clock.createAlarm(callback),
      nowNs: () => clock.nanos,
      outputsChanged: () => this.portChanged(),
      setInterrupt: (irq, pending) => this.setInterrupt(irq, pending),
    };
    for (let i = 0; i < 8; i++) {
      const timer = new Samd21Timer(i, i < 3 ? 0x42002000 + i * 0x400 : 0x42002c00 + (i - 3) * 0x400, host);
      this.timers.push(timer);
      this.add(timer.block);
    }
    this.buildAdc();
    this.add(new RegisterBlock('AC', 0x42004400, 0x400));
    this.add(new RegisterBlock('DAC', 0x42004800, 0x400));
    this.add(new RegisterBlock('PTC', 0x42004c00, 0x400));
    this.add(new RegisterBlock('I2S', 0x42005000, 0x400));
  }

  // ------------------------------------------------------------------ PORT

  private buildPort(): void {
    const port = this.add(new RegisterBlock('PORT', PORT_BASE, 0x100));
    for (let g = 0; g < 2; g++) {
      const base = g * 0x80;
      const group = this.groups[g];
      const reg = (offset: number, apply: (v: number) => void, read?: () => number) =>
        port.on(base + offset, {
          width: 4,
          read,
          write: (v) => {
            apply(v >>> 0);
            this.portChanged();
          },
        });
      reg(0x00, (v) => (group.dir = v), () => group.dir);
      reg(0x04, (v) => (group.dir &= ~v), () => group.dir);
      reg(0x08, (v) => (group.dir |= v), () => group.dir);
      reg(0x0c, (v) => (group.dir ^= v), () => group.dir);
      reg(0x10, (v) => (group.out = v), () => group.out);
      reg(0x14, (v) => (group.out &= ~v), () => group.out);
      reg(0x18, (v) => (group.out |= v), () => group.out);
      reg(0x1c, (v) => (group.out ^= v), () => group.out);
      port.on(base + 0x20, { width: 4, read: () => this.inputLevels(g) });
      // WRCONFIG: configures up to sixteen pins in one write.
      port.on(base + 0x28, {
        width: 4,
        read: () => 0,
        write: (v) => {
          const mask = v & 0xffff;
          const offset = (v >>> 31) & 1 ? 16 : 0;
          const cfg = ((v >>> 16) & PINCFG_PMUXEN) | (((v >>> 17) & 1) << 1) | (((v >>> 18) & 1) << 2) | (((v >>> 22) & 1) << 6);
          const pmux = (v >>> 24) & 0xf;
          for (let i = 0; i < 16; i++) {
            if (!(mask & (1 << i))) continue;
            const pin = offset + i;
            if ((v >>> 30) & 1) group.pincfg[pin] = cfg;
            if ((v >>> 28) & 1) {
              const index = pin >> 1;
              group.pmux[index] = pin & 1 ? (group.pmux[index] & 0x0f) | (pmux << 4) : (group.pmux[index] & 0xf0) | pmux;
            }
          }
          this.portChanged();
        },
      });
      for (let i = 0; i < 16; i++) {
        port.on(base + 0x30 + i, { width: 1, read: () => group.pmux[i], write: (v) => (group.pmux[i] = v & 0xff) });
      }
      for (let i = 0; i < 32; i++) {
        port.on(base + 0x40 + i, {
          width: 1,
          read: () => group.pincfg[i],
          write: (v) => {
            group.pincfg[i] = v & 0xff;
            this.portChanged();
          },
        });
      }
    }
  }

  /** What IN reads: driven pins their output, inputs what the outside or a pull puts there. */
  inputLevels(g: number): number {
    let v = 0;
    for (let bit = 0; bit < 32; bit++) {
      if (this.pinHigh(g, bit)) v |= 1 << bit;
    }
    return v >>> 0;
  }

  /** Whether a pin reads high: driven out, driven from outside, or pulled. */
  pinHigh(g: number, bit: number): boolean {
    const group = this.groups[g];
    const m = 1 << bit;
    const pwm = this.timerLevel(g, bit);
    if (pwm !== undefined) return pwm;
    if (group.dir & m) return (group.out & m) !== 0;
    const ext = group.external[bit];
    if (ext !== undefined) return ext;
    if (group.pincfg[bit] & PINCFG_PULLEN) return (group.out & m) !== 0; // OUT picks up or down
    return false;
  }

  /**
   * Whether a pin is driven: a PORT output not handed to a peripheral, or a
   * pad muxed to a timer that is generating PWM.
   */
  isOutput(pin: number): boolean {
    const g = pin >> 5;
    const bit = pin & 31;
    const group = this.groups[g];
    if (this.timerLevel(g, bit) !== undefined) return true;
    return (group.dir & (1 << bit)) !== 0 && (group.pincfg[bit] & PINCFG_PMUXEN) === 0;
  }

  /** The level a timer drives onto a pad muxed to it (function E or F), if it is running. */
  private timerLevel(g: number, bit: number): boolean | undefined {
    const group = this.groups[g];
    if (!(group.pincfg[bit] & PINCFG_PMUXEN)) return undefined;
    const fn = (group.pmux[bit >> 1] >>> (bit & 1 ? 4 : 0)) & 0xf;
    const pad = g * 32 + bit;
    const route = fn === 4 ? TIMER_FUNCTION_E[pad] : fn === 5 ? TIMER_FUNCTION_F[pad] : undefined;
    return route ? this.timers[route[0]]?.output(route[1]) : undefined;
  }

  /** Drives a pin from outside the chip, or releases it (undefined). */
  setExternal(pin: number, level: boolean | undefined): void {
    this.groups[pin >> 5].external[pin & 31] = level;
    this.portChanged();
  }

  private portChanged(): void {
    for (let g = 0; g < 2; g++) {
      let levels = 0;
      for (let bit = 0; bit < 32; bit++) if (this.pinHigh(g, bit)) levels |= 1 << bit;
      const changed = (levels ^ this.lastLevels[g]) >>> 0;
      this.lastLevels[g] = levels >>> 0;
      if (!changed) continue;
      for (let bit = 0; bit < 32; bit++) {
        if (!(changed & (1 << bit))) continue;
        const high = (levels & (1 << bit)) !== 0;
        this.eicEdge(g, bit, high);
        this.onPinChange?.(g * 32 + bit, high);
      }
    }
    this.eicLevels();
  }

  // ------------------------------------------------------------------- EIC

  private eic!: RegisterBlock;
  private eicFlags = 0;
  private eicInten = 0;

  /**
   * The External Interrupt Controller, which attachInterrupt() uses.
   *
   * A pad muxed to function A (the EIC) feeds its EXTINT line; CONFIG0/1 give
   * each line a sense — rising, falling, both, high or low — and a matching
   * edge or level sets the line's INTFLAG bit, which with INTENSET raises the
   * EIC's NVIC line. Level senses keep the flag set for as long as the level
   * holds, so clearing it in the handler does not lose a held button. The
   * filter and the event outputs are not modelled; the NMI line (PA08) is not
   * either.
   */
  private buildEic(): void {
    const eic = (this.eic = this.add(new RegisterBlock('EIC', 0x40001800, 0x400)));
    const update = () => this.setInterrupt(SAMD21_IRQ.EIC, (this.eicFlags & this.eicInten) !== 0);
    eic.on(0x00, {
      width: 1,
      read: () => eic.peek(0x00, 1) & ~1,
      write: (v) => {
        if (v & 1) {
          eic.bytes.fill(0);
          this.eicFlags = 0;
          this.eicInten = 0;
          update();
        }
      },
    });
    eic.on(0x01, { width: 1, read: () => 0 }); // STATUS: never SYNCBUSY
    eic.on(0x08, { width: 4, read: () => this.eicInten, write: (v) => { this.eicInten &= ~v; update(); } });
    eic.on(0x0c, { width: 4, read: () => this.eicInten, write: (v) => { this.eicInten |= v; update(); this.eicLevels(); } });
    eic.on(0x10, { width: 4, read: () => this.eicFlags, write: (v) => { this.eicFlags &= ~v; this.eicLevels(); update(); } });
    for (const at of [0x18, 0x1c]) eic.on(at, { width: 4, write: () => this.eicLevels() }); // CONFIG0/1
  }

  /** The EXTINT line a pad is wired to on function A, if it is muxed there. */
  private extintOf(g: number, bit: number): number | undefined {
    const group = this.groups[g];
    if (!(group.pincfg[bit] & PINCFG_PMUXEN)) return undefined;
    const fn = (group.pmux[bit >> 1] >>> (bit & 1 ? 4 : 0)) & 0xf;
    if (fn !== 0) return undefined;
    return EXTINT[g * 32 + bit];
  }

  private eicSense(line: number): number {
    if (!this.eic || !(this.eic.peek(0x00, 1) & 0x2)) return 0; // CTRL.ENABLE
    return (this.eic.peek(line < 8 ? 0x18 : 0x1c, 4) >>> ((line % 8) * 4)) & 0x7;
  }

  private eicEdge(g: number, bit: number, high: boolean): void {
    const line = this.extintOf(g, bit);
    if (line === undefined) return;
    const sense = this.eicSense(line);
    if ((sense === SENSE_RISE && high) || (sense === SENSE_FALL && !high) || sense === SENSE_BOTH) {
      this.eicFlags |= 1 << line;
      this.setInterrupt(SAMD21_IRQ.EIC, (this.eicFlags & this.eicInten) !== 0);
    }
  }

  /** Level senses: the flag is set while the level holds. */
  private eicLevels(): void {
    if (!this.eic) return;
    let set = 0;
    for (const [pad, line] of Object.entries(EXTINT)) {
      const sense = this.eicSense(line);
      if (sense !== SENSE_HIGH && sense !== SENSE_LOW) continue;
      const g = Number(pad) >> 5;
      const bit = Number(pad) & 31;
      if (this.extintOf(g, bit) !== line) continue;
      if (this.pinHigh(g, bit) === (sense === SENSE_HIGH)) set |= 1 << line;
    }
    if (set & ~this.eicFlags) {
      this.eicFlags |= set;
      this.setInterrupt(SAMD21_IRQ.EIC, (this.eicFlags & this.eicInten) !== 0);
    }
  }

  // ---------------------------------------------------------------- SERCOM

  /**
   * A SERCOM, in the three modes the Arduino core uses.
   *
   * Every begin() — USART, SPI or I2C — starts with a software reset and spins
   * until CTRLA.SWRST clears itself and SYNCBUSY drops, so all six have that.
   *
   * USART (CTRLA.MODE 1) is a board's Serial1 — SERCOM0 on the Adafruit
   * boards, SERCOM4 on the XIAO. Its data register is always empty and the last
   * byte always sent, so writes go straight out of onUartByte; a byte arriving
   * on its RX pad (receiveUart) raises RXC and, with RXC enabled in INTEN as
   * the core leaves it, the SERCOM's NVIC line.
   *
   * SPI master (MODE 3) exchanges each byte written to DATA with the SPI bus at
   * once and raises RXC, which SPI.transfer() waits for.
   *
   * I2C master (MODE 5) runs Wire's transactions against the I2C bus: writing
   * ADDR starts (or repeats) and addresses, raising MB for a write — or SB with
   * the first byte for a read — with STATUS.RXNACK when nobody answered; DATA
   * writes a byte and raises MB; CTRLB.CMD 2 reads the next byte and 3 stops.
   * BUSSTATE follows, idle to owner and back, as Wire checks it.
   */
  private buildSercom(index: number, base: number): void {
    const s = this.add(new RegisterBlock(`SERCOM${index}`, base, 0x400));
    const rx: number[] = [];
    let inten = 0;
    // I2C master state: MB and SB, RXNACK, BUSSTATE (1 idle, 2 owner).
    let i2cFlags = 0;
    let rxnack = false;
    let busState = 0;
    let i2cData = 0xff;
    let spiRx: number | undefined;
    const mode = () => (s.peek(0x00, 4) >>> 2) & 0x7;
    const isUsart = () => mode() === 1;
    const enabled = () => (s.peek(0x00, 4) & 0x2) !== 0;
    const receiving = () => isUsart() && enabled() && (s.peek(0x04, 4) & (1 << 17)) !== 0;
    const intflag = () => {
      switch (mode()) {
        case 1: // USART: DRE | TXC, and RXC while a byte waits
          return 0x03 | (receiving() && rx.length > 0 ? 0x04 : 0);
        case 3: // SPI master: DRE | TXC, and RXC after a transfer
          return 0x03 | (spiRx !== undefined ? 0x04 : 0);
        case 5: // I2C master: MB (bit 0) and SB (bit 1)
          return i2cFlags;
        default:
          return s.peek(0x18, 1);
      }
    };
    const irq = SAMD21_IRQ.SERCOM0 + index;
    const update = () => this.setInterrupt(irq, isUsart() && (intflag() & inten) !== 0);
    const i2c = () => this.i2cHandler;
    s.on(0x00, {
      width: 4,
      read: () => s.peek(0x00, 4) & ~1,
      write: (v) => {
        if (v & 1) {
          s.bytes.fill(0);
          rx.length = 0;
          inten = 0;
          i2cFlags = 0;
          rxnack = false;
          busState = 0;
          spiRx = undefined;
        }
        update();
      },
    });
    // CTRLB: RXEN for the USART; CMD (bits 16-17) and ACKACT (bit 18) for I2C.
    s.on(0x04, {
      width: 4,
      write: (v) => {
        if (mode() === 5) {
          const cmd = (v >>> 16) & 0x3;
          if (cmd !== 0) {
            // CMD reads back as zero; ACKACT stays.
            s.poke(0x04, v & ~(0x3 << 16), 4);
            i2cFlags = 0;
            if (cmd === 2 && busState === 2) {
              i2cData = i2c()?.readByte(true) ?? 0xff;
              i2cFlags = 0x2;
            } else if (cmd === 3) {
              if (busState === 2) i2c()?.stop();
              busState = 1;
            }
          }
        }
        update();
      },
    });
    s.on(0x14, { width: 1, read: () => inten, write: (v) => { inten &= ~v; update(); } });
    s.on(0x16, { width: 1, read: () => inten, write: (v) => { inten |= v; update(); } });
    s.on(0x18, {
      width: 1,
      read: intflag,
      // I2C flags clear by writing one, as well as by the next operation.
      write: (v) => {
        if (mode() === 5) i2cFlags &= ~v;
      },
    });
    // STATUS: for I2C, RXNACK (bit 2) and BUSSTATE (bits 4-5), which Wire sets
    // to idle once at begin() and the bus moves on from there.
    s.on(0x1a, {
      width: 2,
      read: () => (mode() === 5 ? (rxnack ? 0x04 : 0) | (busState << 4) : s.peek(0x1a, 2)),
      write: (v) => {
        if (mode() === 5) {
          const requested = (v >>> 4) & 0x3;
          if (requested !== 0) busState = requested;
        }
      },
    });
    s.on(0x1c, { width: 4, read: () => 0 }); // SYNCBUSY
    // I2C ADDR: a (repeated) start and the address byte.
    s.on(0x24, {
      width: 4,
      write: (v) => {
        if (mode() !== 5 || !enabled()) return;
        const bus = i2c();
        const address = (v >>> 1) & 0x7f;
        const read = (v & 1) === 1;
        bus?.start(busState === 2);
        busState = 2;
        const ack = bus ? bus.connect(address, !read) : false;
        rxnack = !ack;
        if (read && ack) {
          i2cData = bus?.readByte(true) ?? 0xff;
          i2cFlags = 0x2; // SB: a byte is in
        } else {
          i2cFlags = 0x1; // MB: address sent (and, when NACKed, that is all)
        }
      },
    });
    s.on(0x28, {
      width: 2,
      read: () => {
        switch (mode()) {
          case 1: {
            const byte = rx.shift() ?? 0;
            update();
            return byte;
          }
          case 3: {
            const byte = spiRx ?? 0xff;
            spiRx = undefined;
            return byte;
          }
          case 5:
            return i2cData;
          default:
            return s.peek(0x28, 2);
        }
      },
      write: (v) => {
        switch (mode()) {
          case 1:
            this.onUartByte?.(v & 0xff);
            break;
          case 3: {
            const ctrla = s.peek(0x00, 4);
            const spiMode = ((((ctrla >>> 29) & 1) << 1) | ((ctrla >>> 28) & 1)) as 0 | 1 | 2 | 3;
            const lsbFirst = ((ctrla >>> 30) & 1) === 1;
            spiRx = (this.onSpiTransfer?.(v & 0xff, spiMode, lsbFirst) ?? 0xff) & 0xff;
            break;
          }
          case 5: {
            if (busState !== 2) return;
            const ack = i2c()?.writeByte(v & 0xff) ?? false;
            rxnack = !ack;
            i2cFlags = 0x1;
            break;
          }
        }
      },
    });
    this.sercoms.push({
      mode,
      isUsart,
      ctrla: () => s.peek(0x00, 4),
      receive: (byte) => {
        if (!receiving()) return false;
        rx.push(byte & 0xff);
        update();
        return true;
      },
      baud: () => {
        // CTRLA.SAMPR: 16x or 8x oversampling, arithmetic or fractional BAUD.
        const sampr = (s.peek(0x00, 4) >>> 13) & 0x7;
        const oversample = sampr >= 2 ? 8 : 16;
        const baud = s.peek(0x0c, 2);
        if (sampr === 1 || sampr === 3) {
          const divisor = (baud & 0x1fff) + ((baud >>> 13) & 0x7) / 8;
          return divisor > 0 ? SAMD21_CPU_HZ / (oversample * divisor) : undefined;
        }
        return (SAMD21_CPU_HZ / oversample) * (1 - baud / 65536);
      },
    });
  }

  /** The peripheral function (0 = A … 7 = H) a pin is muxed to, when PMUXEN is set. */
  pinFunction(pin: number): number | undefined {
    const group = this.groups[pin >> 5];
    const bit = pin & 31;
    if (!group || !(group.pincfg[bit] & PINCFG_PMUXEN)) return undefined;
    return (group.pmux[bit >> 1] >>> (bit & 1 ? 4 : 0)) & 0xf;
  }

  /** The SERCOMs running in `mode` (3 SPI master, 5 I2C master), with their CTRLA. */
  sercomsInMode(mode: number): { index: number; ctrla: number }[] {
    return this.sercoms
      .map((sercom, index) => ({ index, mode: sercom.mode(), ctrla: sercom.ctrla() }))
      .filter((sercom) => sercom.mode === mode)
      .map(({ index, ctrla }) => ({ index, ctrla }));
  }

  /**
   * A byte arriving on a USART's RX pad. Delivered to the first SERCOM running
   * as a USART with its receiver enabled — Serial1, on these boards. Returns
   * false when no SERCOM is listening, as a byte on an idle RX pin is lost.
   */
  receiveUart(byte: number): boolean {
    return this.sercoms.some((sercom) => sercom.isUsart() && sercom.receive(byte));
  }

  /** The baud the firmware programmed into its USART, if one is configured. */
  uartBaudRate(): number | undefined {
    const usart = this.sercoms.find((sercom) => sercom.isUsart());
    const baud = usart?.baud();
    return baud !== undefined && Number.isFinite(baud) && baud > 0 ? Math.round(baud) : undefined;
  }

  // ------------------------------------------------------------------- ADC

  /**
   * analogRead(): a software-triggered single conversion. START sets RESRDY at
   * once with the input's voltage against the 3.3 V reference at 10 bits, the
   * resolution the Arduino core configures.
   */
  private buildAdc(): void {
    const adc = this.add(new RegisterBlock('ADC', 0x42004000, 0x400));
    let ready = false;
    let result = 0;
    adc.on(0x19, { width: 1, read: () => 0 }); // STATUS: never SYNCBUSY
    adc.on(0x0c, {
      width: 1,
      write: (v) => {
        if (v & 0x02) {
          // INPUTCTRL.MUXPOS, 0-19: the analog input the conversion samples.
          const channel = adc.peek(0x10, 4) & 0x1f;
          const volts = this.adcVolts[channel] ?? 0;
          result = Math.max(0, Math.min(1023, Math.round((volts / 3.3) * 1023)));
          ready = true;
        }
      },
    });
    // INTFLAG: RESRDY, cleared by writing 1 to it.
    adc.on(0x18, {
      width: 1,
      read: () => (ready ? 0x01 : 0),
      write: (v) => {
        if (v & 0x01) ready = false;
      },
    });
    adc.on(0x1a, {
      width: 2,
      read: () => {
        ready = false;
        return result;
      },
    });
  }
}
