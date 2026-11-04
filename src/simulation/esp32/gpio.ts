// The ESP32's GPIO block, IO MUX and the RTC IO pad controls.
//
// Forty pads (0..39; 20 and 24 and 28..31 are not bonded out, 34..39 are
// input-only), each reached either directly by an IO MUX function or through
// the GPIO matrix: 256 peripheral output signals any pad may carry, and input
// signals any pad may feed. Register offsets and field positions are from
// ESP-IDF's soc/esp32/register/soc/gpio_reg.h, io_mux_reg.h and rtc_io_reg.h.
//
// Pads that also belong to the RTC domain (0, 2, 4, 12..15, 25..27, 32..39)
// take their pull resistors from RTC IO registers rather than IO MUX on this
// chip, which is where ESP-IDF's gpio_pullup_en() writes them, so both are
// consulted.

import type { Peripheral, InterruptingPeripheral, SimulatedClock } from '../espRiscv/peripheral';
import { pinStateChanged, type PinChange, type PinState } from '../gpioEvents';

export const ESP32_PAD_COUNT = 40;

const OUT = 0x04, OUT_W1TS = 0x08, OUT_W1TC = 0x0c;
const OUT1 = 0x10, OUT1_W1TS = 0x14, OUT1_W1TC = 0x18;
const ENABLE = 0x20, ENABLE_W1TS = 0x24, ENABLE_W1TC = 0x28;
const ENABLE1 = 0x2c, ENABLE1_W1TS = 0x30, ENABLE1_W1TC = 0x34;
const STRAP = 0x38, IN = 0x3c, IN1 = 0x40;
const STATUS = 0x44, STATUS_W1TS = 0x48, STATUS_W1TC = 0x4c;
const STATUS1 = 0x50, STATUS1_W1TS = 0x54, STATUS1_W1TC = 0x58;
const ACPU_INT = 0x60, ACPU_INT1 = 0x74, PCPU_INT = 0x68, PCPU_INT1 = 0x7c;
const PIN0 = 0x88;
const FUNC_IN_SEL = 0x130;
const FUNC_OUT_SEL = 0x530;

/** The matrix's "plain GPIO output" signal: the pad follows GPIO_OUT. */
export const SIG_GPIO_OUT = 256;
/** IO MUX function number that hands a pad to the GPIO matrix. */
const PIN_FUNC_GPIO = 2;

/** IO MUX register offset of each pad, from io_mux_reg.h (-1: not bonded). */
export const IO_MUX_OFFSET = [
  0x44, 0x88, 0x40, 0x84, 0x48, 0x6c, 0x60, 0x64, 0x68, 0x54, 0x58, 0x5c, 0x34, 0x38, 0x30, 0x3c,
  0x4c, 0x50, 0x70, 0x74, 0x78, 0x7c, 0x80, 0x8c, 0x90, 0x24, 0x28, 0x2c, -1, -1, -1, -1,
  0x1c, 0x20, 0x14, 0x18, 0x04, 0x08, 0x0c, 0x10,
];

/** RTC IO pull-up/pull-down bits for RTC-capable pads: [register offset, RUE bit, RDE bit]. */
const RTC_PULL: Record<number, [number, number, number]> = {
  4: [0x94, 27, 28], 0: [0x98, 27, 28], 2: [0x9c, 27, 28], 15: [0xa0, 27, 28], 13: [0xa4, 27, 28],
  12: [0xa8, 27, 28], 14: [0xac, 27, 28], 27: [0xb0, 27, 28], 25: [0x84, 27, 28], 26: [0x88, 27, 28],
  33: [0x8c, 27, 28], 32: [0x8c, 22, 23],
};

/** A peripheral's drive of one matrix output signal. */
export interface SignalDrive {
  level: 0 | 1;
}

class RegisterFile implements Peripheral {
  readonly regs = new Map<number, number>();
  constructor(readonly name: string, readonly base: number, readonly size: number, private readonly onWrite: () => void) {}
  readUint32(offset: number): number {
    return (this.regs.get(offset) ?? 0) >>> 0;
  }
  writeUint32(offset: number, value: number): void {
    this.regs.set(offset, value >>> 0);
    this.onWrite();
  }
  reset(): void {
    this.regs.clear();
  }
}

export class Esp32Gpio implements Peripheral, InterruptingPeripheral {
  readonly name = 'gpio';
  readonly base = 0x3ff44000;
  readonly size = 0x1000;
  /** IO MUX, at 0x3FF49000. */
  readonly ioMux: RegisterFile;
  /** RTC IO, at 0x3FF48400. */
  readonly rtcIo: RegisterFile;

