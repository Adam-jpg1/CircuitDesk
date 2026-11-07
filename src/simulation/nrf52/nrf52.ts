// The Nordic nRF52833 (BBC micro:bit V2) and nRF52840 (Arduino Nano 33 BLE),
// on the ARMv7-M core.
//
// Nordic's peripherals share one shape, which is modelled once: TASKS
// registers that start something when written 1, EVENTS registers the
// hardware sets and firmware clears, INTENSET/INTENCLR enabling an interrupt
// per event, SHORTS linking an event to a task. On that:
//
//   * CLOCK/POWER: the HF and LF clocks start when asked.
//   * RTC0-2: 24-bit counters at 32.768 kHz with compare and overflow events;
//     millis() runs on RTC1.
//   * P0/P1 GPIO with PIN_CNF pulls and drive, and GPIOTE events behind
//     attachInterrupt.
//   * UART0 (Serial) in its byte-at-a-time form, paced at the programmed baud.
//   * SAADC with EasyDMA results in RAM: gain, reference and resolution as
//     configured, 3.3 V supply.
//   * TWI and SPI masters (and their EasyDMA forms, TWIM and SPIM), reaching
//     the canvas's device buses.
//   * PWM0-3 playing EasyDMA sequences, as analogWrite programs them.
//   * TIMER0-4 in timer mode with compare events and shorts, which tone()
//     and Servo use.
//   * FICR identity, NVMC ready, UICR erased.
//
// The radio, NFC, I2S, PDM, QSPI, USB (on the 52840) and the crypto blocks
// are not modelled.

import { CortexM } from '../armv7m/cortexM';
import type { MemoryRegion } from '../armv7m/bus';
import type { ArmMcu, I2cMasterHooks, McuSerial } from '../armv7m/armRunner';
import { EventQueue, Pads, Periph, PeriphBus, NOT_DRIVEN } from '../armv7m/peripherals';
import { NrfUsbd } from './usbd';

export const NRF52_HZ = 64_000_000;
export const NRF52_PAD_COUNT = 48;

/** P0.13 is 13, P1.08 is 40: port * 32 + pin. */
export function nrfPadIndex(pad: string): number | undefined {
  const m = /^P([01])\.(\d{1,2})$/.exec(pad);
  if (!m) return undefined;
  const pin = Number(m[2]);
  if (pin > 31 || (m[1] === '1' && pin > 15)) return undefined;
  return Number(m[1]) * 32 + pin;
}

/** SAADC analog inputs AIN0-AIN7 and the pads they are on. */
const AIN_PADS = [2, 3, 4, 5, 28, 29, 30, 31];
export const NRF52_ADC_BY_PAD: Record<number, number> = Object.fromEntries(AIN_PADS.map((p, i) => [p, i]));

export type NrfVariant = '52833' | '52840';

export class Nrf52 implements ArmMcu {
  readonly hz = NRF52_HZ;
  readonly adcReference = 3.3;
  readonly flash: Uint8Array;
  readonly sram: Uint8Array;
  readonly regions: MemoryRegion[];
  readonly bus = new PeriphBus();
  readonly pads = new Pads(NRF52_PAD_COUNT);
  readonly core: CortexM;
  readonly events: EventQueue;
  readonly adcVolts = new Float64Array(8);
  readonly serials: McuSerial[] = [];
  /** GPIO LATCH and DETECTMODE per port, for the SENSE mechanism. */
  private readonly latch = new Uint32Array(2);
  private readonly detectMode = new Uint32Array(2);
  private detectHigh = false;
  /** GPIOTE's PORT event, raised on each rising edge of the combined DETECT signal. */
  onPortDetect: (() => void) | null = null;
  /** Programmable peripheral interconnect: events wired to tasks. */
  ppi!: NrfPpi;
  /** The nRF52840's USB device controller, which the Nano 33 BLE's Serial is. */
  usb?: NrfUsbd;
  i2c: I2cMasterHooks | null = null;
  spiTransfer: ((mosi: number, mode: 0 | 1 | 2 | 3) => number) | null = null;

  readonly out = new Uint32Array(2);
  readonly dir = new Uint32Array(2);
  readonly pinCnf = new Uint32Array(NRF52_PAD_COUNT).fill(0x2); // input buffer disconnected
  /** Pads a peripheral has taken (UART TX, PWM out, ...): what it drives. */
  private readonly takenBy = new Map<number, () => number>();
  private readonly padListeners: ((pin: number, high: boolean) => void)[] = [];
  private uart!: NrfUart;

  constructor(readonly variant: NrfVariant = '52833') {
    const flashBytes = variant === '52840' ? 1024 * 1024 : 512 * 1024;
    const ramBytes = variant === '52840' ? 256 * 1024 : 128 * 1024;
    this.flash = new Uint8Array(flashBytes).fill(0xff);
    this.sram = new Uint8Array(ramBytes);
    this.regions = [
      { start: 0, end: flashBytes, bytes: this.flash, readOnly: true },
      { start: 0x20000000, end: 0x20000000 + ramBytes, bytes: this.sram },
      // The code-RAM alias of the same RAM.
      { start: 0x00800000, end: 0x00800000 + ramBytes, bytes: this.sram },
    ];
    this.core = new CortexM(this, { variant: 'm4', fpu: 'sp', irqCount: 48, priorityBits: 3, cpuid: 0x410fc241 });
    this.events = new EventQueue(() => this.core.cycles);
    this.buildPeripherals();
    this.pads.onChange = (pin, high) => {
      for (const l of this.padListeners) l(pin, high);
    };
    for (let pin = 0; pin < NRF52_PAD_COUNT; pin++) this.refreshPad(pin);
  }

  read(address: number, width: 1 | 2 | 4): number {
    return this.bus.read(address, width);
  }

  write(address: number, value: number, width: 1 | 2 | 4): void {
    this.bus.write(address, value, width);
  }

  reset(): void {
    this.core.reset(this.vectorBase);
  }

  /**
   * Where the application's vector table is. The Nano 33 BLE's bootloader
   * sits at 0 and starts the sketch at 0x10000; it is not simulated, so reset
   * goes straight to the application, as the bootloader would.
   */
  private vectorBase = 0;

  get console(): McuSerial {
    return this.uart;
  }

  adcChannelForPad(p: number): number | undefined {
    return NRF52_ADC_BY_PAD[p];
  }

  load(image: Uint8Array, at = 0): void {
    if (at + image.length > this.flash.length) throw new Error(`Firmware is larger than the nRF${this.variant}'s flash.`);
    this.flash.set(image, at);
    this.vectorBase = at;
  }

  /** Reads RAM through the bus, as EasyDMA does. */
  dmaRead(address: number): number {
    const off = address - 0x20000000;
    return off >= 0 && off < this.sram.length ? this.sram[off] : 0;
  }

