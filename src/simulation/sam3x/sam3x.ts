// The Microchip (Atmel) SAM3X8E, the Arduino Due's chip, on the ARMv7-M core.
//
// Modelled from the SAM3X/SAM3A datasheet (Atmel-11057) and the CMSIS device
// headers the Arduino SAM core is compiled against, at the level the core and
// its libraries actually use:
//
//   * PMC: every oscillator, PLL and master-clock ready flag startup waits on,
//     and the peripheral clock enables. The CPU is taken to run at 84 MHz, the
//     clock the core configures before setup().
//   * EEFC0/1: ready flag, and real page programming (WP, EWP), which is what
//     DueFlashStorage uses to keep data.
//   * PIOA-D: output, input, open drain, pull-ups, peripheral A/B muxing, and
//     the full interrupt model behind attachInterrupt — any edge, rising,
//     falling, low and high level.
//   * UART and USART0-3 (Serial, Serial1, Serial2, Serial3): the shared
//     register layout, interrupt driven, bytes paced at the programmed baud.
//   * TC0-TC2, nine channels: waveform mode with RA/RB/RC compares driving
//     TIOA/TIOB and raising interrupts — analogWrite on the timer pins, tone()
//     and Servo all run on these.
//   * PWM: channels with prescaled clocks, period and duty, and the duty
//     update register analogWrite uses once a channel runs.
//   * ADC: software-triggered conversions, 12 bits against 3.3 V.
//   * DACC: conversion data and its ready flags.
//   * TWI0/1 (Wire1/Wire) as an I2C master, and SPI0 as an SPI master, both
//     reaching the canvas's device buses.
//   * UOTGHS reports its clock usable (USBDevice.attach() waits for that);
//     the native USB port itself is not modelled — SerialUSB sends nowhere.
//   * TRNG, CHIPID, and read-back storage for everything else.

import { CortexM } from '../armv7m/cortexM';
import type { MemoryRegion } from '../armv7m/bus';
import type { ArmMcu } from '../armv7m/armRunner';
import { EventQueue, Pads, Periph, PeriphBus, NOT_DRIVEN } from '../armv7m/peripherals';

export const SAM3X_HZ = 84_000_000;
export const SAM3X_FLASH_BASE = 0x80000;
export const SAM3X_FLASH_BYTES = 512 * 1024;
const SRAM_BASE = 0x20070000;
const SRAM_BYTES = 96 * 1024;
export const SAM3X_PAD_COUNT = 128;

/** PA0 is 0, PB27 is 59: port * 32 + bit. */
export function sam3xPadIndex(pad: string): number | undefined {
  const m = /^P([A-D])(\d{1,2})$/.exec(pad);
  if (!m) return undefined;
  const bit = Number(m[2]);
  if (bit > 31) return undefined;
  return (m[1].charCodeAt(0) - 65) * 32 + bit;
}

const pad = (name: string) => sam3xPadIndex(name)!;

/** ADC channel behind each pad (AD0..AD15). */
export const SAM3X_ADC_BY_PAD: Record<number, number> = {
  [pad('PA2')]: 0, [pad('PA3')]: 1, [pad('PA4')]: 2, [pad('PA6')]: 3, [pad('PA22')]: 4, [pad('PA23')]: 5,
  [pad('PA24')]: 6, [pad('PA16')]: 7, [pad('PB12')]: 8, [pad('PB13')]: 9, [pad('PB17')]: 10, [pad('PB18')]: 11,
  [pad('PB19')]: 12, [pad('PB20')]: 13, [pad('PB21')]: 14,
};

/** NVIC lines (datasheet table 9-1). */
const IRQ = {
  UART: 8, PIOA: 11, PIOB: 12, PIOC: 13, PIOD: 14,
  USART0: 17, USART1: 18, USART2: 19, USART3: 20,
  TWI0: 22, TWI1: 23, SPI0: 24, TC0: 27, PWM: 36, ADC: 37, DACC: 38, UOTGHS: 40, TRNG: 41,
} as const;

export interface I2cMaster {
  start(repeated: boolean): void;
  connect(address: number, write: boolean): boolean;
  writeByte(value: number): boolean;
  readByte(ack: boolean): number;
  stop(): void;
}

/** A U(S)ART as the runner sees it: bytes out, bytes in, and its rate. */
export interface Sam3xSerial {
  readonly name: string;
  readonly rxPad: number;
  readonly txPad: number;
  onTransmit: ((byte: number) => void) | null;
  receive(byte: number): void;
  baud(): number | undefined;
}

export class Sam3x implements ArmMcu {
  readonly hz = SAM3X_HZ;
  readonly adcReference = 3.3;
  readonly flash = new Uint8Array(SAM3X_FLASH_BYTES).fill(0xff);
  readonly sram = new Uint8Array(SRAM_BYTES);
  readonly regions: MemoryRegion[];
  readonly bus = new PeriphBus();
  readonly pads = new Pads(SAM3X_PAD_COUNT);
  readonly core: CortexM;
  readonly events: EventQueue;
  readonly adcVolts = new Float64Array(16);
  readonly serials: Sam3xSerial[] = [];
  /** Wire (TWI1) and Wire1 (TWI0) masters reach the canvas through this. */
  i2c: I2cMaster | null = null;
  /** One SPI byte: MOSI in, MISO out. */
  spiTransfer: ((mosi: number, mode: 0 | 1 | 2 | 3) => number) | null = null;
  /** Level a peripheral drives on a pad muxed to it, by pad; absent = that function drives nothing. */
  private readonly peripheralDrive = new Map<number, { a?: () => number; b?: () => number }>();
  private readonly pios: Pio[] = [];
  private readonly latch = new Map<number, number>();

