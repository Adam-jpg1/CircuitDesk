// I2C port expanders — PCF8574, PCF8575 and MCP23017.
//
// These are the first devices in the library that *drive pins*. Everything
// before them either answered the bus (a sensor) or lit up (a display); an
// expander's whole job is to become eight or sixteen more GPIOs, which means
// its output pins have to appear on real nets and its input pins have to read
// what is actually on them.
//
// The PCF8574 has no registers at all — you write a byte and you read a byte —
// and its outputs are quasi-bidirectional: writing a 1 does not drive high, it
// releases the pin to a weak pull-up, which is precisely why the standard way
// to read an input is to write 1 to it first. Getting that wrong turns every
// input into a permanently-high pin, so it is modelled properly.
//
// The MCP23017 does have registers, two banks of them, plus configurable
// direction, pull-ups, polarity inversion and interrupt-on-change.
//
// NOT modelled: MCP23017 BANK=1 addressing (the sequential map is the one
// libraries use), interrupt-on-compare against DEFVAL (INTCON and DEFVAL are
// stored and read back, but interrupts fire on any change), and the open-drain
// and mirror bits of IOCON.

import type { DeviceSnapshot, I2cDevice } from './types';

export const PCF8574_ADDRESSES = [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27] as const;
export const MCP23017_ADDRESSES = [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27] as const;

/**
 * What an expander pin is doing electrically.
 *
 * `drive-low` is a real low-impedance pull to ground. `weak-high` is the
 * quasi-bidirectional state: released with a pull-up, which anything outside
 * can override. `high-z` is a configured input on a part with real direction
 * control. Collapsing these three into "high or low" is what would make the
 * PCF8574's read protocol impossible to reproduce.
 */
export type ExpanderPinState = 'drive-low' | 'drive-high' | 'weak-high' | 'high-z';

export interface ExpanderDevice extends I2cDevice {
  /** How many IO pins this part has. */
  readonly pinCount: number;
  /** What pin n is doing right now. */
  pinState(index: number): ExpanderPinState;
  /** Tells the device what the outside world has put on a pin. */
  setInputLevel(index: number, high: boolean | null): void;
  /** True when the interrupt output is asserted. */
  readonly interruptAsserted: boolean;
}

// ------------------------------------------------------------------ PCF857x

/**
 * PCF8574 / PCF8575 — a latch and nothing else.
 *
 * One byte (or word) in, one out. There is no direction register: a bit
 * written as 1 releases the pin to a weak pull-up, and a bit written as 0
 * pulls it firmly low. Reading returns whatever is actually on the pins.
 */
export class Pcf857xDevice implements ExpanderDevice {
  readonly instanceId: string;
  private readonly address: number;
  readonly pinCount: number;

  /** The output latch. Every bit starts at 1, as it does at power-on. */
  private latch: number;
  /** What the outside world is holding each pin at, when it is holding it. */
  private external: (boolean | null)[];
  private pendingRead: number[] = [];
  private lastReadValue = 0;
  private writePhase = 0;
  private log: string[] = [];