  dmaWrite(address: number, value: number): void {
    const off = address - 0x20000000;
    if (off >= 0 && off < this.sram.length) this.sram[off] = value & 0xff;
  }

  onPadChange(fn: (pin: number, high: boolean) => void): void {
    this.padListeners.push(fn);
  }

  // ------------------------------------------------------- pad plumbing

  refreshPad(pin: number): void {
    const port = pin >> 5;
    const bit = 1 << (pin & 31);
    const cnf = this.pinCnf[pin];
    let drive = NOT_DRIVEN;
    const taken = this.takenBy.get(pin);
    if (taken) drive = taken();
    else if (this.dir[port] & bit) {
      const high = (this.out[port] & bit) !== 0;
      // DRIVE: S0D1/H0D1 leave a high output floating (open drain).
      const d = (cnf >>> 8) & 7;
      const openHigh = d === 4 || d === 5;
      const openLow = d === 6 || d === 7;
      drive = high ? (openHigh ? NOT_DRIVEN : 1) : openLow ? NOT_DRIVEN : 0;
    }
    this.pads.setDrive(pin, drive);
    const pull = (cnf >>> 2) & 3;
    this.pads.setPull(pin, pull === 3 ? 1 : pull === 1 ? 2 : 0);
  }

  /** A peripheral takes a pad over (PSEL), driving it with `level`, or gives it back. */
  take(pin: number, level: (() => number) | null): void {
    if (pin < 0 || pin >= NRF52_PAD_COUNT) return;
    if (level) this.takenBy.set(pin, level);
    else this.takenBy.delete(pin);
    this.refreshPad(pin);
  }

  /** The pad a PSEL register names, or -1 when disconnected. */
  static psel(v: number): number {
    if (v & 0x80000000) return -1;
    return ((v >>> 5) & 1) * 32 + (v & 0x1f);
  }

  activeI2cPads(): { sda?: number; scl?: number } | undefined {
    return this.twiPads;
  }

  activeSpiPads(): { sck?: number; mosi?: number; miso?: number } | undefined {
    return this.spiPads;
  }

  twiPads: { sda?: number; scl?: number } | undefined;
  spiPads: { sck?: number; mosi?: number; miso?: number } | undefined;

  // ------------------------------------------------------- peripherals

  private buildPeripherals(): void {
    const bus = this.bus;

    // FICR: the device's identity; everything not listed reads erased.
    const ficr = bus.add(new Periph('FICR', 0x10000000, 0x1000));
    for (let o = 0; o < 0x1000; o += 4) ficr.init(o, 0xffffffff);
    const flashKb = this.flash.length / 1024;
    ficr.init(0x010, 4096).init(0x014, flashKb / 4);
    ficr.init(0x060, 0x12345678).init(0x064, 0x9abcdef0);
    ficr.init(0x100, this.variant === '52840' ? 0x52840 : 0x52833).init(0x104, 0x41414130);
    ficr.init(0x10c, this.sram.length / 1024).init(0x110, flashKb);
    // UICR is flash: it is written through the NVMC with CONFIG.WEN set, and
    // programming can only clear bits. mbed's SystemInit programs the reset
    // pin into PSELRESET on first boot and then resets the chip, which is why
    // the contents (and the flash) outlive a system reset here.
    const uicr = bus.add(new Periph('UICR', 0x10001000, 0x1000));
    const nvmc = bus.add(new Periph('NVMC', 0x4001e000, 0x1000)).reg(0x400, () => 1).reg(0x408, () => 1); // READY, READYNEXT
    for (let o = 0; o < 0x1000; o += 4) {
      uicr.init(o, 0xffffffff);
      uicr.reg(o, undefined, (v, prev) => uicr.poke(o, nvmc.peek(0x504) & 1 ? prev & v : prev));
    }
    this.core.onSystemReset = () => this.reset();

    this.ppi = new NrfPpi(this);
    const clock = new NrfPeriph(this, 'CLOCK', 0x40000000, 0);
    clock.task(0x000, () => clock.fire(0x100)); // HFCLKSTART -> HFCLKSTARTED
    clock.task(0x008, () => clock.fire(0x104)); // LFCLKSTART -> LFCLKSTARTED
    clock.task(0x010, () => clock.fire(0x10c)); // CAL -> DONE
    clock.p.reg(0x40c, () => 0x00010001); // HFCLKSTAT: running, from the crystal
    clock.p.reg(0x418, () => 0x00010000 | (clock.p.peek(0x518) & 3)); // LFCLKSTAT
    clock.p.init(0x400, 0x1); // POWER.RESETREAS: reset pin
    if (this.variant === '52840') {
      // A USB cable is in, so VBUS is detected; the USB regulator settles a
      // little after the USBD is enabled, which mbed waits for (USBPWRRDY).
      let regulatorReady = false;
      clock.p.reg(0x438, () => (regulatorReady ? 0x3 : 0x1)); // POWER.USBREGSTATUS
      const usbd = new NrfPeriph(this, 'USBD', 0x40027000, 39);
      this.usb = new NrfUsbd({
        p: usbd.p,
        task: (offset, fn) => usbd.task(offset, fn),
        fire: (offset) => usbd.fire(offset),
        link: (bit, from, to) => usbd.link(bit, from, to),
        afterUs: (us, fn) => this.events.schedule(Math.max(1, Math.round(us * (NRF52_HZ / 1e6))), fn),
        dmaRead: (a) => this.dmaRead(a),
        dmaWrite: (a, v) => this.dmaWrite(a, v),
        enabled: () => {
          if (regulatorReady) return;
          this.events.schedule(NRF52_HZ / 10_000, () => {
            regulatorReady = true;
            clock.fire(0x124); // POWER.USBPWRRDY
          });
        },
      });
    }


    for (const [name, base, irq] of [['RTC0', 0x4000b000, 11], ['RTC1', 0x40011000, 17], ['RTC2', 0x40024000, 36]] as const) {
      new NrfRtc(this, new NrfPeriph(this, name, base, irq));
    }

    this.buildGpio();
    new NrfGpiote(this, new NrfPeriph(this, 'GPIOTE', 0x40006000, 6));

    this.uart = new NrfUart(this, new NrfPeriph(this, 'UART0', 0x40002000, 2), 'Serial');
    this.serials.push(this.uart);
    if (this.variant === '52840') this.serials.push(new NrfUart(this, new NrfPeriph(this, 'UARTE1', 0x40028000, 40), 'UARTE1'));

    new NrfSaadc(this, new NrfPeriph(this, 'SAADC', 0x40007000, 7));
    for (const [name, base, irq] of [['SERIAL0', 0x40003000, 3], ['SERIAL1', 0x40004000, 4], ['SPI2', 0x40023000, 35]] as const) {
      new NrfSerialBox(this, new NrfPeriph(this, name, base, irq));
    }
    for (const [name, base, irq] of [['PWM0', 0x4001c000, 28], ['PWM1', 0x40021000, 33], ['PWM2', 0x40022000, 34], ['PWM3', 0x4002d000, 45]] as const) {
      new NrfPwm(this, new NrfPeriph(this, name, base, irq));
    }
    for (const [name, base, irq, cc] of [
      ['TIMER0', 0x40008000, 8, 4], ['TIMER1', 0x40009000, 9, 4], ['TIMER2', 0x4000a000, 10, 4],
      ['TIMER3', 0x4001a000, 26, 6], ['TIMER4', 0x4001b000, 27, 6],
    ] as const) {
      new NrfTimer(this, new NrfPeriph(this, name, base, irq), cc);
    }
    // Present and inert: the radio, NFC, temperature sensor, random number
    // generator (it reports a value), watchdog, PPI, and the rest.
    for (const [name, base] of [
      ['RADIO', 0x40001000], ['NFCT', 0x40005000], ['TEMP', 0x4000c000], ['ECB', 0x4000e000], ['CCM', 0x4000f000],
      ['WDT', 0x40010000], ['QDEC', 0x40012000], ['COMP', 0x40013000], ['EGU', 0x40014000], ['PDM', 0x4001d000],
      ['MWU', 0x40020000], ['I2S', 0x40025000], ['FPU', 0x40026000], ['USBD', 0x40027000],
      ['QSPI', 0x40029000], ['CC_HOST', 0x5002a000], ['ACL', 0x4001e000 + 0x800],
    ] as const) {
      if (!bus.find(base)) bus.add(new Periph(name, base, 0x1000));
    }
    const rng = new NrfPeriph(this, 'RNG', 0x4000d000, 13);
    rng.task(0x000, () => rng.fire(0x100));
    rng.p.reg(0x508, () => (Math.random() * 256) | 0);
    const temp = bus.find(0x4000c000)!;
    temp.reg(0x100, () => 1).reg(0x508, () => 25 * 4); // DATARDY, 25 °C
  }

