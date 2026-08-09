// The Espressif application-image parser.
//
// Real firmware is used where the compiler backend is available; the rejection
// cases are synthetic, because they have to be — a compiler will not produce a
// truncated or wrong-chip image on request.

import {
  parseEspApplicationImage,
  decodeBase64Image,
  EspImageRejectedError,
  ESP_CHIP_ID,
  ESP32C3_REGIONS,
} from '../src/simulation/esp32c3/espImage';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

/** Builds a syntactically valid image around the given segments. */
function makeImage(
  segments: { addr: number; length: number }[],
  over: { magic?: number; chipId?: number; entry?: number; segmentCount?: number; truncateBy?: number } = {},
): Uint8Array {
  const total = 24 + segments.reduce((n, s) => n + 8 + s.length, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes[0] = over.magic ?? 0xe9;
  bytes[1] = over.segmentCount ?? segments.length;
  view.setUint32(4, over.entry ?? 0x40380000, true);
  view.setUint16(12, over.chipId ?? ESP_CHIP_ID.esp32c3, true);
  let offset = 24;
  for (const segment of segments) {
    view.setUint32(offset, segment.addr, true);
    view.setUint32(offset + 4, segment.length, true);
    offset += 8 + segment.length;
  }
  return over.truncateBy ? bytes.slice(0, bytes.length - over.truncateBy) : bytes;
}

const rejects = (build: () => unknown, what: string) => {
  try {
    build();
    check(false, `${what} is rejected`);
  } catch (err) {
    const ok = err instanceof EspImageRejectedError;
    check(ok, `${what} is rejected — ${(err as Error).message.slice(0, 80)}`);
  }
};

// ---------- 1. a well-formed image ----------
{
  const image = parseEspApplicationImage(makeImage([{ addr: 0x40380000, length: 64 }, { addr: 0x3fc8d400, length: 32 }]));
  check(image.chipName === 'esp32c3', 'a well-formed C3 image parses');
  check(image.segments.length === 2, `both segments are read (${image.segments.length})`);
  check(image.segments[0].loadAddress === 0x40380000, 'the first load address is preserved');
  check(image.segments[0].region.includes('IRAM'), `segments are attributed to a documented region (${image.segments[0].region})`);
  check(image.segments[1].region.includes('DRAM'), `a DRAM segment is recognised (${image.segments[1].region})`);
  check(image.byteLength === 96, `the total payload is measured (${image.byteLength})`);
  check(image.entryPoint === 0x40380000, 'the entry point is read from the header');
}

// ---------- 2. everything malformed is refused ----------
{
  rejects(() => parseEspApplicationImage(new Uint8Array(0)), 'an empty file');
  rejects(() => parseEspApplicationImage(new Uint8Array([0x3a, 0x31, 0x30, 0x30])), 'AVR Intel HEX');
  const uf2 = new Uint8Array(512);
  new DataView(uf2.buffer).setUint32(0, 0x0a324655, true);
  rejects(() => parseEspApplicationImage(uf2), 'an RP2040 UF2');
  rejects(() => parseEspApplicationImage(makeImage([{ addr: 0x40380000, length: 8 }], { magic: 0x7f })), 'a bad magic byte');
  rejects(
    () => parseEspApplicationImage(makeImage([{ addr: 0x40380000, length: 8 }], { chipId: ESP_CHIP_ID.esp32s3 })),
    "another chip's image",
  );
  rejects(
    () => parseEspApplicationImage(makeImage([{ addr: 0x40380000, length: 8 }], { chipId: 0x1234 })),
    'an unknown chip id',
  );
  rejects(() => parseEspApplicationImage(makeImage([{ addr: 0x40380000, length: 64 }], { truncateBy: 32 })), 'a truncated segment');
  rejects(() => parseEspApplicationImage(makeImage([{ addr: 0x10000000, length: 8 }])), 'a segment outside the memory map');
  rejects(() => parseEspApplicationImage(makeImage([{ addr: 0x40380000, length: 8 }], { entry: 0x10000000 })), 'an entry point outside the memory map');
  rejects(() => parseEspApplicationImage(makeImage([{ addr: 0x40380000, length: 8 }], { segmentCount: 0 })), 'a zero segment count');
  rejects(
    () => parseEspApplicationImage(makeImage([{ addr: 0x40380000, length: 64 }]), { maxBytes: 32 }),
    'an image larger than the application partition',
  );
  rejects(() => decodeBase64Image('!!!not base64!!!'), 'a corrupt base64 payload');

  // A segment that starts inside a region but runs past its end is also wrong.
  rejects(
    () => parseEspApplicationImage(makeImage([{ addr: 0x403dfff0, length: 64 }])),
    'a segment that overruns the end of its region',
  );
}

// ---------- 3. the documented memory map ----------
{
  const named = ESP32C3_REGIONS.map((r) => r.name).join(', ');
  check(ESP32C3_REGIONS.length >= 5, `the C3 memory map covers its regions (${named})`);
  check(
    ESP32C3_REGIONS.every((r) => r.end > r.start),
    'every region has a positive extent',
  );
  check(ESP_CHIP_ID.esp32c3 === 5, 'the C3 chip id is 5');
}

// ---------- 4. real compiled firmware ----------
{
  let artifact: { data: string; format: string } | null = null;
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boardId: 'board.esp32-c3',
        fqbn: 'esp32:esp32:esp32c3',
        files: [
          {
            name: 'sketch.ino',
            content: 'void setup() { pinMode(8, OUTPUT); }\nvoid loop() { digitalWrite(8, HIGH); delay(100); digitalWrite(8, LOW); delay(100); }',
          },
        ],
      }),
    });
    const json = (await res.json()) as { success: boolean; firmware?: { data: string; format: string } };
    if (json.success && json.firmware) artifact = json.firmware;
  } catch {
    /* backend unavailable */
  }

  if (!artifact) {
    console.log('SKIP: the ESP32-C3 toolchain is unavailable — real firmware not parsed');
    skipped++;
  } else {
    check(artifact.format === 'esp-image', `the C3 target returns an ESP application image (${artifact.format})`);
    const image = parseEspApplicationImage(decodeBase64Image(artifact.data), { maxBytes: 1_310_720 });
    check(image.chipName === 'esp32c3', 'real firmware declares the C3 chip id');
    check(image.segments.length >= 4, `real firmware has its several segments (${image.segments.length})`);
    check(image.hashAppended, 'real firmware carries the appended SHA-256 that ESP-IDF images have');
    // The entry point must be executable memory, and IRAM is where ESP-IDF
    // puts the startup function.
    check(
      image.entryPoint >= 0x40380000 && image.entryPoint < 0x403e0000,
      `the entry point is in IRAM (0x${image.entryPoint.toString(16)})`,
    );
    const regions = new Set(image.segments.map((s) => s.region));
    check(regions.size >= 3, `segments land in several regions (${[...regions].length})`);
    check(
      image.segments.some((s) => s.region.includes('IROM')),
      'real firmware maps instructions from flash',
    );
    check(image.byteLength > 100_000, `the image is a realistic size (${image.byteLength} bytes)`);
  }
}

console.log(
  failures === 0
    ? `\nESP32-C3 image checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
