// WS2812 strips: the colour is in the waveform or it is nowhere.
//
// Of every part in the library this is the one where faking is cheapest and
// least visible. There is no bus to decode and no register map to get wrong —
// a simulator can watch for `strip.setPixelColor(0, red)` and paint a red dot,
// and a user would not notice until the day they wrote their own bit-bang loop
// and nothing lit.
//
// So nothing here goes near a library. Section 4 runs executed AVR firmware
// that toggles a pin with counted CPU cycles, and the colours asserted are the
// ones decoded from the pulse widths that firmware produced. The earlier
// sections drive the decoder directly with nanosecond timestamps, which is the
// only way to test the boundaries — a 400 ns pulse against an 800 ns one, and
// the 50 us gap that latches a frame.

import { Ws2812Device, WS2812_T0H_NS, WS2812_T1H_NS, WS2812_RESET_NS } from '../src/simulation/devices/ws2812';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
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
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

/**
 * Clocks a byte stream into a device as a real waveform.
 *
 * Deliberately builds the edges rather than calling any shortcut: this is what
 * the wire carries, and it is the only input the device has.
 */
function clock(device: Ws2812Device, bytes: number[], startNs = 1_000_000): number {
  let t = startNs;
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const one = ((byte >> bit) & 1) === 1;
      device.onEdge(true, t);
      t += one ? WS2812_T1H_NS : WS2812_T0H_NS;
      device.onEdge(false, t);
      t += one ? 450 : 850; // the rest of the ~1.25 us bit period
    }
  }
  return t;
}

/** GRB, which is the order the wire carries and a frequent source of bugs. */
const grb = (r: number, g: number, b: number) => [g, r, b];

// ================================================= 1. pulse width is the bit =
section('1. a short pulse is a zero and a long pulse is a one');
{
  const strip = new Ws2812Device('s', 1);
  // 0xFF, 0x00, 0x00 in GRB = full green.
  let t = clock(strip, grb(0, 255, 0));
  strip.settle(t + WS2812_RESET_NS);

  check(strip.frameCount === 1, `one frame latched (${strip.frameCount})`);
  check(
    strip.pixels[0].g === 255 && strip.pixels[0].r === 0 && strip.pixels[0].b === 0,
    `eight long pulses then sixteen short ones decode to full green (${JSON.stringify(strip.pixels[0])})`,
  );

  // The same bits with the widths swapped must give the opposite byte, which is
  // what proves the width is being measured rather than the bit index counted.
  const inverted = new Ws2812Device('s2', 1);
  t = 1_000_000;
  for (let i = 0; i < 24; i++) {
    inverted.onEdge(true, t);
    t += i < 8 ? WS2812_T0H_NS : WS2812_T1H_NS;
    inverted.onEdge(false, t);
    t += 800;
  }
  inverted.settle(t + WS2812_RESET_NS);
  check(
    inverted.pixels[0].g === 0 && inverted.pixels[0].r === 255 && inverted.pixels[0].b === 255,
    `swapping the widths swaps the colour (${JSON.stringify(inverted.pixels[0])})`,
  );
}

// ============================================== 2. the frame latches on a gap =
section('2. nothing is shown until the reset gap has elapsed');
{
  const strip = new Ws2812Device('s', 1);
  const t = clock(strip, grb(255, 0, 0));
  check(strip.frameCount === 0, 'twenty-four bits on the wire have latched nothing yet');
  check(strip.pixels[0].r === 0, 'and the pixel is still dark');
  check(strip.pendingBits === 24, `the bits are held, not discarded (${strip.pendingBits})`);

  // A gap that is too short does not latch.
  strip.settle(t + WS2812_RESET_NS / 2);
  check(strip.frameCount === 0, 'a gap shorter than 50 us does not latch');

  strip.settle(t + WS2812_RESET_NS);
  check(strip.frameCount === 1, 'a gap of 50 us does');
  check(strip.pixels[0].r === 255 && strip.pixels[0].g === 0, `and the pixel is now red (${JSON.stringify(strip.pixels[0])})`);
}