  constructor() {
    // SRAM0 is mirrored at 0x20000000; the core links everything at 0x20070000.
    this.regions = [
      { start: SAM3X_FLASH_BASE, end: SAM3X_FLASH_BASE + SAM3X_FLASH_BYTES, bytes: this.flash, readOnly: true },
      { start: SRAM_BASE, end: SRAM_BASE + SRAM_BYTES, bytes: this.sram },
      { start: 0x20000000, end: 0x20010000, bytes: this.sram.subarray(0, 0x10000) },
      // Boot memory: flash is mapped at 0 when booting from it.
      { start: 0, end: SAM3X_FLASH_BYTES, bytes: this.flash, readOnly: true },
    ];
    this.core = new CortexM(this, { variant: 'm3', irqCount: 45, priorityBits: 4, cpuid: 0x412fc230 });
    this.events = new EventQueue(() => this.core.cycles);
    this.buildPeripherals();
    // Power-on: every pad is an input with its pull-up on, and has been since
    // before the first instruction — so settle them now and let no input-change
    // flag claim an edge that never happened.
    for (let pin = 0; pin < SAM3X_PAD_COUNT; pin++) this.refreshPad(pin);
    for (const pio of this.pios) pio.isr = 0;
  }

  // ------------------------------------------------------------- ArmChip

  read(address: number, width: 1 | 2 | 4): number {
    return this.bus.read(address, width);
  }

  write(address: number, value: number, width: 1 | 2 | 4): void {
    if (address >= SAM3X_FLASH_BASE && address < SAM3X_FLASH_BASE + SAM3X_FLASH_BYTES) {
      // A write to flash fills the page latch; a flash command commits it.
      for (let i = 0; i < width; i++) this.latch.set(address + i, (value >>> (8 * i)) & 0xff);
      return;
    }
    this.bus.write(address, value, width);
  }

  reset(): void {
    this.core.reset(SAM3X_FLASH_BASE);
  }

  /** Serial: the UART on D0/D1, which the programming port's USB bridge carries to the monitor. */
  get console(): Sam3xSerial {
    return this.serials[0];
  }

  adcChannelForPad(p: number): number | undefined {
    return SAM3X_ADC_BY_PAD[p];
  }

  /** Loads an application image at the start of flash. */
  load(image: Uint8Array): void {
    if (image.length > SAM3X_FLASH_BYTES) throw new Error('Firmware is larger than the SAM3X8E\'s 512 KB of flash.');
    this.flash.set(image);
  }

  // ------------------------------------------------------- pad plumbing

  /** Recomputes who drives a pad: the PIO, its muxed peripheral, or nothing. */
  refreshPad(pin: number): void {
    const pio = this.pios[pin >> 5];
    const bit = 1 << (pin & 31);
    let drive = NOT_DRIVEN;
    if (pio.psr & bit) {
      if (pio.osr & bit) {
        const high = (pio.odsr & bit) !== 0;
        drive = pio.mdsr & bit ? (high ? NOT_DRIVEN : 0) : high ? 1 : 0;
      }
    } else {
      const fn = this.peripheralDrive.get(pin);
      const source = pio.absr & bit ? fn?.b : fn?.a;
      if (source) drive = source();
    }
    this.pads.setDrive(pin, drive);
    this.pads.setPull(pin, pio.pusr & bit ? 0 : 1);
  }

  /** Registers what a peripheral drives on a pad when muxed to function A or B. */
  private drives(padName: string, fn: 'a' | 'b', level: () => number): void {
    const p = pad(padName);
    const entry = this.peripheralDrive.get(p) ?? {};
    entry[fn] = level;
    this.peripheralDrive.set(p, entry);
  }

  private refreshPads(names: string[]): void {
    for (const n of names) this.refreshPad(pad(n));
  }

  isOutput(pin: number): boolean {
    return this.pads.drive[pin] !== NOT_DRIVEN;
  }

  setExternal(pin: number, value: boolean | undefined): void {
    this.pads.setExternal(pin, value);
  }

  // ------------------------------------------------------- peripherals

