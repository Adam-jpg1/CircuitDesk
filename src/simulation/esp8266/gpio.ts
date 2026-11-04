// The ESP8266's GPIO: sixteen pads in the GPIO block at 0x60000300, their
// IO MUX registers at 0x60000800, and GPIO16, which lives in the RTC block.
//
// Offsets and fields are the Arduino core's esp8266_peri.h:
//
//   GPO 0x300 (with W1TS 0x304 / W1TC 0x308), GPE 0x30C (0x310 / 0x314),
//   GPI 0x318, the interrupt status GPIE 0x31C (0x320 / 0x324), and
//   GPC(p) 0x328 + 4p: bit 2 open drain, bits 9:7 the interrupt type.
//
//   GPF(p): the IO MUX register of each pad, at its own scattered offset
//   (esp8266_gpioToFn); function select in bits 4, 5 and 8, pull-up bit 7.
//   A pad is a GPIO when its function is GPFFS_GPIO(p): 0 for pads 0, 2, 4
//   and 5, 3 for the rest.
//
//   GPIO16: GP16O 0x768, GP16E 0x774, GP16I 0x78C, GP16F 0x7A0 (pull-down
//   bit 3), in RTC space, with no interrupt.
//
// Pads in another function — UART0 on 1 and 3, HSPI on 12..15 — are not
// driven from here; the runner sees what those peripherals do through their
// own models.

import { pinStateChanged, type PinChange, type PinState } from '../gpioEvents';
import type { Peripheral, SimulatedClock } from '../espRiscv/peripheral';

export const ESP8266_PAD_COUNT = 17;

/** GPF(p) offsets from 0x60000800 (esp8266_gpioToFn). */
const IO_MUX_OFFSET = [0x34, 0x18, 0x38, 0x14, 0x3c, 0x40, 0x1c, 0x20, 0x24, 0x28, 0x2c, 0x30, 0x04, 0x08, 0x0c, 0x10];

function gpioFunction(pin: number): number {
  return pin === 0 || pin === 2 || pin === 4 || pin === 5 ? 0 : 3;
}

/** The IO MUX block: plain registers, read by the GPIO model. */
export class Esp8266IoMux implements Peripheral {
  readonly name = 'io_mux';
  readonly base = 0x60000800;
  readonly size = 0x100;
  readonly regs = new Uint32Array(0x40);
  onChange: (() => void) | null = null;
  readUint32(offset: number): number {
    return this.regs[(offset >> 2) & 0x3f];
  }
  writeUint32(offset: number, value: number): void {
    this.regs[(offset >> 2) & 0x3f] = value >>> 0;
    this.onChange?.();
  }
  reset(): void {
    this.regs.fill(0);
    // After the ROM: the UART0 pads in their UART function, the rest GPIO inputs.
    for (let pin = 0; pin < 16; pin++) this.regs[IO_MUX_OFFSET[pin] >> 2] = pin === 1 || pin === 3 ? 0 : fnBits(gpioFunction(pin));
  }
  functionOf(pin: number): number {
    const v = this.regs[IO_MUX_OFFSET[pin] >> 2];
    return ((v >>> 4) & 3) | (((v >>> 8) & 1) << 2);
  }
  pullUp(pin: number): boolean {
    return ((this.regs[IO_MUX_OFFSET[pin] >> 2] >>> 7) & 1) === 1;
  }
}

function fnBits(f: number): number {
  return ((f & 1) << 4) | (((f >> 1) & 1) << 5) | (((f >> 2) & 1) << 8);
}

