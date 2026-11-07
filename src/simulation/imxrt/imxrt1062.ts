// NXP i.MX RT1062 — the Teensy 4.1's chip — modelled for the ARMv7-M core.
//
// What it models is what the Teensy 4 core uses, as its startup and drivers
// use it:
//
//   * memory: ITCM, DTCM and OCRAM, and the QSPI flash at 0x60000000 the image
//     executes from (the boot ROM's job — reading the image vector table at
//     0x60001000 and jumping to its entry — is done by reset());
//   * the clock tree's status: PLLs report lock, dividers never busy, the DCDC
//     settled, the temperature monitor finished; the SET/CLR/TOG register
//     aliases of the analog blocks;
//   * IOMUXC pin muxing and pad pulls; GPIO1-5 and their fast aliases GPIO6-9,
//     with edge and level interrupts on the combined GPIO6789 line;
//   * ADC1 and ADC2 (single conversions, 8/10/12 bits, calibration);
//   * FlexPWM1-4 and QuadTimer1-3 driving their pins as analogWrite sets them;
//   * LPUART6 (Serial1 on pins 0/1), LPI2C1 (Wire on 18/19), LPSPI4 (SPI on
//     11-13);
//   * the USB OTG1 device controller (usb.ts), which Serial is;
//   * the PIT (pit.ts), which IntervalTimer and tone() run on;
//   * FlexSPI's IP commands (flexspi.ts), which program and erase the flash
//     EEPROM is emulated in.
//
// The CPU clock is fixed at the speed the sketch was built for; the PLL and
// divider settings are accepted and reported but do not change it. Not
// modelled: the other UARTs, I2C and SPI ports, the GPT timers, DMA, the
// ethernet MAC, SD card, FlexIO and the external PSRAM.

import { CortexM } from '../armv7m/cortexM';
import type { MemoryRegion } from '../armv7m/bus';
import type { ArmMcu, I2cMasterHooks, McuSerial } from '../armv7m/armRunner';
import { EventQueue, Pads, Periph, PeriphBus, NOT_DRIVEN } from '../armv7m/peripherals';
import { ImxrtUsb } from './usb';
import { Pit } from './pit';
import { FlexSpi } from './flexspi';

/** The speed the CircuitDesk build selects (the core's 60 MHz setting). */
export const IMXRT_HZ = 60_000_000;
/** GPIO1-5, thirty-two pads each. */
export const IMXRT_PAD_COUNT = 160;

const FLASH_BASE = 0x60000000;
const FLASH_BYTES = 8 * 1024 * 1024;
const TCM_BYTES = 512 * 1024;
const OCRAM_BYTES = 512 * 1024;

const pad = (port: number, bit: number) => (port - 1) * 32 + bit;

/**
 * The Teensy 4.1's pins: the pad, and its IOMUXC mux and pad-control
 * registers, from the core's core_pins.h and imxrt.h.
 */
const TEENSY41_PINS: [port: number, bit: number, mux: number, ctl: number][] = [
  [1, 3, 0x0c8, 0x2b8], [1, 2, 0x0c4, 0x2b4], [4, 4, 0x024, 0x214], [4, 5, 0x028, 0x218], [4, 6, 0x02c, 0x21c],
  [4, 8, 0x034, 0x224], [2, 10, 0x164, 0x354], [2, 17, 0x180, 0x370], [2, 16, 0x17c, 0x36c], [2, 11, 0x168, 0x358],
  [2, 0, 0x13c, 0x32c], [2, 2, 0x144, 0x334], [2, 1, 0x140, 0x330], [2, 3, 0x148, 0x338], [1, 18, 0x104, 0x2f4],
  [1, 19, 0x108, 0x2f8], [1, 23, 0x118, 0x308], [1, 22, 0x114, 0x304], [1, 17, 0x100, 0x2f0], [1, 16, 0x0fc, 0x2ec],
  [1, 26, 0x124, 0x314], [1, 27, 0x128, 0x318], [1, 24, 0x11c, 0x30c], [1, 25, 0x120, 0x310], [1, 12, 0x0ec, 0x2dc],
  [1, 13, 0x0f0, 0x2e0], [1, 30, 0x134, 0x324], [1, 31, 0x138, 0x328], [3, 18, 0x094, 0x284], [4, 31, 0x090, 0x280],
  [3, 23, 0x0a8, 0x298], [3, 22, 0x0a4, 0x294], [2, 12, 0x16c, 0x35c], [4, 7, 0x030, 0x220], [2, 29, 0x1b0, 0x3a0],
  [2, 28, 0x1ac, 0x39c], [2, 18, 0x184, 0x374], [2, 19, 0x188, 0x378], [1, 28, 0x12c, 0x31c], [1, 29, 0x130, 0x320],
  [1, 20, 0x10c, 0x2fc], [1, 21, 0x110, 0x300], [3, 15, 0x1c8, 0x3b8], [3, 14, 0x1c4, 0x3b4], [3, 13, 0x1c0, 0x3b0],
  [3, 12, 0x1bc, 0x3ac], [3, 17, 0x1d0, 0x3c0], [3, 16, 0x1cc, 0x3bc], [4, 24, 0x074, 0x264], [4, 27, 0x080, 0x270],
  [4, 28, 0x084, 0x274], [4, 22, 0x06c, 0x25c], [4, 26, 0x07c, 0x26c], [4, 25, 0x078, 0x268], [4, 29, 0x088, 0x278],
];