  /**
   * P0 and P1 share one window: P0's registers are at 0x50000504 onwards and
   * P1's at 0x50000804, each with OUT, OUTSET, OUTCLR, IN, DIR, DIRSET,
   * DIRCLR and then PIN_CNF[n] from +0x700.
   */
  /**
   * SENSE: a pin configured to sense high or low meets its condition, which
   * sets its LATCH bit and raises the port's DETECT signal — the OR of the
   * pins meeting it, or in LDETECT mode, whether any LATCH bit is set. GPIOTE
   * sees the ports' DETECT combined, as its PORT event.
   */
  private updateDetect(): void {
    let detect = false;
    for (let port = 0; port < 2; port++) {
      let met = 0;
      const count = port === 0 ? 32 : this.variant === '52840' ? 16 : 10;
      for (let b = 0; b < count; b++) {
        const sense = (this.pinCnf[port * 32 + b] >>> 16) & 3;
        if (sense < 2) continue;
        const high = this.pads.level(port * 32 + b);
        if (sense === 2 ? high : !high) met |= 1 << b;
      }
      this.latch[port] = (this.latch[port] | met) >>> 0;
      if (this.detectMode[port] ? this.latch[port] !== 0 : met !== 0) detect = true;
    }
    if (detect && !this.detectHigh) {
      this.detectHigh = true;
      this.onPortDetect?.();
    } else if (!detect) this.detectHigh = false;
  }

  private buildGpio(): void {
    const chip = this;
    const pinsOf = (port: number) => (port === 0 ? 32 : this.variant === '52840' ? 16 : 10);
    const changed = (port: number, mask: number) => {
      for (let b = 0; b < pinsOf(port); b++) if (mask & (1 << b)) this.refreshPad(port * 32 + b);
    };
    const setOut = (port: number, v: number) => {
      const before = this.out[port];
      this.out[port] = v >>> 0;
      changed(port, before ^ this.out[port]);
    };
    const setDir = (port: number, v: number) => {
      const before = this.dir[port];
      this.dir[port] = v >>> 0;
      changed(port, before ^ this.dir[port]);
    };
    const locate = (offset: number): [number, number] | null => {
      for (const port of [1, 0]) {
        const rel = offset - port * 0x300;
        if (rel >= 0x504 && rel < 0x780 + (port === 1 ? 0 : 0)) return [port, rel];
      }
      return null;
    };
    const readReg = (port: number, rel: number): number => {
      switch (rel) {
        case 0x504: case 0x508: case 0x50c:
          return this.out[port];
        case 0x510: {
          let v = 0;
          for (let b = 0; b < pinsOf(port); b++) if (this.pads.level(port * 32 + b)) v |= 1 << b;
          return v >>> 0;
        }
        case 0x514: case 0x518: case 0x51c:
          return this.dir[port];
        case 0x520:
          return this.latch[port];
        case 0x524:
          return this.detectMode[port];
        default:
          if (rel >= 0x700 && rel < 0x780) {
            const pin = (rel - 0x700) >> 2;
            return pin < pinsOf(port) ? this.pinCnf[port * 32 + pin] : 0;
          }
          return 0;
      }
    };
    const writeReg = (port: number, rel: number, v: number): void => {
      switch (rel) {
        case 0x504: return setOut(port, v);
        case 0x508: return setOut(port, this.out[port] | v);
        case 0x50c: return setOut(port, this.out[port] & ~v);
        case 0x514: return setDir(port, v);
        case 0x518: return setDir(port, this.dir[port] | v);
        case 0x51c: return setDir(port, this.dir[port] & ~v);
        case 0x520:
          this.latch[port] &= ~v;
          return this.updateDetect();
        case 0x524:
          this.detectMode[port] = v & 1;
          return this.updateDetect();
        default:
          if (rel >= 0x700 && rel < 0x780) {
            const pin = (rel - 0x700) >> 2;
            if (pin >= pinsOf(port)) return;
            const pad = port * 32 + pin;
            this.pinCnf[pad] = v >>> 0;
            // PIN_CNF.DIR is the same bit as DIR.
            if (v & 1) this.dir[port] |= 1 << pin;
            else this.dir[port] &= ~(1 << pin);
            this.refreshPad(pad);
            this.updateDetect();
          }
      }
    };
    this.onPadChange(() => this.updateDetect());
    this.bus.add(
      new (class extends Periph {
        override read(offset: number): number {
          const at = locate(offset & ~3);
          return at ? readReg(at[0], at[1]) >>> 0 : 0;
        }
        override write(offset: number, value: number): void {
          const at = locate(offset & ~3);
          if (at) writeReg(at[0], at[1], value);
        }
      })('GPIO', 0x50000000, 0x1000),
    );
    void chip;
  }
}

/**
 * A Nordic peripheral: tasks at 0x000-0x0FC, events at 0x100-0x1FC (event i
 * enables with INTEN bit i), SHORTS at 0x200, INTEN/INTENSET/INTENCLR at
 * 0x300/0x304/0x308. Its NVIC line is asserted while any enabled event is set.
 */