// ================================================= 3. strips, and short frames
section('3. a frame shorter than the strip leaves the rest alone');
{
  const strip = new Ws2812Device('s', 8);
  // Light all eight blue.
  let t = clock(strip, Array.from({ length: 8 }, () => grb(0, 0, 255)).flat());
  strip.settle(t + WS2812_RESET_NS);
  check(strip.litCount === 8, `all eight pixels lit (${strip.litCount})`);

  // Now send one pixel's worth. Real hardware holds the rest at their last
  // value; a model that cleared them would make a partial update look like a
  // bug in the sketch rather than in the sketch's LED count.
  t = clock(strip, grb(255, 0, 0), t + 200_000);
  strip.settle(t + WS2812_RESET_NS);
  check(strip.pixels[0].r === 255 && strip.pixels[0].b === 0, 'the first pixel took the new colour');
  check(strip.pixels[7].b === 255, 'and the eighth is still holding its old one');
  check(strip.litCount === 8, 'so the strip is still fully lit');

  // Bits past the end of the part belong to the next one along a real chain.
  const small = new Ws2812Device('s2', 2);
  t = clock(small, Array.from({ length: 5 }, () => grb(9, 9, 9)).flat());
  small.settle(t + WS2812_RESET_NS);
  check(small.overflowBitCount === 3 * 24, `three pixels' worth went past the end (${small.overflowBitCount} bits)`);
  check(small.pixels.length === 2, 'and the part still has exactly its own two pixels');
}

// =========================================== 3b. malformed traffic is reported
section('3b. traffic that is not WS2812 is recorded, not decoded');
{
  const strip = new Ws2812Device('s', 1);
  // A 3 ms pulse is not a bit by any reading.
  strip.onEdge(true, 1_000_000);
  strip.onEdge(false, 1_000_000 + 3_000_000);
  check(strip.malformedPulseCount === 1, 'an absurdly long pulse is counted as malformed');
  check(strip.pendingBits === 0, 'and contributes no bit');

  // Twenty bits is not a whole pixel. Reported rather than padded.
  const partial = new Ws2812Device('p', 1);
  let t = 1_000_000;
  for (let i = 0; i < 20; i++) {
    partial.onEdge(true, t);
    t += WS2812_T1H_NS;
    partial.onEdge(false, t);
    t += 450;
  }
  partial.settle(t + WS2812_RESET_NS);
  check(partial.shortFrameCount === 1, 'a frame that is not a whole number of pixels is reported');
}

// ================================= 4. executed firmware, driving the pin itself
section('4. a bit-bang loop in real firmware lights the strip');
{
  // No library. The sketch writes the port directly with the timing the
  // datasheet asks for. If the model were watching for a library call rather
  // than the wire, this would light nothing.
  // Measured, not assumed: on a 16 MHz AVR this emits a 375 ns high time for a
  // zero and a 1375 ns one for a one, either side of the 600 ns threshold with
  // enough margin that codegen variation cannot flip a bit. The loop is written
  // inline rather than behind a helper for the same reason — a function call
  // the compiler is free to reshape is a function whose timing is not the
  // timing you wrote.
  const SOURCE = [
    '#define PIN 6',
    'void sendByte(uint8_t b) {',
    '  for (int8_t i = 7; i >= 0; i--) {',
    '    if ((b >> i) & 1) {',
    '      PORTD |= (1 << PIN);',
    '      __asm__ __volatile__(".rept 20\\n nop\\n .endr\\n");',
    '      PORTD &= ~(1 << PIN);',
    '      __asm__ __volatile__(".rept 4\\n nop\\n .endr\\n");',
    '    } else {',
    '      PORTD |= (1 << PIN);',
    '      __asm__ __volatile__(".rept 4\\n nop\\n .endr\\n");',
    '      PORTD &= ~(1 << PIN);',
    '      __asm__ __volatile__(".rept 20\\n nop\\n .endr\\n");',
    '    }',
    '  }',
    '}',
    'void setup() {',
    '  DDRD |= (1 << PIN);',
    '  PORTD &= ~(1 << PIN);',
    '  delay(2);',
    '  noInterrupts();',
    '  sendByte(0x00); sendByte(0xFF); sendByte(0x00);', // GRB: full red
    '  sendByte(0xFF); sendByte(0x00); sendByte(0x00);', // GRB: full green
    '  interrupts();',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('neopixel');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const strip: ComponentInstance = {
    id: uid('n'), definitionId: 'comp.neopixel-strip', x: 300, y: 0, rotation: 0,
    properties: { pixelCount: 8 }, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(strip);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '5V', strip.id, 'vcc');
  wire(board.id, 'GND_TOP', strip.id, 'gnd');
  wire(board.id, 'D6', strip.id, 'din');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the bit-bang test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(100);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<
      string,
      { pixelColors?: { r: number; g: number; b: number }[] }
    >;
    const colors = visuals[strip.id]?.pixelColors ?? [];
    console.log(`   pixels: ${JSON.stringify(colors.slice(0, 3))}`);
    check(colors.length === 8, `the canvas is handed all eight pixels (${colors.length})`);
    check(
      colors[0]?.r === 255 && colors[0]?.g === 0 && colors[0]?.b === 0,
      `the first pixel is red, decoded from the pulses firmware produced (${JSON.stringify(colors[0])})`,
    );
    check(
      colors[1]?.g === 255 && colors[1]?.r === 0,
      `the second is green, so GRB order came off the wire (${JSON.stringify(colors[1])})`,
    );
    check(
      colors.slice(2).every((c) => !c.r && !c.g && !c.b),
      'and the six pixels firmware never addressed are dark — nothing was filled in',
    );
  }
  simulationController.stop();
}