  private buildPeripherals(): void {
    const bus = this.bus;
    const core = this.core;

    // PMC: everything is ready the moment it is asked for.
    const pmc = bus.add(new Periph('PMC', 0x400e0600, 0x200));
    pmc.reg(0x68, () => 0x0003_07cb); // MOSCXTS LOCKA MCKRDY LOCKU OSCSELS PCKRDY0-2 MOSCSELS MOSCRCS
    pmc.reg(0x24, () => 0x10000 | 750); // MAINF ready
    let pcsr0 = 0;
    let pcsr1 = 0;
    pmc.reg(0x10, undefined, (v) => (pcsr0 |= v));
    pmc.reg(0x14, undefined, (v) => (pcsr0 &= ~v));
    pmc.reg(0x18, () => pcsr0);
    pmc.reg(0x100, undefined, (v) => (pcsr1 |= v));
    pmc.reg(0x104, undefined, (v) => (pcsr1 &= ~v));
    pmc.reg(0x108, () => pcsr1);

    // Flash controllers.
    for (const [i, base] of [[0, 0x400e0a00], [1, 0x400e0c00]] as const) {
      const efc = bus.add(new Periph(`EEFC${i}`, base, 0x200));
      let frr = 0;
      efc.reg(0x08, () => 1); // FSR.FRDY
      efc.reg(0x0c, () => frr);
      efc.reg(0x04, undefined, (v) => {
        if (v >>> 24 !== 0x5a) return;
        const cmd = v & 0xff;
        const page = (v >>> 8) & 0xffff;
        const bank = SAM3X_FLASH_BASE + i * 0x40000;
        if (cmd === 0x00) frr = 0x285e0a60;
        else if (cmd === 0x01 || cmd === 0x03 || cmd === 0x05 || cmd === 0x07) this.programPage(bank + page * 256, cmd === 0x03 || cmd === 0x07);
        else if (cmd === 0x0d) frr = 0x2; // GPNVM1: boot from flash
      });
    }

    bus.add(new Periph('CHIPID', 0x400e0940, 0x20)).init(0x00, 0x285e0a60);
    bus.add(new Periph('SMC', 0x400e0000, 0x200));
    bus.add(new Periph('MATRIX', 0x400e0400, 0x200));
    bus.add(new Periph('RSTC', 0x400e1a00, 0x10)).init(0x04, 0x00010000);
    bus.add(new Periph('SUPC', 0x400e1a10, 0x20)).reg(0x14, () => 0x80); // SR.OSCSEL
    bus.add(new Periph('RTT', 0x400e1a30, 0x10));
    bus.add(new Periph('WDT', 0x400e1a50, 0x10));
    bus.add(new Periph('RTC', 0x400e1a60, 0x30));
    bus.add(new Periph('GPBR', 0x400e1a90, 0x20));
    bus.add(new Periph('DMAC', 0x400c4000, 0x400));
    bus.add(new Periph('CAN0', 0x400b4000, 0x400));
    bus.add(new Periph('CAN1', 0x400b8000, 0x400));
    bus.add(new Periph('EMAC', 0x400b0000, 0x400));
    bus.add(new Periph('HSMCI', 0x40000000, 0x400));
    bus.add(new Periph('SSC', 0x40004000, 0x400));
    bus.add(new Periph('SPI1', 0x4000c000, 0x400));
    bus.add(new Periph('UOTGHS', 0x400ac000, 0x4000)).reg(0x804, () => 0x4000 | 0x800); // CLKUSABLE, VBUS
    const trng = bus.add(new Periph('TRNG', 0x400bc000, 0x100));
    trng.reg(0x1c, () => 1).reg(0x50, () => (Math.random() * 0x100000000) >>> 0);

    // PIO controllers.
    for (let port = 0; port < 4; port++) this.pios.push(new Pio(this, port, 0x400e0e00 + port * 0x200, IRQ.PIOA + port));
    this.pads.onChange = (pin, high) => this.pios[pin >> 5]?.inputChanged(pin & 31, high);

    // Serial ports. Serial is the UART on PA8/PA9; Serial1-3 are USART0, 1, 3.
    const serial = (name: string, base: number, irq: number, rx: string, tx: string, fn: 'a' | 'b') => {
      const s = new Usart(this, name, base, irq, pad(rx), pad(tx));
      this.drives(tx, fn, () => s.txIdle());
      this.serials.push(s);
      return s;
    };
    serial('Serial', 0x400e0800, IRQ.UART, 'PA8', 'PA9', 'a');
    serial('Serial1', 0x40098000, IRQ.USART0, 'PA10', 'PA11', 'a');
    serial('Serial2', 0x4009c000, IRQ.USART1, 'PA12', 'PA13', 'a');
    new Usart(this, 'USART2', 0x400a0000, IRQ.USART2, -1, -1);
    serial('Serial3', 0x400a4000, IRQ.USART3, 'PD5', 'PD4', 'b');

    // Timer counters: three blocks of three channels.
    const tioPads: Record<number, [string | null, 'a' | 'b', string | null, 'a' | 'b']> = {
      0: ['PB25', 'b', 'PB27', 'b'],
      1: ['PA2', 'a', 'PA3', 'a'],
      2: [null, 'a', 'PA6', 'a'],
      6: ['PC25', 'b', 'PC26', 'b'],
      7: ['PC28', 'b', 'PC29', 'b'],
      8: ['PD7', 'b', 'PD8', 'b'],
    };
    for (let block = 0; block < 3; block++) {
      const p = bus.add(new Periph(`TC${block}`, 0x40080000 + block * 0x4000, 0x100));
      for (let ch = 0; ch < 3; ch++) {
        const id = block * 3 + ch;
        const pins = tioPads[id];
        const channel = new TcChannel(this, p, ch * 0x40, IRQ.TC0 + id, () => {
          if (pins) this.refreshPads([pins[0], pins[2]].filter((x): x is string => !!x));
        });
        if (pins?.[0]) this.drives(pins[0], pins[1], () => (channel.tioa ? 1 : 0));
        if (pins?.[2]) this.drives(pins[2], pins[3], () => (channel.tiob ? 1 : 0));
      }
    }

    // PWM: PWML4-7 on PC21-PC24 (function B) are the Due's analogWrite pins 9-6.
    const pwm = new PwmController(this, bus.add(new Periph('PWM', 0x40094000, 0x400)), (ch) => {
      const name = { 4: 'PC21', 5: 'PC22', 6: 'PC23', 7: 'PC24' }[ch];
      if (name) this.refreshPad(pad(name));
    });
    for (const [ch, name] of [[4, 'PC21'], [5, 'PC22'], [6, 'PC23'], [7, 'PC24']] as const) {
      this.drives(name, 'b', () => (pwm.lowOutput(ch) ? 1 : 0));
    }

    this.buildAdc();
    this.buildDac();
    this.buildTwi('TWI0', 0x4008c000, IRQ.TWI0, ['PA17', 'PA18'], false);
    this.buildTwi('TWI1', 0x40090000, IRQ.TWI1, ['PB12', 'PB13'], true);
    this.buildSpi();
    void core;
  }