class NrfPeriph {
  readonly p: Periph;
  private inten = 0;
  private readonly ev = new Uint8Array(64);
  private readonly tasks = new Map<number, () => void>();
  private readonly shortsFn = new Map<number, () => void>();

  constructor(
    private readonly chip: Nrf52,
    name: string,
    base: number,
    private readonly irq: number,
  ) {
    const existing = chip.bus.find(base);
    this.p = existing && existing.base === base ? existing : chip.bus.add(new Periph(name, base, 0x1000));
    for (let i = 0; i < 64; i++) {
      this.p.reg(0x100 + i * 4, () => this.ev[i], (v) => {
        this.ev[i] = v & 1;
        this.update();
      });
    }
    this.p.reg(0x300, () => this.inten, (v) => {
      this.inten = v >>> 0;
      this.update();
    });
    this.p.reg(0x304, () => this.inten, (v) => {
      this.inten = (this.inten | v) >>> 0;
      this.update();
    });
    this.p.reg(0x308, () => this.inten, (v) => {
      this.inten = (this.inten & ~v) >>> 0;
      this.update();
    });
  }

  task(offset: number, fn: () => void): void {
    this.tasks.set(offset, fn);
    this.p.reg(offset, () => 0, (v) => {
      if (v & 1) fn();
    });
  }

  /** Runs a task as if written, for shorts. */
  runTask(offset: number): void {
    this.tasks.get(offset)?.();
  }

  /** Links SHORTS bit `bit` to a task. */
  short(bit: number, task: number): void {
    this.shortsFn.set(bit, () => this.runTask(task));
  }

  /** The hardware sets an event; SHORTS from it run their tasks. */
  fire(offset: number): void {
    const i = (offset - 0x100) >> 2;
    this.ev[i] = 1;
    this.update();
    const shorts = this.p.peek(0x200);
    for (const [bit, fn] of this.shortsFn) if (shorts & (1 << bit) && this.shortFrom.get(bit) === offset) fn();
    this.chip.ppi.event(this.p.base + offset);
  }

  private readonly shortFrom = new Map<number, number>();

  /** A SHORTS bit: when event `from` fires, task `to` runs. */
  link(bit: number, from: number, to: number): void {
    this.shortFrom.set(bit, from);
    this.short(bit, to);
  }

  event(offset: number): boolean {
    return this.ev[(offset - 0x100) >> 2] === 1;
  }

  private update(): void {
    let active = false;
    for (let i = 0; i < 32 && !active; i++) if (this.ev[i] && this.inten & (1 << i)) active = true;
    this.chip.core.setIrqLevel(this.irq, active);
  }

  get cpu(): CortexM {
    return this.chip.core;
  }
}

/**
 * PPI: channel n runs the task at TEP[n] (and FORK[n]) whenever the event at
 * EEP[n] fires, while the channel is enabled in CHEN. Channel groups are
 * enabled and disabled by their tasks. The fixed channels 20-31 serve the
 * radio and timers for Bluetooth, which is not simulated.
 */
class NrfPpi {
  private readonly p: Periph;
  private byEvent = new Map<number, number[]>();

  constructor(private readonly chip: Nrf52) {
    const p = (this.p = chip.bus.add(new Periph('PPI', 0x4001f000, 0x1000)));
    const rebuild = () => this.rebuild();
    p.reg(0x500, undefined, rebuild); // CHEN
    p.reg(0x504, () => p.peek(0x500), (v) => {
      p.poke(0x500, p.peek(0x500) | v);
      rebuild();
    }); // CHENSET
    p.reg(0x508, () => p.peek(0x500), (v) => {
      p.poke(0x500, p.peek(0x500) & ~v);
      rebuild();
    }); // CHENCLR
    for (let i = 0; i < 20; i++) p.reg(0x510 + i * 8, undefined, rebuild); // CH[i].EEP
    for (let g = 0; g < 6; g++) {
      p.reg(g * 8, () => 0, (v) => {
        if (!(v & 1)) return;
        p.poke(0x500, p.peek(0x500) | p.peek(0x800 + g * 4));
        rebuild();
      }); // TASKS_CHG[g].EN
      p.reg(g * 8 + 4, () => 0, (v) => {
        if (!(v & 1)) return;
        p.poke(0x500, p.peek(0x500) & ~p.peek(0x800 + g * 4));
        rebuild();
      }); // TASKS_CHG[g].DIS
    }
  }

  private rebuild(): void {
    const map = new Map<number, number[]>();
    const chen = this.p.peek(0x500);
    for (let i = 0; i < 20; i++) {
      if (!(chen & (1 << i))) continue;
      const eep = this.p.peek(0x510 + i * 8) >>> 0;
      if (!eep) continue;
      const list = map.get(eep) ?? [];
      list.push(i);
      map.set(eep, list);
    }
    this.byEvent = map;
  }

  /** An event fired at this address. */
  event(address: number): void {
    const channels = this.byEvent.get(address >>> 0);
    if (!channels) return;
    for (const i of channels) {
      for (const tep of [this.p.peek(0x514 + i * 8), this.p.peek(0x910 + i * 4)]) {
        if (tep) this.chip.write(tep >>> 0, 1, 4);
      }
    }
  }
}

/** RTC: a 24-bit counter at 32.768 kHz / (PRESCALER + 1). */
class NrfRtc {
  private running = false;
  private anchorCount = 0;
  private anchorCycle = 0;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly chip: Nrf52,
    private readonly n: NrfPeriph,
  ) {
    n.task(0x000, () => {
      if (this.running) return;
      this.running = true;
      this.anchorCycle = chip.core.cycles;
      this.reschedule();
    });
    n.task(0x004, () => {
      this.anchorCount = this.count();
      this.running = false;
      this.reschedule();
    });
    n.task(0x008, () => {
      this.anchorCount = 0;
      this.anchorCycle = chip.core.cycles;
      this.reschedule();
    });
    n.task(0x00c, () => {
      this.anchorCount = 0xfffff0;
      this.anchorCycle = chip.core.cycles;
      this.reschedule();
    });
    n.p.reg(0x504, () => this.count());
    for (let i = 0; i < 4; i++) n.p.reg(0x540 + i * 4, undefined, () => this.reschedule());
    // INTENSET is NrfPeriph's; hooking it here would replace that handler and
    // leave the RTC's interrupts permanently disabled.
  }

  private cyclesPerTick(): number {
    return (NRF52_HZ / 32768) * ((this.n.p.peek(0x508) & 0xfff) + 1);
  }

  private count(): number {
    if (!this.running) return this.anchorCount;
    return (this.anchorCount + Math.floor((this.chip.core.cycles - this.anchorCycle) / this.cyclesPerTick())) & 0xffffff;
  }

  private reschedule(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.running) return;
    const now = this.count();
    // The next compare match, or the overflow.
    let next = 0x1000000;
    for (let i = 0; i < 4; i++) {
      const cc = this.n.p.peek(0x540 + i * 4) & 0xffffff;
      const d = (cc - now) & 0xffffff;
      if (d > 0 && now + d < next) next = now + d;
    }
    const per = this.cyclesPerTick();
    const elapsed = this.chip.core.cycles - this.anchorCycle;
    const ticksElapsed = Math.floor(elapsed / per);
    const at = this.anchorCycle + (ticksElapsed + (next - now)) * per;
    this.cancel = this.chip.events.schedule(Math.max(1, Math.ceil(at - this.chip.core.cycles)), () => {
      this.cancel = null;
      const c = this.count();
      if (next >= 0x1000000 || c === 0) {
        this.anchorCount = 0;
        this.anchorCycle = this.chip.core.cycles;
        this.n.fire(0x104); // OVRFLW
      }
      const v = next & 0xffffff;
      for (let i = 0; i < 4; i++) if ((this.n.p.peek(0x540 + i * 4) & 0xffffff) === v) this.n.fire(0x140 + i * 4);
      this.reschedule();
    });
  }
}

