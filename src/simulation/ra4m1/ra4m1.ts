// The Renesas RA4M1 (R7FA4M1AB), the Arduino Uno R4 Minima's chip, on the
// ARMv7-M core.
//
// Modelled from the RA4M1 hardware manual and the device header the Arduino
// Renesas core is compiled against, at the level that core and Renesas' FSP
// drivers (which the core uses, unmodified) drive the chip:
//
//   * SYSTEM: clock-source and operating-mode stabilisation flags and the
//     register protection. The CPU is taken to run at 48 MHz (HOCO), with
//     PCLKB at 24 MHz, as the Minima's configuration sets them.
//   * ICU: every peripheral interrupt reaches the NVIC through an IELSR
//     register that links an event number to an NVIC line, with its IR flag;
//     and the IRQ0-15 pin interrupts behind attachInterrupt.
//   * PORT and PFS: direction, output, input, pull-ups, open drain and the
//     peripheral selection of every pad.
//   * AGT0/1: the 16-bit down-counters; millis() runs on AGT0's underflow.
//   * SCI0-9 in asynchronous mode: Serial1 is SCI2 on D0/D1.
//   * GPT0-7: saw-wave PWM with buffered compare registers, as analogWrite,
//     tone and Servo use them.
//   * ADC140: single scans, 12 or 14 bits against 5 V (the Minima's AVCC).
//   * IIC0/1 as masters (Wire is IIC1 on A4/A5), SPI0/1 as masters.
//   * DAC12: the A0 output's conversion register.
//
// Registers the RA family wraps narrower aliases into (PORT's PCNTRn, PFS)
// put the high half of the word at the lower address; that layout is kept.

import { CortexM } from '../armv7m/cortexM';
import type { MemoryRegion } from '../armv7m/bus';
import type { ArmMcu, I2cMasterHooks, McuSerial } from '../armv7m/armRunner';
import { EventQueue, Pads, Periph, PeriphBus, NOT_DRIVEN } from '../armv7m/peripherals';
import { RaUsbFs } from './usbfs';

export const RA4M1_HZ = 48_000_000;
const PCLKB_HZ = 24_000_000;
/** PCLKA, which clocks the SCI and SPI. */
const PCLKA_HZ = 48_000_000;
/** PCLKD, which clocks the GPT. */
const PCLKD_HZ = 48_000_000;
export const RA4M1_FLASH_BYTES = 256 * 1024;
/** The Arduino bootloader occupies the first 16 KB; sketches are linked above it. */
export const RA4M1_APP_BASE = 0x4000;
const SRAM_BASE = 0x20000000;
const SRAM_BYTES = 32 * 1024;
const DATA_FLASH_BASE = 0x40100000;
const DATA_FLASH_BYTES = 8 * 1024;
export const RA4M1_PAD_COUNT = 160;

/** P111 is 1 * 16 + 11 = 27: port * 16 + pin. */
export function ra4m1PadIndex(pad: string): number | undefined {
  const m = /^P(\d)(\d\d)$/.exec(pad);
  if (!m) return undefined;
  const pin = Number(m[2]);
  if (pin > 15) return undefined;
  return Number(m[1]) * 16 + pin;
}
const pad = (name: string) => ra4m1PadIndex(name)!;

/** ADC channel behind each pad (AN000-AN022), from the core's pinmux table. */
const ADC_TABLE = 'P103:19 P102:20 P101:21 P100:22 P500:16 P501:17 P502:18 P015:10 P014:9 P013:8 P012:7 P011:6 P010:5 P004:4 P003:3 P002:2 P001:1 P000:0';
export const RA4M1_ADC_BY_PAD: Record<number, number> = Object.fromEntries(
  ADC_TABLE.split(' ').map((e) => {
    const [p, ch] = e.split(':');
    return [pad(p), Number(ch)];
  }),
);

/** External interrupt channel (IRQn) behind each pad. */
const IRQ_TABLE =
  'P400:0 P401:5 P402:4 P213:2 P212:3 P411:4 P410:5 P409:6 P408:7 P206:0 P205:1 P200:0 P304:9 P302:5 P301:6 P110:3 ' +
  'P111:4 P105:0 P104:1 P101:1 P100:2 P501:11 P502:12 P015:7 P011:15 P004:3 P002:2 P001:7 P000:6';
const IRQ_BY_PAD = new Map<number, number>(
  IRQ_TABLE.split(' ').map((e) => {
    const [p, ch] = e.split(':');
    return [pad(p), Number(ch)];
  }),
);

/** Peripheral functions by pad and PSEL value, from the core's pinmux table. */
const PIN_FUNCTIONS =
  'P400:3:GPT6_A P400:7:IIC0_SCL P400:4:SCI0_SCK P400:5:SCI1_SCK P401:3:GPT6_B P401:7:IIC0_SDA P401:4:SCI0_CTS ' +
  'P401:5:SCI1_TX P402:5:SCI1_RX P213:3:GPT0_A P213:5:SCI1_TX P212:3:GPT0_B P212:5:SCI1_RX P411:3:GPT6_A ' +
  'P411:4:SCI0_TX P411:6:SPI0_MOSI P410:3:GPT6_B P410:4:SCI0_RX P410:6:SPI0_MISO P409:3:GPT5_A P409:4:SCI3_TX ' +
  'P408:3:GPT5_B P408:4:SCI3_RX P408:7:IIC0_SCL P407:4:SCI0_CTS P407:7:IIC0_SDA P206:7:IIC1_SDA P206:4:SCI4_RX ' +
  'P205:3:GPT4_A P205:7:IIC1_SCL P205:4:SCI4_TX P204:3:GPT4_B P204:7:IIC0_SCL P204:4:SCI4_SCK P204:5:SCI9_SCK ' +
  'P204:6:SPI1_SCK P304:3:GPT7_A P303:3:GPT7_B P302:3:GPT4_A P302:4:SCI2_TX P301:3:GPT4_B P301:4:SCI2_RX ' +
  'P301:5:SCI9_CTS P300:3:GPT0_A P300:6:SPI1_SSL P112:3:GPT3_B P112:5:SCI1_SCK P112:4:SCI2_TX P111:3:GPT3_A ' +
  'P111:4:SCI2_SCK P111:5:SCI9_SCK P111:6:SPI1_SCK P110:3:GPT1_B P110:4:SCI2_CTS P110:5:SCI9_RX P110:6:SPI1_MISO ' +
  'P109:3:GPT1_A P109:4:SCI1_SCK P109:5:SCI9_TX P109:6:SPI1_MOSI P108:3:GPT0_B P108:5:SCI9_CTS P107:3:GPT0_A ' +
  'P106:3:GPT0_B P105:3:GPT1_A P104:3:GPT1_B P104:4:SCI0_RX P103:3:GPT2_A P103:4:SCI0_CTS P103:6:SPI0_SSL ' +
  'P102:3:GPT2_B P102:4:SCI0_SCK P102:5:SCI2_TX P102:6:SPI0_SCK P101:3:GPT5_A P101:7:IIC1_SDA P101:4:SCI0_TX ' +
  'P101:5:SCI1_CTS P101:6:SPI0_MOSI P100:3:GPT5_B P100:7:IIC1_SCL P100:4:SCI0_RX P100:5:SCI1_SCK P100:6:SPI0_MISO ' +
  'P500:3:GPT2_A P501:3:GPT2_B P501:5:SCI1_TX P502:3:GPT3_B P502:5:SCI1_RX P015:5:SCI1_CTS P014:3:GPT0_A ' +
  'P013:3:GPT0_B P012:3:GPT1_A P012:4:SCI1_TX P011:3:GPT1_B P011:4:SCI1_RX P010:3:GPT2_B P004:5:SCI1_RX ' +
  'P003:3:GPT2_A P002:3:GPT3_B P001:3:GPT3_A P000:3:GPT4_B';

