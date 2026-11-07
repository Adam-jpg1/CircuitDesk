// RP2040 firmware images (UF2), parsed and validated.
//
// This module deliberately imports no emulator: firmware is validated before
// the RP2040 engine chunk is fetched, so a bad artifact is refused without
// downloading several hundred kilobytes of emulator to find out.
//
// Every documented field is checked. A UF2 that is quietly mis-parsed produces
// a firmware image whose failures look like simulator bugs, and an artifact
// built for another architecture must never be executed as if it were an
// RP2040 image.

export const FLASH_BASE = 0x10000000;
export const FLASH_SIZE = 2 * 1024 * 1024;
export const RP2040_FAMILY_ID = 0xe48bff56;

const BLOCK_SIZE = 512;
const MAGIC_START0 = 0x0a324655;
const MAGIC_START1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;
const MAX_PAYLOAD = 476;
const FLAG_NOT_MAIN_FLASH = 0x0001;
const FLAG_FAMILY_PRESENT = 0x2000;

/** Raised for any artifact this simulator will not execute. */
export class FirmwareRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirmwareRejectedError';
  }
}

export interface Uf2Image {
  /** Payloads keyed by their absolute target address in the XIP window. */
  blocks: Map<number, Uint8Array>;
  /** Family ids the file declares. */
  families: Set<number>;
  /** Total payload bytes destined for flash. */
  byteLength: number;
}

/**
 * Parses a UF2 built for the RP2040.
 *
 * Throws FirmwareRejectedError with a message a user can act on, rather than
 * returning a partially-loaded image.
 */
export function parseRp2040Uf2(buf: Uint8Array): Uf2Image {
  if (buf.length === 0) throw new FirmwareRejectedError('The firmware file is empty.');
  if (buf.length % BLOCK_SIZE !== 0) {
    // Intel HEX is the AVR artifact format and is text, so it lands here.
    const looksLikeHex = buf[0] === ':'.charCodeAt(0);
    throw new FirmwareRejectedError(
      looksLikeHex
        ? 'This is an AVR Intel HEX file, not an RP2040 UF2. CircuitDesk will not run AVR firmware on an RP2040: recompile for the board on the canvas.'
        : `A UF2 file is a whole number of 512-byte blocks; this one is ${buf.length} bytes.`,
    );
  }

  const blocks = new Map<number, Uint8Array>();
  const families = new Set<number>();
  let byteLength = 0;

  for (let off = 0; off + BLOCK_SIZE <= buf.length; off += BLOCK_SIZE) {
    const block = off / BLOCK_SIZE;
    const dv = new DataView(buf.buffer, buf.byteOffset + off, BLOCK_SIZE);
    if (dv.getUint32(0, true) !== MAGIC_START0 || dv.getUint32(4, true) !== MAGIC_START1) {
      throw new FirmwareRejectedError(`Block ${block} does not start with the UF2 magic: this is not a UF2 file.`);
    }
    if (dv.getUint32(508, true) !== MAGIC_END) {
      throw new FirmwareRejectedError(`Block ${block} has a corrupt UF2 trailer.`);
    }
    const flags = dv.getUint32(8, true);
    const addr = dv.getUint32(12, true);
    const len = dv.getUint32(16, true);
    if (len > MAX_PAYLOAD) {
      throw new FirmwareRejectedError(`Block ${block} claims a ${len}-byte payload; the UF2 format allows at most ${MAX_PAYLOAD}.`);
    }
    if (flags & FLAG_FAMILY_PRESENT) families.add(dv.getUint32(28, true));
    if (flags & FLAG_NOT_MAIN_FLASH) continue;
    if (addr < FLASH_BASE || addr + len > FLASH_BASE + FLASH_SIZE) {
      throw new FirmwareRejectedError(
        `Block ${block} targets 0x${addr.toString(16)}, which is outside the RP2040's ${FLASH_SIZE / 1024} KB flash window.`,
      );
    }
    blocks.set(addr, buf.slice(off + 32, off + 32 + len));
    byteLength += len;
  }

  if (families.size > 0 && !families.has(RP2040_FAMILY_ID)) {
    const listed = [...families].map((f) => `0x${f.toString(16)}`).join(', ');
    throw new FirmwareRejectedError(
      `This UF2 declares family id ${listed}, not the RP2040's 0x${RP2040_FAMILY_ID.toString(16)}. It was built for a different chip.`,
    );
  }
  if (blocks.size === 0) {
    throw new FirmwareRejectedError('This UF2 contains no flash data: there is nothing to execute.');
  }
  if (byteLength > FLASH_SIZE) {
    throw new FirmwareRejectedError(`The firmware is ${byteLength} bytes, larger than the RP2040's ${FLASH_SIZE} byte flash.`);
  }
  return { blocks, families, byteLength };
}

/**
 * Decodes the compiler service's base64 firmware payload.
 *
 * Kept separate from parsing so a corrupt transfer is reported as a transfer
 * problem rather than as a malformed UF2.
 */
export function decodeBase64Firmware(data: string): Uint8Array {
  try {
    const binary = atob(data.trim());
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    throw new FirmwareRejectedError('The compiled firmware could not be decoded: the compiler response was corrupt.');
  }
}
