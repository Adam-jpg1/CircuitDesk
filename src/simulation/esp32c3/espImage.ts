// Espressif application images, parsed and validated.
//
// An ESP32-C3 build writes four binaries: a second-stage bootloader, a
// partition table, the application image, and a merged 4 MB flash image that
// is just the other three placed at their flash offsets. The one that executes
// is the application image, and it is entirely self-describing — it carries
// its own segment load addresses and its own entry point.
//
// That is what makes the boot path here both small and accurate. On hardware
// the mask ROM reads the partition table to *find* this image, then the
// second-stage bootloader copies these exact segments to these exact addresses
// and jumps to this exact entry point. Doing that directly reproduces the
// result rather than skipping it, and it needs no Espressif ROM code at all.
//
// The layout below is the documented `esp_image_header_t` /
// `esp_image_segment_header_t` pair from the ESP-IDF image format, which is
// public. No vendor code is included.
//
// This module deliberately imports no emulator, so a wrong-architecture or
// malformed artifact is refused before any execution engine is downloaded.

/** First byte of every Espressif application image. */
const IMAGE_MAGIC = 0xe9;

/** Chip identifiers from the image header. */
export const ESP_CHIP_ID = {
  esp32: 0x0000,
  esp32s2: 0x0002,
  esp32c3: 0x0005,
  esp32s3: 0x0009,
  esp32c2: 0x000c,
  esp32c6: 0x000d,
  esp32h2: 0x0010,
} as const;

export type EspChipName = keyof typeof ESP_CHIP_ID;

const CHIP_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ESP_CHIP_ID).map(([name, id]) => [id, name]),
);

/** Header is 8 bytes of image header plus 16 of extended header. */
const HEADER_SIZE = 24;
const SEGMENT_HEADER_SIZE = 8;
const MAX_SEGMENTS = 16;

/**
 * ESP32-C3 address ranges a segment may legitimately target.
 *
 * These come from the chip's memory map. A segment outside them is either a
 * corrupt image or one built for a different part, and is refused rather than
 * quietly dropped — a partially loaded image fails later in ways that look
 * like emulator bugs.
 */
export const ESP32C3_REGIONS: { start: number; end: number; name: string }[] = [
  { start: 0x3c000000, end: 0x3c800000, name: 'DROM (flash-mapped constants)' },
  { start: 0x3fc80000, end: 0x3fce0000, name: 'DRAM' },
  { start: 0x40380000, end: 0x403e0000, name: 'IRAM' },
  { start: 0x42000000, end: 0x42800000, name: 'IROM (flash-mapped code)' },
  { start: 0x50000000, end: 0x50002000, name: 'RTC fast memory' },
];

export class EspImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EspImageRejectedError';
  }
}

export interface EspSegment {
  loadAddress: number;
  data: Uint8Array;
  /** Which documented region this segment lands in. */
  region: string;
}

export interface EspApplicationImage {
  entryPoint: number;
  chipId: number;
  chipName: string;
  segments: EspSegment[];
  /** Total bytes across all segments, for a size check against the target. */
  byteLength: number;
  /** True when the image carries an appended SHA-256, as ESP-IDF images do. */
  hashAppended: boolean;
}

/**
 * Parses an Espressif application image and checks it belongs on this chip.
 *
 * Throws EspImageRejectedError with a message a user can act on rather than
 * returning a partially populated image.
 */
