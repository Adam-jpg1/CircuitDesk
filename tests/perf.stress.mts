// What the expanded library actually costs.
//
// The part count roughly doubled over this project and the simulation grew
// four shared media, so the question is whether any of it shows up where a
// user would feel it: opening the library, searching it, dropping a hundred
// parts on a canvas, and settling a circuit once a millisecond.
//
// These are measurements, not thresholds. The few assertions here are the ones
// where a regression would be a bug rather than a slowdown — a settle that
// takes longer than the millisecond it represents cannot run in real time, and
// that is a correctness statement rather than a preference. Everything else is
// printed so the optimisation milestone after this has numbers to argue with.

import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
import { partMatches, matchRank } from '../src/components-library/partSearch';
import { simulationController } from '../src/simulation/simulationController';
import { emptyProject } from '../src/project/templates';
import { buildCircuitGraph } from '../src/circuit/nets';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log('SKIP:', msg);
  skipped++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const inst = (definitionId: string, x = 0, y = 0): ComponentInstance => ({
  id: uid('c'), definitionId, x, y, rotation: 0, properties: {}, simulationState: {},
});
function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

/** Median of repeated timings, which is what a user experiences. */
function timeIt(times: number, fn: () => void): { medianMs: number; worstMs: number } {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[Math.floor(samples.length / 2)], worstMs: samples[samples.length - 1] };
}

// ============================================== 1. the library itself ========
section('1. opening and searching the library');
{
  const open = timeIt(20, () => {
    // What the panel does on open: every definition, its category and its
    // coverage row.
    const byCategory = new Map<string, number>();
    for (const d of COMPONENT_DEFINITIONS) byCategory.set(d.category, (byCategory.get(d.category) ?? 0) + 1);
    for (const c of COMPONENT_COVERAGE) void c.status;
  });
  console.log(`   ${COMPONENT_DEFINITIONS.length} definitions, ${COMPONENT_COVERAGE.length} coverage rows`);
  console.log(`   library open: median ${open.medianMs.toFixed(2)} ms, worst ${open.worstMs.toFixed(2)} ms`);
  check(open.medianMs < 20, `opening the library is ${open.medianMs.toFixed(2)} ms`);

  // What a keystroke costs: filter the whole library and rank what survives,
  // which is what the panel does on every character.
  const queries = ['led', 'oled', 'motor', 'can', 'lora', '74hc', 'sensor', 'zzz'];
  const search = timeIt(40, () => {
    for (const q of queries) {
      COMPONENT_DEFINITIONS.filter((d) => partMatches(d, q))
        .map((d) => ({ d, rank: matchRank(d, q) }))
        .sort((a, b) => a.rank - b.rank);
    }
  });
  console.log(`   search: ${queries.length} queries in median ${search.medianMs.toFixed(2)} ms ` +
    `(${(search.medianMs / queries.length).toFixed(3)} ms each)`);
  check(search.medianMs / queries.length < 5, 'a keystroke of search is well under a frame');

  const hits = COMPONENT_DEFINITIONS.filter((d) => partMatches(d, 'oled'));
  check(hits.length > 0, `and it finds things (${hits.length} for "oled")`);
}

// ================================================= 2. canvas-sized graphs ====
section('2. netlist over big canvases');
{
  const scenarios: { name: string; build: () => CircuitProject }[] = [
    {
      name: '100 simple parts',
      build: () => {
        const p = emptyProject('perf');
        const board = inst('board.arduino-uno');
        p.boardInstances.push(board);
        for (let i = 0; i < 100; i++) {
          const led = inst(i % 2 === 0 ? 'comp.led' : 'comp.resistor', (i % 10) * 40, Math.floor(i / 10) * 40);
          p.componentInstances.push(led);
          wire(p, board.id, `D${2 + (i % 10)}`, led.id, i % 2 === 0 ? 'anode' : 'a');
        }
        return p;
      },
    },
    {
      name: '25 logic ICs',
      build: () => {
        const p = emptyProject('perf');
        const board = inst('board.arduino-uno');
        p.boardInstances.push(board);
        let previous: ComponentInstance | null = null;
        for (let i = 0; i < 25; i++) {
          const ic = inst('comp.74hc00', (i % 5) * 60, Math.floor(i / 5) * 60);
          p.componentInstances.push(ic);
          if (previous) wire(p, previous.id, '1y', ic.id, '1a');
          previous = ic;
        }
        return p;
      },
    },
    {
      name: '10 displays',
      build: () => {
        const p = emptyProject('perf');
        const board = inst('board.arduino-uno');
        p.boardInstances.push(board);
        for (let i = 0; i < 10; i++) {
          const d = inst(i % 2 ? 'comp.oled' : 'comp.lcd1602', (i % 5) * 80, Math.floor(i / 5) * 80);
          p.componentInstances.push(d);
          wire(p, board.id, 'A4', d.id, 'sda');
          wire(p, board.id, 'A5', d.id, 'scl');
          wire(p, board.id, '5V', d.id, 'vcc');
          wire(p, board.id, 'GND_TOP', d.id, 'gnd');
        }
        return p;
      },
    },
    {
      name: 'communication-heavy',
      build: () => {
        const p = emptyProject('perf');
        const board = inst('board.arduino-uno');
        p.boardInstances.push(board);
        for (const id of ['comp.nrf24l01', 'comp.lora-sx1278', 'comp.mcp2515', 'comp.max485',
          'comp.rf433-tx', 'comp.rf433-rx', 'comp.ir-receiver', 'comp.ir-led', 'comp.gps', 'comp.hc05']) {
          const c = inst(id);
          p.componentInstances.push(c);
          wire(p, board.id, '5V', c.id, 'vcc');
          wire(p, board.id, 'GND_TOP', c.id, 'gnd');
        }
        return p;
      },
    },
    {
      name: 'multi-board',
      build: () => {
        const p = emptyProject('perf');
        for (let b = 0; b < 4; b++) {
          const board = inst(b % 2 ? 'board.raspberry-pi-pico' : 'board.arduino-uno', b * 300, 0);
          p.boardInstances.push(board);
          for (let i = 0; i < 12; i++) {
            const led = inst('comp.led', b * 300 + i * 20, 120);
            p.componentInstances.push(led);
            wire(p, board.id, b % 2 ? `GP${i}` : `D${2 + i}`, led.id, 'anode');
          }
        }
        return p;
      },
    },
  ];

  for (const s of scenarios) {
    const project = s.build();
    const parts = project.componentInstances.length + project.boardInstances.length;
    const t = timeIt(15, () => {
      buildCircuitGraph(project);
    });
    console.log(
      `   ${s.name.padEnd(22)} ${String(parts).padStart(4)} parts, ` +
      `${String(project.connections.length).padStart(4)} wires — netlist median ${t.medianMs.toFixed(2)} ms, worst ${t.worstMs.toFixed(2)} ms`,
    );
    // A netlist rebuild happens on every wiring edit, so it has to be inside a
    // frame or the canvas stutters while you draw.
    check(t.medianMs < 16, `${s.name}: the netlist rebuilds inside one frame`);
  }
}