  /** Commits the latch to one 256-byte page. Without erase, programming can only clear bits. */
  private programPage(address: number, erase: boolean): void {
    const offset = address - SAM3X_FLASH_BASE;
    if (offset < 0 || offset + 256 > this.flash.length) return;
    for (let i = 0; i < 256; i++) {
      const at = address + i;
      const latched = this.latch.get(at);
      const old = erase ? 0xff : this.flash[offset + i];
      this.flash[offset + i] = latched === undefined ? old : old & latched;
    }
    for (let i = 0; i < 256; i++) this.latch.delete(address + i);
  }

  private buildAdc(): void {
    const adc = this.bus.add(new Periph('ADC', 0x400c0000, 0x100));
    let chsr = 0;
    let isr = 0;
    let imr = 0;
    let lcdr = 0;
    const cdr = new Uint16Array(16);
    const irq = () => this.core.setIrqLevel(IRQ.ADC, (isr & imr) !== 0);
    adc.reg(0x00, undefined, (v) => {
      if (v & 1) {
        // SWRST
        chsr = 0;
        isr = 0;
        imr = 0;
      }
      if (v & 2) {
        // START: convert every enabled channel, lowest first.
        for (let ch = 0; ch < 16; ch++) {
          if (!(chsr & (1 << ch))) continue;
          const v12 = Math.round((Math.max(0, Math.min(3.3, this.adcVolts[ch])) / 3.3) * 4095);
          cdr[ch] = v12;
          // The channel number rides along in LCDR only with EMR.TAG set.
          lcdr = adc.peek(0x40) & (1 << 24) ? v12 | (ch << 12) : v12;
          isr |= 1 << ch;
          isr |= 1 << 24; // DRDY
        }
        irq();
      }
    });
    adc.reg(0x10, undefined, (v) => (chsr |= v));
    adc.reg(0x14, undefined, (v) => (chsr &= ~v));
    adc.reg(0x18, () => chsr);
    adc.reg(0x20, () => {
      isr &= ~(1 << 24);
      irq();
      return lcdr;
    });
    adc.reg(0x24, undefined, (v) => {
      imr |= v;
      irq();
    });
    adc.reg(0x28, undefined, (v) => {
      imr &= ~v;
      irq();
    });
    adc.reg(0x2c, () => imr);
    adc.reg(0x30, () => isr);
    for (let ch = 0; ch < 16; ch++) {
      adc.reg(0x50 + ch * 4, () => {
        isr &= ~(1 << ch);
        irq();
        return cdr[ch];
      });
    }
  }

  /** DACC conversion data, by channel, as the 12-bit value written. */
  readonly dacValue = new Uint16Array(2);

  private buildDac(): void {
    const dac = this.bus.add(new Periph('DACC', 0x400c8000, 0x100));
    let chsr = 0;
    dac.reg(0x10, undefined, (v) => (chsr |= v & 3));
    dac.reg(0x14, undefined, (v) => (chsr &= ~v));
    dac.reg(0x18, () => chsr);
    dac.reg(0x20, undefined, (v) => {
      const mr = dac.peek(0x04);
      const ch = (mr >>> 16) & 1; // USER_SEL
      this.dacValue[ch] = v & 0xfff;
    });
    dac.reg(0x30, () => 0x3); // TXRDY, EOC
  }