/** GPIOTE: IN events on a pad's edges, as CONFIG[n] selects. */
class NrfGpiote {
  constructor(chip: Nrf52, n: NrfPeriph) {
    const levels = new Map<number, boolean>();
    chip.onPadChange((pin, high) => {
      if (levels.get(pin) === high) return;
      levels.set(pin, high);
      for (let i = 0; i < 8; i++) {
        const cfg = n.p.peek(0x510 + i * 4);
        if ((cfg & 3) !== 1) continue; // MODE: event
        const psel = ((cfg >>> 13) & 1) * 32 + ((cfg >>> 8) & 0x1f);
        if (psel !== pin) continue;
        const pol = (cfg >>> 16) & 3; // 1 rising, 2 falling, 3 toggle
        if ((pol === 1 && high) || (pol === 2 && !high) || pol === 3) n.fire(0x100 + i * 4);
      }
    });
    chip.onPortDetect = () => n.fire(0x17c); // PORT
  }
}

/** UART0 in its byte-at-a-time form (ENABLE = 4), and UARTE's TX/RX DMA. */
class NrfUart implements McuSerial {
  onTransmit: ((byte: number) => void) | null = null;
  private readonly rxQueue: number[] = [];
  private rxScheduled = false;
  private rxStarted = false;
  /** UARTE: the receive buffer EasyDMA is filling. */
  private rxDma: { ptr: number; max: number; n: number } | null = null;
  private txCancel: (() => void) | null = null;

  constructor(
    private readonly chip: Nrf52,
    private readonly n: NrfPeriph,
    readonly name: string,
  ) {
    n.task(0x000, () => this.startRx()); // STARTRX
    n.task(0x004, () => this.stopRx()); // STOPRX
    n.task(0x008, () => this.startTx()); // STARTTX
    n.task(0x00c, () => {
      this.txCancel?.();
      this.txCancel = null;
      n.fire(0x158); // TXSTOPPED
    }); // STOPTX
    // UARTE SHORTS: ENDRX_STARTRX and ENDRX_STOPRX.
    n.link(5, 0x110, 0x000);
    n.link(6, 0x110, 0x004);
    n.p.reg(0x51c, undefined, (v) => this.transmit(v & 0xff)); // TXD (UART)
    n.p.reg(0x518, () => {
      const v = this.rxd;
      this.pump();
      return v;
    }); // RXD (UART)
    for (const off of [0x500, 0x50c, 0x514]) n.p.reg(off, undefined, () => this.claim()); // ENABLE, PSEL.TXD, PSEL.RXD
  }

  private rxd = 0;

  get rxPad(): number {
    return Nrf52.psel(this.n.p.peek(0x514));
  }

  get txPad(): number {
    return Nrf52.psel(this.n.p.peek(0x50c));
  }

  /** ENABLE 8 is the UARTE (EasyDMA); 4 is the legacy UART. */
  private dma(): boolean {
    return this.n.p.peek(0x500) === 8;
  }

  private claim(): void {
    const tx = this.txPad;
    if (tx >= 0 && this.n.p.peek(0x500)) this.chip.take(tx, () => 1);
  }

  baud(): number | undefined {
    const v = this.n.p.peek(0x524);
    return v ? Math.round((v * 16_000_000) / 2 ** 32) : undefined;
  }

  private charCycles(): number {
    return Math.max(16, Math.round((NRF52_HZ * 10) / (this.baud() ?? 115200)));
  }

  /** A byte leaves on the TX pad — if one is connected. */
  private emit(byte: number): void {
    if (this.txPad >= 0) this.onTransmit?.(byte);
  }

  private startTx(): void {
    if (!this.dma()) return;
    // UARTE: TXD.MAXCNT bytes from TXD.PTR, a TXDRDY as each one goes, ENDTX after the last.
    this.txCancel?.();
    const ptr = this.n.p.peek(0x544);
    const count = this.n.p.peek(0x548) & 0xffff;
    const bytes = Array.from({ length: count }, (_, i) => this.chip.dmaRead(ptr + i));
    this.n.p.poke(0x54c, 0); // TXD.AMOUNT
    this.n.fire(0x150); // TXSTARTED
    let sent = 0;
    const next = () => {
      if (sent >= bytes.length) {
        this.txCancel = null;
        this.n.fire(0x120); // ENDTX
        return;
      }
      this.txCancel = this.chip.events.schedule(this.charCycles(), () => {
        this.emit(bytes[sent++]);
        this.n.p.poke(0x54c, sent);
        this.n.fire(0x11c); // TXDRDY
        next();
      });
    };
    next();
  }

  private transmit(byte: number): void {
    this.emit(byte);
    this.chip.events.schedule(this.charCycles(), () => this.n.fire(0x11c)); // TXDRDY
  }

  private startRx(): void {
    this.rxStarted = true;
    if (this.dma()) {
      this.rxDma = { ptr: this.n.p.peek(0x534), max: this.n.p.peek(0x538) & 0xffff, n: 0 };
      this.n.fire(0x14c); // RXSTARTED
    }
    this.pump();
  }

  private stopRx(): void {
    this.rxStarted = false;
    if (this.rxDma) this.endRx();
    this.n.fire(0x144); // RXTO: the receiver has stopped
  }

  private endRx(): void {
    const dma = this.rxDma!;
    this.rxDma = null;
    this.n.p.poke(0x53c, dma.n); // RXD.AMOUNT
    this.n.fire(0x110); // ENDRX (whose shorts may start the next buffer)
  }

  receive(byte: number): void {
    this.rxQueue.push(byte & 0xff);
    this.pump();
  }