/** RA4M1 event numbers (bsp_elc.h). */
const EV = {
  ICU_IRQ0: 1, AGT0_INT: 30, AGT1_INT: 33, ADC0_SCAN_END: 41, USBFS_INT: 51,
  IIC0_RXI: 53, IIC1_RXI: 58, GPT0_CCMPA: 87, SCI0_RXI: 152, SPI0_RXI: 173, SPI1_RXI: 178,
} as const;
/** SCIn RXI events; TXI, TEI and ERI follow at +1, +2, +3. */
const SCI_RXI: Record<number, number> = { 0: 152, 1: 158, 2: 163, 9: 168 };

export class Ra4m1 implements ArmMcu {
  readonly hz = RA4M1_HZ;
  /** The Minima's analog reference is its 5 V supply. */
  readonly adcReference = 5;
  readonly flash = new Uint8Array(RA4M1_FLASH_BYTES).fill(0xff);
  readonly sram = new Uint8Array(SRAM_BYTES);
  readonly dataFlash = new Uint8Array(DATA_FLASH_BYTES).fill(0xff);
  readonly regions: MemoryRegion[];
  readonly bus = new PeriphBus();
  readonly pads = new Pads(RA4M1_PAD_COUNT);
  readonly core: CortexM;
  readonly events: EventQueue;
  readonly adcVolts = new Float64Array(32);
  readonly serials: McuSerial[] = [];
  /** Native USB: Serial on the Minima. */
  readonly usb: RaUsbFs;
  /** Events whose source is a level: an IR flag cleared while it is still high is set again. */
  private readonly levels = new Map<number, () => boolean>();
  i2c: I2cMasterHooks | null = null;
  spiTransfer: ((mosi: number, mode: 0 | 1 | 2 | 3) => number) | null = null;
  readonly dacValue = new Uint16Array(1);

  /** PmnPFS of every pad. */
  readonly pfs = new Uint32Array(RA4M1_PAD_COUNT);
  private readonly functions = new Map<number, string>();
  private readonly drivers = new Map<string, () => number>();
  private readonly ielsr = new Uint32Array(32);
  private readonly sciByChannel = new Map<number, Sci>();
  private consoleSerial: McuSerial | null = null;

  constructor() {
    this.regions = [
      { start: 0, end: RA4M1_FLASH_BYTES, bytes: this.flash, readOnly: true },
      { start: SRAM_BASE, end: SRAM_BASE + SRAM_BYTES, bytes: this.sram },
      { start: DATA_FLASH_BASE, end: DATA_FLASH_BASE + DATA_FLASH_BYTES, bytes: this.dataFlash, readOnly: true },
    ];
    this.core = new CortexM(this, { variant: 'm4', fpu: 'sp', irqCount: 32, priorityBits: 4, cpuid: 0x410fc241 });
    this.events = new EventQueue(() => this.core.cycles);
    this.usb = new RaUsbFs({
      afterUs: (us, fn) => void this.events.schedule((us * RA4M1_HZ) / 1e6, fn),
      setInterrupt: (active) => active && this.raise(EV.USBFS_INT),
    });
    this.levels.set(EV.USBFS_INT, () => this.usb.asserted);
    for (const entry of PIN_FUNCTIONS.split(' ')) {
      const [p, psel, fn] = entry.split(':');
      this.functions.set(pad(p) * 32 + Number(psel), fn);
    }
    this.buildPeripherals();
    for (let pin = 0; pin < RA4M1_PAD_COUNT; pin++) this.refreshPad(pin);
  }

  // ------------------------------------------------------------- ArmChip

  read(address: number, width: 1 | 2 | 4): number {
    return this.bus.read(address, width);
  }

  write(address: number, value: number, width: 1 | 2 | 4): void {
    this.bus.write(address, value, width);
  }

  reset(): void {
    this.core.reset(RA4M1_APP_BASE);
  }

  /** The UART on D0/D1 (Serial1). Serial itself is native USB. */
  get console(): McuSerial | null {
    return this.consoleSerial;
  }

  adcChannelForPad(p: number): number | undefined {
    return RA4M1_ADC_BY_PAD[p];
  }

  load(image: Uint8Array): void {
    if (RA4M1_APP_BASE + image.length > RA4M1_FLASH_BYTES) throw new Error("Firmware is larger than the RA4M1's flash above the bootloader.");
    this.flash.set(image, RA4M1_APP_BASE);
  }

  // ------------------------------------------------------------------ ICU

  /** A peripheral event: every NVIC line linked to it gets its IR flag set. */
  raise(event: number): void {
    for (let n = 0; n < 32; n++) {
      if ((this.ielsr[n] & 0x1ff) === event && !(this.ielsr[n] & 0x10000)) {
        this.ielsr[n] |= 0x10000;
        this.core.setIrqLevel(n, true);
      }
    }
  }

  // ------------------------------------------------------- pad plumbing

  /** The named peripheral function a pad is currently given to, if any. */
  functionOf(pin: number): string | undefined {
    const v = this.pfs[pin];
    if (!(v & 0x10000)) return undefined; // PMR: general I/O
    return this.functions.get(pin * 32 + ((v >>> 24) & 0x1f));
  }

  refreshPad(pin: number): void {
    const v = this.pfs[pin];
    let drive = NOT_DRIVEN;
    const openDrain = (v & 0x40) !== 0;
    if (v & 0x10000) {
      const fn = this.functionOf(pin);
      const source = fn ? this.drivers.get(fn) : undefined;
      if (source) {
        const level = source();
        drive = openDrain && level === 1 ? NOT_DRIVEN : level;
      }
    } else if (v & 0x8000) {
      drive = NOT_DRIVEN; // ASEL: analog
    } else if (v & 0x4) {
      const high = v & 1;
      drive = openDrain ? (high ? NOT_DRIVEN : 0) : high;
    }
    this.pads.setDrive(pin, drive);
    this.pads.setPull(pin, v & 0x10 && !(v & 0x8000) ? 1 : 0);
  }

  /** What a named function drives, on whichever pad selects it. */
  private drives(fn: string, level: () => number): void {
    this.drivers.set(fn, level);
  }

  /** Re-evaluates every pad currently given to one of these functions. */
  refreshFunction(...fns: string[]): void {
    for (let pin = 0; pin < RA4M1_PAD_COUNT; pin++) {
      const fn = this.functionOf(pin);
      if (fn && fns.includes(fn)) this.refreshPad(pin);
    }
  }

