// The ESP32-C3's GPIO, IO MUX and GPIO matrix.
//
// Nothing here intercepts `digitalWrite`, `digitalRead` or `pinMode`. Those are
// Arduino functions that compile down to ESP-IDF calls which write registers,
// and it is the registers this models — so a sketch that drives a pin through
// the IDF API, through the HAL, or by writing the registers itself all reach
// the same place, and none of them is special-cased.
//
// Three blocks decide what a pin does on this chip, and all three matter:
//
//   * The IO MUX chooses which function owns the pad, and holds the pull
//     resistors and the input buffer enable.
//   * The GPIO matrix routes a peripheral signal, or the GPIO output register,
//     to the pad.
//   * The GPIO block holds the output value and the output enable.
//
// Modelling only the last of those would make a pin appear driven when the pad
// is still assigned to a different function, which is exactly the mistake that
// makes a simulated board look like it works while real hardware sits idle.
//
// Register offsets and bit positions are the documented ones from the ESP32-C3
// technical reference manual.

import type { Peripheral } from '../espRiscv/peripheral';
import type { PinChange, PinLevel, PinPull, PinState } from '../gpioEvents';
import { pinStateChanged } from '../gpioEvents';

export const GPIO_BASE = 0x60004000;
export const IO_MUX_BASE = 0x60009000;

/** The C3 has 22 GPIOs, numbered 0 to 21. */
export const ESP32C3_GPIO_COUNT = 22;

// ------------------------------------------------------------ GPIO registers

const GPIO_OUT = 0x04;
const GPIO_OUT_W1TS = 0x08;
const GPIO_OUT_W1TC = 0x0c;
const GPIO_ENABLE = 0x20;
const GPIO_ENABLE_W1TS = 0x24;
const GPIO_ENABLE_W1TC = 0x28;
const GPIO_STRAP = 0x38;
const GPIO_IN = 0x3c;
const GPIO_STATUS = 0x44;
const GPIO_STATUS_W1TS = 0x48;
const GPIO_STATUS_W1TC = 0x4c;
const GPIO_PCPU_INT = 0x5c;
const GPIO_PIN_BASE = 0x74;
const GPIO_FUNC_IN_SEL_BASE = 0x154;
const GPIO_FUNC_OUT_SEL_BASE = 0x554;

/** GPIO_PINn_REG: bit 2 puts the pad into open-drain mode. */
const GPIO_PIN_PAD_DRIVER = 1 << 2;
/** GPIO_PINn_REG.INT_TYPE (bits 7-9) and INT_ENA (bits 13-17; bit 13 is the CPU's). */
const INT_TYPE_SHIFT = 7;
const INT_ENA_CPU = 1 << 13;
const INT_RISING = 1;
const INT_FALLING = 2;
const INT_ANY_EDGE = 3;
const INT_LOW = 4;
const INT_HIGH = 5;

/** FUNCn_OUT_SEL_CFG fields. */
const OUT_SEL_MASK = 0xff;
const OUT_INV_SEL = 1 << 8;
const OEN_SEL = 1 << 9;
const OEN_INV_SEL = 1 << 10;

/**
 * The signal number meaning "drive this pad from the GPIO output register"
 * rather than from a peripheral. ESP-IDF writes it for every plain digital pin.
 */
export const SIG_GPIO_OUT_IDX = 128;

// ---------------------------------------------------------- IO MUX registers

/** IO MUX has one register per pad, starting one word into the block. */
const IO_MUX_PIN_BASE = 0x04;

const FUN_PD = 1 << 7;
const FUN_PU = 1 << 8;
const FUN_IE = 1 << 9;
const MCU_SEL_SHIFT = 12;
const MCU_SEL_MASK = 0x7;

/** IO MUX function number that hands a pad to the GPIO matrix. */
export const PIN_FUNC_GPIO = 1;

/**
 * Reset value of an IO MUX pad register.
 *
 * Out of reset the C3 leaves pads on their IO MUX function 1 with the input
 * buffer off and no pull, which is what firmware finds and reconfigures.
 */
const IO_MUX_RESET = PIN_FUNC_GPIO << MCU_SEL_SHIFT;