  constructor(instanceId: string, address: number, pinCount: 8 | 16) {
    this.instanceId = instanceId;
    this.address = address;
    this.pinCount = pinCount;
    this.latch = pinCount === 8 ? 0xff : 0xffff;
    this.external = new Array(pinCount).fill(null);
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  start(_address: number, write: boolean): void {
    if (write) this.writePhase = 0;
    else this.pendingRead = this.readBytes();
  }

  stop(): void {
    this.pendingRead = [];
    this.writePhase = 0;
  }

  writeByte(value: number): boolean {
    if (this.pinCount === 8) {
      this.latch = value & 0xff;
      return true;
    }
    // The 8575 takes two bytes, low then high.
    this.latch =
      this.writePhase === 0
        ? (this.latch & 0xff00) | (value & 0xff)
        : (this.latch & 0x00ff) | ((value & 0xff) << 8);
    this.writePhase = this.writePhase === 0 ? 1 : 0;
    return true;
  }

  readByte(): number {
    if (this.pendingRead.length === 0) this.pendingRead = this.readBytes();
    return this.pendingRead.shift() ?? 0xff;
  }

  /**
   * What a read returns: the actual pin levels.
   *
   * A pin the latch is holding low reads low whatever is outside — that is
   * what "pulled firmly low" means. A pin released to its pull-up reads
   * whatever the outside world is doing, or high if nothing is.
   */
  private readBytes(): number[] {
    const value = this.currentPinValue();
    this.lastReadValue = value;
    return this.pinCount === 8 ? [value & 0xff] : [value & 0xff, (value >> 8) & 0xff];
  }

  private currentPinValue(): number {
    let value = 0;
    for (let i = 0; i < this.pinCount; i++) {
      const released = ((this.latch >> i) & 1) === 1;
      const bit = !released ? 0 : this.external[i] === null ? 1 : this.external[i] ? 1 : 0;
      value |= bit << i;
    }
    return value;
  }

  pinState(index: number): ExpanderPinState {
    if (index < 0 || index >= this.pinCount) return 'high-z';
    // Quasi-bidirectional: 0 drives, 1 merely releases to a pull-up.
    return ((this.latch >> index) & 1) === 0 ? 'drive-low' : 'weak-high';
  }

  setInputLevel(index: number, high: boolean | null): void {
    if (index >= 0 && index < this.pinCount) this.external[index] = high;
  }

  /** The PCF857x asserts INT when a pin changes away from the last read. */
  get interruptAsserted(): boolean {
    return this.currentPinValue() !== this.lastReadValue;
  }

  get latchValue(): number {
    return this.latch;
  }

  reset(): void {
    this.latch = this.pinCount === 8 ? 0xff : 0xffff;
    this.external.fill(null);
    this.writePhase = 0;
    this.log.push('reset');
  }

  snapshot(): DeviceSnapshot {
    return {
      status: `latch 0x${this.latch.toString(16).padStart(this.pinCount / 4, '0')}`,
      log: this.log.slice(-16),
    };
  }
}

// ----------------------------------------------------------------- MCP23017

/** Register numbers in the sequential (BANK=0) map libraries use. */
export const MCP23017_REG = {
  IODIRA: 0x00, IODIRB: 0x01,
  IPOLA: 0x02, IPOLB: 0x03,
  GPINTENA: 0x04, GPINTENB: 0x05,
  DEFVALA: 0x06, DEFVALB: 0x07,
  INTCONA: 0x08, INTCONB: 0x09,
  IOCON: 0x0a,
  GPPUA: 0x0c, GPPUB: 0x0d,
  INTFA: 0x0e, INTFB: 0x0f,
  INTCAPA: 0x10, INTCAPB: 0x11,
  GPIOA: 0x12, GPIOB: 0x13,
  OLATA: 0x14, OLATB: 0x15,
} as const;

/**
 * MCP23017 — sixteen real GPIOs with direction, pull-ups and interrupts.
 *
 * Unlike the PCF857x these pins have genuine direction control: an output
 * drives both ways, and an input is high impedance with an optional pull-up.
 * That difference is the reason to choose one part over the other, so the
 * model keeps it.
 */
export class Mcp23017Device implements ExpanderDevice {
  readonly instanceId: string;
  private readonly address: number;
  readonly pinCount = 16;

  /** 1 = input, which is the power-on state. */
  private iodir = 0xffff;
  private ipol = 0x0000;
  private gpinten = 0x0000;
  private defval = 0x0000;
  private intcon = 0x0000;
  private iocon = 0x00;
  private gppu = 0x0000;
  private olat = 0x0000;
  private intf = 0x0000;
  private intcap = 0x0000;

  private external: (boolean | null)[] = new Array(16).fill(null);
  private pointer = 0;
  private pointerSet = false;
  private reading = false;
  private log: string[] = [];
  private unknown: number[] = [];

  constructor(instanceId: string, address: number) {
    this.instanceId = instanceId;
    this.address = address;
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    if (write) this.pointerSet = false;
  }

  stop(): void {
    this.pointerSet = false;
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    if (!this.pointerSet) {
      this.pointer = value & 0xff;
      this.pointerSet = true;
      return true;
    }
    const ok = this.writeRegister(this.pointer, value & 0xff);
    // Sequential mode auto-increments, which is how libraries write pairs.
    if ((this.iocon & 0x20) === 0) this.pointer = (this.pointer + 1) & 0xff;
    return ok;
  }

  readByte(): number {
    const value = this.readRegister(this.pointer);
    if ((this.iocon & 0x20) === 0) this.pointer = (this.pointer + 1) & 0xff;
    return value ?? 0xff;
  }

  /** What each pin actually reads: outside world, pull-up, or the latch. */
  private gpioValue(): number {
    let value = 0;
    for (let i = 0; i < 16; i++) {
      const isInput = ((this.iodir >> i) & 1) === 1;
      let bit: number;
      if (!isInput) {
        bit = (this.olat >> i) & 1;
      } else if (this.external[i] !== null) {
        bit = this.external[i] ? 1 : 0;
      } else {
        // Floating with no pull-up is genuinely undefined; reporting the
        // pull-up state is the honest answer available here.
        bit = ((this.gppu >> i) & 1) === 1 ? 1 : 0;
      }
      // Polarity inversion applies to inputs only, as the datasheet says.
      if (isInput && ((this.ipol >> i) & 1) === 1) bit ^= 1;
      value |= bit << i;
    }
    return value;
  }