  private padsFor(fn: string): number[] {
    const out: number[] = [];
    for (let pin = 0; pin < RA4M1_PAD_COUNT; pin++) if (this.functionOf(pin) === fn) out.push(pin);
    return out;
  }

  activeI2cPads(): { sda?: number; scl?: number } | undefined {
    for (const n of [1, 0]) {
      const scl = this.padsFor(`IIC${n}_SCL`)[0];
      if (scl !== undefined) return { scl, sda: this.padsFor(`IIC${n}_SDA`)[0] };
    }
    return undefined;
  }

  activeSpiPads(): { sck?: number; mosi?: number; miso?: number } | undefined {
    for (const n of [1, 0]) {
      const sck = this.padsFor(`SPI${n}_SCK`)[0];
      if (sck !== undefined) return { sck, mosi: this.padsFor(`SPI${n}_MOSI`)[0], miso: this.padsFor(`SPI${n}_MISO`)[0] };
    }
    return undefined;
  }

  /** A pad's level changed: IRQn pin interrupts. */
  private padChanged(pin: number, high: boolean): void {
    const irq = IRQ_BY_PAD.get(pin);
    if (irq === undefined || !(this.pfs[pin] & 0x4000)) return; // ISEL
    const mode = this.irqcr[irq] & 3; // 00 falling, 01 rising, 10 both, 11 low level
    if ((mode === 0 && !high) || (mode === 1 && high) || mode === 2 || (mode === 3 && !high)) this.raise(EV.ICU_IRQ0 + irq);
  }

  private readonly irqcr = new Uint8Array(16);

  // ------------------------------------------------------- peripherals

  private buildPeripherals(): void {
    const bus = this.bus;

    // SYSTEM: oscillators are stable when asked, mode transitions finish at once.
    const sys = bus.add(new Regs('SYSTEM', 0x4001e000, 0x1000));
    sys.keep(0x26, 0x01, 1); // SCKSCR: MOCO at reset
    sys.r(0x3c, 1, () => 0x29); // OSCSF: HOCOSF MOSCSF PLLSF
    sys.r(0xa0, 1, () => sys.stored(0xa0, 1) & ~0x10); // OPCCR.OPCMTSF: transition done
    sys.r(0xaa, 1, () => sys.stored(0xaa, 1) & ~0x10); // SOPCCR.SOPCMTSF
    sys.r(0x4b1, 1, () => sys.stored(0x4b1, 1) | 0x10); // VBTSR.VBTRVLD
    sys.keep(0x410, 0x01, 1); // RSTSR0.PORF
    bus.add(new Periph('MSTP', 0x40047000, 0x20)).init(0x00, 0xffffffff).init(0x04, 0xffffffff).init(0x08, 0xffffffff);
    // FCACHE: FCACHEIV clears itself once the cache is invalidated.
    bus.add(new Regs('FCACHE', 0x4001c000, 0x200)).r(0x104, 2, () => 0);
    bus.add(new Periph('BUS', 0x40003000, 0x1000));
    bus.add(new Periph('DTC', 0x40005400, 0x100));
    bus.add(new Periph('DMAC', 0x40005000, 0x300));
    bus.add(new Periph('ELC', 0x40041000, 0x100));
    bus.add(new Periph('IWDT', 0x40044400, 0x100));
    bus.add(new Periph('WDT', 0x40044200, 0x100));
    bus.add(new Periph('RTC', 0x40044000, 0x100));
    bus.add(new Periph('CAC', 0x40044600, 0x100));
    bus.add(new Periph('DEBUG', 0x4001b000, 0x100));
    bus.add(new Periph('CTSU', 0x40081000, 0x100));
    bus.add(new Periph('CRC', 0x40074000, 0x100));
    bus.add(new Periph('DOC', 0x40054100, 0x100));
    bus.add(new Periph('KINT', 0x40080000, 0x100));
    bus.add(new Periph('OPAMP', 0x40086000, 0x100));
    bus.add(new Periph('ACMPLP', 0x40085e00, 0x100));
    bus.add(new Periph('CAN0', 0x40050000, 0x1000));
    bus.add(new Periph('POEG', 0x40042000, 0x400));
    bus.add(new Periph('SRAM', 0x40002000, 0x100));
    bus.add(new Periph('DAC8', 0x4009e000, 0x100));
    this.buildFlashController();

    // ICU: IRQCR for the pins, IELSR linking events to NVIC lines.
    const icu = bus.add(new Regs('ICU', 0x40006000, 0x400));
    for (let i = 0; i < 16; i++) icu.r(i, 1, () => this.irqcr[i], (v) => (this.irqcr[i] = v));
    for (let n = 0; n < 32; n++) {
      icu.r(0x300 + n * 4, 4, () => this.ielsr[n], (v) => {
        // IR can only be cleared by software.
        let ir = this.ielsr[n] & 0x10000 & v;
        if (!ir && this.levels.get(v & 0x1ff)?.()) ir = 0x10000;
        this.ielsr[n] = ((v & ~0x10000) | ir) >>> 0;
        this.core.setIrqLevel(n, ir !== 0);
      });
    }

    this.buildPorts();
    this.pads.onChange = (pin, high) => this.padChanged(pin, high);
    bus.add(new Periph('PMISC', 0x40040d00, 0x20));

    new Agt(this, bus.add(new Regs('AGT0', 0x40084000, 0x100)), EV.AGT0_INT);
    new Agt(this, bus.add(new Regs('AGT1', 0x40084100, 0x100)), EV.AGT1_INT);

    for (const ch of [0, 1, 2, 9]) {
      const sci = new Sci(this, ch, bus.add(new Regs(`SCI${ch}`, 0x40070000 + ch * 0x20, 0x20)), SCI_RXI[ch]);
      this.sciByChannel.set(ch, sci);
      this.drives(`SCI${ch}_TX`, () => sci.txLevel());
    }
    // Serial1 is SCI2 on D0 (P301, RX) and D1 (P302, TX).
    this.consoleSerial = this.sciByChannel.get(2)!;
    this.serials.push(this.sciByChannel.get(2)!, this.sciByChannel.get(0)!, this.sciByChannel.get(1)!, this.sciByChannel.get(9)!);

    const gpt = new GptBlock(this);
    for (let ch = 0; ch < 8; ch++) {
      const g = gpt.channel(ch, bus.add(new Periph(`GPT${ch}`, 0x40078000 + ch * 0x100, 0x100)), ch < 2 ? 32 : 16);
      this.drives(`GPT${ch}_A`, () => g.output(0));
      this.drives(`GPT${ch}_B`, () => g.output(1));
    }
    bus.add(new Periph('GPT_OPS', 0x40078ff0, 0x10));
    const usb = this.usb;
    bus.add(
      new (class extends Periph {
        override read(offset: number, width: 1 | 2 | 4): number {
          return usb.read(offset, width);
        }
        override write(offset: number, value: number, width: 1 | 2 | 4): void {
          usb.write(offset, value, width);
        }
      })('USBFS', 0x40090000, 0x1000),
    );

    this.buildAdc();
    this.buildDac();
    new Iic(this, bus.add(new Regs('IIC0', 0x40053000, 0x100)), EV.IIC0_RXI);
    new Iic(this, bus.add(new Regs('IIC1', 0x40053100, 0x100)), EV.IIC1_RXI);
    new Spi(this, bus.add(new Regs('SPI0', 0x40072000, 0x100)), EV.SPI0_RXI);
    new Spi(this, bus.add(new Regs('SPI1', 0x40072100, 0x100)), EV.SPI1_RXI);
  }