  private pump(): void {
    if (!this.rxStarted || this.rxScheduled || !this.rxQueue.length) return;
    if (this.dma() ? !this.rxDma : this.n.event(0x108)) return;
    this.rxScheduled = true;
    this.chip.events.schedule(this.charCycles(), () => {
      this.rxScheduled = false;
      if (this.dma()) {
        const dma = this.rxDma;
        // Between buffers the byte waits in the receiver, as in the hardware FIFO.
        if (!dma) return;
        this.chip.dmaWrite(dma.ptr + dma.n, this.rxQueue.shift()!);
        dma.n++;
        this.n.fire(0x108); // RXDRDY
        if (dma.n >= dma.max) this.endRx();
        return this.pump();
      }
      if (this.n.event(0x108)) return this.pump();
      this.rxd = this.rxQueue.shift()!;
      this.n.fire(0x108); // RXDRDY
    });
  }
}

/** SAADC: one sample of every configured channel, written to RAM by EasyDMA. */
class NrfSaadc {
  constructor(chip: Nrf52, n: NrfPeriph) {
    n.task(0x000, () => n.fire(0x100)); // START -> STARTED
    n.task(0x004, () => {
      // SAMPLE: convert each channel with PSELP set, in order.
      const ptr = n.p.peek(0x62c);
      const max = n.p.peek(0x630) & 0x7fff;
      const res = [8, 10, 12, 14][n.p.peek(0x5f0) & 3];
      let written = 0;
      for (let ch = 0; ch < 8 && written < max; ch++) {
        const pselp = n.p.peek(0x510 + ch * 16) & 0x1f;
        if (!pselp) continue;
        const cfg = n.p.peek(0x518 + ch * 16);
        const gain = [1 / 6, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 1, 2, 4][(cfg >>> 8) & 7];
        const ref = cfg & 0x1000 ? 3.3 / 4 : 0.6;
        const volts = pselp === 9 ? 3.3 : chip.adcVolts[pselp - 1] ?? 0;
        let v = Math.round(((volts * gain) / ref) * 2 ** res);
        v = Math.max(0, Math.min(2 ** res - 1, v));
        chip.dmaWrite(ptr + written * 2, v & 0xff);
        chip.dmaWrite(ptr + written * 2 + 1, (v >>> 8) & 0xff);
        written++;
      }
      n.p.poke(0x634, written); // RESULT.AMOUNT
      chip.events.schedule(64 * 10, () => {
        n.fire(0x108); // DONE
        n.fire(0x10c); // RESULTDONE
        n.fire(0x104); // END
      });
    });
    n.task(0x008, () => n.fire(0x114)); // STOP -> STOPPED
    n.task(0x00c, () => n.fire(0x110)); // CALIBRATEOFFSET -> CALIBRATEDONE
  }
}

/**
 * The shared serial block at one base: SPI (ENABLE 1), SPIM (7), TWI (5) or
 * TWIM (6), whichever firmware enables.
 */
class NrfSerialBox {
  private rxd = 0;
  private txAddressed = false;
  private reading = false;

  constructor(
    private readonly chip: Nrf52,
    private readonly n: NrfPeriph,
  ) {
    const p = n.p;
    // TWI tasks
    n.task(0x000, () => this.startRx()); // STARTRX (TWI/TWIM)
    n.task(0x008, () => this.startTx()); // STARTTX
    n.task(0x014, () => this.stop()); // STOP
    n.task(0x01c, () => {
      this.suspended = true;
      n.fire(0x148);
    }); // SUSPEND -> SUSPENDED
    n.task(0x020, () => this.resume()); // RESUME
    n.task(0x010, () => this.spimStart()); // SPIM START
    p.reg(0x51c, undefined, (v) => this.txd(v & 0xff)); // TXD
    p.reg(0x518, () => {
      const v = this.rxd;
      if (this.mode() === 5 && this.reading) this.nextRead();
      return v;
    }); // RXD
    // The nRF5 core's Wire enables the block before it selects the pins, so
    // the pads are looked at again whenever either changes.
    for (const off of [0x500, 0x508, 0x50c, 0x510]) p.reg(off, undefined, () => this.pins());
  }

  private mode(): number {
    return this.n.p.peek(0x500) & 0xf;
  }

  private pins(): void {
    const m = this.mode();
    if (m === 5 || m === 6) {
      const scl = Nrf52.psel(this.n.p.peek(0x508));
      const sda = Nrf52.psel(this.n.p.peek(0x50c));
      this.chip.twiPads = { scl, sda };
    } else if (m === 1 || m === 7) {
      const sck = Nrf52.psel(this.n.p.peek(0x508));
      const mosi = Nrf52.psel(this.n.p.peek(0x50c));
      const miso = Nrf52.psel(this.n.p.peek(0x510));
      this.chip.spiPads = { sck, mosi, miso };
    }
  }

  private bus(): I2cMasterHooks | null {
    return this.chip.i2c;
  }

  private address(): number {
    return this.n.p.peek(0x588) & 0x7f;
  }

  private byteCycles(): number {
    return 64 * 90; // ~90 µs a byte at 100 kHz
  }

  // ---- TWI (legacy)
  //
  // STARTTX/STARTRX send START and the address at once (an address NACK is
  // ERRORSRC.ANACK). Writing: each TXD byte goes out as it is written, then
  // TXDSENT. Reading: a byte arrives, RXDREADY, then BB; SHORTS BB_SUSPEND
  // holds the bus there until RESUME, BB_STOP makes the byte just received the
  // last (NACKed, then STOP). Without either, the next byte starts when RXD is
  // read, as the real part stretches the clock until it is.

  private inTransaction = false;
  private pendingTxd: number | null = null;
  private suspended = false;
  private awaitingRxdRead = false;

  private startTx(): void {
    const m = this.mode();
    if (m === 6) return this.twimTransfer(true);
    if (m !== 5) return;
    this.bus()?.start(this.inTransaction);
    this.inTransaction = true;
    this.txAddressed = false;
    this.reading = false;
    this.pendingTxd = null;
    this.chip.events.schedule(this.byteCycles(), () => {
      const ack = this.bus() ? this.bus()!.connect(this.address(), true) : false;
      if (!ack) {
        this.n.p.poke(0x4c4, this.n.p.peek(0x4c4) | 2); // ERRORSRC.ANACK
        this.n.fire(0x124); // ERROR
        return;
      }
      this.txAddressed = true;
      const pending = this.pendingTxd;
      this.pendingTxd = null;
      if (pending !== null) this.sendByte(pending);
    });
  }

  private txd(byte: number): void {
    const m = this.mode();
    if (m === 1) return this.spiByte(byte);
    if (m !== 5) return;
    if (!this.txAddressed) this.pendingTxd = byte;
    else this.sendByte(byte);
  }