/** What is driving a pad, if anything. */
type PadDriver = 'chip' | 'external' | 'pull' | 'none';

export interface Esp32C3GpioOptions {
  /**
   * Value the strapping register reports.
   *
   * On a DevKitM-1 the boot mode straps sit at their idle levels, which is what
   * a board that is running rather than being flashed reads back.
   */
  strapping?: number;
  /**
   * Where this chip's GPIO block, IO MUX and pin count come from.
   *
   * The C6 uses the same register layout at different addresses with more
   * pins — the offsets above are identical on both parts, the bases are not
   * (0x60091000 against 0x60004000, 0x60090000 against 0x60009000) and the C6
   * has 31 GPIOs to the C3's 22. Left out, these are the C3's.
   */
  base?: number;
  ioMuxBase?: number;
  pinCount?: number;
  /** The GPIO interrupt's source number on this chip's interrupt matrix (16 on the C3, 30 on the C6). */
  interruptSource?: number;
  /** FUNCn_IN_SEL_CFG: the GPIO-number mask, then the invert and route-through-matrix bits (C3: 0x1f, 5, 6; C6: 0x3f, 6, 7). */
  inSel?: { mask: number; invBit: number; sigSelBit: number };
}

/** What a peripheral is putting on one of its matrix output signals. */
export interface SignalDrive {
  level: 0 | 1;
  /** The peripheral's own output enable for the signal. */
  enable: boolean;
}

/**
 * The GPIO block, together with the IO MUX and matrix registers that decide
 * whether its output register reaches a pad at all.
 */
export class Esp32C3Gpio implements Peripheral {
  readonly name = 'gpio';
  readonly base: number;
  readonly size = 0x1000;

  /** How many pads this part has. */
  readonly pinCount: number;

  private readonly registers = new Map<number, number>();

  /** Levels a wire outside the chip is holding, by pin. */
  private readonly external = new Map<number, 0 | 1>();

  /** Last reported state per pin, so a change can carry what it replaced. */
  private readonly reported = new Map<number, PinState>();

  private readonly listeners = new Set<(change: PinChange) => void>();

  /** Peripheral output signals currently driven, by matrix signal number. */
  private readonly signals = new Map<number, SignalDrive>();

  /** Called when the GPIO interrupt may have changed without a register write. */
  onInterruptChange: (() => void) | null = null;

  /** The IO MUX, exposed as its own peripheral because it has its own base. */
  readonly ioMux: Esp32C3IoMux;

  constructor(
    private readonly clock: { readonly nanos: number },
    private readonly options: Esp32C3GpioOptions = {},
  ) {
    this.base = options.base ?? GPIO_BASE;
    this.pinCount = options.pinCount ?? ESP32C3_GPIO_COUNT;
    this.ioMux = new Esp32C3IoMux(() => this.refresh(), options.ioMuxBase ?? IO_MUX_BASE, this.pinCount);
    this.reset();
  }

  reset(): void {
    this.registers.clear();
    this.registers.set(GPIO_STRAP, (this.options.strapping ?? 0) >>> 0);
    // The matrix's reset state routes nothing: a pad only follows the GPIO
    // output register once firmware says so.
    for (let pin = 0; pin < this.pinCount; pin++) {
      this.registers.set(GPIO_FUNC_OUT_SEL_BASE + pin * 4, OUT_SEL_MASK);
    }
    this.external.clear();
    this.reported.clear();
    this.signals.clear();
    this.ioMux.reset();
    this.refresh();
  }

  // ------------------------------------------------------------------ bus