export function parseEspApplicationImage(
  buffer: Uint8Array,
  options: { expectChip?: EspChipName; regions?: { start: number; end: number; name: string }[]; maxBytes?: number } = {},
): EspApplicationImage {
  const expectChip = options.expectChip ?? 'esp32c3';
  const regions = options.regions ?? ESP32C3_REGIONS;

  if (buffer.length === 0) throw new EspImageRejectedError('The firmware file is empty.');

  // The two other artifact formats CircuitDesk handles are recognised on sight,
  // so a board mix-up is reported as a board mix-up.
  if (buffer[0] === ':'.charCodeAt(0)) {
    throw new EspImageRejectedError(
      'This is an AVR Intel HEX file, not an Espressif image. CircuitDesk will not run AVR firmware on an ESP32-C3 — recompile for the board on the canvas.',
    );
  }
  if (buffer.length >= 4) {
    const first = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true);
    if (first === 0x0a324655) {
      throw new EspImageRejectedError(
        'This is an RP2040 UF2 file, not an Espressif image. CircuitDesk will not run RP2040 firmware on an ESP32-C3 — recompile for the board on the canvas.',
      );
    }
  }
  if (buffer[0] !== IMAGE_MAGIC) {
    throw new EspImageRejectedError(
      `An Espressif application image starts with 0x${IMAGE_MAGIC.toString(16)}; this one starts with 0x${buffer[0].toString(16)}.`,
    );
  }
  if (buffer.length < HEADER_SIZE) {
    throw new EspImageRejectedError(`The image is ${buffer.length} bytes, too short to contain a header.`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  const segmentCount = buffer[1];
  const entryPoint = view.getUint32(4, true);
  const chipId = view.getUint16(12, true);
  const hashAppended = buffer[23] === 1;

  if (chipId !== ESP_CHIP_ID[expectChip]) {
    const actual = CHIP_NAMES[chipId] ?? `unknown chip id 0x${chipId.toString(16)}`;
    throw new EspImageRejectedError(
      `This image was built for ${actual}, not ${expectChip}. CircuitDesk will not execute firmware built for a different chip — recompile for the board on the canvas.`,
    );
  }
  if (segmentCount === 0 || segmentCount > MAX_SEGMENTS) {
    throw new EspImageRejectedError(`The image claims ${segmentCount} segments, which is outside the format's range.`);
  }

  const segments: EspSegment[] = [];
  let offset = HEADER_SIZE;
  let byteLength = 0;

  for (let i = 0; i < segmentCount; i++) {
    if (offset + SEGMENT_HEADER_SIZE > buffer.length) {
      throw new EspImageRejectedError(`The image ends part-way through the header of segment ${i}.`);
    }
    const loadAddress = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    offset += SEGMENT_HEADER_SIZE;

    if (offset + length > buffer.length) {
      throw new EspImageRejectedError(
        `Segment ${i} claims ${length} bytes but only ${buffer.length - offset} remain — the image is truncated.`,
      );
    }
    const region = regions.find((r) => loadAddress >= r.start && loadAddress + length <= r.end);
    if (!region) {
      throw new EspImageRejectedError(
        `Segment ${i} loads at 0x${loadAddress.toString(16)} (${length} bytes), which is not inside any ${expectChip} memory region.`,
      );
    }
    segments.push({ loadAddress, data: buffer.slice(offset, offset + length), region: region.name });
    byteLength += length;
    offset += length;
  }

  if (options.maxBytes !== undefined && byteLength > options.maxBytes) {
    throw new EspImageRejectedError(
      `The firmware is ${byteLength} bytes across its segments, larger than the ${options.maxBytes} byte application partition.`,
    );
  }

  // The entry point has to be somewhere the image actually placed code.
  const entryRegion = regions.find((r) => entryPoint >= r.start && entryPoint < r.end);
  if (!entryRegion) {
    throw new EspImageRejectedError(
      `The image's entry point 0x${entryPoint.toString(16)} is not inside any ${expectChip} memory region.`,
    );
  }

  return { entryPoint, chipId, chipName: expectChip, segments, byteLength, hashAppended };
}

/**
 * Decodes the compiler service's base64 payload.
 *
 * Separate from parsing so a corrupt transfer is reported as a transfer
 * problem rather than as a malformed image.
 */
export function decodeBase64Image(data: string): Uint8Array {
  try {
    const binary = atob(data.trim());
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    throw new EspImageRejectedError('The compiled firmware could not be decoded — the compiler response was corrupt.');
  }
}
