// Which SERCOM pad each SAMD21 pin carries on peripheral functions C (SERCOM)
// and D (SERCOM-ALT), from the datasheet's I/O multiplexing table. Pins are
// group * 32 + bit, as the runner numbers them.
//
// The boards' variants agree with it on every bus pin they define: the
// Feather's SDA/SCL are SERCOM3 PAD0/PAD1 on function C and its SPI is
// SERCOM4 on D; the QT Py's I2C is SERCOM1 and its SPI SERCOM2; the XIAO's
// I2C is SERCOM2 on D and its SPI SERCOM0 on D.

/** [sercom, pad] */
export type SercomPad = readonly [sercom: number, pad: number];

export const SERCOM_FUNCTION_C: Record<number, SercomPad> = {
  8: [0, 0], 9: [0, 1], 10: [0, 2], 11: [0, 3],
  12: [2, 0], 13: [2, 1], 14: [2, 2], 15: [2, 3],
  16: [1, 0], 17: [1, 1], 18: [1, 2], 19: [1, 3],
  20: [5, 2], 21: [5, 3], 22: [3, 0], 23: [3, 1], 24: [3, 2], 25: [3, 3],
  44: [4, 0], 45: [4, 1], 46: [4, 2], 47: [4, 3], 48: [5, 0], 49: [5, 1],
};

export const SERCOM_FUNCTION_D: Record<number, SercomPad> = {
  0: [1, 0], 1: [1, 1], 4: [0, 0], 5: [0, 1], 6: [0, 2], 7: [0, 3],
  8: [2, 0], 9: [2, 1], 10: [2, 2], 11: [2, 3],
  12: [4, 0], 13: [4, 1], 14: [4, 2], 15: [4, 3],
  16: [3, 0], 17: [3, 1], 18: [3, 2], 19: [3, 3],
  20: [3, 2], 21: [3, 3], 22: [5, 0], 23: [5, 1], 24: [5, 2], 25: [5, 3],
  30: [1, 2], 31: [1, 3],
  32: [5, 2], 33: [5, 3], 34: [5, 0], 35: [5, 1],
  40: [4, 0], 41: [4, 1], 42: [4, 2], 43: [4, 3],
  54: [5, 2], 55: [5, 3], 62: [5, 0], 63: [5, 1],
};

/** The pad that SERCOM `pad` of `sercom` is muxed to, or undefined. */
export function pinForSercomPad(
  sercom: number,
  pad: number,
  functionOf: (pin: number) => number | undefined,
): number | undefined {
  for (let pin = 0; pin < 64; pin++) {
    const fn = functionOf(pin);
    const entry = fn === 2 ? SERCOM_FUNCTION_C[pin] : fn === 3 ? SERCOM_FUNCTION_D[pin] : undefined;
    if (entry && entry[0] === sercom && entry[1] === pad) return pin;
  }
  return undefined;
}