  /** PORT0-9 and PFS: the high half of each word sits at the lower address. */
  private buildPorts(): void {
    const portWord = (port: number, reg: number): number => {
      let pdr = 0;
      let podr = 0;
      let pidr = 0;
      for (let pin = 0; pin < 16; pin++) {
        const p = port * 16 + pin;
        const v = this.pfs[p];
        if (v & 0x4) pdr |= 1 << pin;
        if (v & 0x1) podr |= 1 << pin;
        if (this.pads.level(p)) pidr |= 1 << pin;
      }
      if (reg === 0) return ((podr << 16) | pdr) >>> 0; // PCNTR1
      if (reg === 1) return pidr; // PCNTR2 (EIDR not modelled)
      return 0; // PCNTR3/4 are write-only
    };
    const setPfsBits = (p: number, set: number, clear: number) => {
      const before = this.pfs[p];
      this.pfs[p] = ((before & ~clear) | set) >>> 0;
      if (before !== this.pfs[p]) this.refreshPad(p);
    };
    const portWrite = (port: number, reg: number, word: number, mask: number): void => {
      for (let pin = 0; pin < 16; pin++) {
        const p = port * 16 + pin;
        const bit = 1 << pin;
        if (reg === 0) {
          if (mask & bit) setPfsBits(p, word & bit ? 0x4 : 0, word & bit ? 0 : 0x4);
          if (mask & (bit << 16)) setPfsBits(p, (word >>> 16) & bit ? 1 : 0, (word >>> 16) & bit ? 0 : 1);
        } else if (reg === 2) {
          // PCNTR3: POSR sets (low half), PORR resets (high half).
          if (mask & bit && word & bit) setPfsBits(p, 1, 0);
          if (mask & (bit << 16) && (word >>> 16) & bit) setPfsBits(p, 0, 1);
        }
      }
    };
    this.bus.add(new SwappedPeriph('PORT', 0x40040000, 0x140, (offset) => portWord(offset >> 5, (offset & 0x1f) >> 2), (offset, word, mask) => portWrite(offset >> 5, (offset & 0x1f) >> 2, word, mask)));
    this.bus.add(
      new SwappedPeriph(
        'PFS',
        0x40040800,
        0x280,
        (offset) => {
          const p = (offset >> 6) * 16 + ((offset & 0x3f) >> 2);
          if (p >= RA4M1_PAD_COUNT) return 0;
          return ((this.pfs[p] & ~0x2) | (this.pads.level(p) ? 0x2 : 0)) >>> 0;
        },
        (offset, word, mask) => {
          const p = (offset >> 6) * 16 + ((offset & 0x3f) >> 2);
          if (p >= RA4M1_PAD_COUNT) return;
          const before = this.pfs[p];
          this.pfs[p] = ((before & ~mask) | (word & mask & ~0x2)) >>> 0;
          if (before !== this.pfs[p]) this.refreshPad(p);
        },
      ),
    );
  }

  private buildAdc(): void {
    const adc = this.bus.add(new Regs('ADC0', 0x4005c000, 0x200));
    const result = new Uint16Array(32);
    let busy = false;
    const convert = (volts: number): number => {
      const cer = adc.stored(0x0e, 2);
      const prc = (cer >>> 1) & 3; // ADCER.ADPRC: 00 12-bit, 01 10-bit, 11 14-bit
      const bits = prc === 3 ? 14 : prc === 1 ? 10 : 12;
      const full = (1 << bits) - 1;
      const v = Math.round((Math.max(0, Math.min(this.adcReference, volts)) / this.adcReference) * full);
      return cer & 0x8000 ? (v << (16 - bits)) & 0xffff : v; // ADRFMT: left aligned
    };
    adc.r(0x00, 2, () => (adc.stored(0x00, 2) & ~0x8000) | (busy ? 0x8000 : 0), (v) => {
      if (!(v & 0x8000) || busy) return; // ADCSR.ADST
      busy = true;
      this.events.schedule(48 * 3, () => {
        busy = false;
        const sel = adc.stored(0x04, 2) | (adc.stored(0x06, 2) << 16);
        for (let ch = 0; ch < 32; ch++) if (sel & (1 << ch)) result[ch] = convert(this.adcVolts[ch]);
        const exicr = adc.stored(0x12, 2);
        if (exicr & 0x100) result[30] = convert(1.05); // temperature sensor
        if (exicr & 0x200) result[31] = convert(1.43); // internal reference
        if (adc.stored(0x00, 2) & 0x1000) this.raise(EV.ADC0_SCAN_END); // ADIE
      });
    });
    for (let ch = 0; ch < 28; ch++) adc.r(0x20 + ch * 2, 2, () => result[ch]);
    adc.r(0x1a, 2, () => result[30]); // ADTSDR
    adc.r(0x1c, 2, () => result[31]); // ADOCDR
  }

  private buildDac(): void {
    const dac = this.bus.add(new Regs('DAC', 0x4005e000, 0x1100));
    dac.r(0x00, 2, undefined, (v) => (this.dacValue[0] = v & 0xfff));
  }

  /**
   * The flash controller (FACI LP), as r_flash_lp drives it: program/erase
   * mode entry through FENTRYR, then program, block erase and blank check
   * over FSAR..FEAR, each reported done by FSTATR1.FRDY (cleared again when
   * firmware clears FCR.OPST) and by the flash-ready event. The data flash is
   * addressed at 0xFE000000 for these commands; it reads at 0x40100000. The
   * EEPROM library keeps its data here, through Renesas' virtual EEPROM.
   */
  private buildFlashController(): void {
    const f = this.bus.add(new Regs('FACI', 0x407ec000, 0x4000));
    let entry = 0; // 0x80 data flash P/E, 0x01 code flash P/E
    let frdy = false;
    let bcerr = false;
    let illegal = false;
    const enter = (v: number) => {
      if ((v & 0xff00) === 0xaa00) entry = v & 0x81;
    };
    f.r(0x3fb2, 2, () => entry, enter);
    f.r(0x3fb0, 2, () => entry, enter);
    f.r(0x12c, 4, () => (frdy ? 0x40 : 0) | 0x2); // FSTATR1: FRDY, DRRDY
    const errors = () => (bcerr ? 0x8 : 0) | (illegal ? 0x10 : 0);
    f.r(0x128, 4, errors); // FSTATR00
    f.r(0x1f0, 4, errors); // FSTATR2
    const addr = (lo: number, hi: number) => ((f.stored(hi, 2) << 16) | f.stored(lo, 2)) >>> 0;
    const locate = (a: number): { area: Uint8Array; index: number } | null => {
      if (entry & 0x80 && a >= 0xfe000000 && a < 0xfe000000 + DATA_FLASH_BYTES) return { area: this.dataFlash, index: a - 0xfe000000 };
      if (entry & 0x01 && a < RA4M1_FLASH_BYTES) return { area: this.flash, index: a };
      return null;
    };
    f.r(0x114, 1, undefined, (v) => {
      if (!(v & 0x80)) {
        frdy = false; // OPST cleared: ready for the next command
        return;
      }
      const cmd = v & 0x0f;
      const start = addr(0x108, 0x110);
      const end = addr(0x118, 0x120);
      const from = locate(start);
      illegal = from === null;
      bcerr = false;
      if (from) {
        if (cmd === 0x1) {
          // Program: one byte of data flash, or eight bytes of code flash.
          const words = [f.stored(0x130, 2), f.stored(0x138, 2), f.stored(0x140, 2), f.stored(0x144, 2)];
          const n = from.area === this.dataFlash ? 1 : 8;
          for (let i = 0; i < n && from.index + i < from.area.length; i++) {
            from.area[from.index + i] &= (words[i >> 1] >>> ((i & 1) * 8)) & 0xff;
          }
        } else if (cmd === 0x4 || cmd === 0x3) {
          const to = locate(end) ?? from;
          const last = Math.min(from.area.length - 1, to.index);
          if (cmd === 0x4) for (let i = from.index; i <= last; i++) from.area[i] = 0xff;
          else for (let i = from.index; i <= last; i++) if (from.area[i] !== 0xff) bcerr = true;
        }
      }
      frdy = true;
      this.raise(24); // FCU_FRDYI
    });
  }
}

