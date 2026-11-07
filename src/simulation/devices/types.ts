// Peripheral device models.
//
// A device model is the component-side half of a simulation: the MCU emulator
// provides the bus or pin, and a device here decides how real hardware would
// answer. Nothing in this folder may invent a response — an unaddressed device
// must stay silent, an unknown command must be recorded as unhandled, and a
// device that is not wired up must not react at all.
//
// Only the I2C layer is implemented today; the other interfaces are declared so
// the shape of the next milestones is fixed and devices can be added without
// reworking the plumbing. An interface here does NOT imply a working device —
// see the capability table for what is genuinely claimed.

/** Something the canvas can draw and the inspector can read back. */
export interface DeviceSnapshot {
  /** Short human summary, e.g. "display on, 1024 bytes written". */
  status: string;
  /** Bus/command activity, newest last, capped by the device. */
  log: string[];
}

export interface SimDevice {
  readonly instanceId: string;
  /** Returns the device to power-on state. */
  reset(): void;
  snapshot(): DeviceSnapshot;
}

/** Driven by a single digital pin level (relay coil, simple LED, …). */
export interface DigitalDevice extends SimDevice {
  onPinLevel(pinId: string, high: boolean): void;
}

/** Sources an analog voltage onto a net (sensors that feed the ADC). */
export interface AnalogDevice extends SimDevice {
  /** Volts this device drives onto `pinId`, or null when it is not driving. */
  analogOut(pinId: string): number | null;
}

/** Consumes a measured duty cycle / pulse width (servo, motor, dimmer). */
export interface PwmDevice extends SimDevice {
  onPwm(pinId: string, duty: number, pulseWidthUs: number): void;
}

/** Attached to a UART; receives TX bytes and may emit RX bytes. */
export interface UartDevice extends SimDevice {
  onByteFromMcu(byte: number): void;
  /** Bytes the device wants to send back, drained by the runner. */
  takeBytesForMcu(): number[];
}

/**
 * An I2C target. The bus calls these in the order the controller drives them.
 *
 * `matchesAddress` is what makes a wrong address genuinely fail: the bus NACKs
 * when no device claims the address, exactly as real hardware would.
 */
export interface I2cDevice extends SimDevice {
  matchesAddress(address: number): boolean;
  /** Bus START (or repeated START) directed at this device. */
  start(address: number, write: boolean): void;
  /** Controller wrote a byte; return false to NACK it. */
  writeByte(value: number): boolean;
  /** Controller is reading; return the byte this device drives. */
  readByte(): number;
  stop(): void;
}

/** Datasheet SPI mode numbering: (CPOL << 1) | CPHA. */
export type SpiMode = 0 | 1 | 2 | 3;

/**
 * An SPI target.
 *
 * Selection is decided by the bus from the real chip-select pin level, not by
 * the device — a part whose CS is never pulled low simply never sees traffic.
 */
/** Reads one of a device's non-bus control lines. Undefined when unwired. */
export type ControlPinReader = (pinId: string) => boolean | undefined;

export interface SpiDevice extends SimDevice {
  /**
   * Re-points the device at its control lines.
   *
   * Called on every bind, not only on creation: a wiring edit rebinds the
   * circuit without power-cycling anything, so a display that keeps its
   * framebuffer must also stop reading the pad its D/C used to be on.
   */
  attachControls?(read: ControlPinReader): void;
  /**
   * Component pin id that selects this device, or null for parts with no chip
   * select that shift whatever appears on the clock (a 74HC595 does this).
   */
  readonly csPinId: string | null;
  /** SPI modes the silicon actually accepts; anything else is a wiring bug. */
  readonly supportedModes: readonly SpiMode[];
  select(active: boolean): void;
  /**
   * One full-duplex byte. Receives the MOSI byte as it appears on the wire and
   * returns the MISO byte, or null when this part does not drive MISO at all.
   */
  transfer(mosi: number): number | null;
}