/** Teensy pin number to pad. */
export const TEENSY41_PIN_PADS = TEENSY41_PINS.map(([port, bit]) => pad(port, bit));

/**
 * PWM outputs by Teensy pin, from the core's pwm.c: FlexPWM module,
 * submodule and channel (X, A, B), or QuadTimer module and channel; and the
 * mux value that routes it to the pin.
 */
type PwmRoute = { kind: 'flexpwm'; module: number; sm: number; ch: 'X' | 'A' | 'B'; mux: number } | { kind: 'qtimer'; module: number; ch: number; mux: number };
const PWM_ROUTES: Record<number, PwmRoute> = {
  0: { kind: 'flexpwm', module: 1, sm: 1, ch: 'X', mux: 4 },
  1: { kind: 'flexpwm', module: 1, sm: 0, ch: 'X', mux: 4 },
  2: { kind: 'flexpwm', module: 4, sm: 2, ch: 'A', mux: 1 },
  3: { kind: 'flexpwm', module: 4, sm: 2, ch: 'B', mux: 1 },
  4: { kind: 'flexpwm', module: 2, sm: 0, ch: 'A', mux: 1 },
  5: { kind: 'flexpwm', module: 2, sm: 1, ch: 'A', mux: 1 },
  6: { kind: 'flexpwm', module: 2, sm: 2, ch: 'A', mux: 2 },
  7: { kind: 'flexpwm', module: 1, sm: 3, ch: 'B', mux: 6 },
  8: { kind: 'flexpwm', module: 1, sm: 3, ch: 'A', mux: 6 },
  9: { kind: 'flexpwm', module: 2, sm: 2, ch: 'B', mux: 2 },
  10: { kind: 'qtimer', module: 1, ch: 0, mux: 1 },
  11: { kind: 'qtimer', module: 1, ch: 2, mux: 1 },
  12: { kind: 'qtimer', module: 1, ch: 1, mux: 1 },
  13: { kind: 'qtimer', module: 2, ch: 0, mux: 1 },
  14: { kind: 'qtimer', module: 3, ch: 2, mux: 1 },
  15: { kind: 'qtimer', module: 3, ch: 3, mux: 1 },
  18: { kind: 'qtimer', module: 3, ch: 1, mux: 1 },
  19: { kind: 'qtimer', module: 3, ch: 0, mux: 1 },
  22: { kind: 'flexpwm', module: 4, sm: 0, ch: 'A', mux: 1 },
  23: { kind: 'flexpwm', module: 4, sm: 1, ch: 'A', mux: 1 },
  24: { kind: 'flexpwm', module: 1, sm: 2, ch: 'X', mux: 4 },
  25: { kind: 'flexpwm', module: 1, sm: 3, ch: 'X', mux: 4 },
  28: { kind: 'flexpwm', module: 3, sm: 1, ch: 'B', mux: 1 },
  29: { kind: 'flexpwm', module: 3, sm: 1, ch: 'A', mux: 1 },
  33: { kind: 'flexpwm', module: 2, sm: 0, ch: 'B', mux: 1 },
  36: { kind: 'flexpwm', module: 2, sm: 3, ch: 'A', mux: 6 },
  37: { kind: 'flexpwm', module: 2, sm: 3, ch: 'B', mux: 6 },
  42: { kind: 'flexpwm', module: 1, sm: 1, ch: 'B', mux: 1 },
  43: { kind: 'flexpwm', module: 1, sm: 1, ch: 'A', mux: 1 },
  44: { kind: 'flexpwm', module: 1, sm: 0, ch: 'B', mux: 1 },
  45: { kind: 'flexpwm', module: 1, sm: 0, ch: 'A', mux: 1 },
  46: { kind: 'flexpwm', module: 1, sm: 2, ch: 'B', mux: 1 },
  47: { kind: 'flexpwm', module: 1, sm: 2, ch: 'A', mux: 1 },
  51: { kind: 'flexpwm', module: 3, sm: 3, ch: 'B', mux: 1 },
  54: { kind: 'flexpwm', module: 3, sm: 0, ch: 'A', mux: 1 },
};

/** ADC inputs: ADC1 and ADC2 input n and the GPIO1 bit (pad) it is on. */
const ADC1_INPUTS = [27, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];
const ADC2_INPUTS = [27, 28, 29, 30, 31, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];

const IRQ = { LPUART6: 25, LPI2C1: 28, LPSPI4: 35, USB1: 113, GPIO5: 88, PIT: 122, GPIO6789: 157 };

/** The fast GPIO blocks 6-9 are 1-4 again, by the IOMUXC_GPR26-29 selection. */
const GPIO_BASES: [number, number][] = [
  [0x401b8000, 1], [0x401bc000, 2], [0x401c0000, 3], [0x401c4000, 4], [0x400c0000, 5],
  [0x42000000, 1], [0x42004000, 2], [0x42008000, 3], [0x4200c000, 4],
];

const r16 = (p: Periph, off: number) => (p.peek(off & ~3) >>> ((off & 2) * 8)) & 0xffff;