  private sendByte(byte: number): void {
    this.chip.events.schedule(this.byteCycles(), () => {
      const ack = this.bus() ? this.bus()!.writeByte(byte) : false;
      if (!ack) {
        this.n.p.poke(0x4c4, this.n.p.peek(0x4c4) | 4); // ERRORSRC.DNACK
        this.n.fire(0x124);
        return;
      }
      this.n.fire(0x11c); // TXDSENT
    });
  }

  private startRx(): void {
    const m = this.mode();
    if (m === 6) return this.twimTransfer(false);
    if (m !== 5) return;
    this.bus()?.start(this.inTransaction);
    this.inTransaction = true;
    this.reading = true;
    this.suspended = false;
    this.awaitingRxdRead = false;
    this.chip.events.schedule(this.byteCycles(), () => {
      const ack = this.bus() ? this.bus()!.connect(this.address(), false) : false;
      if (!ack) {
        this.n.p.poke(0x4c4, this.n.p.peek(0x4c4) | 2);
        this.n.fire(0x124);
        return;
      }
      this.readByte();
    });
  }

  /** RXD was read: without a suspend, the next byte follows. */
  private nextRead(): void {
    if (!this.awaitingRxdRead) return;
    this.awaitingRxdRead = false;
    this.readByte();
  }

  private resume(): void {
    if (this.mode() !== 5 || !this.suspended) return;
    this.suspended = false;
    if (this.reading) this.readByte();
  }

  private readByte(): void {
    this.chip.events.schedule(this.byteCycles(), () => {
      if (!this.reading) return;
      const shorts = this.n.p.peek(0x200);
      const last = (shorts & 2) !== 0; // BB_STOP
      this.rxd = this.bus() ? this.bus()!.readByte(!last) : 0xff;
      this.n.fire(0x108); // RXDREADY
      this.n.fire(0x138); // BB
      if (last) this.stop();
      else if (shorts & 1) {
        this.suspended = true; // BB_SUSPEND
        this.n.fire(0x148); // SUSPENDED
      } else this.awaitingRxdRead = true;
    });
  }

  private stop(): void {
    if (this.mode() !== 5 && this.mode() !== 6) return;
    this.bus()?.stop();
    this.reading = false;
    this.suspended = false;
    this.awaitingRxdRead = false;
    this.inTransaction = false;
    // A read after a STOP begins with a fresh START, not a repeated one.
    this.txAddressed = false;
    this.chip.events.schedule(64 * 10, () => this.n.fire(0x104)); // STOPPED
  }

  // ---- TWIM (EasyDMA)

  private twimTransfer(write: boolean): void {
    const p = this.n.p;
    const bus = this.bus();
    this.n.fire(write ? 0x150 : 0x14c); // TXSTARTED / RXSTARTED
    bus?.start(!write && this.txAddressed);
    const ack = bus ? bus.connect(this.address(), write) : false;
    if (!ack) {
      p.poke(0x4c4, p.peek(0x4c4) | 2);
      this.n.fire(0x124);
      return;
    }
    if (write) {
      const ptr = p.peek(0x544);
      const count = p.peek(0x548) & 0xffff;
      let sent = 0;
      for (; sent < count; sent++) if (!bus!.writeByte(this.chip.dmaRead(ptr + sent))) break;
      p.poke(0x54c, sent);
      this.txAddressed = true;
      this.chip.events.schedule(this.byteCycles() * (count + 1), () => {
        if (sent < count) {
          p.poke(0x4c4, p.peek(0x4c4) | 4);
          this.n.fire(0x124);
        }
        this.n.fire(0x160); // LASTTX
        const shorts = p.peek(0x200);
        if (shorts & (1 << 7)) this.startRx(); // LASTTX_STARTRX
        else if (shorts & (1 << 9)) this.stop(); // LASTTX_STOP
        else if (shorts & (1 << 8)) this.n.fire(0x148); // LASTTX_SUSPEND
      });
    } else {
      const ptr = p.peek(0x534);
      const count = p.peek(0x538) & 0xffff;
      for (let i = 0; i < count; i++) this.chip.dmaWrite(ptr + i, bus!.readByte(i < count - 1));
      p.poke(0x53c, count);
      this.chip.events.schedule(this.byteCycles() * (count + 1), () => {
        this.n.fire(0x15c); // LASTRX
        if (p.peek(0x200) & (1 << 12)) this.stop(); // LASTRX_STOP
      });
    }
  }

  // ---- SPI (legacy) and SPIM

  private spiMode(): 0 | 1 | 2 | 3 {
    const cfg = this.n.p.peek(0x554);
    return ((((cfg >>> 2) & 1) << 1) | ((cfg >>> 1) & 1)) as 0 | 1 | 2 | 3;
  }

  private spiOne(byte: number): number {
    const lsb = (this.n.p.peek(0x554) & 1) !== 0;
    const rev = (b: number) => {
      let r = 0;
      for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i;
      return r;
    };
    const out = lsb ? rev(byte) : byte;
    const got = (this.chip.spiTransfer ? this.chip.spiTransfer(out, this.spiMode()) : 0xff) & 0xff;
    return lsb ? rev(got) : got;
  }

  private spiByte(byte: number): void {
    this.rxd = this.spiOne(byte);
    this.n.fire(0x108); // READY
  }

  private spimStart(): void {
    if (this.mode() !== 7) return;
    const p = this.n.p;
    const txPtr = p.peek(0x544);
    const txCount = p.peek(0x548) & 0xffff;
    const rxPtr = p.peek(0x534);
    const rxCount = p.peek(0x538) & 0xffff;
    const n = Math.max(txCount, rxCount);
    const orc = p.peek(0x5c0) & 0xff;
    this.n.fire(0x14c);
    for (let i = 0; i < n; i++) {
      const got = this.spiOne(i < txCount ? this.chip.dmaRead(txPtr + i) : orc);
      if (i < rxCount) this.chip.dmaWrite(rxPtr + i, got);
    }
    p.poke(0x54c, txCount);
    p.poke(0x53c, rxCount);
    this.chip.events.schedule(64 * 2 * Math.max(1, n), () => {
      this.n.fire(0x120); // ENDTX
      this.n.fire(0x110); // ENDRX
      this.n.fire(0x118); // END
    });
  }
}

/** PWM: plays the compare values of SEQ[n] from RAM, as analogWrite programs it. */
class NrfPwm {
  private readonly levels = [0, 0, 0, 0];
  private cancel: (() => void) | null = null;
  private values = [0, 0, 0, 0];

  constructor(
    private readonly chip: Nrf52,
    private readonly n: NrfPeriph,
  ) {
    n.task(0x008, () => this.start(0)); // SEQSTART[0]
    n.task(0x00c, () => this.start(1)); // SEQSTART[1]
    n.task(0x004, () => this.stop()); // STOP
    n.p.reg(0x500, undefined, () => this.claim());
    for (let i = 0; i < 4; i++) n.p.reg(0x560 + i * 4, undefined, () => this.claim());
  }