export class Esp8266Gpio implements Peripheral {
  readonly name = 'gpio';
  readonly base = 0x60000300;
  readonly size = 0x100;
  readonly padCount = ESP8266_PAD_COUNT;
  readonly ioMux = new Esp8266IoMux();
  private out = 0;
  private enable = 0;
  private status = 0;
  private readonly conf = new Uint32Array(16);
  /** GPIO16's RTC registers: output, enable, function/pull. */
  gp16 = { out: 0, enable: 0, conf: 0, fn: 0 };
  private readonly external = new Map<number, 0 | 1>();
  private readonly reported = new Map<number, PinState>();
  private readonly listeners = new Set<(change: PinChange) => void>();
  private refreshing = false;
  private refreshAgain = false;
  /** Open-drain pulls from targets on a bus (the soft I2C's devices), ANDed onto the pad. */
  private readonly busPulls = new Set<number>();
  onInterruptChange: (() => void) | null = null;
  /** Peripheral-driven pad levels (UART TX), when a pad is in that function. */
  readonly peripheralLevels = new Map<number, 0 | 1>();

  constructor(private readonly clock: SimulatedClock) {
    this.ioMux.onChange = () => this.refresh();
    this.reset();
  }

  reset(): void {
    this.out = 0;
    this.enable = 0;
    this.status = 0;
    this.conf.fill(0);
    this.gp16 = { out: 0, enable: 0, conf: 0, fn: 0 };
    this.ioMux.reset();
    this.busPulls.clear();
    this.reported.clear();
    for (let pin = 0; pin < this.padCount; pin++) this.reported.set(pin, this.pinState(pin));
  }

  private isGpio(pin: number): boolean {
    if (pin === 16) return (this.gp16.fn & 3) === 1 || (this.gp16.fn & 3) === 0;
    return this.ioMux.functionOf(pin) === gpioFunction(pin);
  }

  pullOf(pin: number): 'up' | 'down' | 'none' {
    if (pin === 16) return (this.gp16.fn >>> 3) & 1 ? 'down' : 'none';
    return this.ioMux.pullUp(pin) ? 'up' : 'none';
  }

  private drive(pin: number): { driving: boolean; level: 0 | 1; openDrain: boolean } {
    const none = { driving: false, level: 0 as 0 | 1, openDrain: false };
    if (pin === 16) {
      if (!(this.gp16.enable & 1)) return none;
      return { driving: true, level: (this.gp16.out & 1) as 0 | 1, openDrain: false };
    }
    if (!this.isGpio(pin)) {
      const p = this.peripheralLevels.get(pin);
      return p === undefined ? none : { driving: true, level: p, openDrain: false };
    }
    if (!((this.enable >>> pin) & 1)) return none;
    const level = ((this.out >>> pin) & 1) as 0 | 1;
    const openDrain = ((this.conf[pin] >>> 2) & 1) === 1;
    if (openDrain && level === 1) return { driving: false, level: 1, openDrain };
    return { driving: true, level, openDrain };
  }

  private levelOf(pin: number): 0 | 1 | undefined {
    if (this.busPulls.has(pin)) return 0;
    const d = this.drive(pin);
    if (d.driving) return d.level;
    const ext = this.external.get(pin);
    if (ext !== undefined) return ext;
    const pull = this.pullOf(pin);
    return pull === 'up' ? 1 : pull === 'down' ? 0 : undefined;
  }

  pinState(pin: number): PinState {
    const d = this.drive(pin);
    const gpio = this.isGpio(pin);
    const openDrainHigh = !d.driving && d.openDrain && gpio && pin < 16 && ((this.enable >>> pin) & 1) === 1;
    const direction = d.driving || openDrainHigh ? 'output' : gpio ? 'input' : 'disabled';
    return {
      pin,
      direction,
      level: this.levelOf(pin),
      pull: this.pullOf(pin),
      openDrain: d.openDrain && (d.driving || openDrainHigh),
      timestamp: this.clock.nanos,
    };
  }

  /** GPI: what each pad reads. */
  inputWord(): number {
    let v = 0;
    for (let pin = 0; pin < 16; pin++) if (this.levelOf(pin) === 1) v |= 1 << pin;
    return v >>> 0;
  }

  gp16Input(): number {
    return this.levelOf(16) === 1 ? 1 : 0;
  }