/**
 * A block of registers of their own widths — the RA's peripherals are mostly
 * byte and halfword registers at their own addresses. An access that matches a
 * register exactly calls it; any other is split into bytes, each landing on
 * the register that covers it (read-modify-write for a partial write).
 * Addresses no register claims read back what was written.
 */
class Regs extends Periph {
  private readonly defs: { offset: number; width: 1 | 2 | 4; read?: () => number; write?: (v: number) => void }[] = [];
  private readonly byOffset = new Map<number, (typeof this.defs)[number]>();
  private readonly bytes = new Map<number, number>();

  /** A register; without `read` it reads back what was written. */
  r(offset: number, width: 1 | 2 | 4, read?: () => number, write?: (v: number) => void): this {
    const def = { offset, width, read, write };
    this.defs.push(def);
    this.byOffset.set(offset * 8 + width, def);
    return this;
  }

  /** The stored value of a register (what was last written). */
  stored(offset: number, width: 1 | 2 | 4): number {
    let v = 0;
    for (let i = 0; i < width; i++) v |= (this.bytes.get(offset + i) ?? 0) << (8 * i);
    return v >>> 0;
  }

  keep(offset: number, value: number, width: 1 | 2 | 4): void {
    for (let i = 0; i < width; i++) this.bytes.set(offset + i, (value >>> (8 * i)) & 0xff);
  }

  private covering(o: number) {
    for (const d of this.defs) if (o >= d.offset && o < d.offset + d.width) return d;
    return undefined;
  }

  private readDef(d: (typeof this.defs)[number]): number {
    return d.read ? d.read() >>> 0 : this.stored(d.offset, d.width);
  }

  private writeDef(d: (typeof this.defs)[number], v: number): void {
    const mask = d.width === 4 ? 0xffffffff : (1 << (8 * d.width)) - 1;
    this.keep(d.offset, v & mask, d.width);
    d.write?.((v & mask) >>> 0);
  }

  override read(offset: number, width: 1 | 2 | 4): number {
    const exact = this.byOffset.get(offset * 8 + width);
    if (exact) return this.readDef(exact);
    let v = 0;
    for (let i = 0; i < width; i++) {
      const o = offset + i;
      const d = this.covering(o);
      const b = d ? (this.readDef(d) >>> (8 * (o - d.offset))) & 0xff : this.bytes.get(o) ?? 0;
      v |= b << (8 * i);
    }
    return v >>> 0;
  }

  override write(offset: number, value: number, width: 1 | 2 | 4): void {
    const exact = this.byOffset.get(offset * 8 + width);
    if (exact) return this.writeDef(exact, value);
    // Group the bytes by the register they land in.
    const touched = new Map<(typeof this.defs)[number], number>();
    for (let i = 0; i < width; i++) {
      const o = offset + i;
      const b = (value >>> (8 * i)) & 0xff;
      const d = this.covering(o);
      if (!d) {
        this.bytes.set(o, b);
        continue;
      }
      const base = touched.get(d) ?? this.stored(d.offset, d.width);
      const shift = 8 * (o - d.offset);
      touched.set(d, ((base & ~(0xff << shift)) | (b << shift)) >>> 0);
    }
    for (const [d, v] of touched) this.writeDef(d, v);
  }
}

/**
 * A register block whose narrower accesses take the high part of the word at
 * the lower address (the RA's PORT and PFS layout).
 */
class SwappedPeriph extends Periph {
  constructor(
    name: string,
    base: number,
    size: number,
    private readonly readWord: (offset: number) => number,
    private readonly writeWord: (offset: number, value: number, mask: number) => void,
  ) {
    super(name, base, size);
  }

  override read(offset: number, width: 1 | 2 | 4): number {
    const word = this.readWord(offset & ~3) >>> 0;
    if (width === 4) return word;
    const shift = 8 * (4 - (offset & 3) - width);
    return (word >>> shift) & (width === 1 ? 0xff : 0xffff);
  }

  override write(offset: number, value: number, width: 1 | 2 | 4): void {
    if (width === 4) return this.writeWord(offset & ~3, value >>> 0, 0xffffffff);
    const shift = 8 * (4 - (offset & 3) - width);
    const mask = ((width === 1 ? 0xff : 0xffff) << shift) >>> 0;
    this.writeWord(offset & ~3, ((value << shift) & mask) >>> 0, mask);
  }
}

/** AGT: a 16-bit down-counter that reloads on underflow. */
class Agt {
  private reload = 0xffff;
  private running = false;
  private anchorCount = 0xffff;
  private anchorCycle = 0;
  private cancel: (() => void) | null = null;
  private cr = 0;

  constructor(
    private readonly chip: Ra4m1,
    private readonly p: Regs,
    private readonly event: number,
  ) {
    // AGT: writing sets both the counter and the reload value.
    p.r(0x00, 2, () => this.count(), (v) => {
      this.reload = v & 0xffff;
      this.anchorCount = this.reload;
      this.anchorCycle = this.chip.core.cycles;
      this.reschedule();
    });
    p.r(0x08, 1, () => (this.cr & ~0x2) | (this.running ? 0x2 : 0), (v) => {
      if (v & 0x4) {
        // TSTOP: stop and reinitialise.
        this.running = false;
        this.anchorCount = this.reload;
        this.cancel?.();
        this.cancel = null;
        this.cr = 0;
        return;
      }
      // TEDGF, TUNDF, TCMAF, TCMBF are cleared by writing 0.
      this.cr = (v & 0x09) | (this.cr & v & 0xf0);
      const start = (v & 1) !== 0;
      if (start && !this.running) {
        this.running = true;
        this.anchorCycle = this.chip.core.cycles;
      } else if (!start && this.running) {
        this.anchorCount = this.count();
        this.running = false;
      }
      this.reschedule();
    });
  }