  private out = 0;
  private out1 = 0;
  private enable = 0;
  private enable1 = 0;
  private status = 0;
  private status1 = 0;
  private readonly pinReg = new Uint32Array(ESP32_PAD_COUNT);
  private readonly inSel = new Uint32Array(256);
  private readonly outSel = new Uint32Array(ESP32_PAD_COUNT);
  private readonly external = new Map<number, 0 | 1>();
  private readonly signals = new Map<number, 0 | 1>();
  private readonly reported = new Map<number, PinState>();
  private readonly listeners = new Set<(change: PinChange) => void>();
  /** Called when the GPIO interrupt may have changed without a register write. */
  onInterruptChange: (() => void) | null = null;
  /** Peripherals that sample an input signal on a pad edge (a UART RX, a PCNT...). */
  onInputEdge: ((pin: number, level: 0 | 1) => void) | null = null;
  private refreshing = false;

  constructor(
    private readonly clock: SimulatedClock,
    private readonly interruptSource = 22,
  ) {
    this.ioMux = new RegisterFile('io_mux', 0x3ff49000, 0x100, () => this.refresh());
    this.rtcIo = new RegisterFile('rtc_io', 0x3ff48400, 0x100, () => this.refresh());
    this.reset();
  }

  reset(): void {
    this.out = this.out1 = this.enable = this.enable1 = this.status = this.status1 = 0;
    this.pinReg.fill(0);
    this.inSel.fill(0);
    // FUNC_OUT_SEL resets to signal 256 with OEN from GPIO_ENABLE (0x100).
    this.outSel.fill(0x100);
    this.ioMux.reset();
    this.rtcIo.reset();
    // Every pad's IO MUX register resets to function 0 with its input buffer off,
    // except the pads the boot ROM leaves as GPIO with pull-ups (0, 2's strap
    // pads and the UART pins) — the difference does not reach a sketch, which
    // configures every pin it uses.
    this.signals.clear();
    this.reported.clear();
    for (let pin = 0; pin < ESP32_PAD_COUNT; pin++) this.reported.set(pin, this.pinState(pin));
  }

  // ------------------------------------------------------------ pad state

  private mux(pin: number): number {
    const off = IO_MUX_OFFSET[pin];
    return off < 0 ? 0 : this.ioMux.readUint32(off);
  }

  private functionOf(pin: number): number {
    return (this.mux(pin) >>> 12) & 7;
  }

  private inputEnabled(pin: number): boolean {
    return ((this.mux(pin) >>> 9) & 1) === 1;
  }

  pullOf(pin: number): 'up' | 'down' | 'none' {
    let up = ((this.mux(pin) >>> 8) & 1) === 1;
    let down = ((this.mux(pin) >>> 7) & 1) === 1;
    const rtc = RTC_PULL[pin];
    if (rtc) {
      const v = this.rtcIo.readUint32(rtc[0]);
      up ||= ((v >>> rtc[1]) & 1) === 1;
      down ||= ((v >>> rtc[2]) & 1) === 1;
    }
    return up ? 'up' : down ? 'down' : 'none';
  }

  private enabledBit(pin: number): boolean {
    return pin < 32 ? ((this.enable >>> pin) & 1) === 1 : ((this.enable1 >>> (pin - 32)) & 1) === 1;
  }

  private outBit(pin: number): 0 | 1 {
    return (pin < 32 ? (this.out >>> pin) & 1 : (this.out1 >>> (pin - 32)) & 1) as 0 | 1;
  }

  /** What the chip drives onto a pad, if anything. */
  private drive(pin: number): { driving: boolean; level: 0 | 1; openDrain: boolean } {
    const none = { driving: false, level: 0 as 0 | 1, openDrain: false };
    if (pin >= 34 || IO_MUX_OFFSET[pin] < 0) return none;
    if (this.functionOf(pin) !== PIN_FUNC_GPIO) return none;
    const sel = this.outSel[pin];
    let oe = this.enabledBit(pin);
    if (sel & (1 << 11)) oe = !oe;
    if (!oe) return none;
    const signal = sel & 0x1ff;
    let level: 0 | 1 = signal === SIG_GPIO_OUT ? this.outBit(pin) : (this.signals.get(signal) ?? 0);
    if (signal !== SIG_GPIO_OUT && sel & (1 << 9)) level = (1 - level) as 0 | 1;
    const openDrain = ((this.pinReg[pin] >>> 2) & 1) === 1;
    // An open-drain pad driving high lets go of the line.
    if (openDrain && level === 1) return { driving: false, level: 1, openDrain };
    return { driving: true, level, openDrain };
  }