  readUint32(offset: number): number {
    switch (offset) {
      case 0x00: return this.out >>> 0;
      case 0x0c: return this.enable >>> 0;
      case 0x18: return this.inputWord();
      case 0x1c: return this.status >>> 0;
    }
    if (offset >= 0x28 && offset < 0x68) return this.conf[(offset - 0x28) >> 2];
    return 0;
  }

  writeUint32(offset: number, value: number): void {
    value = (value >>> 0) & 0xffff;
    switch (offset) {
      case 0x00: this.out = value; break;
      case 0x04: this.out |= value; break;
      case 0x08: this.out &= ~value; break;
      case 0x0c: this.enable = value; break;
      case 0x10: this.enable |= value; break;
      case 0x14: this.enable &= ~value; break;
      case 0x1c: this.status = value; break;
      case 0x20: this.status |= value; break;
      case 0x24: this.status &= ~value; break;
      default:
        if (offset >= 0x28 && offset < 0x68) this.conf[(offset - 0x28) >> 2] = value;
        else return;
    }
    this.refresh();
  }

  /** GPIO16's registers, which the RTC block forwards here. */
  writeGp16(field: 'out' | 'enable' | 'conf' | 'fn', value: number): void {
    this.gp16[field] = value >>> 0;
    this.refresh();
  }

  assertedInterruptSources(): number[] {
    return this.status & 0xffff ? [4] : [];
  }

  drivePin(pin: number, level: 0 | 1 | undefined): void {
    if (pin < 0 || pin >= this.padCount) return;
    if (level === undefined) this.external.delete(pin);
    else this.external.set(pin, level);
    this.refresh();
  }

  /** A peripheral (UART TX) puts a level on a pad it owns. */
  drivePeripheral(pin: number, level: 0 | 1): void {
    if (this.peripheralLevels.get(pin) === level) return;
    this.peripheralLevels.set(pin, level);
    this.refresh();
  }

  onPinChange(listener: (change: PinChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The function a pad's IO MUX selects (GPFFS). */
  padFunction(pin: number): number {
    return pin < 16 ? this.ioMux.functionOf(pin) : this.gp16.fn & 3;
  }

  private edge(pin: number, high: boolean): void {
    if (pin >= 16) return;
    const type = (this.conf[pin] >>> 7) & 7;
    if (type === 3 || (type === 1 && high) || (type === 2 && !high)) this.status |= 1 << pin;
  }

  private latchLevels(): void {
    for (let pin = 0; pin < 16; pin++) {
      const type = (this.conf[pin] >>> 7) & 7;
      const level = this.levelOf(pin);
      if ((type === 4 && level === 0) || (type === 5 && level === 1)) this.status |= 1 << pin;
    }
  }

  /** A bus target pulls a pad low (0) or lets it go (undefined). */
  pullBus(pin: number, level: 0 | undefined): void {
    if ((level === 0) === this.busPulls.has(pin)) return;
    if (level === 0) this.busPulls.add(pin);
    else this.busPulls.delete(pin);
    this.refresh();
  }

  private refresh(): void {
    // A listener may move a pad itself (a bus target answering); that change
    // is reported once this pass is done rather than lost.
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        this.refreshPass();
      } while (this.refreshAgain);
    } finally {
      this.refreshing = false;
    }
  }

  private refreshPass(): void {
    {
      const before = this.status & 0xffff;
      for (let pin = 0; pin < this.padCount; pin++) {
        const current = this.pinState(pin);
        const previous = this.reported.get(pin)!;
        this.reported.set(pin, current);
        if (previous.level !== current.level) this.edge(pin, current.level === 1);
        if (!pinStateChanged(previous, current)) continue;
        for (const listener of this.listeners) listener({ previous, current });
      }
      this.latchLevels();
      if (!!(this.status & 0xffff) !== !!before) this.onInterruptChange?.();
    }
  }
}