  /** CPU cycles per count, from AGTMR1.TCK and AGTMR2.CKS. */
  private cyclesPerTick(): number {
    const tck = (this.p.stored(0x09, 1) >>> 4) & 7;
    const cks = this.p.stored(0x0a, 1) & 7;
    const pclkb = RA4M1_HZ / PCLKB_HZ;
    if (tck === 1) return pclkb * 8;
    if (tck === 3) return pclkb * 2;
    if (tck === 4 || tck === 6) return (RA4M1_HZ / 32768) * 2 ** cks;
    return pclkb;
  }

  private count(): number {
    if (!this.running) return this.anchorCount;
    const ticks = Math.floor((this.chip.core.cycles - this.anchorCycle) / this.cyclesPerTick());
    if (ticks <= this.anchorCount) return this.anchorCount - ticks;
    return this.reload - ((ticks - this.anchorCount - 1) % (this.reload + 1));
  }

  private reschedule(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.running) return;
    const per = this.cyclesPerTick();
    const elapsed = this.chip.core.cycles - this.anchorCycle;
    // The underflow comes one count after zero.
    const ticksToUnderflow = (this.count() + 1) * per - (elapsed % per);
    this.cancel = this.chip.events.schedule(Math.max(1, Math.round(ticksToUnderflow)), () => {
      this.cancel = null;
      this.anchorCount = this.reload;
      this.anchorCycle = this.chip.core.cycles;
      this.cr |= 0x20; // TUNDF
      this.chip.raise(this.event);
      this.reschedule();
    });
  }
}

/** SCI in asynchronous mode. */
class Sci implements McuSerial {
  readonly name: string;
  readonly rxPad: number;
  readonly txPad: number;
  onTransmit: ((byte: number) => void) | null = null;
  private ssr = 0x84; // TDRE TEND
  private rdr = 0;
  private holding = -1;
  private shifting = false;
  private readonly rxQueue: number[] = [];
  private rxScheduled = false;
  private scr = 0;

  constructor(
    private readonly chip: Ra4m1,
    channel: number,
    private readonly p: Regs,
    private readonly rxi: number,
  ) {
    this.name = channel === 2 ? 'Serial1' : `SCI${channel}`;
    const pads: Record<number, [string, string]> = { 2: ['P301', 'P302'], 0: ['P410', 'P411'], 1: ['P402', 'P401'], 9: ['P110', 'P109'] };
    this.rxPad = pad(pads[channel][0]);
    this.txPad = pad(pads[channel][1]);
    p.r(0x02, 1, () => this.scr, (v) => {
      const before = this.scr;
      this.scr = v;
      // TXI comes only from TDR emptying into the shift register: the FSP
      // driver writes the first byte itself after setting TIE.
      if (v & 0x04 && !(before & 0x04) && this.ssr & 0x04 && !this.shifting) this.chip.raise(this.rxi + 2);
      if (v & 0x10) this.pumpRx();
      this.chip.refreshFunction(`SCI${channel}_TX`);
    });
    p.r(0x03, 1, undefined, (v) => this.transmit(v & 0xff)); // TDR
    p.r(0x04, 1, () => this.ssr, (v) => {
      this.ssr &= v | ~0x38; // ORER, FER, PER are cleared by writing 0
    });
    p.r(0x05, 1, () => {
      // RDR: reading it clears RDRF and lets the next byte in.
      this.ssr &= ~0x40;
      const v = this.rdr;
      this.pumpRx();
      return v;
    });
  }

  baud(): number | undefined {
    const brr = this.p.stored(0x01, 1);
    const cks = this.p.stored(0x00, 1) & 3;
    const semr = this.p.stored(0x07, 1);
    let divisor = 64 * 2 ** (2 * cks - 1) * (brr + 1);
    if (semr & 0x10) divisor /= 2; // ABCS
    if (semr & 0x40) divisor /= 2; // BGDM
    let b = PCLKA_HZ / divisor;
    if (semr & 0x04) {
      const mddr = this.p.stored(0x12, 1); // BRME with MDDR
      if (mddr) b = (b * mddr) / 256;
    }
    return Math.round(b);
  }

  private charCycles(): number {
    return Math.max(16, Math.round((RA4M1_HZ * 10) / (this.baud() ?? 115200)));
  }

  txLevel(): number {
    return 1;
  }

  private transmit(byte: number): void {
    if (!(this.scr & 0x20)) return; // TE
    this.ssr &= ~0x04; // TEND
    if (this.shifting) {
      this.holding = byte;
      this.ssr &= ~0x80;
    } else this.shift(byte);
  }

  private shift(byte: number): void {
    this.shifting = true;
    this.onTransmit?.(byte);
    // The byte moves to the shift register at once: TDR is empty again.
    this.ssr |= 0x80;
    if (this.scr & 0x80) this.chip.raise(this.rxi + 1); // TXI
    this.chip.events.schedule(this.charCycles(), () => {
      this.shifting = false;
      if (this.holding >= 0) {
        const next = this.holding;
        this.holding = -1;
        this.shift(next);
        return;
      }
      this.ssr |= 0x04; // TEND
      if (this.scr & 0x04) this.chip.raise(this.rxi + 2); // TEI
    });
  }

  receive(byte: number): void {
    this.rxQueue.push(byte & 0xff);
    this.pumpRx();
  }

  private pumpRx(): void {
    if (!(this.scr & 0x10) || this.rxScheduled || !this.rxQueue.length || this.ssr & 0x40) return;
    this.rxScheduled = true;
    this.chip.events.schedule(this.charCycles(), () => {
      this.rxScheduled = false;
      if (this.ssr & 0x40 || !(this.scr & 0x10)) return this.pumpRx();
      if (!this.rxQueue.length) return;
      this.rdr = this.rxQueue.shift()!;
      this.ssr |= 0x40;
      if (this.scr & 0x40) this.chip.raise(this.rxi); // RXI
    });
  }
}

/** The GPT channels and the start/stop/clear registers they share. */
class GptBlock {
  private readonly channels: GptChannel[] = [];

  constructor(private readonly chip: Ra4m1) {}

  channel(ch: number, p: Periph, bits: 16 | 32): GptChannel {
    const g = new GptChannel(this.chip, ch, p, bits, this);
    this.channels[ch] = g;
    return g;
  }

  /** GTSTR/GTSTP/GTCLR written on any channel act on every channel enabled for it. */
  broadcast(kind: 'start' | 'stop' | 'clear', mask: number): void {
    for (const g of this.channels) if (g && mask & (1 << g.ch)) g.software(kind);
  }
}

class GptChannel {
  private running = false;
  private anchorCount = 0;
  private anchorCycle = 0;
  private readonly out = [0, 0];
  private cancel: (() => void) | null = null;
  private readonly mask: number;