export class Imxrt1062 implements ArmMcu {
  readonly hz = IMXRT_HZ;
  readonly adcReference = 3.3;
  readonly flash = new Uint8Array(FLASH_BYTES).fill(0xff);
  /** The QSPI flash, where the EEPROM emulation writes (flexspi.ts). */
  get nonVolatile(): Uint8Array[] {
    return [this.flash];
  }
  readonly itcm = new Uint8Array(TCM_BYTES);
  readonly dtcm = new Uint8Array(TCM_BYTES);
  readonly ocram = new Uint8Array(OCRAM_BYTES);
  readonly ocram1 = new Uint8Array(OCRAM_BYTES);
  readonly regions: MemoryRegion[];
  readonly bus = new PeriphBus();
  readonly pads = new Pads(IMXRT_PAD_COUNT);
  readonly core: CortexM;
  readonly events: EventQueue;
  /** Analog inputs by GPIO1 bit: every ADC input is a GPIO1 pad. */
  readonly adcVolts = new Float64Array(32);
  readonly serials: McuSerial[] = [];
  readonly usb: ImxrtUsb;
  i2c: I2cMasterHooks | null = null;
  spiTransfer: ((mosi: number, mode: 0 | 1 | 2 | 3) => number) | null = null;

  // GPIO state per port (1-5).
  private readonly dr = new Uint32Array(6);
  private readonly gdir = new Uint32Array(6);
  private readonly icr1 = new Uint32Array(6);
  private readonly icr2 = new Uint32Array(6);
  private readonly imr = new Uint32Array(6);
  private readonly isr = new Uint32Array(6);
  private readonly edgeSel = new Uint32Array(6);
  /** IOMUXC mux value and pad control for each pad that is a Teensy pin. */
  private readonly mux = new Uint8Array(IMXRT_PAD_COUNT).fill(5);
  private readonly padCtl = new Uint32Array(IMXRT_PAD_COUNT).fill(0x10b0);
  private readonly takenBy = new Map<number, () => number>();
  private readonly padListeners: ((pin: number, high: boolean) => void)[] = [];
  private readonly lastLevel = new Uint8Array(IMXRT_PAD_COUNT);
  private serial1!: Lpuart;
  private readonly pwm = new Map<number, PwmOutput>();
  private lpi2c!: Lpi2c;

  constructor() {
    this.regions = [
      { start: FLASH_BASE, end: FLASH_BASE + FLASH_BYTES, bytes: this.flash, readOnly: true },
      { start: 0x00000000, end: TCM_BYTES, bytes: this.itcm },
      { start: 0x20000000, end: 0x20000000 + TCM_BYTES, bytes: this.dtcm },
      { start: 0x20200000, end: 0x20200000 + OCRAM_BYTES, bytes: this.ocram },
      { start: 0x20280000, end: 0x20280000 + OCRAM_BYTES, bytes: this.ocram1 },
    ];
    this.core = new CortexM(this, { variant: 'm7', fpu: 'dp', irqCount: 160, priorityBits: 4, cpuid: 0x411fc271 });
    // SysTick's external reference is a 100 kHz clock on this part.
    this.core.systickExternalDivisor = IMXRT_HZ / 100_000;
    this.events = new EventQueue(() => this.core.cycles);
    this.usb = new ImxrtUsb({
      afterUs: (us, fn) => this.events.schedule(Math.max(1, Math.round((us * IMXRT_HZ) / 1e6)), fn),
      setInterrupt: (on) => this.core.setIrqLevel(IRQ.USB1, on),
      read8: (a) => this.read8(a),
      write8: (a, v) => this.write8(a, v),
      read32: (a) => this.read8(a) | (this.read8(a + 1) << 8) | (this.read8(a + 2) << 16) | (this.read8(a + 3) << 24),
      write32: (a, v) => {
        for (let i = 0; i < 4; i++) this.write8(a + i, (v >>> (i * 8)) & 0xff);
      },
    });
    this.buildPeripherals();
    this.pads.onChange = (pin, high) => {
      for (const l of this.padListeners) l(pin, high);
    };
    this.onPadChange((pin, high) => this.gpioEdge(pin, high));
    for (let p = 0; p < IMXRT_PAD_COUNT; p++) this.refreshPad(p);
  }

  read(address: number, width: 1 | 2 | 4): number {
    return this.bus.read(address, width);
  }

  write(address: number, value: number, width: 1 | 2 | 4): void {
    this.bus.write(address, value, width);
  }

  /** Bytes of RAM as the USB controller's DMA reaches them. */
  private memFor(address: number): [Uint8Array, number] | null {
    for (const r of this.regions) if (address >= r.start && address < r.end) return [r.bytes, address - r.start];
    return null;
  }

  read8(address: number): number {
    const m = this.memFor(address >>> 0);
    return m ? m[0][m[1]] : 0;
  }

  write8(address: number, value: number): void {
    const m = this.memFor(address >>> 0);
    if (m && m[0] !== this.flash) m[0][m[1]] = value & 0xff;
  }

  /** The boot ROM's part: the image vector table at 0x60001000 names the entry point. */
  reset(): void {
    this.core.reset(FLASH_BASE + 0x1000);
    this.core.r[13] = 0x20078000;
  }

  load(image: Uint8Array): void {
    if (image.length > FLASH_BYTES) throw new Error("Firmware is larger than the Teensy 4.1's flash.");
    this.flash.set(image, 0);
  }

  get console(): McuSerial | null {
    return this.serial1;
  }

  adcChannelForPad(p: number): number | undefined {
    return p >= 12 && p < 32 ? p : undefined;
  }

  onPadChange(fn: (pin: number, high: boolean) => void): void {
    this.padListeners.push(fn);
  }

  activeI2cPads(): { sda?: number; scl?: number } {
    return { sda: TEENSY41_PIN_PADS[18], scl: TEENSY41_PIN_PADS[19] };
  }