  private buildTwi(name: string, base: number, irqLine: number, padNames: string[], toCanvas: boolean): void {
    // Only Wire's bus reaches the canvas; Wire1 runs against an empty bus.
    const i2c = () => (toCanvas ? this.i2c : null);
    const twi = this.bus.add(new Periph(name, base, 0x100));
    let sr = 0x0009; // TXCOMP | SVREAD? (idle: TXCOMP set)
    sr = 0x1; // TXCOMP
    let imr = 0;
    let active = false;
    let reading = false;
    let stopRequested = false;
    let rhr = 0;
    let readPending = false;
    const irq = () => this.core.setIrqLevel(irqLine, (sr & imr) !== 0);
    const address = () => (twi.peek(0x04) >>> 16) & 0x7f;
    const finish = () => {
      i2c()?.stop();
      active = false;
      reading = false;
      stopRequested = false;
      sr |= 0x1; // TXCOMP
    };
    const beginRead = () => {
      i2c()?.start(active);
      active = true;
      reading = true;
      stopRequested = false;
      const ok = i2c() ? i2c()!.connect(address(), false) : false;
      sr &= ~0x107;
      if (!ok) {
        sr |= 0x100 | 0x1; // NACK, TXCOMP
        i2c()?.stop();
        active = false;
        reading = false;
      } else {
        readPending = true;
      }
    };
    const pullByte = () => {
      // The next byte is clocked in when firmware looks for it, so a STOP
      // requested before then is honoured with a NACK on this byte.
      if (!readPending || !reading) return;
      readPending = false;
      rhr = i2c() ? i2c()!.readByte(!stopRequested) : 0xff;
      sr |= 0x2; // RXRDY
      if (stopRequested) finish();
    };
    twi.reg(0x00, undefined, (v) => {
      if (v & 0x80) {
        // SWRST
        sr = 0x1;
        active = false;
      }
      const read = (twi.peek(0x04) & 0x1000) !== 0; // MMR.MREAD
      if (v & 0x1) {
        // START
        if (read) beginRead();
      }
      if (v & 0x2) {
        // STOP
        if (reading) {
          stopRequested = true;
          if (!readPending && !(sr & 0x2)) readPending = true;
        } else if (active) finish();
      }
      irq();
    });
    twi.reg(0x20, () => {
      pullByte();
      const v = sr;
      sr &= ~0x100; // NACK clears on read
      return v;
    });
    twi.reg(0x24, undefined, (v) => {
      imr |= v;
      irq();
    });
    twi.reg(0x28, undefined, (v) => {
      imr &= ~v;
      irq();
    });
    twi.reg(0x2c, () => imr);
    twi.reg(0x30, () => {
      sr &= ~0x2;
      if (reading && !stopRequested) readPending = true;
      return rhr;
    });
    twi.reg(0x34, undefined, (v) => {
      // THR: in master write mode the first byte starts the transfer.
      sr &= ~0x105;
      if (!active) {
        i2c()?.start(false);
        active = true;
        reading = false;
        const ok = i2c() ? i2c()!.connect(address(), true) : false;
        if (!ok) {
          sr |= 0x100 | 0x1 | 0x4; // NACK, TXCOMP, TXRDY
          i2c()?.stop();
          active = false;
          irq();
          return;
        }
      }
      const ack = i2c() ? i2c()!.writeByte(v & 0xff) : false;
      sr |= 0x4; // TXRDY
      if (!ack) sr |= 0x100;
      irq();
    });
    void padNames;
  }

  private buildSpi(): void {
    const spi = this.bus.add(new Periph('SPI0', 0x40008000, 0x100));
    let rdr = 0;
    let sr = 0x202 | 0x10000; // TDRE, TXEMPTY, (SPIENS when enabled)
    spi.reg(0x00, undefined, (v) => {
      if (v & 1) sr |= 0x10000;
      if (v & 2) sr &= ~0x10000;
    });
    spi.reg(0x08, () => {
      sr &= ~1;
      return rdr;
    });
    spi.reg(0x0c, undefined, (v) => {
      const mr = spi.peek(0x04);
      // Fixed peripheral select from MR, or variable from TDR.PCS.
      const pcs = mr & 0x2 ? (v >>> 16) & 0xf : (mr >>> 16) & 0xf;
      const cs = pcs & 1 ? (pcs & 2 ? (pcs & 4 ? 3 : 2) : 1) : 0;
      const csr = spi.peek(0x30 + cs * 4);
      const cpol = csr & 1;
      const ncpha = (csr >>> 1) & 1;
      const mode = ((cpol << 1) | (ncpha ? 0 : 1)) as 0 | 1 | 2 | 3;
      rdr = (this.spiTransfer ? this.spiTransfer(v & 0xff, mode) : 0xff) & 0xff;
      sr |= 0x1 | 0x2 | 0x200;
    });
    spi.reg(0x10, () => sr);
  }
}

/** One PIO controller: 32 pads of one port. */
class Pio {
  psr = 0xffffffff;
  osr = 0;
  odsr = 0;
  mdsr = 0;
  pusr = 0; // 0 = pull-up enabled, as at reset
  absr = 0;
  owsr = 0;
  imr = 0;
  isr = 0;
  aimmr = 0;
  elsr = 0;
  frlhsr = 0;
  private readonly periph: Periph;