  readUint32(offset: number): number {
    if (offset === GPIO_IN) return this.inputRegister();
    if (offset === GPIO_PCPU_INT) return this.cpuInterruptStatus();
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  writeUint32(offset: number, value: number): void {
    const v = value >>> 0;
    switch (offset) {
      // The set and clear registers do not hold a value of their own; they
      // act on the register they belong to and read back as zero.
      case GPIO_OUT_W1TS:
        this.registers.set(GPIO_OUT, (this.peek(GPIO_OUT) | v) >>> 0);
        break;
      case GPIO_OUT_W1TC:
        this.registers.set(GPIO_OUT, (this.peek(GPIO_OUT) & ~v) >>> 0);
        break;
      case GPIO_ENABLE_W1TS:
        this.registers.set(GPIO_ENABLE, (this.peek(GPIO_ENABLE) | v) >>> 0);
        break;
      case GPIO_ENABLE_W1TC:
        this.registers.set(GPIO_ENABLE, (this.peek(GPIO_ENABLE) & ~v) >>> 0);
        break;
      case GPIO_STATUS_W1TS:
        this.registers.set(GPIO_STATUS, (this.peek(GPIO_STATUS) | v) >>> 0);
        break;
      case GPIO_STATUS_W1TC:
        this.registers.set(GPIO_STATUS, (this.peek(GPIO_STATUS) & ~v) >>> 0);
        // A level interrupt whose level still holds is raised again at once.
        this.latchLevels();
        break;
      case GPIO_IN:
      case GPIO_STRAP:
        // Driven by the pads and by the strapping resistors respectively.
        return;
      default:
        this.registers.set(offset, v);
    }
    this.refresh();
  }

  peek(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  // ------------------------------------------------------------ pad model

  private outSel(pin: number): number {
    return this.peek(GPIO_FUNC_OUT_SEL_BASE + pin * 4);
  }

  /**
   * What the matrix puts on a pad: whether it drives, and the level, before
   * open-drain is applied.
   *
   * SIG_GPIO_OUT_IDX means the pad follows the GPIO output and enable
   * registers. Any other signal is a peripheral's: its level comes from the
   * peripheral, and its enable too unless OEN_SEL hands that to the GPIO
   * enable register. A signal no modelled peripheral drives is left undriven
   * rather than guessed at. Either way the IO MUX must have given the pad to
   * the matrix.
   */
  private matrixDrive(pin: number): { driving: boolean; value: 0 | 1 } {
    if (this.ioMux.functionOf(pin) !== PIN_FUNC_GPIO) return { driving: false, value: 0 };
    const config = this.outSel(pin);
    const signal = config & OUT_SEL_MASK;
    const gpioEnabled = (this.peek(GPIO_ENABLE) & (1 << pin)) !== 0;
    let enabled: boolean;
    let value: 0 | 1;
    if (signal === SIG_GPIO_OUT_IDX) {
      enabled = gpioEnabled;
      value = (this.peek(GPIO_OUT) & (1 << pin)) !== 0 ? 1 : 0;
    } else {
      const drive = this.signals.get(signal);
      if (!drive) return { driving: false, value: 0 };
      enabled = (config & OEN_SEL) !== 0 ? gpioEnabled : drive.enable;
      value = drive.level;
    }
    if ((config & OEN_INV_SEL) !== 0) enabled = !enabled;
    if ((config & OUT_INV_SEL) !== 0) value = (1 - value) as 0 | 1;
    return { driving: enabled, value };
  }

  private openDrain(pin: number): boolean {
    return (this.peek(GPIO_PIN_BASE + pin * 4) & GPIO_PIN_PAD_DRIVER) !== 0;
  }

  /**
   * Resolves what is actually on a pad.
   *
   * The chip wins when it is driving, except in open-drain mode where driving
   * a one means letting go — that is the whole point of open drain, and a
   * pull-up or another device decides the level instead.
   */
  private resolve(pin: number): { level: PinLevel; driver: PadDriver } {
    const { driving, value } = this.matrixDrive(pin);
    if (driving) {
      if (!(this.openDrain(pin) && value === 1)) return { level: value, driver: 'chip' };
    }
    const external = this.external.get(pin);
    if (external !== undefined) return { level: external, driver: 'external' };
    const pull = this.ioMux.pullOf(pin);
    if (pull === 'up') return { level: 1, driver: 'pull' };
    if (pull === 'down') return { level: 0, driver: 'pull' };
    // Nothing holds it. A real floating pin reads whatever noise reaches it,
    // and inventing a level here would hide a genuine wiring mistake.
    return { level: undefined, driver: 'none' };
  }

  /**
   * GPIO_IN, as the hardware presents it.
   *
   * A pad whose input buffer is off reads zero, which is what the chip does
   * and why firmware enables the buffer before reading. A floating pad has no
   * defined level; zero is what this reports, and the pin state alongside says
   * the level is indeterminate so the difference is not lost.
   */
  private inputRegister(): number {
    let value = 0;
    for (let pin = 0; pin < this.pinCount; pin++) {
      if (!this.ioMux.inputEnabled(pin)) continue;
      if (this.resolve(pin).level === 1) value |= 1 << pin;
    }
    return value >>> 0;
  }

  // --------------------------------------------------------- exposed state

  pinNumbers(): number[] {
    return Array.from({ length: this.pinCount }, (_, i) => i);
  }

  pinState(pin: number): PinState {
    const { level } = this.resolve(pin);
    const { driving } = this.matrixDrive(pin);
    const direction = driving ? 'output' : this.ioMux.inputEnabled(pin) ? 'input' : 'disabled';
    return {
      pin,
      direction,
      level,
      pull: this.ioMux.pullOf(pin),
      openDrain: driving && this.openDrain(pin),
      timestamp: this.clock.nanos,
    };
  }

  /** Drives a pin from outside the chip, as a wire on the canvas would. */
  drivePin(pin: number, level: 0 | 1 | undefined): void {
    if (pin < 0 || pin >= this.pinCount) return;
    if (level === undefined) this.external.delete(pin);
    else this.external.set(pin, level);
    this.refresh();
  }

  onPinChange(listener: (change: PinChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Recomputes every pad and reports the ones that moved.
   *
   * Called after anything that can change a pad — a register write, an
   * external drive — rather than on a schedule, so a change is reported at the
   * moment it happens and never later.
   */
  private refresh(): void {
    const before = this.cpuInterruptStatus();
    for (let pin = 0; pin < this.pinCount; pin++) {
      const current = this.pinState(pin);
      const previous = this.reported.get(pin);
      this.reported.set(pin, current);
      if (previous === undefined) continue;
      if (previous.level !== current.level) this.edge(pin, current.level === 1);
      if (!pinStateChanged(previous, current)) continue;
      for (const listener of this.listeners) listener({ previous, current });
    }
    this.latchLevels();
    if (this.cpuInterruptStatus() !== before) this.onInterruptChange?.();
  }

  // ------------------------------------------------------------- matrix signals

  /**
   * A peripheral drives one of its output signals. Pads the matrix routes the
   * signal to follow at once, and report the change like any other.
   */
  driveSignal(signal: number, drive: SignalDrive | undefined): void {
    const previous = this.signals.get(signal);
    if (drive === undefined) {
      if (!previous) return;
      this.signals.delete(signal);
    } else {
      if (previous && previous.level === drive.level && previous.enable === drive.enable) return;
      this.signals.set(signal, drive);
    }
    this.refresh();
  }

  /**
   * The pad a peripheral input signal reads, if the matrix routes one to it.
   * A signal not routed through the matrix (SIG_IN_SEL clear) reads its IO MUX
   * pad directly, which no modelled peripheral uses, so it reports none.
   */
  inputSignalPin(signal: number): number | undefined {
    const layout = this.options.inSel ?? { mask: 0x1f, invBit: 5, sigSelBit: 6 };
    const config = this.peek(GPIO_FUNC_IN_SEL_BASE + signal * 4);
    if (!(config & (1 << layout.sigSelBit))) return undefined;
    const pin = config & layout.mask;
    return pin < this.pinCount ? pin : undefined;
  }

  /** The first pad the matrix routes a peripheral output signal to, if any. */
  outputSignalPin(signal: number): number | undefined {
    for (let pin = 0; pin < this.pinCount; pin++) {
      if (this.ioMux.functionOf(pin) === PIN_FUNC_GPIO && (this.outSel(pin) & OUT_SEL_MASK) === signal) return pin;
    }
    return undefined;
  }

  /** The level a peripheral input signal sees: its pad, inverted if asked, or a constant. */
  inputSignalLevel(signal: number): 0 | 1 {
    const layout = this.options.inSel ?? { mask: 0x1f, invBit: 5, sigSelBit: 6 };
    const config = this.peek(GPIO_FUNC_IN_SEL_BASE + signal * 4);
    const pin = config & layout.mask;
    // Past the last GPIO are the constants: the highest numbers read high.
    let level: 0 | 1 = pin < this.pinCount ? (this.resolve(pin).level === 1 ? 1 : 0) : pin === layout.mask ? 1 : 0;
    if (config & (1 << layout.invBit)) level = (1 - level) as 0 | 1;
    return level;
  }

  // --------------------------------------------------------------- interrupts

  private intType(pin: number): number {
    return (this.peek(GPIO_PIN_BASE + pin * 4) >>> INT_TYPE_SHIFT) & 0x7;
  }

  /** An edge on a pad sets its STATUS bit if the pin's interrupt type wants it. */
  private edge(pin: number, high: boolean): void {
    const type = this.intType(pin);
    if (type === INT_ANY_EDGE || (type === INT_RISING && high) || (type === INT_FALLING && !high)) {
      this.registers.set(GPIO_STATUS, (this.peek(GPIO_STATUS) | (1 << pin)) >>> 0);
    }
  }

  /** Level types hold their STATUS bit for as long as the level does. */
  private latchLevels(): void {
    let set = 0;
    for (let pin = 0; pin < this.pinCount; pin++) {
      const type = this.intType(pin);
      if (type !== INT_LOW && type !== INT_HIGH) continue;
      if (this.resolve(pin).level === (type === INT_HIGH ? 1 : 0)) set |= 1 << pin;
    }
    if (set) this.registers.set(GPIO_STATUS, (this.peek(GPIO_STATUS) | set) >>> 0);
  }

  /** GPIO_PCPU_INT: the STATUS bits of pins whose interrupt goes to the CPU. */
  private cpuInterruptStatus(): number {
    const status = this.peek(GPIO_STATUS);
    if (!status) return 0;
    let value = 0;
    for (let pin = 0; pin < this.pinCount; pin++) {
      if (status & (1 << pin) && this.peek(GPIO_PIN_BASE + pin * 4) & INT_ENA_CPU) value |= 1 << pin;
    }
    return value >>> 0;
  }

  /** The GPIO interrupt source is asserted while any CPU-enabled pin has its STATUS bit. */
  assertedInterruptSources(): number[] {
    const source = this.options.interruptSource;
    return source !== undefined && this.cpuInterruptStatus() !== 0 ? [source] : [];
  }
}

/**
 * The IO MUX.
 *
 * A separate peripheral because it has its own base address, but it belongs
 * with the GPIO block: it decides whether the GPIO matrix owns a pad at all,
 * and it holds the pulls and the input buffer enable.
 */
export class Esp32C3IoMux implements Peripheral {
  readonly name = 'io_mux';
  readonly size = 0x1000;

  private readonly registers = new Map<number, number>();

  constructor(
    private readonly onChange: () => void,
    readonly base = IO_MUX_BASE,
    private readonly pinCount = ESP32C3_GPIO_COUNT,
  ) {
    this.reset();
  }

  reset(): void {
    this.registers.clear();
    for (let pin = 0; pin < this.pinCount; pin++) {
      this.registers.set(IO_MUX_PIN_BASE + pin * 4, IO_MUX_RESET);
    }
  }

  readUint32(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  writeUint32(offset: number, value: number): void {
    this.registers.set(offset, value >>> 0);
    this.onChange();
  }

  private padRegister(pin: number): number {
    return (this.registers.get(IO_MUX_PIN_BASE + pin * 4) ?? 0) >>> 0;
  }

  /** Which IO MUX function currently owns the pad. */
  functionOf(pin: number): number {
    return (this.padRegister(pin) >>> MCU_SEL_SHIFT) & MCU_SEL_MASK;
  }

  inputEnabled(pin: number): boolean {
    return (this.padRegister(pin) & FUN_IE) !== 0;
  }

  pullOf(pin: number): PinPull {
    const config = this.padRegister(pin);
    // Both enabled is a firmware mistake rather than a state the pad can be
    // in; the pull-up wins on this part, as it is the stronger of the two.
    if ((config & FUN_PU) !== 0) return 'up';
    if ((config & FUN_PD) !== 0) return 'down';
    return 'none';
  }
}