  activeSpiPads(): { sck?: number; mosi?: number; miso?: number } {
    return { sck: TEENSY41_PIN_PADS[13], mosi: TEENSY41_PIN_PADS[11], miso: TEENSY41_PIN_PADS[12] };
  }

  // ------------------------------------------------------------------ pads

  /** A peripheral drives a pad (its mux selects it), or gives it back. */
  take(p: number, level: (() => number) | null): void {
    if (level) this.takenBy.set(p, level);
    else this.takenBy.delete(p);
    this.refreshPad(p);
  }

  refreshPad(p: number): void {
    const port = (p >> 5) + 1;
    const bit = 1 << (p & 31);
    let drive = NOT_DRIVEN;
    const taken = this.takenBy.get(p);
    if (taken) drive = taken();
    else if (this.mux[p] === 5 && this.gdir[port] & bit) drive = this.dr[port] & bit ? 1 : 0;
    this.pads.setDrive(p, drive);
    // PKE and PUE enable the pull; PUS 0 pulls down, 1-3 up.
    const ctl = this.padCtl[p];
    const pulled = (ctl & 0x3000) === 0x3000;
    this.pads.setPull(p, pulled ? ((ctl >>> 14) & 3 ? 1 : 2) : 0);
  }

  private gpioWrite(port: number, before: number): void {
    let changed = (before ^ this.dr[port]) >>> 0;
    for (let b = 0; changed; b++, changed >>>= 1) if (changed & 1) this.refreshPad(pad(port, b));
  }

  /** ICR (or EDGE_SEL) decides whether a pad's change sets its ISR bit. */
  private gpioEdge(p: number, high: boolean): void {
    if (this.lastLevel[p] === (high ? 1 : 0)) return;
    this.lastLevel[p] = high ? 1 : 0;
    const port = (p >> 5) + 1;
    const b = p & 31;
    const bit = 1 << b;
    let hit: boolean;
    if (this.edgeSel[port] & bit) hit = true;
    else {
      const icr = ((b < 16 ? this.icr1[port] >>> (b * 2) : this.icr2[port] >>> ((b - 16) * 2)) & 3);
      hit = icr === 0 ? !high : icr === 1 ? high : icr === 2 ? high : !high;
    }
    if (hit) {
      this.isr[port] = (this.isr[port] | bit) >>> 0;
      this.gpioIrq();
    }
  }

  private gpioIrq(): void {
    let fast = false;
    for (let port = 1; port <= 4; port++) if (this.isr[port] & this.imr[port]) fast = true;
    this.core.setIrqLevel(IRQ.GPIO6789, fast);
    this.core.setIrqLevel(IRQ.GPIO5, (this.isr[5] & this.imr[5]) !== 0);
  }

  private psr(port: number): number {
    let v = 0;
    for (let b = 0; b < 32; b++) if (this.pads.level(pad(port, b))) v |= 1 << b;
    return v >>> 0;
  }

  // ----------------------------------------------------------- peripherals