  constructor(
    private readonly chip: Ra4m1,
    readonly ch: number,
    private readonly p: Periph,
    bits: 16 | 32,
    block: GptBlock,
  ) {
    this.mask = bits === 32 ? 0xffffffff : 0xffff;
    p.init(0x64, this.mask); // GTPR
    p.init(0x68, this.mask); // GTPBR
    p.init(0x30, 1); // GTUDDTYC: up
    p.reg(0x04, () => (this.running ? 1 << ch : 0), (v) => block.broadcast('start', v));
    p.reg(0x08, () => (this.running ? 0 : 1 << ch), (v) => block.broadcast('stop', v));
    p.reg(0x0c, undefined, (v) => block.broadcast('clear', v));
    p.reg(0x2c, undefined, (v, prev) => {
      if (v & 1 && !(prev & 1)) this.start();
      else if (!(v & 1) && prev & 1) this.stop();
    });
    p.reg(0x34, undefined, () => this.initialOutputs()); // GTIOR
    p.reg(0x30, undefined, () => this.refresh()); // GTUDDTYC (forced duty)
    p.reg(0x3c, undefined, (v, prev) => p.poke(0x3c, prev & v)); // GTST flags: write 0 to clear
    p.reg(0x48, () => this.count(), (v) => {
      this.anchorCount = (v & this.mask) >>> 0;
      this.anchorCycle = this.chip.core.cycles;
      this.reschedule();
    });
    p.reg(0x64, undefined, () => this.reschedule());
    p.reg(0x4c, undefined, () => this.reschedule());
    p.reg(0x50, undefined, () => this.reschedule());
  }

  software(kind: 'start' | 'stop' | 'clear'): void {
    if (kind === 'start' && this.p.peek(0x10) & 0x80000000) this.start(); // GTSSR.CSTRT
    if (kind === 'stop' && this.p.peek(0x14) & 0x80000000) this.stop(); // GTPSR.CSTOP
    if (kind === 'clear' && this.p.peek(0x18) & 0x80000000) {
      this.anchorCount = 0;
      this.anchorCycle = this.chip.core.cycles;
      this.reschedule();
    }
  }

  private ticksPer(): number {
    const tpcs = (this.p.peek(0x2c) >>> 24) & 7;
    return (RA4M1_HZ / PCLKD_HZ) * 4 ** Math.min(tpcs, 5);
  }

  private count(): number {
    if (!this.running) return this.anchorCount;
    const period = (this.p.peek(0x64) & this.mask) + 1;
    const ticks = Math.floor((this.chip.core.cycles - this.anchorCycle) / this.ticksPer());
    return (this.anchorCount + ticks) % period;
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.anchorCycle = this.chip.core.cycles;
    this.p.poke(0x2c, this.p.peek(0x2c) | 1);
    this.initialOutputs();
    this.reschedule();
  }

  private stop(): void {
    if (!this.running) return;
    this.anchorCount = this.count();
    this.running = false;
    this.p.poke(0x2c, this.p.peek(0x2c) & ~1);
    this.cancel?.();
    this.cancel = null;
  }

  /** GTIOx's bit 4: the level the pin starts at. */
  private initialOutputs(): void {
    const ior = this.p.peek(0x34);
    this.out[0] = (ior >>> 4) & 1;
    this.out[1] = (ior >>> 20) & 1;
    this.refresh();
  }

  private refresh(): void {
    this.chip.refreshFunction(`GPT${this.ch}_A`, `GPT${this.ch}_B`);
  }

  /** Pin level for GTIOCnA (0) or GTIOCnB (1), or not driven when its output is disabled. */
  output(which: 0 | 1): number {
    const ior = this.p.peek(0x34);
    const enabled = which === 0 ? ior & 0x100 : ior & 0x1000000; // OAE / OBE
    if (!enabled) return NOT_DRIVEN;
    const duty = (this.p.peek(0x30) >>> (which === 0 ? 16 : 24)) & 3; // OADTY / OBDTY
    if (duty === 2) return 0;
    if (duty === 3) return 1;
    return this.out[which];
  }

  private apply(which: 0 | 1, code: number): boolean {
    const before = this.out[which];
    if (code === 1) this.out[which] = 0;
    else if (code === 2) this.out[which] = 1;
    else if (code === 3) this.out[which] ^= 1;
    return before !== this.out[which];
  }

  private reschedule(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.running) return;
    const pr = this.p.peek(0x64) & this.mask;
    const cnt = this.count();
    let next = pr + 1;
    for (const off of [0x4c, 0x50]) {
      const c = this.p.peek(off) & this.mask;
      if (c > cnt && c <= pr && c < next) next = c;
    }
    const per = this.ticksPer();
    const into = (this.chip.core.cycles - this.anchorCycle) % per;
    this.cancel = this.chip.events.schedule(Math.max(1, (next - cnt) * per - into), () => this.reached(next));
  }

  private reached(value: number): void {
    this.cancel = null;
    const ior = this.p.peek(0x34);
    let changed = false;
    const pr = this.p.peek(0x64) & this.mask;
    if (value === pr + 1) {
      // Cycle end: buffers transfer, outputs take their cycle-end level.
      const ber = this.p.peek(0x40);
      if (((ber >>> 16) & 3) !== 0) this.p.poke(0x4c, this.p.peek(0x54)); // GTCCRC -> GTCCRA
      if (((ber >>> 18) & 3) !== 0) this.p.poke(0x50, this.p.peek(0x58)); // GTCCRE -> GTCCRB
      if (((ber >>> 20) & 3) !== 0) this.p.poke(0x64, this.p.peek(0x68)); // GTPBR -> GTPR
      changed = this.apply(0, (ior >>> 2) & 3) || changed;
      changed = this.apply(1, (ior >>> 18) & 3) || changed;
      this.anchorCount = 0;
      this.anchorCycle = this.chip.core.cycles;
      this.p.poke(0x3c, this.p.peek(0x3c) | 0x40); // TCFPO
      this.chip.raise(87 + this.ch * 8 + 6); // GPTn_COUNTER_OVERFLOW
      value = 0;
    } else {
      this.anchorCount = value;
      this.anchorCycle = this.chip.core.cycles;
    }
    if (value === (this.p.peek(0x4c) & this.mask)) {
      changed = this.apply(0, ior & 3) || changed;
      this.p.poke(0x3c, this.p.peek(0x3c) | 1);
      this.chip.raise(87 + this.ch * 8); // CAPTURE_COMPARE_A
    }
    if (value === (this.p.peek(0x50) & this.mask)) {
      changed = this.apply(1, (ior >>> 16) & 3) || changed;
      this.p.poke(0x3c, this.p.peek(0x3c) | 2);
      this.chip.raise(87 + this.ch * 8 + 1); // CAPTURE_COMPARE_B
    }
    if (changed) this.refresh();
    this.reschedule();
  }
}

/**
 * RIIC as a master: START, address, data and STOP complete at once, reported
 * through ICSR2 and the RXI/TXI/TEI/EEI events the FSP driver runs on. Each
 * event fires as its flag rises with the interrupt enabled, as the hardware's
 * do, so clearing a flag never re-raises one already handled.
 */
class Iic {
  private sr2 = 0;
  private active = false;
  private reading = false;
  private addressed = false;
  private stopRequested = false;
  private rx = 0xff;
  private raised = 0;