  constructor(
    private readonly chip: Sam3x,
    private readonly port: number,
    base: number,
    private readonly irqLine: number,
  ) {
    const p = (this.periph = chip.bus.add(new Periph(`PIO${String.fromCharCode(65 + port)}`, base, 0x200)));
    const changed = (mask: number) => {
      for (let bit = 0; bit < 32; bit++) if (mask & (1 << bit)) chip.refreshPad(port * 32 + bit);
    };
    const setReg = (offset: number, apply: (v: number) => void) => p.reg(offset, undefined, (v) => {
      apply(v);
      changed(v);
    });
    setReg(0x00, (v) => (this.psr |= v));
    setReg(0x04, (v) => (this.psr &= ~v));
    p.reg(0x08, () => this.psr);
    setReg(0x10, (v) => (this.osr |= v));
    setReg(0x14, (v) => (this.osr &= ~v));
    p.reg(0x18, () => this.osr);
    setReg(0x30, (v) => (this.odsr |= v));
    setReg(0x34, (v) => (this.odsr &= ~v));
    p.reg(0x38, () => this.odsr, (v) => {
      const mask = this.owsr;
      const before = this.odsr;
      this.odsr = ((this.odsr & ~mask) | (v & mask)) >>> 0;
      changed(before ^ this.odsr);
    });
    p.reg(0x3c, () => {
      let v = 0;
      for (let bit = 0; bit < 32; bit++) if (chip.pads.level(port * 32 + bit)) v |= 1 << bit;
      return v >>> 0;
    });
    p.reg(0x40, undefined, (v) => {
      this.imr |= v;
      this.updateIrq();
    });
    p.reg(0x44, undefined, (v) => {
      this.imr &= ~v;
      this.updateIrq();
    });
    p.reg(0x48, () => this.imr);
    p.reg(0x4c, () => {
      const v = this.isr;
      this.isr = this.levelPending();
      this.updateIrq();
      return v >>> 0;
    });
    setReg(0x50, (v) => (this.mdsr |= v));
    setReg(0x54, (v) => (this.mdsr &= ~v));
    p.reg(0x58, () => this.mdsr);
    setReg(0x60, (v) => (this.pusr |= v)); // PUDR: disable
    setReg(0x64, (v) => (this.pusr &= ~v)); // PUER: enable
    p.reg(0x68, () => this.pusr);
    p.reg(0x70, () => this.absr, (v, prev) => {
      this.absr = v;
      changed(v ^ prev);
    });
    p.reg(0xa0, undefined, (v) => (this.owsr |= v));
    p.reg(0xa4, undefined, (v) => (this.owsr &= ~v));
    p.reg(0xa8, () => this.owsr);
    p.reg(0xb0, undefined, (v) => (this.aimmr |= v));
    p.reg(0xb4, undefined, (v) => (this.aimmr &= ~v));
    p.reg(0xb8, () => this.aimmr);
    p.reg(0xc0, undefined, (v) => (this.elsr &= ~v)); // ESR: edge
    p.reg(0xc4, undefined, (v) => {
      this.elsr |= v; // LSR: level
      this.isr |= this.levelPending();
      this.updateIrq();
    });
    p.reg(0xc8, () => this.elsr);
    p.reg(0xd0, undefined, (v) => (this.frlhsr &= ~v)); // FELLSR: falling/low
    p.reg(0xd4, undefined, (v) => (this.frlhsr |= v)); // REHLSR: rising/high
    p.reg(0xd8, () => this.frlhsr);
  }

  /** Level-mode inputs currently at their active level. */
  private levelPending(): number {
    let v = 0;
    const level = this.aimmr & this.elsr;
    if (!level) return 0;
    for (let bit = 0; bit < 32; bit++) {
      if (!(level & (1 << bit))) continue;
      const high = this.chip.pads.level(this.port * 32 + bit);
      if (high === ((this.frlhsr & (1 << bit)) !== 0)) v |= 1 << bit;
    }
    return v >>> 0;
  }

  inputChanged(bit: number, high: boolean): void {
    const mask = 1 << bit;
    if (this.aimmr & mask) {
      if (this.elsr & mask) {
        if (high === ((this.frlhsr & mask) !== 0)) this.isr |= mask;
      } else if (high === ((this.frlhsr & mask) !== 0)) this.isr |= mask;
    } else {
      this.isr |= mask; // any edge
    }
    this.updateIrq();
  }

  private updateIrq(): void {
    this.chip.core.setIrqLevel(this.irqLine, (this.isr & this.imr) !== 0);
  }
}

/** UART and USART share this layout up to BRGR. */
class Usart implements Sam3xSerial {
  onTransmit: ((byte: number) => void) | null = null;
  private sr = 0x0202; // TXRDY TXEMPTY
  private imr = 0;
  private rxEnabled = false;
  private txEnabled = false;
  private rhr = 0;
  private readonly rxQueue: number[] = [];
  private rxScheduled = false;
  private readonly p: Periph;

  constructor(
    private readonly chip: Sam3x,
    readonly name: string,
    base: number,
    private readonly irqLine: number,
    readonly rxPad: number,
    readonly txPad: number,
  ) {
    const p = (this.p = chip.bus.add(new Periph(name, base, name === 'Serial' ? 0x140 : 0x100)));
    p.reg(0x00, undefined, (v) => {
      if (v & 0x4) this.rxEnabled = false; // RSTRX
      if (v & 0x8) this.txEnabled = false; // RSTTX
      if (v & 0x10) this.rxEnabled = true;
      if (v & 0x20) this.rxEnabled = false;
      if (v & 0x40) this.txEnabled = true;
      if (v & 0x80) this.txEnabled = false;
      if (v & 0x100) this.sr &= ~0xe0; // RSTSTA
      if (this.rxEnabled) this.pumpRx();
      if (txPad >= 0) chip.refreshPad(txPad);
    });
    p.reg(0x08, undefined, (v) => {
      this.imr |= v;
      this.irq();
    });
    p.reg(0x0c, undefined, (v) => {
      this.imr &= ~v;
      this.irq();
    });
    p.reg(0x10, () => this.imr);
    p.reg(0x14, () => this.sr);
    p.reg(0x18, () => {
      this.sr &= ~0x1;
      this.irq();
      this.pumpRx();
      return this.rhr;
    });
    p.reg(0x1c, undefined, (v) => this.transmit(v & 0xff));
  }