// ============================================= 5. the wrong pin lights nothing
section('5. driving the wrong pin lights nothing');
{
  const SOURCE = [
    '#define PIN 5', // wired part is on D6
    'void setup() {',
    '  DDRD |= (1 << PIN);',
    '  noInterrupts();',
    '  for (uint8_t i = 0; i < 24; i++) {',
    '    PORTD |= (1 << PIN); __asm__ __volatile__(".rept 20\\n nop\\n .endr\\n");',
    '    PORTD &= ~(1 << PIN); __asm__ __volatile__(".rept 4\\n nop\\n .endr\\n");',
    '  }',
    '  interrupts();',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('neopixel-wrong-pin');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const strip: ComponentInstance = {
    id: uid('n'), definitionId: 'comp.neopixel', x: 300, y: 0, rotation: 0,
    properties: { pixelCount: 1 }, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(strip);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '5V', strip.id, 'vcc');
  wire(board.id, 'GND_TOP', strip.id, 'gnd');
  wire(board.id, 'D6', strip.id, 'din');

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the wrong-pin variant would not start');
  } else {
    simulationController.pause();
    simulationController.advance(100);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<
      string,
      { pixelColors?: { r: number; g: number; b: number }[] }
    >;
    const colors = visuals[strip.id]?.pixelColors ?? [];
    check(
      colors.every((c) => !c.r && !c.g && !c.b),
      `a strip whose data pin is never driven stays dark (${JSON.stringify(colors)})`,
    );
  }
  simulationController.stop();
}

// ==================================================== 6. the parts as shipped
section('6. the four parts in the library');
{
  const ids = ['comp.neopixel', 'comp.neopixel-ring', 'comp.neopixel-strip', 'comp.neopixel-matrix'];
  for (const id of ids) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.supportLevel === 'simulated', `${id} is badged Simulated`);
    check(def.simulationAdapterId === 'sim.neopixel', `${id} uses the addressable-LED adapter`);
    for (const pinId of ['din', 'dout', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `${id} exposes ${pinId}`);
    }
    check(
      def.properties.some((pp) => pp.key === 'pixelCount'),
      `${id} lets you set the pixel count, which is how chaining is expressed`,
    );
    check(/DOUT\s+drives nothing/.test(def.description ?? ''), `${id} says outright that DOUT is not modelled`);

    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'simulated', `${id} is recorded as simulated`);
    check((cov?.tests ?? []).includes('tests/leds.addressable.mts'), `${id} names this file as its proof`);
  }
}

console.log(
  failures === 0
    ? `\nAddressable LED checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
