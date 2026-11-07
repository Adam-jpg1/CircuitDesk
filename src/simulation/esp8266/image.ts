// ESP8266 firmware images, as the Arduino core builds them.
//
// The .bin an ESP8266 build writes is a flash image: the core's eboot
// bootloader at offset 0 and the application at 0x1000. Both use the
// ESP8266's original image format — an 8-byte header (magic 0xE9, segment
// count, flash mode, size and speed, entry point) followed directly by the
// segments, each an 8-byte (address, length) header and its bytes — without
// the extended header later chips add. eboot only copies the application's
// RAM segments into place and jumps to its entry, so the runtime does that
// itself; the application's code segment (at 0x40201010) is executed from
// the flash window where it already sits.

import type { EspApplicationImage, EspSegment } from '../esp32c3/espImage';
import { EspImageRejectedError } from '../esp32c3/espImage';

export const ESP8266_APP_OFFSET = 0x1000;
const MAGIC = 0xe9;

export const ESP8266_REGIONS = [
  { start: 0x3ffe8000, end: 0x40000000, name: 'DRAM' },
  { start: 0x40100000, end: 0x40110000, name: 'IRAM' },
  { start: 0x40200000, end: 0x40300000, name: 'IROM (flash-mapped code)' },
];

/** Flash size from the header's size nibble: 512 KB, 256 KB, 1, 2, 4 MB, then the 2/4 MB C1 layouts, 8, 16 MB. */
export function esp8266FlashBytes(bin: Uint8Array): number {
  const kb = [512, 256, 1024, 2048, 4096, 2048, 4096, 8192, 16384][(bin[3] >>> 4) & 0xf] ?? 4096;
  return kb * 1024;
}

export function parseEsp8266Image(bin: Uint8Array): EspApplicationImage {
  if (bin.length < ESP8266_APP_OFFSET + 8 || bin[0] !== MAGIC || bin[ESP8266_APP_OFFSET] !== MAGIC) {
    throw new EspImageRejectedError('This is not an ESP8266 Arduino flash image (no bootloader and application at 0x1000).');
  }
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const base = ESP8266_APP_OFFSET;
  const count = bin[base + 1];
  if (count === 0 || count > 16) throw new EspImageRejectedError(`The ESP8266 application declares ${count} segments.`);
  const entryPoint = view.getUint32(base + 4, true);
  let at = base + 8;
  const segments: EspSegment[] = [];
  let byteLength = 0;
  for (let i = 0; i < count; i++) {
    if (at + 8 > bin.length) throw new EspImageRejectedError('The ESP8266 application is truncated.');
    const loadAddress = view.getUint32(at, true);
    const length = view.getUint32(at + 4, true);
    if (at + 8 + length > bin.length) throw new EspImageRejectedError('An ESP8266 segment runs past the end of the image.');
    const region = ESP8266_REGIONS.find((r) => loadAddress >= r.start && loadAddress + length <= r.end);
    if (!region) throw new EspImageRejectedError(`An ESP8266 segment loads at 0x${loadAddress.toString(16)}, outside the chip's memory.`);
    segments.push({ loadAddress, data: bin.subarray(at + 8, at + 8 + length), region: region.name, fileOffset: at + 8 });
    byteLength += length;
    at += 8 + length;
  }
  if (!ESP8266_REGIONS.some((r) => entryPoint >= r.start && entryPoint < r.end)) {
    throw new EspImageRejectedError(`The ESP8266 application's entry point 0x${entryPoint.toString(16)} is not in its memory.`);
  }
  return { raw: bin, entryPoint, chipId: -1, chipName: 'esp8266', segments, byteLength, hashAppended: false };
}