  private buildPeripherals(): void {
    const bus = this.bus;

    // The analog blocks — PLLs, PFDs, PMU, XTALOSC, TEMPMON, USB analog —
    // with their SET/CLR/TOG aliases at +4/+8/+C. Every PLL reports lock and
    // the temperature monitor reports a finished measurement.
    const analog = bus.add(new SctPeriph('CCM_ANALOG', 0x400d8000, 0x1000));
    for (const pll of [0x000, 0x010, 0x020, 0x030, 0x070, 0x0a0, 0x0e0]) analog.status(pll, 0x80000000);
    analog.status(0x180, 0x4); // TEMPMON_TEMPSENSE0.FINISHED
    analog.status(0x1c0, 0x8); // USB_ANALOG_USB1_VBUS_DETECT_STAT.VBUS_VALID
    bus.add(new SctPeriph('USBPHY1', 0x400d9000, 0x1000));
    bus.add(new SctPeriph('USBPHY2', 0x400da000, 0x1000));
    const ccm = bus.add(new Periph('CCM', 0x400fc000, 0x4000));
    ccm.reg(0x48, () => 0); // CDHIPR: no divider or mux change in progress
    const dcdc = bus.add(new Periph('DCDC', 0x40080000, 0x4000));
    dcdc.reg(0x0, () => dcdc.peek(0) | 0x80000000); // REG0.STS_DC_OK
    // OCOTP fuses: the temperature calibration the core reads.
    const ocotp = bus.add(new Periph('OCOTP', 0x401f4000, 0x4000));
    ocotp.init(0x4e0, (0x56a << 20) | (0x4b0 << 8) | 0x5f); // ANA1: room count, hot count, hot temperature
    ocotp.init(0x0, 0); // CTRL: not busy
    // FlexSPI: IP commands on FLEXSPI program and erase the QSPI flash, which
    // is where EEPROM lives (flexspi.ts); nothing answers on FLEXSPI2, so no
    // external PSRAM or flash is detected there.
    new FlexSpi(bus.add(new Periph('FLEXSPI', 0x402a8000, 0x4000)), this.flash);
    new FlexSpi(bus.add(new Periph('FLEXSPI2', 0x402a4000, 0x4000)), null);

    // PIT: IntervalTimer, and tone() on it.
    new Pit(
      { hz: this.hz, events: this.events, cycles: () => this.core.cycles, setIrq: (on) => this.core.setIrqLevel(IRQ.PIT, on) },
      bus.add(new Periph('PIT', 0x40084000, 0x4000)),
    );

    // IOMUXC: the mux and pad control of each Teensy pin.
    const iomuxc = bus.add(new Periph('IOMUXC', 0x401f8000, 0x4000));
    TEENSY41_PINS.forEach(([port, bit, muxOff, ctlOff]) => {
      const p = pad(port, bit);
      iomuxc.reg(muxOff, () => this.mux[p], (v) => {
        this.mux[p] = v & 7;
        this.pwmRouted(p);
        this.refreshPad(p);
      });
      iomuxc.reg(ctlOff, () => this.padCtl[p], (v) => {
        this.padCtl[p] = v >>> 0;
        this.refreshPad(p);
      });
    });

    // GPIO1-5, and 6-9 as the same ports.
    for (const [base, port] of GPIO_BASES) {
      const g = bus.add(new Periph(`GPIO${port}`, base, 0x4000));
      g.reg(0x00, () => this.dr[port], (v) => {
        const before = this.dr[port];
        this.dr[port] = v >>> 0;
        this.gpioWrite(port, before);
      });
      g.reg(0x04, () => this.gdir[port], (v) => {
        const before = this.gdir[port];
        this.gdir[port] = v >>> 0;
        let changed = (before ^ this.gdir[port]) >>> 0;
        for (let b = 0; changed; b++, changed >>>= 1) if (changed & 1) this.refreshPad(pad(port, b));
      });
      g.reg(0x08, () => this.psr(port));
      g.reg(0x0c, () => this.icr1[port], (v) => (this.icr1[port] = v >>> 0));
      g.reg(0x10, () => this.icr2[port], (v) => (this.icr2[port] = v >>> 0));
      g.reg(0x14, () => this.imr[port], (v) => {
        this.imr[port] = v >>> 0;
        this.gpioIrq();
      });
      g.reg(0x18, () => this.isr[port], (v) => {
        this.isr[port] = (this.isr[port] & ~v) >>> 0;
        this.gpioIrq();
      });
      g.reg(0x1c, () => this.edgeSel[port], (v) => (this.edgeSel[port] = v >>> 0));
      const setDr = (v: number) => {
        const before = this.dr[port];
        this.dr[port] = v >>> 0;
        this.gpioWrite(port, before);
      };
      g.reg(0x84, () => 0, (v) => setDr(this.dr[port] | v));
      g.reg(0x88, () => 0, (v) => setDr(this.dr[port] & ~v));
      g.reg(0x8c, () => 0, (v) => setDr(this.dr[port] ^ v));
    }

    new ImxrtAdc(this, bus.add(new Periph('ADC1', 0x400c4000, 0x4000)), ADC1_INPUTS);
    new ImxrtAdc(this, bus.add(new Periph('ADC2', 0x400c8000, 0x4000)), ADC2_INPUTS);

    // PWM: the counters' registers; outputs are worked out from them when a
    // pin's mux routes one there (pwmRouted) and whenever they change.
    for (const [i, base] of [0x403dc000, 0x403e0000, 0x403e4000, 0x403e8000].entries()) {
      const p = bus.add(new Periph(`FLEXPWM${i + 1}`, base, 0x4000));
      for (let off = 0; off < 0x200; off += 4) p.reg(off, undefined, () => this.pwmChanged('flexpwm', i + 1));
    }
    for (const [i, base] of [0x401dc000, 0x401e0000, 0x401e4000, 0x401e8000].entries()) {
      const p = bus.add(new Periph(`TMR${i + 1}`, base, 0x4000));
      p.init(0x1c, 0xf << 16); // ENBL: every channel enabled out of reset
      for (let off = 0; off < 0x80; off += 4) p.reg(off, undefined, () => this.pwmChanged('qtimer', i + 1));
    }

    const uartPads = { tx: TEENSY41_PIN_PADS[1], rx: TEENSY41_PIN_PADS[0] };
    this.serial1 = new Lpuart(this, bus.add(new Periph('LPUART6', 0x40198000, 0x4000)), 'Serial1', uartPads.tx, uartPads.rx, IRQ.LPUART6);
    this.serials.push(this.serial1);
    this.lpi2c = new Lpi2c(this, bus.add(new Periph('LPI2C1', 0x403f0000, 0x4000)));
    void this.lpi2c;
    new Lpspi(this, bus.add(new Periph('LPSPI4', 0x403a0000, 0x4000)));

    const usb = this.usb;
    bus.add(
      new (class extends Periph {
        override read(offset: number, width: 1 | 2 | 4): number {
          return usb.read(offset, width);
        }
        override write(offset: number, value: number, width: 1 | 2 | 4): void {
          usb.write(offset, value, width);
        }
      })('USB1', 0x402e0000, 0x4000),
    );
  }

  // ------------------------------------------------------------------ PWM

  private pwmRouted(p: number): void {
    const pin = TEENSY41_PIN_PADS.indexOf(p);
    const route = PWM_ROUTES[pin];
    const existing = this.pwm.get(p);
    if (route && this.mux[p] === route.mux) {
      if (!existing) {
        const out = new PwmOutput(this, p);
        this.pwm.set(p, out);
        this.take(p, () => out.level);
      }
      this.updatePwm(p, route);
    } else if (existing) {
      existing.stop();
      this.pwm.delete(p);
      this.take(p, null);
    }
  }

