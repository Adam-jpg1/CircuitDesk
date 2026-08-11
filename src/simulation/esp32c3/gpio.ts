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
const GPIO_PIN_BASE = 0x74;
const GPIO_FUNC_IN_SEL_BASE = 0x154;
const GPIO_FUNC_OUT_SEL_BASE = 0x554;

/** GPIO_PINn_REG: bit 2 puts the pad into open-drain mode. */
const GPIO_PIN_PAD_DRIVER = 1 << 2;

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
    this.ioMux.reset();
    this.refresh();
  }

  // ------------------------------------------------------------------ bus

  readUint32(offset: number): number {
    if (offset === GPIO_IN) return this.inputRegister();
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

  /** True when the matrix and IO MUX let the GPIO register reach this pad. */
  private padFollowsGpioRegister(pin: number): boolean {
    if (this.ioMux.functionOf(pin) !== PIN_FUNC_GPIO) return false;
    return (this.peek(GPIO_FUNC_OUT_SEL_BASE + pin * 4) & OUT_SEL_MASK) === SIG_GPIO_OUT_IDX;
  }

  /**
   * True when the pad is configured to drive at all.
   *
   * Where the enable comes from depends on what the matrix routed. The
   * special signal meaning "this is a plain GPIO" carries its enable in the
   * GPIO enable register, and firmware leaves OEN_SEL clear for it — requiring
   * that bit would leave every ordinary output looking undriven. A pad routed
   * to a real peripheral takes its enable from that peripheral unless OEN_SEL
   * overrides it, and those peripherals are not modelled here, so such a pad
   * is reported as not driven rather than guessed at.
   */
  private outputEnabled(pin: number): boolean {
    if (this.ioMux.functionOf(pin) !== PIN_FUNC_GPIO) return false;
    const config = this.peek(GPIO_FUNC_OUT_SEL_BASE + pin * 4);
    const fromGpioRegister = (config & OUT_SEL_MASK) === SIG_GPIO_OUT_IDX || (config & OEN_SEL) !== 0;
    if (!fromGpioRegister) return false;
    const enabled = (this.peek(GPIO_ENABLE) & (1 << pin)) !== 0;
    return (config & OEN_INV_SEL) !== 0 ? !enabled : enabled;
  }

  /** The value the chip would put on the pad, before open-drain is applied. */
  private outputValue(pin: number): 0 | 1 {
    const value = (this.peek(GPIO_OUT) & (1 << pin)) !== 0 ? 1 : 0;
    const inverted = (this.peek(GPIO_FUNC_OUT_SEL_BASE + pin * 4) & OUT_INV_SEL) !== 0;
    return (inverted ? 1 - value : value) as 0 | 1;
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
    const driving = this.outputEnabled(pin) && this.padFollowsGpioRegister(pin);
    if (driving) {
      const value = this.outputValue(pin);
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
    const driving = this.outputEnabled(pin) && this.padFollowsGpioRegister(pin);
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
    for (let pin = 0; pin < this.pinCount; pin++) {
      const current = this.pinState(pin);
      const previous = this.reported.get(pin);
      this.reported.set(pin, current);
      if (previous === undefined || !pinStateChanged(previous, current)) continue;
      for (const listener of this.listeners) listener({ previous, current });
    }
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
