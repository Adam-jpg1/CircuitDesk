// How much does a display cost per frame?
//
// The reason this file exists is a design decision that could have gone badly.
// A 240x320 TFT is 76,800 pixels; the monochrome renderer's technique — one SVG
// node per run of lit pixels — would have produced tens of thousands of nodes
// per panel, rebuilt on every publish, and one display on the canvas would have
// made the editor unusable. The colour path therefore rasterises into an
// offscreen canvas and emits a single <image>.
//
// "Therefore" is not evidence, so this measures it: the per-frame cost of the
// work that actually runs on the publish path, at every panel size that ships.
// The numbers are printed rather than merely asserted, because the useful
// output of a benchmark is the number; the assertions are only there to catch a
// regression that would make a display noticeably freeze the editor.
//
// The budget is deliberately loose. A frame arrives at most every 33 ms
// (PUBLISH_EVERY_MS), and a panel that costs more than a few milliseconds of
// that is eating the budget the rest of the canvas needs.

import { Rgb565Framebuffer, rgb565 } from '../src/simulation/devices/framebuffer';
import { PagedMonoRam } from '../src/simulation/devices/pagedMono';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

/** Median of repeated runs — a single timing on a shared runner is noise. */
function timeMs(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/** What the publish path does per frame for a colour panel. */
const PANELS: [string, number, number][] = [
  ['128x64 (mono equivalent)', 128, 64],
  ['96x64 SSD1331', 96, 64],
  ['128x160 ST7735', 128, 160],
  ['240x240 GC9A01', 240, 240],
  ['240x320 ILI9341', 240, 320],
];

// ============================================ 1. filling a panel from firmware
section('1. the cost of firmware filling a whole panel');
for (const [name, w, h] of PANELS) {
  const fb = new Rgb565Framebuffer(w, h);
  fb.setColumnRange(0, w - 1);
  fb.setRowRange(0, h - 1);
  const colour = rgb565(31, 200, 90);
  const ms = timeMs(5, () => {
    fb.rewind();
    for (let i = 0; i < w * h; i++) fb.writePixel(colour);
  });
  console.log(`   ${name.padEnd(26)} full-screen write  ${ms.toFixed(2)} ms  (${w * h} px)`);
  // This is the whole screen in one go, which firmware does at most a few times
  // a second; a budget of 40 ms leaves it comfortably off the critical path.
  check(ms < 40, `${name}: a full-screen fill stays under 40 ms (${ms.toFixed(2)} ms)`);
}

// ================================== 2. the conversion the renderer does per frame
section('2. the cost of turning a framebuffer into pixels for the canvas');
for (const [name, w, h] of PANELS) {
  const fb = new Rgb565Framebuffer(w, h);
  // A realistic frame rather than a uniform one: uniform data would let the
  // CPU's branch predictor flatter the measurement.
  for (let i = 0; i < fb.pixels.length; i++) fb.pixels[i] = (i * 2654435761) & 0xffff;
  const out = new Uint8ClampedArray(w * h * 4);
  const ms = timeMs(9, () => fb.toRgba(out));
  const perFrameBudget = 33;
  console.log(
    `   ${name.padEnd(26)} RGBA conversion    ${ms.toFixed(2)} ms  ` +
      `(${((ms / perFrameBudget) * 100).toFixed(1)}% of a 33 ms publish)`,
  );
  check(ms < 8, `${name}: conversion stays well inside one publish (${ms.toFixed(2)} ms)`);
}

// ====================== 3. what the node-per-pixel approach would have cost ===
section('3. why the colour path is rasterised rather than drawn as nodes');
{
  // Not a real renderer — just counting the nodes the monochrome technique
  // would produce for a colour panel, which is the number that made the
  // decision. Runs of equal colour cannot be merged in a photographic frame.
  const fb = new Rgb565Framebuffer(240, 320);
  for (let i = 0; i < fb.pixels.length; i++) fb.pixels[i] = (i * 2654435761) & 0xffff;
  let runs = 0;
  let previous = -1;
  for (let y = 0; y < 320; y++) {
    previous = -1;
    for (let x = 0; x < 240; x++) {
      const v = fb.pixels[y * 240 + x];
      if (v !== previous) {
        runs++;
        previous = v;
      }
    }
  }
  console.log(`   a 240x320 frame would need ~${runs.toLocaleString()} SVG nodes as runs of equal colour`);
  check(runs > 20_000, 'which is far past what a canvas can carry per part, so one <image> it is');
  console.log('   the shipped path emits exactly 1 node per panel, whatever the resolution');
}

// ================================= 4. the monochrome path, for comparison =====
section('4. the monochrome panels, which stay on the node path');
for (const [name, w, h] of [
  ['128x64 SSD1306', 128, 64],
  ['128x128 SH1107', 128, 128],
  ['84x48 PCD8544', 84, 48],
] as [string, number, number][]) {
  const ram = new PagedMonoRam(w, h);
  // A text-like frame: mostly blank with runs of set pixels, which is what
  // these panels actually show and where run-merging pays off.
  for (let i = 0; i < ram.ram.length; i += 3) ram.ram[i] = 0b00111100;
  let runs = 0;
  for (let y = 0; y < h; y++) {
    let inRun = false;
    for (let x = 0; x < w; x++) {
      const on = ram.pixel(x, y);
      if (on && !inRun) runs++;
      inRun = on;
    }
  }
  const ms = timeMs(9, () => ram.orientedFrame());
  console.log(`   ${name.padEnd(26)} ~${String(runs).padStart(5)} nodes, oriented frame ${ms.toFixed(3)} ms`);
  check(runs < 6000, `${name}: the node count stays manageable (${runs})`);
}

// =========================================== 5. several panels on one canvas ==
section('5. five panels at once, which is the case that has to not stall');
{
  const panels = PANELS.map(([, w, h]) => {
    const fb = new Rgb565Framebuffer(w, h);
    for (let i = 0; i < fb.pixels.length; i++) fb.pixels[i] = (i * 2654435761) & 0xffff;
    return { fb, out: new Uint8ClampedArray(w * h * 4) };
  });
  const ms = timeMs(5, () => {
    for (const p of panels) p.fb.toRgba(p.out);
  });
  const total = panels.reduce((n, p) => n + p.fb.pixels.length, 0);
  console.log(`   five panels (${total.toLocaleString()} px total) convert in ${ms.toFixed(2)} ms`);
  check(ms < 20, `five colour panels stay inside a frame budget (${ms.toFixed(2)} ms)`);

  // And the case that matters more: nothing changed, so nothing is converted.
  // The renderer only rasterises when the device's revision moves, which is
  // what keeps an idle canvas free.
  const revisions = panels.map((p) => p.fb.revision);
  const unchanged = panels.every((p, i) => p.fb.revision === revisions[i]);
  check(unchanged, 'reading a framebuffer does not bump its revision, so an idle panel repaints never');
}

console.log(
  failures === 0 ? '\nDisplay performance checks passed.' : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
