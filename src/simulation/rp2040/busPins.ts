// Which GP pins the RP2040's I2C and SPI controllers are currently driving.
//
// WHY THIS IS NOT A CONSTANT
//
// The RP2040 does not bond its buses to fixed pins the way an AVR does. Every
// controller appears at several places in the GPIO function-select table, and
// the Arduino-Pico core lets a sketch choose between them with `Wire.setSDA()`
// or `SPI.setSCK()` before `begin()`. Hard-coding one set of pins would make a
// perfectly ordinary sketch appear to talk to nothing.
//
// So the mapping is read back from the pads themselves: whichever pins the
// firmware has muxed to the I2C or SPI function *are* the bus. That is the
// same principle the clock tree follows — derive behaviour from the registers
// the firmware actually programmed, not from an assumption about what it
// probably did.
//
// The tables below are the RP2040 datasheet's GPIO function table (section
// 2.19.2). The pattern is regular, so it is expressed as arithmetic rather
// than copied out as thirty rows.

/** Function-select values from the datasheet's GPIO function table. */
export const FUNCSEL_SPI = 1;
export const FUNCSEL_UART = 2;
export const FUNCSEL_I2C = 3;
export const FUNCSEL_PWM = 4;
export const FUNCSEL_SIO = 5;
export const FUNCSEL_NULL = 0x1f;

/** Highest GPIO on the die. */
const MAX_GPIO = 29;

/**
 * The pins the installed Arduino-Pico core uses before a sketch says otherwise.
 *
 * These are needed as a starting point, not as an answer. A device wired to the
 * canvas is on its pins from the moment the project loads, but the RP2040 does
 * not mux a bus until the sketch calls `Wire.begin()` or `SPI.begin()` inside
 * `setup()`. Without a documented default, a device could not be attached in
 * time to answer a transaction issued in that same `setup()`.
 *
 * As soon as the firmware muxes anything, the live reading wins — including
 * when a sketch calls `Wire.setSDA()` to move the bus somewhere else.
 */
export const ARDUINO_PICO_DEFAULT_I2C: Required<Pick<I2cPinAssignment, 'sda' | 'scl'>> & { instance: 0 } = {
  sda: 4,
  scl: 5,
  instance: 0,
};

export const ARDUINO_PICO_DEFAULT_SPI: Required<Pick<SpiPinAssignment, 'sck' | 'mosi' | 'miso' | 'cs'>> & {
  instance: 0;
} = {
  miso: 16,
  cs: 17,
  sck: 18,
  mosi: 19,
  instance: 0,
};

export interface I2cPinAssignment {
  sda?: number;
  scl?: number;
  /** Which of the chip's two I2C controllers these pins belong to. */
  instance?: 0 | 1;
}

export interface SpiPinAssignment {
  sck?: number;
  mosi?: number;
  miso?: number;
  /** Hardware chip-select pin, when the firmware muxed one. Most Arduino
   *  sketches drive CS as a plain GPIO instead, which is why this is optional. */
  cs?: number;
  instance?: 0 | 1;
}

/**
 * I2C role of a pin when it is muxed to the I2C function.
 *
 * Even pins are SDA and odd pins are SCL, and the controller alternates every
 * two pins: GP0/GP1 are I2C0, GP2/GP3 are I2C1, GP4/GP5 are I2C0 again.
 */
export function rp2040I2cRole(pin: number): { instance: 0 | 1; line: 'sda' | 'scl' } | null {
  if (pin < 0 || pin > MAX_GPIO) return null;
  return {
    instance: ((pin >> 1) & 1) as 0 | 1,
    line: pin % 2 === 0 ? 'sda' : 'scl',
  };
}

/**
 * SPI role of a pin when it is muxed to the SPI function.
 *
 * The four lines repeat every four pins in the order RX, CSn, SCK, TX, and the
 * controller alternates every eight: GP0-GP7 are SPI0, GP8-GP15 are SPI1,
 * GP16-GP23 are SPI0, GP24-GP29 are SPI1.
 */
export function rp2040SpiRole(pin: number): { instance: 0 | 1; line: 'miso' | 'cs' | 'sck' | 'mosi' } | null {
  if (pin < 0 || pin > MAX_GPIO) return null;
  const lines = ['miso', 'cs', 'sck', 'mosi'] as const;
  return {
    instance: (((pin >> 2) >> 1) & 1) as 0 | 1,
    line: lines[pin % 4],
  };
}

/** The subset of a GPIO pad this module reads. */
export interface PadFunction {
  readonly functionSelect: number;
}

/**
 * Reads the live I2C pin assignment out of the pads.
 *
 * Returns the first controller that has both lines muxed. A sketch that has
 * not called `Wire.begin()` yet has no I2C pins at all, which is reported as
 * an empty assignment rather than as a guess.
 */
export function readI2cPins(pads: readonly PadFunction[]): I2cPinAssignment {
  const found: Record<number, I2cPinAssignment> = {};
  for (let pin = 0; pin < pads.length && pin <= MAX_GPIO; pin++) {
    if (pads[pin]?.functionSelect !== FUNCSEL_I2C) continue;
    const role = rp2040I2cRole(pin);
    if (!role) continue;
    const entry = (found[role.instance] ??= { instance: role.instance });
    entry[role.line] ??= pin;
  }
  for (const instance of [0, 1] as const) {
    const entry = found[instance];
    if (entry?.sda !== undefined && entry?.scl !== undefined) return entry;
  }
  return found[0] ?? found[1] ?? {};
}

/**
 * Reads the live SPI pin assignment out of the pads.
 *
 * SCK is the line that matters: a sketch can leave MISO unmuxed on a
 * write-only bus, and most drive chip-select as a plain GPIO.
 */
export function readSpiPins(pads: readonly PadFunction[]): SpiPinAssignment {
  const found: Record<number, SpiPinAssignment> = {};
  for (let pin = 0; pin < pads.length && pin <= MAX_GPIO; pin++) {
    if (pads[pin]?.functionSelect !== FUNCSEL_SPI) continue;
    const role = rp2040SpiRole(pin);
    if (!role) continue;
    const entry = (found[role.instance] ??= { instance: role.instance });
    entry[role.line] ??= pin;
  }
  for (const instance of [0, 1] as const) {
    if (found[instance]?.sck !== undefined) return found[instance];
  }
  return found[0] ?? found[1] ?? {};
}