  baud(): number | undefined {
    const cd = this.p.peek(0x20) & 0xffff;
    return cd ? Math.round(SAM3X_HZ / (16 * cd)) : undefined;
  }

  /** CPU cycles one character takes on the wire. */
  private charCycles(): number {
    const b = this.baud() ?? 115200;
    return Math.max(16, Math.round((SAM3X_HZ * 10) / b));
  }

  txIdle(): number {
    return 1;
  }

  private transmit(byte: number): void {
    if (!this.txEnabled) return;
    this.sr &= ~0x202;
    this.irq();
    this.onTransmit?.(byte);
    this.chip.events.schedule(this.charCycles(), () => {
      this.sr |= 0x202;
      this.irq();
    });
  }

  receive(byte: number): void {
    this.rxQueue.push(byte & 0xff);
    this.pumpRx();
  }

  private pumpRx(): void {
    if (!this.rxEnabled || this.rxScheduled || this.rxQueue.length === 0 || this.sr & 0x1) return;
    this.rxScheduled = true;
    this.chip.events.schedule(this.charCycles(), () => {
      this.rxScheduled = false;
      if (!this.rxEnabled) return;
      if (this.sr & 0x1) {
        this.pumpRx();
        return;
      }
      this.rhr = this.rxQueue.shift()!;
      this.sr |= 0x1;
      this.irq();
    });
  }

  private irq(): void {
    this.chip.core.setIrqLevel(this.irqLine, (this.sr & this.imr) !== 0);
  }
}

/** One timer-counter channel, in waveform mode. */
class TcChannel {
  tioa = false;
  tiob = false;
  private sr = 0;
  private imr = 0;
  private running = false;
  /** Counter value at `anchor` cycles. */
  private anchorValue = 0;
  private anchorCycle = 0;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly chip: Sam3x,
    private readonly p: Periph,
    private readonly at: number,
    private readonly irqLine: number,
    private readonly outputsChanged: () => void,
  ) {
    p.reg(at + 0x00, undefined, (v) => {
      if (v & 0x2) this.stop(); // CLKDIS
      if (v & 0x1) this.sr |= 0x10000; // CLKEN
      if (v & 0x4 && this.sr & 0x10000) this.start(); // SWTRG
    });
    p.reg(at + 0x10, () => this.value());
    p.reg(at + 0x20, () => {
      const v = this.sr | (this.tioa ? 0x20000 : 0) | (this.tiob ? 0x40000 : 0) | (this.running ? 0x10000 : 0);
      this.sr &= ~0xff;
      this.irq();
      return v;
    });
    p.reg(at + 0x24, undefined, (v) => {
      this.imr |= v;
      this.irq();
    });
    p.reg(at + 0x28, undefined, (v) => {
      this.imr &= ~v;
      this.irq();
    });
    p.reg(at + 0x2c, () => this.imr);
    for (const off of [0x14, 0x18, 0x1c]) p.reg(at + off, undefined, () => this.reschedule());
    p.reg(at + 0x04, undefined, () => this.reschedule());
  }

  private get cmr(): number {
    return this.p.peek(this.at + 0x04);
  }

  /** CPU cycles per counter tick, from TCCLKS. */
  private divisor(): number {
    switch (this.cmr & 7) {
      case 0:
        return 2;
      case 1:
        return 8;
      case 2:
        return 32;
      case 3:
        return 128;
      case 4:
        return SAM3X_HZ / 32768;
      default:
        return 2;
    }
  }

  private value(): number {
    if (!this.running) return this.anchorValue >>> 0;
    return (this.anchorValue + Math.floor((this.chip.core.cycles - this.anchorCycle) / this.divisor())) >>> 0;
  }

  private start(): void {
    this.running = true;
    this.anchorValue = 0;
    this.anchorCycle = this.chip.core.cycles;
    // A software trigger in waveform mode also applies the trigger action; the
    // Arduino setups leave it at none.
    this.reschedule();
  }

  private stop(): void {
    this.anchorValue = this.value();
    this.running = false;
    this.cancel?.();
    this.cancel = null;
  }

  private reschedule(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.running) return;
    const wave = (this.cmr & 0x8000) !== 0;
    if (!wave) return;
    const now = this.value();
    const ra = this.p.peek(this.at + 0x14);
    const rb = this.p.peek(this.at + 0x18);
    const rc = this.p.peek(this.at + 0x1c);
    // Up to RC, then reset. With RC at zero the reset only comes when the
    // counter wraps, so it runs free — which is how Servo uses it.
    const upRc = ((this.cmr >>> 13) & 3) === 2 && rc !== 0;
    const top = upRc ? rc : 0xffffffff;
    const targets = [ra, rb, rc, top].filter((t) => t > now && t <= top);
    const next = targets.length ? Math.min(...targets) : top;
    const cycles = (next - now) * this.divisor();
    this.cancel = this.chip.events.schedule(cycles, () => this.reached(next));
  }

  private action(code: number, current: boolean): boolean {
    switch (code) {
      case 1:
        return true;
      case 2:
        return false;
      case 3:
        return !current;
      default:
        return current;
    }
  }

  private reached(value: number): void {
    const cmr = this.cmr;
    const ra = this.p.peek(this.at + 0x14);
    const rb = this.p.peek(this.at + 0x18);
    const rc = this.p.peek(this.at + 0x1c);
    const upRc = ((cmr >>> 13) & 3) === 2 && rc !== 0;
    const before = [this.tioa, this.tiob];
    if (value === ra) {
      this.sr |= 0x4;
      this.tioa = this.action((cmr >>> 16) & 3, this.tioa);
    }
    if (value === rb) {
      this.sr |= 0x8;
      this.tiob = this.action((cmr >>> 24) & 3, this.tiob);
    }
    if (value === rc) {
      this.sr |= 0x10;
      this.tioa = this.action((cmr >>> 18) & 3, this.tioa);
      this.tiob = this.action((cmr >>> 26) & 3, this.tiob);
    }
    this.anchorValue = value;
    this.anchorCycle = this.chip.core.cycles;
    if ((upRc && value === rc) || value === 0xffffffff) {
      if (value === 0xffffffff) this.sr |= 0x1; // COVFS
      this.anchorValue = 0;
      // A compare at zero happens at the reset itself.
      if (ra === 0) {
        this.sr |= 0x4;
        this.tioa = this.action((cmr >>> 16) & 3, this.tioa);
      }
      if (rb === 0) {
        this.sr |= 0x8;
        this.tiob = this.action((cmr >>> 24) & 3, this.tiob);
      }
    }
    if (before[0] !== this.tioa || before[1] !== this.tiob) this.outputsChanged();
    this.irq();
    this.reschedule();
  }

  private irq(): void {
    this.chip.core.setIrqLevel(this.irqLine, (this.sr & this.imr & 0xff) !== 0);
  }
}