  private claimed: number[] = [];

  private claim(): void {
    for (const pin of this.claimed) this.chip.take(pin, null);
    this.claimed = [];
    if (!(this.n.p.peek(0x500) & 1)) return;
    for (let i = 0; i < 4; i++) {
      const pin = Nrf52.psel(this.n.p.peek(0x560 + i * 4));
      if (pin < 0) continue;
      this.claimed.push(pin);
      this.chip.take(pin, () => this.levels[i]);
    }
  }

  private start(seq: number): void {
    const p = this.n.p;
    const base = 0x520 + seq * 0x20;
    const ptr = p.peek(base);
    const decoder = p.peek(0x510) & 3;
    const read16 = (i: number) => this.chip.dmaRead(ptr + i * 2) | (this.chip.dmaRead(ptr + i * 2 + 1) << 8);
    // Individual: one value per channel; common: one value for all four.
    this.values = decoder === 2 ? [read16(0), read16(1), read16(2), read16(3)] : [read16(0), read16(0), read16(0), read16(0)];
    this.n.fire(0x108 + seq * 4); // SEQSTARTED[n]
    this.claim();
    this.period();
  }

  private stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.n.fire(0x104); // STOPPED
  }

  private set(i: number, v: number): void {
    if (this.levels[i] === v) return;
    this.levels[i] = v;
    const pin = Nrf52.psel(this.n.p.peek(0x560 + i * 4));
    if (pin >= 0) this.chip.refreshPad(pin);
  }

  /** One PWM period, counting up to COUNTERTOP at 16 MHz / 2^PRESCALER. */
  private period(): void {
    this.cancel?.();
    const p = this.n.p;
    const top = p.peek(0x508) & 0x7fff;
    const ticks = (NRF52_HZ / 16_000_000) * 2 ** (p.peek(0x50c) & 7);
    if (!top) return;
    const edges: [number, number, number][] = [];
    for (let i = 0; i < 4; i++) {
      const v = this.values[i];
      const cmp = Math.min(top, v & 0x7fff);
      // Bit 15 set: the output starts high and falls at the compare value.
      const startHigh = (v & 0x8000) !== 0 ? 1 : 0;
      this.set(i, cmp === 0 ? 1 - startHigh : startHigh);
      if (cmp > 0 && cmp < top) edges.push([cmp * ticks, i, 1 - startHigh]);
    }
    for (const [at, i, level] of edges) this.chip.events.schedule(at, () => this.set(i, level));
    this.cancel = this.chip.events.schedule(top * ticks, () => {
      this.n.fire(0x118); // PWMPERIODEND
      this.period();
    });
  }
}

/** TIMER in timer mode: counts at 16 MHz / 2^PRESCALER, compare events with shorts. */
class NrfTimer {
  private running = false;
  private anchorCount = 0;
  private anchorCycle = 0;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly chip: Nrf52,
    private readonly n: NrfPeriph,
    private readonly ccCount: number,
  ) {
    n.task(0x000, () => {
      if (this.running) return;
      this.running = true;
      this.anchorCycle = chip.core.cycles;
      this.reschedule();
    }); // START
    n.task(0x004, () => {
      this.anchorCount = this.count();
      this.running = false;
      this.reschedule();
    }); // STOP
    n.task(0x00c, () => {
      this.anchorCount = 0;
      this.anchorCycle = chip.core.cycles;
      this.reschedule();
    }); // CLEAR
    n.task(0x010, () => {
      this.anchorCount = 0;
      this.running = false;
      this.reschedule();
    }); // SHUTDOWN
    n.task(0x008, () => this.countOne()); // COUNT, in counter mode
    for (let i = 0; i < ccCount; i++) {
      n.task(0x040 + i * 4, () => n.p.poke(0x540 + i * 4, this.count())); // CAPTURE[i]
      n.p.reg(0x540 + i * 4, undefined, () => this.reschedule());
    }
  }

  private mask(): number {
    const bm = this.n.p.peek(0x508) & 3;
    return [0xffff, 0xff, 0xffffff, 0xffffffff][bm];
  }

  private cyclesPerTick(): number {
    return (NRF52_HZ / 16_000_000) * 2 ** (this.n.p.peek(0x510) & 0xf);
  }

  /** MODE 1 or 2: counting COUNT tasks (often from the PPI) rather than time. */
  private counter(): boolean {
    return (this.n.p.peek(0x504) & 3) !== 0;
  }

  private countOne(): void {
    if (!this.running || !this.counter()) return;
    const mask = this.mask();
    const c = ((this.anchorCount + 1) & mask) >>> 0;
    this.anchorCount = c;
    const shorts = this.n.p.peek(0x200);
    for (let i = 0; i < this.ccCount; i++) {
      if ((this.n.p.peek(0x540 + i * 4) & mask) >>> 0 !== c) continue;
      this.n.fire(0x140 + i * 4); // COMPARE[i]
      if (shorts & (1 << i)) this.anchorCount = 0; // COMPARE_CLEAR
      if (shorts & (1 << (i + 8))) this.running = false; // COMPARE_STOP
    }
  }

  private count(): number {
    if (!this.running || this.counter()) return this.anchorCount;
    return ((this.anchorCount + Math.floor((this.chip.core.cycles - this.anchorCycle) / this.cyclesPerTick())) & this.mask()) >>> 0;
  }

  private reschedule(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.running || this.counter()) return;
    const now = this.count();
    const mask = this.mask();
    let best = Infinity;
    for (let i = 0; i < this.ccCount; i++) {
      // Unsigned throughout: in 32-bit mode a plain & would go negative.
      const cc = (this.n.p.peek(0x540 + i * 4) & mask) >>> 0;
      let d = ((cc - now) & mask) >>> 0;
      if (d === 0) d = mask + 1;
      if (d < best) best = d;
    }
    if (best === Infinity) return;
    const per = this.cyclesPerTick();
    const into = (this.chip.core.cycles - this.anchorCycle) % per;
    this.cancel = this.chip.events.schedule(Math.max(1, best * per - into), () => {
      this.cancel = null;
      const c = this.count();
      const shorts = this.n.p.peek(0x200);
      let cleared = false;
      for (let i = 0; i < this.ccCount; i++) {
        if ((this.n.p.peek(0x540 + i * 4) & mask) >>> 0 !== c) continue;
        this.n.fire(0x140 + i * 4); // COMPARE[i]
        if (shorts & (1 << i)) cleared = true; // COMPARE_CLEAR
        if (shorts & (1 << (i + 8))) this.running = false; // COMPARE_STOP
      }
      if (cleared) {
        this.anchorCount = 0;
        this.anchorCycle = this.chip.core.cycles;
      } else {
        this.anchorCount = c;
        this.anchorCycle = this.chip.core.cycles;
      }
      this.reschedule();
    });
  }
}