  private readRegister(register: number): number | null {
    const hi = (v: number) => (v >> 8) & 0xff;
    const lo = (v: number) => v & 0xff;
    switch (register) {
      case MCP23017_REG.IODIRA: return lo(this.iodir);
      case MCP23017_REG.IODIRB: return hi(this.iodir);
      case MCP23017_REG.IPOLA: return lo(this.ipol);
      case MCP23017_REG.IPOLB: return hi(this.ipol);
      case MCP23017_REG.GPINTENA: return lo(this.gpinten);
      case MCP23017_REG.GPINTENB: return hi(this.gpinten);
      case MCP23017_REG.DEFVALA: return lo(this.defval);
      case MCP23017_REG.DEFVALB: return hi(this.defval);
      case MCP23017_REG.INTCONA: return lo(this.intcon);
      case MCP23017_REG.INTCONB: return hi(this.intcon);
      case MCP23017_REG.IOCON: return this.iocon;
      case MCP23017_REG.GPPUA: return lo(this.gppu);
      case MCP23017_REG.GPPUB: return hi(this.gppu);
      case MCP23017_REG.INTFA: return lo(this.intf);
      case MCP23017_REG.INTFB: return hi(this.intf);
      case MCP23017_REG.INTCAPA: {
        // Reading INTCAP clears the interrupt, as it does on hardware.
        const v = lo(this.intcap);
        this.intf &= 0xff00;
        return v;
      }
      case MCP23017_REG.INTCAPB: {
        const v = hi(this.intcap);
        this.intf &= 0x00ff;
        return v;
      }
      case MCP23017_REG.GPIOA: return lo(this.gpioValue());
      case MCP23017_REG.GPIOB: return hi(this.gpioValue());
      case MCP23017_REG.OLATA: return lo(this.olat);
      case MCP23017_REG.OLATB: return hi(this.olat);
      default:
        this.unknown.push(register);
        return null;
    }
  }

  private writeRegister(register: number, value: number): boolean {
    const setLo = (current: number) => (current & 0xff00) | value;
    const setHi = (current: number) => (current & 0x00ff) | (value << 8);
    switch (register) {
      case MCP23017_REG.IODIRA: this.iodir = setLo(this.iodir); return true;
      case MCP23017_REG.IODIRB: this.iodir = setHi(this.iodir); return true;
      case MCP23017_REG.IPOLA: this.ipol = setLo(this.ipol); return true;
      case MCP23017_REG.IPOLB: this.ipol = setHi(this.ipol); return true;
      case MCP23017_REG.GPINTENA: this.gpinten = setLo(this.gpinten); return true;
      case MCP23017_REG.GPINTENB: this.gpinten = setHi(this.gpinten); return true;
      case MCP23017_REG.DEFVALA: this.defval = setLo(this.defval); return true;
      case MCP23017_REG.DEFVALB: this.defval = setHi(this.defval); return true;
      case MCP23017_REG.INTCONA: this.intcon = setLo(this.intcon); return true;
      case MCP23017_REG.INTCONB: this.intcon = setHi(this.intcon); return true;
      case MCP23017_REG.IOCON: this.iocon = value; return true;
      case MCP23017_REG.GPPUA: this.gppu = setLo(this.gppu); return true;
      case MCP23017_REG.GPPUB: this.gppu = setHi(this.gppu); return true;
      // Writing GPIO writes the output latch, which is what surprises people.
      case MCP23017_REG.GPIOA:
      case MCP23017_REG.OLATA: this.olat = setLo(this.olat); return true;
      case MCP23017_REG.GPIOB:
      case MCP23017_REG.OLATB: this.olat = setHi(this.olat); return true;
      default:
        this.unknown.push(register);
        return false;
    }
  }

  pinState(index: number): ExpanderPinState {
    if (index < 0 || index >= 16) return 'high-z';
    const isInput = ((this.iodir >> index) & 1) === 1;
    if (isInput) return ((this.gppu >> index) & 1) === 1 ? 'weak-high' : 'high-z';
    return ((this.olat >> index) & 1) === 1 ? 'drive-high' : 'drive-low';
  }

  setInputLevel(index: number, high: boolean | null): void {
    if (index < 0 || index >= 16) return;
    const before = this.external[index];
    this.external[index] = high;
    if (before === high) return;
    // Interrupt on change, for enabled input pins.
    if (((this.gpinten >> index) & 1) === 1 && ((this.iodir >> index) & 1) === 1) {
      this.intf |= 1 << index;
      this.intcap = this.gpioValue();
    }
  }

  get interruptAsserted(): boolean {
    return this.intf !== 0;
  }

  get directionRegister(): number {
    return this.iodir;
  }

  get outputLatch(): number {
    return this.olat;
  }

  reset(): void {
    this.iodir = 0xffff;
    this.ipol = 0;
    this.gpinten = 0;
    this.defval = 0;
    this.intcon = 0;
    this.iocon = 0;
    this.gppu = 0;
    this.olat = 0;
    this.intf = 0;
    this.external.fill(null);
    this.log.push('reset');
  }

  snapshot(): DeviceSnapshot {
    return {
      status: `dir 0x${this.iodir.toString(16).padStart(4, '0')} · out 0x${this.olat.toString(16).padStart(4, '0')}${this.interruptAsserted ? ' · INT' : ''}`,
      log: [...this.log.slice(-14), ...(this.unknown.length ? [`${this.unknown.length} unknown register(s)`] : [])],
    };
  }
}