  private pwmChanged(kind: 'flexpwm' | 'qtimer', module: number): void {
    for (const p of this.pwm.keys()) {
      const route = PWM_ROUTES[TEENSY41_PIN_PADS.indexOf(p)];
      if (route && route.kind === kind && route.module === module) this.updatePwm(p, route);
    }
  }

  /** Period and high time in CPU cycles (the IPG clock is the CPU clock at this speed). */
  private updatePwm(p: number, route: PwmRoute): void {
    const out = this.pwm.get(p)!;
    if (route.kind === 'flexpwm') {
      const m = this.bus.find([0x403dc000, 0x403e0000, 0x403e4000, 0x403e8000][route.module - 1])!;
      const sm = route.sm * 0x60;
      // The counter runs from INIT to VAL1 and wraps at 16 bits, so the
      // distances between the compare values are taken modulo 2^16.
      const d = (a: number, b: number) => (a - b) & 0xffff;
      const init = r16(m, sm + 0x02);
      const ctrl = r16(m, sm + 0x06);
      const val0 = r16(m, sm + 0x0a);
      const val1 = r16(m, sm + 0x0e);
      const val2 = r16(m, sm + 0x12);
      const val3 = r16(m, sm + 0x16);
      const val4 = r16(m, sm + 0x1a);
      const val5 = r16(m, sm + 0x1e);
      const run = (r16(m, 0x188) >>> 8) & (1 << route.sm); // MCTRL.RUN
      const prescale = 1 << ((ctrl >>> 4) & 7);
      const counts = d(val1, init) + 1;
      let high = 0;
      if (route.ch === 'A') high = val3 >= val2 ? d(val3, val2) : 0;
      else if (route.ch === 'B') high = val5 >= val4 ? d(val5, val4) : 0;
      else high = d(val1, val0);
      if (!run || counts <= 1) out.set(0, 0);
      else out.set(counts * prescale, Math.max(0, Math.min(counts, high)) * prescale);
    } else {
      const t = this.bus.find([0x401dc000, 0x401e0000, 0x401e4000, 0x401e8000][route.module - 1])!;
      const ch = route.ch * 0x20;
      const load = r16(t, ch + 0x06);
      const cmpld1 = r16(t, ch + 0x10);
      const ctrl = r16(t, ch + 0x0c);
      const enbl = r16(t, 0x1e);
      const pcs = (ctrl >>> 9) & 0xf;
      const prescale = pcs >= 8 ? 1 << (pcs - 8) : 1;
      const running = (ctrl >>> 13) !== 0 && (enbl & (1 << route.ch)) !== 0;
      const high = cmpld1;
      const low = 65537 - load;
      if (!running || high + low <= 0) out.set(0, 0);
      else out.set((high + low) * prescale, high * prescale);
    }
  }
}

/** Registers with SET, CLR and TOG aliases at +4, +8 and +C, as the analog blocks have. */
class SctPeriph extends Periph {
  private readonly statusBits = new Map<number, number>();

  /** Bits that always read as set (a PLL's LOCK, say). */
  status(offset: number, bits: number): this {
    this.statusBits.set(offset, bits);
    return this;
  }

  override read(offset: number, width: 1 | 2 | 4): number {
    const base = offset & ~0xf;
    const v = (this.peek(base) | (this.statusBits.get(base) ?? 0)) >>> 0;
    const shift = (offset & 3) * 8;
    return width === 4 ? v : (v >>> shift) & (width === 1 ? 0xff : 0xffff);
  }

  override write(offset: number, value: number, width: 1 | 2 | 4): void {
    const base = offset & ~0xf;
    const v = width === 4 ? value >>> 0 : (value << ((offset & 3) * 8)) >>> 0;
    const old = this.peek(base);
    switch (offset & 0xc) {
      case 0x0: return this.poke(base, v);
      case 0x4: return this.poke(base, old | v);
      case 0x8: return this.poke(base, old & ~v);
      default: return this.poke(base, old ^ v);
    }
  }
}

/** A pin's PWM waveform, edges scheduled on the chip's clock. */
class PwmOutput {
  level = 0;
  private period = 0;
  private high = 0;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly chip: Imxrt1062,
    private readonly p: number,
  ) {}

  set(period: number, high: number): void {
    if (period === this.period && high === this.high) return;
    this.period = Math.round(period);
    this.high = Math.round(high);
    this.stop();
    if (this.period <= 0 || this.high <= 0) return this.drive(0);
    if (this.high >= this.period) return this.drive(1);
    this.edge(1);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  private drive(level: number): void {
    this.level = level;
    this.chip.refreshPad(this.p);
  }

  private edge(level: number): void {
    this.drive(level);
    this.cancel = this.chip.events.schedule(level ? this.high : this.period - this.high, () => this.edge(level ? 0 : 1));
  }
}

/** ADC: one conversion at a time on HC0, the result in R0, COCO0 when done. */
class ImxrtAdc {
  constructor(chip: Imxrt1062, p: Periph, inputs: number[]) {
    let result = 0;
    let done = false;
    p.reg(0x00, undefined, (v) => {
      const ch = v & 0x1f;
      done = false;
      if (ch === 0x1f) return; // conversion off
      chip.events.schedule(chip.hz / 500_000, () => {
        const bits = [8, 10, 12, 12][(p.peek(0x44) >>> 2) & 3];
        const max = (1 << bits) - 1;
        const gpio1Bit = inputs[ch];
        const volts = gpio1Bit === undefined ? 0 : chip.adcVolts[gpio1Bit];
        result = Math.max(0, Math.min(max, Math.round((volts / chip.adcReference) * max)));
        done = true;
      });
    }); // HC0
    p.reg(0x20, () => (done ? 1 : 0)); // HS.COCO0
    p.reg(0x24, () => {
      done = false;
      return result;
    }); // R0
    p.reg(0x48, () => p.peek(0x48) & ~0x80); // GC: calibration finishes at once
    p.reg(0x4c, () => 0); // GS: not busy, no calibration failure
  }
}