  /** The level on a pad, from whatever is driving it. */
  private levelOf(pin: number): 0 | 1 | undefined {
    const ext = this.external.get(pin);
    const d = this.drive(pin);
    if (d.driving) return d.level;
    if (ext !== undefined) return ext;
    const pull = this.pullOf(pin);
    return pull === 'up' ? 1 : pull === 'down' ? 0 : undefined;
  }

  pinState(pin: number): PinState {
    const d = this.drive(pin);
    const openDrainHigh = !d.driving && d.openDrain && this.enabledBit(pin) && this.functionOf(pin) === PIN_FUNC_GPIO;
    const direction = d.driving || openDrainHigh ? 'output' : this.inputEnabled(pin) || this.functionOf(pin) === PIN_FUNC_GPIO ? 'input' : 'disabled';
    return {
      pin,
      direction,
      level: this.levelOf(pin),
      pull: this.pullOf(pin),
      openDrain: d.openDrain && (d.driving || openDrainHigh),
      timestamp: this.clock.nanos,
    };
  }

  /** The level GPIO_IN reports for a pad: zero with its input buffer off. */
  private inputLevel(pin: number): 0 | 1 {
    if (!this.inputEnabled(pin) && !this.drive(pin).driving) return 0;
    return this.levelOf(pin) === 1 ? 1 : 0;
  }

  // ------------------------------------------------------------ registers

  readUint32(offset: number): number {
    switch (offset) {
      case OUT: return this.out >>> 0;
      case OUT1: return this.out1 >>> 0;
      case ENABLE: return this.enable >>> 0;
      case ENABLE1: return this.enable1 >>> 0;
      // GPIO0, 2, 5, 12, 15 strapping as an ordinary SPI boot.
      case STRAP: return 0x13;
      case IN: {
        let v = 0;
        for (let pin = 0; pin < 32; pin++) if (this.inputLevel(pin)) v |= 1 << pin;
        return v >>> 0;
      }
      case IN1: {
        let v = 0;
        for (let pin = 32; pin < ESP32_PAD_COUNT; pin++) if (this.inputLevel(pin)) v |= 1 << (pin - 32);
        return v >>> 0;
      }
      case STATUS: return this.status >>> 0;
      case STATUS1: return this.status1 >>> 0;
      case PCPU_INT: return this.pending(15, 0);
      case PCPU_INT1: return this.pending(15, 1);
      case ACPU_INT: return this.pending(13, 0);
      case ACPU_INT1: return this.pending(13, 1);
    }
    if (offset >= PIN0 && offset < PIN0 + ESP32_PAD_COUNT * 4) return this.pinReg[(offset - PIN0) >> 2];
    if (offset >= FUNC_IN_SEL && offset < FUNC_IN_SEL + 256 * 4) return this.inSel[(offset - FUNC_IN_SEL) >> 2];
    if (offset >= FUNC_OUT_SEL && offset < FUNC_OUT_SEL + ESP32_PAD_COUNT * 4) return this.outSel[(offset - FUNC_OUT_SEL) >> 2];
    return 0;
  }

  writeUint32(offset: number, value: number): void {
    value >>>= 0;
    switch (offset) {
      case OUT: this.out = value; break;
      case OUT_W1TS: this.out |= value; break;
      case OUT_W1TC: this.out &= ~value; break;
      case OUT1: this.out1 = value & 0xff; break;
      case OUT1_W1TS: this.out1 |= value & 0xff; break;
      case OUT1_W1TC: this.out1 &= ~value; break;
      case ENABLE: this.enable = value; break;
      case ENABLE_W1TS: this.enable |= value; break;
      case ENABLE_W1TC: this.enable &= ~value; break;
      case ENABLE1: this.enable1 = value & 0xff; break;
      case ENABLE1_W1TS: this.enable1 |= value & 0xff; break;
      case ENABLE1_W1TC: this.enable1 &= ~value; break;
      case STATUS: this.status = value; break;
      case STATUS_W1TS: this.status |= value; break;
      case STATUS_W1TC: this.status &= ~value; break;
      case STATUS1: this.status1 = value & 0xff; break;
      case STATUS1_W1TS: this.status1 |= value & 0xff; break;
      case STATUS1_W1TC: this.status1 &= ~value; break;
      default:
        if (offset >= PIN0 && offset < PIN0 + ESP32_PAD_COUNT * 4) this.pinReg[(offset - PIN0) >> 2] = value;
        else if (offset >= FUNC_IN_SEL && offset < FUNC_IN_SEL + 256 * 4) this.inSel[(offset - FUNC_IN_SEL) >> 2] = value;
        else if (offset >= FUNC_OUT_SEL && offset < FUNC_OUT_SEL + ESP32_PAD_COUNT * 4) this.outSel[(offset - FUNC_OUT_SEL) >> 2] = value;
        else return;
    }
    this.refresh();
  }