// ================================================ 3. the settle, running =====
section('3. settle cost against real time');
{
  const p = emptyProject('perf-sim');
  const board = inst('board.arduino-uno');
  p.boardInstances.push(board);
  // A mixed load: a display, a radio, a CAN controller, an IR pair and LEDs.
  const oled = inst('comp.oled');
  const radio = inst('comp.nrf24l01');
  const can = inst('comp.mcp2515');
  const irRx = inst('comp.ir-receiver');
  const remote = inst('comp.ir-remote');
  p.componentInstances.push(oled, radio, can, irRx, remote);
  for (const c of [oled, radio, can, irRx]) {
    wire(p, board.id, c === oled ? '5V' : '3V3', c.id, 'vcc');
    wire(p, board.id, 'GND_TOP', c.id, 'gnd');
  }
  wire(p, board.id, 'A4', oled.id, 'sda');
  wire(p, board.id, 'A5', oled.id, 'scl');
  wire(p, board.id, 'D13', radio.id, 'sck');
  wire(p, board.id, 'D11', radio.id, 'mosi');
  wire(p, board.id, 'D12', radio.id, 'miso');
  wire(p, board.id, 'D10', radio.id, 'csn');
  wire(p, board.id, 'D9', radio.id, 'ce');
  wire(p, board.id, 'D8', can.id, 'cs');
  wire(p, board.id, 'D2', irRx.id, 'out');
  for (let i = 0; i < 20; i++) {
    const led = inst('comp.led');
    p.componentInstances.push(led);
    wire(p, board.id, 'D3', led.id, 'anode');
  }
  p.codeFiles = [{
    id: 'f', name: 'sketch.ino', language: 'cpp',
    content: 'void setup(){Serial.begin(9600);pinMode(3,OUTPUT);}\nvoid loop(){digitalWrite(3,HIGH);delay(1);digitalWrite(3,LOW);delay(1);}',
  }];

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the settle benchmark cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(50); // warm the binding and the bus caches

    const SIM_MS = 500;
    const started = performance.now();
    simulationController.advance(SIM_MS);
    const wall = performance.now() - started;
    const ratio = SIM_MS / wall;
    console.log(
      `   ${p.componentInstances.length} parts, ${p.connections.length} wires: ` +
      `${SIM_MS} ms simulated in ${wall.toFixed(0)} ms wall — ${ratio.toFixed(1)}x real time`,
    );
    console.log(`   per settle: ${(wall / SIM_MS).toFixed(3)} ms for one simulated millisecond`);
    // Faster than real time is the bar. Below it the simulation cannot keep up
    // with its own clock and everything timed — a servo pulse, a UART byte, a
    // CAN frame — stretches for the user.
    check(ratio > 1, `the simulation runs at ${ratio.toFixed(1)}x real time`);

    const publish = timeIt(30, () => simulationController.publishNow());
    console.log(`   publishing a frame: median ${publish.medianMs.toFixed(2)} ms, worst ${publish.worstMs.toFixed(2)} ms`);
    check(publish.medianMs < 33, 'and a frame publishes inside two frames of a 60 Hz budget');

    const used = process.memoryUsage();
    console.log(`   heap in use: ${(used.heapUsed / 1024 / 1024).toFixed(1)} MiB of ${(used.heapTotal / 1024 / 1024).toFixed(1)} MiB`);
  }
  simulationController.stop();
}

// ==================================================== 4. the shipped bundle ==
section('4. bundle size');
{
  const { readdir, stat, readFile } = await import('node:fs/promises');
  const { gzipSync } = await import('node:zlib');
  try {
    const assets = await readdir('dist/assets');
    let raw = 0;
    let gz = 0;
    for (const name of assets.filter((n) => n.endsWith('.js') || n.endsWith('.css'))) {
      const path = `dist/assets/${name}`;
      raw += (await stat(path)).size;
      gz += gzipSync(await readFile(path)).length;
    }
    console.log(`   ${(raw / 1024 / 1024).toFixed(2)} MiB raw, ${(gz / 1024 / 1024).toFixed(2)} MiB gzipped`);
    check(raw > 0, 'the build produced assets to measure');
  } catch {
    skip('no dist/ build to measure — run `npm run build` first');
  }
}

console.log(
  failures === 0
    ? `\nPerformance stress passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