  constructor(
    private readonly chip: Ra4m1,
    private readonly p: Regs,
    private readonly rxi: number,
  ) {
    p.r(0x00, 1, undefined, (v) => {
      // ICCR1: IICRST with ICE clear resets the bus state.
      if (v & 0x40) this.reset();
    });
    p.r(0x01, 1, () => (this.active ? 0xe0 & (this.reading ? 0xc0 : 0xe0) : 0) | (this.active ? 0x80 : 0), (v) => {
      if (v & 0x02) this.start(false); // ST
      if (v & 0x04) this.start(true); // RS
      if (v & 0x08) this.stop(); // SP
    });
    p.r(0x07, 1, undefined, () => this.events()); // ICIER
    p.r(0x09, 1, () => this.sr2, (v) => {
      this.sr2 &= v | 0xa0; // flags other than TDRE and RDRF are cleared by writing 0
      this.settle();
      this.events();
    });
    p.r(0x12, 1, undefined, (v) => this.transmit(v & 0xff)); // ICDRT
    p.r(0x13, 1, () => {
      // ICDRR: reading frees the receiver for the next byte.
      const v = this.rx;
      this.sr2 &= ~0x20;
      this.settle();
      if (this.reading && !this.stopRequested) this.receiveNext();
      this.events();
      return v;
    });
  }

  private bus(): I2cMasterHooks | null {
    return this.chip.i2c;
  }

  private reset(): void {
    this.active = false;
    this.reading = false;
    this.sr2 = 0;
    this.raised = 0;
  }

  /** CPU cycles for one byte (nine SCL clocks) at the programmed bit rate. */
  private byteCycles(): number {
    const cks = (this.p.stored(0x02, 1) >>> 4) & 7; // ICMR1.CKS
    const iicClock = PCLKB_HZ / 2 ** cks;
    const high = (this.p.stored(0x11, 1) & 0x1f) + 1;
    const low = (this.p.stored(0x10, 1) & 0x1f) + 1;
    const scl = (high + low) / iicClock; // seconds per SCL period
    return Math.max(240, Math.round(9 * scl * RA4M1_HZ));
  }

  private later(cycles: number, fn: () => void): void {
    this.chip.events.schedule(cycles, fn);
  }

  private start(repeated: boolean): void {
    this.sr2 &= ~0xff;
    this.settle();
    this.later(240, () => {
      this.bus()?.start(repeated && this.active);
      this.active = true;
      this.addressed = false;
      this.reading = false;
      this.stopRequested = false;
      this.sr2 |= 0x04 | 0x80; // START, TDRE
      this.events();
    });
  }

  private stop(): void {
    this.stopRequested = true;
    this.sr2 &= ~0x88;
    this.settle();
    this.later(240, () => {
      if (this.active) this.bus()?.stop();
      this.active = false;
      this.reading = false;
      this.sr2 |= 0x08; // STOP
      this.events();
    });
  }

  /** A byte written to ICDRT goes out over the next nine clocks. */
  private transmit(byte: number): void {
    if (!this.active) return;
    this.sr2 &= ~0xc0;
    this.settle();
    this.later(this.byteCycles(), () => {
      if (!this.active) return;
      if (!this.addressed) {
        this.addressed = true;
        const write = (byte & 1) === 0;
        const ack = this.bus() ? this.bus()!.connect(byte >>> 1, write) : false;
        if (!ack) {
          this.sr2 |= 0x10 | 0x40 | 0x80; // NACKF, TEND, TDRE
        } else if (write) {
          this.sr2 |= 0x80 | 0x40; // TDRE, TEND
        } else {
          // Receiving: the address phase ends with RDRF; the first read of
          // ICDRR is a dummy that starts the first byte.
          this.reading = true;
          this.rx = 0xff;
          this.sr2 |= 0x20;
        }
      } else {
        const ack = this.bus() ? this.bus()!.writeByte(byte) : false;
        this.sr2 |= ack ? 0xc0 : 0xd0;
      }
      this.events();
    });
  }

  private receiveNext(): void {
    // ICMR3.ACKBT set means NACK the byte about to be received; it is read
    // as the byte ends, which is when the hardware sends the acknowledge.
    this.later(this.byteCycles(), () => {
      if (!this.reading) return;
      const nack = (this.p.stored(0x04, 1) & 0x08) !== 0;
      this.rx = this.bus() ? this.bus()!.readByte(!nack) : 0xff;
      this.sr2 |= 0x20;
      this.events();
    });
  }

  /** Notes flags that have dropped, so setting one again is a new edge. */
  private settle(): void {
    this.raised &= this.sr2;
  }

  /** Each enabled flag raises its interrupt as it rises, as the hardware's flags do. */
  private events(): void {
    const ier = this.p.stored(0x07, 1);
    const on = this.sr2 & ier;
    const rising = on & ~this.raised;
    this.raised = on;
    if (rising & 0x20) this.chip.raise(this.rxi); // RXI: RDRF
    if (rising & 0x80) this.chip.raise(this.rxi + 1); // TXI: TDRE
    if (rising & 0x40) this.chip.raise(this.rxi + 2); // TEI: TEND
    if (rising & 0x1f) this.chip.raise(this.rxi + 3); // EEI: NACKF, STOP, START, AL, TMOF
  }
}

/** RSPI as a master, one frame at a time. */
class Spi {
  private rx = 0;
  private sr = 0x20; // SPTEF

  constructor(
    private readonly chip: Ra4m1,
    private readonly p: Regs,
    private readonly rxi: number,
  ) {
    p.r(0x03, 1, () => this.sr, (v) => {
      this.sr &= v | ~0x0f; // error flags are cleared by writing 0
    });
    for (const width of [1, 2, 4] as const) {
      p.r(0x04, width, () => {
        this.sr &= ~0x80; // SPRF
        return this.rx;
      }, (v) => this.transfer(v, width));
    }
  }

  private transfer(v: number, width: 1 | 2 | 4): void {
    const spcr = this.p.stored(0x00, 1);
    if (!(spcr & 0x40)) return; // SPE
    const cmd = this.p.stored(0x10, 2); // SPCMD0
    const mode = ((((cmd >>> 1) & 1) << 1) | (cmd & 1)) as 0 | 1 | 2 | 3;
    const lsb = (cmd & 0x1000) !== 0;
    const spb = (cmd >>> 8) & 0xf;
    const bits = width === 1 ? 8 : spb === 0xf ? 16 : spb === 0x2 || spb === 0x3 ? 32 : 8;
    const rev = (b: number) => {
      let r = 0;
      for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i;
      return r;
    };
    const one = (b: number) => {
      const out = lsb ? rev(b & 0xff) : b & 0xff;
      const got = (this.chip.spiTransfer ? this.chip.spiTransfer(out, mode) : 0xff) & 0xff;
      return lsb ? rev(got) : got;
    };
    let rx = 0;
    const n = bits / 8;
    for (let i = n - 1; i >= 0; i--) {
      const shift = lsb ? (n - 1 - i) * 8 : i * 8;
      rx |= one((v >>> shift) & 0xff) << shift;
    }
    this.rx = rx >>> 0;
    this.sr |= 0x80 | 0x20; // SPRF SPTEF
    if (spcr & 0x80) this.chip.raise(this.rxi); // SPRIE
    if (spcr & 0x20) this.chip.raise(this.rxi + 1); // SPTIE
    this.chip.raise(this.rxi + 4); // transmission complete
  }
}
