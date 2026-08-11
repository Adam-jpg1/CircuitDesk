// ESP32-C6 firmware identification, and why it is not an ESP32-C3.
//
// Both parts are Espressif RISC-V chips, which makes it tempting to treat one
// image as usable on the other. They are not interchangeable, and the reason is
// not a version number: the C6 unifies address windows that the C3 splits, so
// a C6 image's segments land nowhere valid on a C3 and vice versa. These cases
// make that rejection precise and deliberate rather than an accident of some
// later loader failing.

import {
  parseEspApplicationImage,
  EspImageRejectedError,
  ESP_CHIP_ID,
  ESP32C3_REGIONS,
  ESP32C6_REGIONS,
  CHIP_REGIONS,
} from '../src/simulation/esp32c3/espImage';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

/** Builds an image header the way the toolchain writes one. */
function buildImage(options: {
  chipId: number;
  entry: number;
  segments: { load: number; length: number }[];
}): Uint8Array {
  const total = 24 + options.segments.reduce((n, s) => n + 8 + s.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = 0xe9;
  out[1] = options.segments.length;
  view.setUint32(4, options.entry, true);
  view.setUint16(12, options.chipId, true);
  let offset = 24;
  for (const seg of options.segments) {
    view.setUint32(offset, seg.load, true);
    view.setUint32(offset + 4, seg.length, true);
    offset += 8 + seg.length;
  }
  return out;
}

/** Segment layouts taken from real builds of each chip. */
const C6_SEGMENTS = [
  { load: 0x42030020, length: 32 },
  { load: 0x40800000, length: 32 },
  { load: 0x42000020, length: 32 },
];
const C3_SEGMENTS = [
  { load: 0x3c0d0020, length: 32 },
  { load: 0x3fc90000, length: 32 },
  { load: 0x40380000, length: 32 },
];

const c6Image = buildImage({ chipId: ESP_CHIP_ID.esp32c6, entry: 0x40800828, segments: C6_SEGMENTS });
const c3Image = buildImage({ chipId: ESP_CHIP_ID.esp32c3, entry: 0x403807ca, segments: C3_SEGMENTS });

function rejection(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof EspImageRejectedError ? (error as Error).message : `wrong error: ${String(error)}`;
  }
}

// ---------- 1. the region tables differ, and differ correctly ----------
{
  check(CHIP_REGIONS.esp32c6 === ESP32C6_REGIONS, 'the parser selects the C6 table for a C6 image');
  check(CHIP_REGIONS.esp32c3 === ESP32C3_REGIONS, 'and the C3 table for a C3 image');

  // The C6 unifies what the C3 splits. If these ever became equal, every
  // cross-family check below would pass for the wrong reason.
  check(
    JSON.stringify(ESP32C6_REGIONS) !== JSON.stringify(ESP32C3_REGIONS),
    'the two chips do not share a memory map',
  );
  const c6Ram = ESP32C6_REGIONS.find((r) => r.start === 0x40800000);
  check(c6Ram?.end === 0x40880000, 'the C6 has one 512 KB window for instruction and data RAM');
  check(
    ESP32C3_REGIONS.every((r) => r.start !== 0x40800000),
    'which is not a C3 address at all',
  );
}

// ---------- 2. each image loads on its own chip ----------
{
  const c6 = parseEspApplicationImage(c6Image, { expectChip: 'esp32c6' });
  check(c6.chipName === 'esp32c6', 'a C6 image parses as a C6 image');
  check(c6.entryPoint === 0x40800828, `with its own entry point (0x${c6.entryPoint.toString(16)})`);
  check(c6.segments.length === 3, 'and all its segments');
  check(
    c6.segments.every((s) => s.region.length > 0),
    'each landing in a named C6 region',
  );

  const c3 = parseEspApplicationImage(c3Image, { expectChip: 'esp32c3' });
  check(c3.chipName === 'esp32c3', 'and a C3 image still parses as a C3 image');
}

// ---------- 3. neither runs as the other ----------
{
  const c6AsC3 = rejection(() => parseEspApplicationImage(c6Image, { expectChip: 'esp32c3' }));
  check(c6AsC3 !== null, 'a C6 image is refused when a C3 is expected');
  check(/esp32c6/.test(c6AsC3 ?? ''), `and the message names what it actually is (${c6AsC3?.slice(0, 70)})`);

  const c3AsC6 = rejection(() => parseEspApplicationImage(c3Image, { expectChip: 'esp32c6' }));
  check(c3AsC6 !== null, 'a C3 image is refused when a C6 is expected');
  check(/esp32c3/.test(c3AsC6 ?? ''), `and likewise (${c3AsC6?.slice(0, 70)})`);

  // The chip id is the first line of defence, but not the only one: an image
  // whose header claims C6 while its segments are laid out for a C3 is still
  // refused, because the segments cannot be placed.
  const mislabelled = buildImage({ chipId: ESP_CHIP_ID.esp32c6, entry: 0x40800828, segments: C3_SEGMENTS });
  const refused = rejection(() => parseEspApplicationImage(mislabelled, { expectChip: 'esp32c6' }));
  check(refused !== null, 'an image labelled C6 with C3 segments is refused on its segments');
  check(/not inside any esp32c6 memory region/.test(refused ?? ''), `naming the region problem (${refused?.slice(0, 80)})`);
}

// ---------- 4. other architectures are refused as themselves ----------
{
  const hex = new TextEncoder().encode(':100000000C9434000C9451000C945100');
  const asHex = rejection(() => parseEspApplicationImage(hex, { expectChip: 'esp32c6' }));
  check(/Intel HEX/.test(asHex ?? ''), 'an AVR HEX file is recognised as one');

  const uf2 = new Uint8Array(512);
  new DataView(uf2.buffer).setUint32(0, 0x0a324655, true);
  const asUf2 = rejection(() => parseEspApplicationImage(uf2, { expectChip: 'esp32c6' }));
  check(/UF2/.test(asUf2 ?? ''), 'and an RP2040 UF2 as one');

  check(rejection(() => parseEspApplicationImage(new Uint8Array(0), { expectChip: 'esp32c6' })) !== null, 'an empty file is refused');
  check(
    rejection(() => parseEspApplicationImage(Uint8Array.from([0xe9, 1]), { expectChip: 'esp32c6' })) !== null,
    'a truncated header is refused',
  );

  // A segment claiming more bytes than the file holds.
  const truncated = buildImage({ chipId: ESP_CHIP_ID.esp32c6, entry: 0x40800828, segments: [{ load: 0x40800000, length: 32 }] });
  new DataView(truncated.buffer).setUint32(28, 4096, true);
  check(
    /truncated/.test(rejection(() => parseEspApplicationImage(truncated, { expectChip: 'esp32c6' })) ?? ''),
    'a segment longer than the file is refused as truncated',
  );

  // Larger than the application partition.
  const oversized = buildImage({ chipId: ESP_CHIP_ID.esp32c6, entry: 0x40800828, segments: [{ load: 0x40800000, length: 64 }] });
  check(
    /larger than/.test(rejection(() => parseEspApplicationImage(oversized, { expectChip: 'esp32c6', maxBytes: 32 })) ?? ''),
    'an image larger than the partition is refused',
  );

  // An entry point outside every region.
  const badEntry = buildImage({ chipId: ESP_CHIP_ID.esp32c6, entry: 0x20000000, segments: C6_SEGMENTS });
  check(
    /entry point/.test(rejection(() => parseEspApplicationImage(badEntry, { expectChip: 'esp32c6' })) ?? ''),
    'an entry point outside memory is refused',
  );
}

console.log(failures === 0 ? '\nESP32-C6 image checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