/** LPUART: 4-word FIFOs, the flags and interrupts the core's HardwareSerial uses. */
class Lpuart implements McuSerial {
  onTransmit: ((byte: number) => void) | null = null;
  private readonly txFifo: number[] = [];
  private readonly rxFifo: number[] = [];
  private shifting = false;
  private idle = false;
  private idleTimer: (() => void) | null = null;
  private readonly rxQueue: number[] = [];
  private rxBusy = false;

  constructor(
    private readonly chip: Imxrt1062,
    private readonly p: Periph,
    readonly name: string,
    readonly txPad: number,
    readonly rxPad: number,
    private readonly irq: number,
  ) {
    p.reg(0x14, () => this.stat(), (v) => {
      if (v & (1 << 20)) this.idle = false; // IDLE, write 1 to clear
      this.update();
    }); // STAT
    p.reg(0x18, undefined, () => this.update()); // CTRL
    p.reg(0x1c, () => {
      const b = this.rxFifo.shift() ?? 0;
      this.pumpRx();
      this.update();
      return b;
    }, (v) => {
      if (!(p.peek(0x18) & (1 << 19))) return; // TE
      this.txFifo.push(v & 0xff);
      this.shift();
      this.update();
    }); // DATA
    p.reg(0x2c, () => (p.peek(0x2c) & 0x00030003) | (this.txFifo.length << 8) | (this.rxFifo.length << 24)); // WATER
    p.reg(0x08, undefined, (v) => {
      if (v & 2) {
        this.txFifo.length = 0;
        this.rxFifo.length = 0;
      }
    }); // GLOBAL.RST
    p.reg(0x28, () => p.peek(0x28) | 0x00c00000 | (this.txFifo.length === 0 ? 0 : 0), (v) => {
      if (v & (1 << 15)) this.txFifo.length = 0; // TXFLUSH
      if (v & (1 << 14)) this.rxFifo.length = 0; // RXFLUSH
      p.poke(0x28, v & ~0xc000);
    }); // FIFO
    p.init(0x28, 0x00c00011); // FIFO: TXEMPT, RXEMPT, 4-word FIFOs
    chip.take(txPad, () => (this.enabled() ? 1 : NOT_DRIVEN));
  }

  private enabled(): boolean {
    return (this.p.peek(0x18) & (1 << 19)) !== 0;
  }

  baud(): number | undefined {
    const b = this.p.peek(0x10);
    const sbr = b & 0x1fff;
    const osr = ((b >>> 24) & 0x1f) + 1;
    return sbr ? Math.round(24_000_000 / (osr * sbr)) : undefined;
  }

  private charCycles(): number {
    return Math.max(16, Math.round((this.chip.hz * 10) / (this.baud() ?? 115200)));
  }

  private stat(): number {
    const water = this.p.peek(0x2c);
    const txWater = water & 3;
    const rxWater = (water >>> 16) & 3;
    let s = 0;
    if (this.txFifo.length <= txWater) s |= 1 << 23; // TDRE
    if (!this.txFifo.length && !this.shifting) s |= 1 << 22; // TC
    if (this.rxFifo.length > rxWater) s |= 1 << 21; // RDRF
    if (this.idle) s |= 1 << 20; // IDLE
    return s >>> 0;
  }

  private update(): void {
    const ctrl = this.p.peek(0x18);
    const s = this.stat();
    const on =
      (ctrl & (1 << 23) && s & (1 << 23)) || // TIE
      (ctrl & (1 << 22) && s & (1 << 22)) || // TCIE
      (ctrl & (1 << 21) && s & (1 << 21)) || // RIE
      (ctrl & (1 << 20) && s & (1 << 20)); // ILIE
    this.chip.core.setIrqLevel(this.irq, !!on);
  }

  private shift(): void {
    if (this.shifting || !this.txFifo.length) return;
    this.shifting = true;
    const byte = this.txFifo.shift()!;
    this.chip.events.schedule(this.charCycles(), () => {
      this.onTransmit?.(byte);
      this.shifting = false;
      this.shift();
      this.update();
    });
    this.update();
  }

  receive(byte: number): void {
    this.rxQueue.push(byte & 0xff);
    this.pumpRx();
  }

  private pumpRx(): void {
    if (this.rxBusy || !this.rxQueue.length || this.rxFifo.length >= 4) return;
    if (!(this.p.peek(0x18) & (1 << 18))) return; // RE
    this.rxBusy = true;
    this.chip.events.schedule(this.charCycles(), () => {
      this.rxBusy = false;
      this.rxFifo.push(this.rxQueue.shift()!);
      this.idle = false;
      this.idleTimer?.();
      // A character time with nothing arriving raises IDLE.
      this.idleTimer = this.chip.events.schedule(this.charCycles(), () => {
        this.idleTimer = null;
        if (!this.rxQueue.length) {
          this.idle = true;
          this.update();
        }
      });
      this.update();
      this.pumpRx();
    });
  }
}