/** The PWM controller: eight channels, PWMLx outputs as the Due uses them. */
class PwmController {
  private enabled = 0;
  private readonly high = new Uint8Array(8);
  private readonly cancels: ((() => void) | null)[] = new Array(8).fill(null);

  constructor(
    private readonly chip: Sam3x,
    private readonly p: Periph,
    private readonly outputChanged: (ch: number) => void,
  ) {
    p.reg(0x04, undefined, (v) => {
      for (let ch = 0; ch < 8; ch++) if (v & (1 << ch) && !(this.enabled & (1 << ch))) this.startChannel(ch);
      this.enabled |= v & 0xff;
    });
    p.reg(0x08, undefined, (v) => {
      for (let ch = 0; ch < 8; ch++) {
        if (v & (1 << ch)) {
          this.cancels[ch]?.();
          this.cancels[ch] = null;
          this.setOutput(ch, false);
        }
      }
      this.enabled &= ~v;
    });
    p.reg(0x0c, () => this.enabled);
  }

  /** PWMLx is the complement of the channel waveform: high for the duty part of each period. */
  lowOutput(ch: number): boolean {
    return this.high[ch] === 1;
  }

  private chanReg(ch: number, off: number): number {
    return this.p.peek(0x200 + ch * 0x20 + off);
  }

  private clockDivisor(ch: number): number {
    const cpre = this.chanReg(ch, 0x00) & 0xf;
    const clk = this.p.peek(0x00);
    if (cpre <= 10) return 2 ** cpre;
    const shift = cpre === 11 ? 0 : 16;
    const div = (clk >>> shift) & 0xff;
    const pre = (clk >>> (shift + 8)) & 0xf;
    return Math.max(1, div) * 2 ** pre;
  }

  private setOutput(ch: number, high: boolean): void {
    if (this.high[ch] === (high ? 1 : 0)) return;
    this.high[ch] = high ? 1 : 0;
    this.outputChanged(ch);
  }

  private startChannel(ch: number): void {
    this.period(ch);
  }

  private period(ch: number): void {
    // Buffered updates take effect at the period boundary.
    const base = 0x200 + ch * 0x20;
    const updDuty = this.p.peek(base + 0x08);
    if (updDuty) {
      this.p.poke(base + 0x04, updDuty);
      this.p.poke(base + 0x08, 0);
    }
    const updPeriod = this.p.peek(base + 0x10);
    if (updPeriod) {
      this.p.poke(base + 0x0c, updPeriod);
      this.p.poke(base + 0x10, 0);
    }
    const cprd = this.chanReg(ch, 0x0c) & 0xffffff;
    const cdty = Math.min(cprd, this.chanReg(ch, 0x04) & 0xffffff);
    const div = this.clockDivisor(ch);
    const periodCycles = Math.max(2, cprd * div);
    if (cprd === 0) return;
    if (cdty === 0) this.setOutput(ch, false);
    else {
      this.setOutput(ch, true);
      if (cdty < cprd) this.chip.events.schedule(cdty * div, () => this.setOutput(ch, false));
    }
    this.cancels[ch] = this.chip.events.schedule(periodCycles, () => {
      if (this.enabled & (1 << ch)) this.period(ch);
    });
  }
}