  // ------------------------------------------------------------ interrupts

  /** Pads with a latched interrupt enabled for a CPU (int_ena bit 13: APP, 15: PRO). */
  private pending(enaBit: number, word: number): number {
    let v = 0;
    const status = word === 0 ? this.status : this.status1;
    for (let i = 0; i < 32; i++) {
      const pin = word * 32 + i;
      if (pin >= ESP32_PAD_COUNT) break;
      if ((status >>> i) & 1 && (this.pinReg[pin] >>> enaBit) & 1) v |= 1 << i;
    }
    return v >>> 0;
  }

  private setStatus(pin: number): void {
    if (pin < 32) this.status |= 1 << pin;
    else this.status1 |= 1 << (pin - 32);
  }

  /** Latches level-type interrupts, which hold while their level does. */
  private latchLevels(): void {
    for (let pin = 0; pin < ESP32_PAD_COUNT; pin++) {
      const type = (this.pinReg[pin] >>> 7) & 7;
      if (type === 4 && this.inputLevel(pin) === 0) this.setStatus(pin);
      if (type === 5 && this.inputLevel(pin) === 1) this.setStatus(pin);
    }
  }

  private edge(pin: number, high: boolean): void {
    const type = (this.pinReg[pin] >>> 7) & 7;
    if (type === 3 || (type === 1 && high) || (type === 2 && !high)) this.setStatus(pin);
  }

  assertedInterruptSources(): number[] {
    const any = this.pending(15, 0) | this.pending(15, 1) | this.pending(13, 0) | this.pending(13, 1);
    return any ? [this.interruptSource] : [];
  }

  // ------------------------------------------------------------ outside world

  drivePin(pin: number, level: 0 | 1 | undefined): void {
    if (pin < 0 || pin >= ESP32_PAD_COUNT) return;
    if (level === undefined) this.external.delete(pin);
    else this.external.set(pin, level);
    this.refresh();
  }

  onPinChange(listener: (change: PinChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A peripheral drives one of its matrix output signals. */
  driveSignal(signal: number, level: 0 | 1): void {
    if (this.signals.get(signal) === level) return;
    this.signals.set(signal, level);
    this.refresh();
  }

  /** The pad routed to a peripheral input signal, if the matrix routes one. */
  inputSignalPin(signal: number): number | undefined {
    const cfg = this.inSel[signal];
    if (!(cfg & (1 << 7))) return undefined;
    const pin = cfg & 0x3f;
    return pin < ESP32_PAD_COUNT ? pin : undefined;
  }

  /** The level a peripheral input signal sees. */
  inputSignalLevel(signal: number): 0 | 1 {
    const cfg = this.inSel[signal];
    const pin = cfg & 0x3f;
    let level: 0 | 1 = pin < ESP32_PAD_COUNT ? (this.levelOf(pin) === 1 ? 1 : 0) : pin === 0x38 ? 1 : 0;
    if (cfg & (1 << 6)) level = (1 - level) as 0 | 1;
    return level;
  }

  /** The first pad carrying a peripheral output signal, if any. */
  outputSignalPin(signal: number): number | undefined {
    for (let pin = 0; pin < ESP32_PAD_COUNT; pin++) {
      if (IO_MUX_OFFSET[pin] >= 0 && this.functionOf(pin) === PIN_FUNC_GPIO && (this.outSel[pin] & 0x1ff) === signal) return pin;
    }
    return undefined;
  }

  private refresh(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const before = this.assertedInterruptSources().length;
      for (let pin = 0; pin < ESP32_PAD_COUNT; pin++) {
        if (IO_MUX_OFFSET[pin] < 0) continue;
        const current = this.pinState(pin);
        const previous = this.reported.get(pin)!;
        this.reported.set(pin, current);
        if (previous.level !== current.level) {
          this.edge(pin, current.level === 1);
          this.onInputEdge?.(pin, current.level === 1 ? 1 : 0);
        }
        if (!pinStateChanged(previous, current)) continue;
        for (const listener of this.listeners) listener({ previous, current });
      }
      this.latchLevels();
      if (this.assertedInterruptSources().length !== before) this.onInterruptChange?.();
    } finally {
      this.refreshing = false;
    }
  }
}