/**
 * LPI2C master: commands through MTDR (START+address, transmit, receive n,
 * STOP), each taking a byte time on the bus, received bytes in MRDR. A NACK
 * sets NDF and the transfer's remaining data commands are dropped.
 */
class Lpi2c {
  private readonly cmds: number[] = [];
  private readonly rx: number[] = [];
  private busy = false;
  private msr = 0;
  private inTransaction = false;
  private nacked = false;

  constructor(
    private readonly chip: Imxrt1062,
    private readonly p: Periph,
  ) {
    p.reg(0x10, undefined, (v) => {
      if (v & (1 << 8)) this.cmds.length = 0; // RTF
      if (v & (1 << 9)) this.rx.length = 0; // RRF
      p.poke(0x10, v & ~0x300);
    }); // MCR
    p.reg(0x14, () => this.status(), (v) => (this.msr &= ~(v & 0x7f00))); // MSR, write 1 to clear
    p.reg(0x5c, () => Math.min(this.cmds.length, 4) | (Math.min(this.rx.length, 4) << 16)); // MFSR
    p.reg(0x60, undefined, (v) => {
      this.cmds.push(v & 0x7ff);
      this.next();
    }); // MTDR
    p.reg(0x70, () => {
      if (!this.rx.length) return 1 << 14; // RXEMPTY
      return this.rx.shift()!;
    }); // MRDR
  }

  private status(): number {
    let s = this.msr;
    if (this.cmds.length === 0) s |= 1; // TDF
    if (this.rx.length) s |= 2; // RDF
    if (this.inTransaction) s |= (1 << 24) | (1 << 25); // MBF, BBF
    return s >>> 0;
  }

  private byteCycles(): number {
    return Math.round(this.chip.hz / 11_000); // 9 bits at 100 kHz
  }

  private next(): void {
    if (this.busy || !this.cmds.length) return;
    this.busy = true;
    this.chip.events.schedule(this.byteCycles(), () => {
      this.busy = false;
      const word = this.cmds.shift();
      if (word !== undefined) this.run(word);
      this.next();
    });
  }

  private run(word: number): void {
    const cmd = (word >>> 8) & 7;
    const data = word & 0xff;
    const bus = this.chip.i2c;
    switch (cmd) {
      case 4:
      case 5: {
        bus?.start(this.inTransaction);
        this.inTransaction = true;
        this.nacked = false;
        const ack = bus ? bus.connect(data >>> 1, (data & 1) === 0) : false;
        if (!ack && cmd === 4) {
          this.nacked = true;
          this.msr |= 1 << 10; // NDF
        }
        return;
      }
      case 0:
        if (this.nacked) return;
        if (!(bus ? bus.writeByte(data) : false)) {
          this.nacked = true;
          this.msr |= 1 << 10;
        }
        return;
      case 1: {
        if (this.nacked) return;
        // DATA + 1 bytes; the last is NACKed when a STOP or START follows.
        const count = data + 1;
        const nextCmd = ((this.cmds[0] ?? 0x200) >>> 8) & 7;
        for (let i = 0; i < count; i++) {
          const last = i === count - 1 && (nextCmd === 2 || nextCmd === 4 || nextCmd === 5);
          this.rx.push(bus ? bus.readByte(!last) : 0xff);
        }
        return;
      }
      case 2:
        if (this.inTransaction) bus?.stop();
        this.inTransaction = false;
        this.nacked = false;
        this.msr |= 1 << 9; // SDF
        return;
      default:
    }
  }
}

/** LPSPI master: a TDR write is a frame on the device bus, its answer in RDR. */
class Lpspi {
  private readonly rx: number[] = [];

  constructor(
    private readonly chip: Imxrt1062,
    private readonly p: Periph,
  ) {
    p.reg(0x10, undefined, (v) => {
      if (v & (1 << 9)) this.rx.length = 0; // RRF
      p.poke(0x10, v & ~0x300);
    }); // CR
    p.reg(0x14, () => 0x1 | (this.rx.length ? 0x2 : 0) | (1 << 10)); // SR: TDF, RDF, TCF
    p.reg(0x5c, () => Math.min(this.rx.length, 16) << 16); // FSR.RXCOUNT
    p.reg(0x70, () => (this.rx.length ? 0 : 2)); // RSR.RXEMPTY
    p.reg(0x74, () => this.rx.shift() ?? 0); // RDR
    p.reg(0x64, undefined, (v) => this.frame(v >>> 0)); // TDR
  }

  private frame(word: number): void {
    const tcr = this.p.peek(0x60);
    const bits = (tcr & 0xfff) + 1;
    const mode = ((((tcr >>> 31) & 1) << 1) | ((tcr >>> 30) & 1)) as 0 | 1 | 2 | 3;
    const lsb = (tcr & (1 << 23)) !== 0;
    const bytes = Math.max(1, Math.ceil(bits / 8));
    const rev = (b: number) => {
      let r = 0;
      for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i;
      return r;
    };
    let result = 0;
    for (let i = bytes - 1; i >= 0; i--) {
      // Most significant byte first, unless LSB first.
      const k = lsb ? bytes - 1 - i : i;
      const out = (word >>> (k * 8)) & 0xff;
      const sent = lsb ? rev(out) : out;
      const got = (this.chip.spiTransfer ? this.chip.spiTransfer(sent, mode) : 0xff) & 0xff;
      result |= (lsb ? rev(got) : got) << (k * 8);
    }
    if (!(tcr & (1 << 19))) this.rx.push(result >>> 0); // RXMSK
  }
}
