// The UART endpoint, and a GPS that talks through it rather than around it.
//
// The shortcut this file exists to prevent: a GPS is on the canvas, the board
// has a serial peripheral, so the GPS calls queueSerialInput and everything
// works. With that shortcut a GPS wired to the wrong pins works, a GPS with no
// wires works, two boards each with their own GPS read each other's sentences,
// and a baud mismatch produces perfect text. All four are tested below and all
// four must fail.
//
// Fidelity is stated rather than implied: this is a byte-level endpoint with
// modelled timing, not a bit-level one. Byte time, baud agreement and idle are
// modelled because firmware can observe them; start-bit edges are not, and that
// gap is recorded as `uart-bit-level` rather than quietly avoided.

import {
  UartLink,
  byteTimeUs,
  baudCompatible,
  DEFAULT_UART,
  type UartConfig,
  type UartPeripheral,
} from '../src/simulation/devices/uartEndpoint';
import { GpsNeo6mDevice, checksum } from '../src/simulation/devices/gpsNeo6m';
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
const inst = (definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance => ({
  id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});
function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

/** A device that records what it is given and says what it is told to say. */
class LoopbackDevice implements UartPeripheral {
  readonly instanceId = 'loop';
  received: number[] = [];
  outbound: number[] = [];
  private config: UartConfig;
  constructor(baud = 9600) {
    this.config = { ...DEFAULT_UART, baud };
  }
  uartConfig(): UartConfig {
    return this.config;
  }
  onByteFromBoard(byte: number): void {
    this.received.push(byte);
  }
  takeBytesForBoard(): number[] {
    const out = this.outbound;
    this.outbound = [];
    return out;
  }
  reset(): void {
    this.received = [];
    this.outbound = [];
  }
}

// ============================================== 1. the wire costs real time =
section('1. a byte takes as long as the baud says');
{
  const slow = byteTimeUs({ baud: 9600, dataBits: 8, parity: 'none', stopBits: 1 });
  const fast = byteTimeUs({ baud: 115200, dataBits: 8, parity: 'none', stopBits: 1 });
  console.log(`   9600 baud: ${slow.toFixed(1)} us/byte   115200 baud: ${fast.toFixed(1)} us/byte`);
  check(Math.abs(slow - 1041.7) < 1, `ten bits at 9600 is about 1042 us (${slow.toFixed(1)})`);
  check(fast < slow / 10, 'and twelve times the rate is more than ten times faster');

  const withParity = byteTimeUs({ baud: 9600, dataBits: 8, parity: 'even', stopBits: 2 });
  check(withParity > slow, 'parity and a second stop bit make the byte longer, as they do on a wire');
}

// ================================================= 2. baud has to agree =====
section('2. two ends at different rates do not exchange clean bytes');
{
  check(baudCompatible(9600, 9600), 'identical rates agree');
  check(baudCompatible(9600, 9800), 'a two per cent error is within what a UART tolerates');
  check(!baudCompatible(9600, 115200), 'and twelve times the rate is not');
  check(!baudCompatible(9600, 4800), 'nor half of it');

  const device = new LoopbackDevice(9600);
  const link = new UartLink('board', device);

  link.setBoardConfig({ baud: 9600 });
  link.boardTransmitted(0x41, 0);
  check(device.received[0] === 0x41, 'at matching rates the byte arrives intact');

  link.setBoardConfig({ baud: 115200 });
  link.boardTransmitted(0x41, 0);
  check(device.received[1] !== 0x41, `at mismatched rates it does not (0x${device.received[1].toString(16)})`);
  check(link.stats.framingErrors === 1, 'and the link counts a framing error');

  // The same in the other direction: a sketch at the wrong rate reads rubbish.
  const back = new LoopbackDevice(9600);
  const link2 = new UartLink('board', back);
  link2.setBoardConfig({ baud: 38400 });
  back.outbound = [0x48, 0x49];
  link2.poll(0);
  const got = link2.drainToBoard(10_000_000);
  check(got.length === 2, 'the bytes still arrive');
  check(got[0] !== 0x48, 'but not as what was sent — a wrong Serial.begin gives rubbish, not silence');
}

// ============================================ 3. bytes arrive at wire speed =
section('3. a burst is delivered over the time it would really take');
{
  const device = new LoopbackDevice(9600);
  const link = new UartLink('board', device);
  link.setBoardConfig({ baud: 9600 });
  device.outbound = [1, 2, 3, 4, 5];
  link.poll(0);

  check(link.drainToBoard(0).length === 1, 'the first byte is available immediately');
  check(link.drainToBoard(0).length === 0, 'and the second is not yet');
  const spacing = byteTimeUs(DEFAULT_UART);
  check(link.drainToBoard(spacing * 2).length === 2, 'two more after two byte times');
  check(link.drainToBoard(spacing * 10).length === 2, 'and the rest once the wire has had time');
  check(link.stats.pending === 0, 'with nothing left queued');
}

// ================================= 4. the GPS emits sentences a parser accepts
section('4. real NMEA, with checksums that validate');
{
  const gps = new GpsNeo6mDevice('g');
  gps.fix.latitude = 48.8584;
  gps.fix.longitude = 2.2945;
  gps.fix.altitudeMetres = 330;
  gps.fix.satellites = 11;
  gps.fix.speedKnots = 3.5;
  gps.fix.headingDegrees = 92.5;

  const text = gps.peekSentences();
  console.log(`   ${text.trim().split('\r\n').join('\n   ')}`);

  const lines = text.trim().split('\r\n');
  check(lines.length === 2, `two sentences (${lines.length})`);
  check(lines[0].startsWith('$GPGGA,'), 'a GGA');
  check(lines[1].startsWith('$GPRMC,'), 'and an RMC');

  // The checksum is the thing a strict parser rejects, so it is computed.
  for (const line of lines) {
    const star = line.lastIndexOf('*');
    const body = line.slice(1, star);
    const given = line.slice(star + 1);
    check(checksum(body) === given, `${line.slice(1, 7)} carries a valid checksum (${given})`);
  }

  // The configured position is in the sentence, in NMEA's ddmm.mmmm form.
  // 48.8584 deg = 48 deg 51.504 min.
  check(lines[0].includes('4851.504'), `the latitude is the configured one (${lines[0].split(',')[2]})`);
  check(lines[0].includes(',N,'), 'in the northern hemisphere');
  check(lines[0].includes('00217.670'), `and the longitude too (${lines[0].split(',')[4]})`);
  check(lines[0].includes(',E,'), 'east of Greenwich');
  check(lines[0].includes(',11,'), 'with the satellite count');
  check(lines[1].includes('3.50'), 'and the RMC carries the speed');

  // No fix is a different sentence, not a missing one.
  const lost = new GpsNeo6mDevice('g2');
  lost.fix.hasFix = false;
  const lostLines = lost.peekSentences().trim().split('\r\n');
  check(lostLines[1].split(',')[2] === 'V', 'with no fix the RMC status is V, not A');
  check(lostLines[0].split(',')[6] === '0', 'and the GGA fix quality is 0');
}

// ============================ 5. through a real board, a real wire, real UART
section('5. an executed sketch parsing sentences off its own Serial');
{
  // The sketch reads Serial and echoes what it finds. Nothing GPS-specific and
  // nothing simulator-specific: if the bytes did not come through the UART
  // peripheral, this prints nothing.
  const SOURCE = [
    'char line[100];',
    'uint8_t n = 0;',
    'void setup() { Serial.begin(9600); }',
    'void loop() {',
    '  while (Serial.available()) {',
    '    char c = Serial.read();',
    '    if (c == 0x0A) {',
    '      line[n] = 0;',
    '      if (n > 6 && line[0] == 0x24 && line[3] == 0x52) Serial.println(line);',
    '      n = 0;',
    '    } else if (n < 98 && c != 0x0D) {',
    '      line[n++] = c;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('gps');
  const board = inst('board.arduino-uno');
  const gps = inst('comp.gps', { latitude: 48.8584, longitude: 2.2945, satellites: 11, baud: 9600 });
  p.boardInstances.push(board);
  p.componentInstances.push(gps);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  wire(p, board.id, '5V', gps.id, 'vcc');
  wire(p, board.id, 'GND_TOP', gps.id, 'gnd');
  wire(p, board.id, 'D0', gps.id, 'tx'); // the module drives the board's RX
  wire(p, board.id, 'D1', gps.id, 'rx');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired GPS test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(3000);
    simulationController.publishNow();
    const text = useSimulationStore.getState().serialText ?? '';
    const echoed = text.split('\n').filter((l) => l.startsWith('$GPRMC'));
    console.log(`   sketch echoed: ${echoed[0] ?? '(nothing)'}`);
    check(echoed.length > 0, 'the sketch received NMEA through its own Serial port');
    check(
      (echoed[0] ?? '').includes('4851.504'),
      'carrying the latitude configured on the part, not a default',
    );
  }
  simulationController.stop();
}

// ============================== 6. wrong pins, no pins, and the wrong board ==
section('6. a GPS that is not wired to the UART does nothing');
{
  const SOURCE = [
    'void setup() { Serial.begin(9600); }',
    'void loop() { while (Serial.available()) { Serial.print("X"); Serial.read(); } }',
  ].join('\n');

  const build = async (label: string, wireIt: (p: CircuitProject, b: string, g: string) => void) => {
    const p = emptyProject(label);
    const board = inst('board.arduino-uno');
    const gps = inst('comp.gps');
    p.boardInstances.push(board);
    p.componentInstances.push(gps);
    p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
    wire(p, board.id, '5V', gps.id, 'vcc');
    wire(p, board.id, 'GND_TOP', gps.id, 'gnd');
    wireIt(p, board.id, gps.id);
    simulationController.stop();
    const report = await simulationController.build(p);
    if (!report.anyRunnable || !(await simulationController.start())) return null;
    simulationController.pause();
    simulationController.advance(2500);
    simulationController.publishNow();
    const text = useSimulationStore.getState().serialText ?? '';
    simulationController.stop();
    return text;
  };

  const wrongPins = await build('wrong-pins', (p, b, g) => {
    wire(p, b, 'D5', g, 'tx'); // not the UART pad
    wire(p, b, 'D6', g, 'rx');
  });
  if (wrongPins === null) skip('the wrong-pins variant would not start');
  else check(!wrongPins.includes('X'), `a GPS on the wrong pins delivers nothing ("${wrongPins.trim()}")`);

  const noPins = await build('no-pins', () => {
    /* power only */
  });
  if (noPins === null) skip('the unwired variant would not start');
  else check(!noPins.includes('X'), `and one with no data wires at all delivers nothing ("${noPins.trim()}")`);
}

// ============================================ 7. two boards stay independent
section('7. two boards with their own GPS do not read each other');
{
  const SOURCE = [
    'void setup() { Serial.begin(9600); }',
    'void loop() {',
    '  static char line[100]; static uint8_t n = 0;',
    '  while (Serial.available()) {',
    '    char c = Serial.read();',
    '    if (c == 0x0A) { line[n] = 0; if (n > 20) Serial.println(line); n = 0; }',
    '    else if (n < 98 && c != 0x0D) line[n++] = c;',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('two-gps');
  const boardA = inst('board.arduino-uno');
  const boardB = inst('board.arduino-uno');
  // Two obviously different longitudes, so a crossed link is unmistakable.
  const gpsA = inst('comp.gps', { latitude: 10.0, longitude: 10.0 });
  const gpsB = inst('comp.gps', { latitude: 20.0, longitude: 20.0 });
  p.boardInstances.push(boardA, boardB);
  p.componentInstances.push(gpsA, gpsB);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  for (const [b, g] of [
    [boardA, gpsA],
    [boardB, gpsB],
  ] as [ComponentInstance, ComponentInstance][]) {
    wire(p, b.id, '5V', g.id, 'vcc');
    wire(p, b.id, 'GND_TOP', g.id, 'gnd');
    wire(p, b.id, 'D0', g.id, 'tx');
    wire(p, b.id, 'D1', g.id, 'rx');
  }

  simulationController.stop();
  const report = await simulationController.build(p);
  console.log(`   builds: ${report.builds.length}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the two-board variant would not start');
  } else {
    simulationController.pause();
    simulationController.advance(3000);
    simulationController.publishNow();
    const store = useSimulationStore.getState();
    const combined = store.serialText ?? '';
    // 10 deg = 1000.0000, 20 deg = 2000.0000 in NMEA's ddmm.mmmm.
    const sawA = /1000\.0000/.test(combined);
    const sawB = /2000\.0000/.test(combined);
    console.log(`   saw GPS A: ${sawA}   saw GPS B: ${sawB}`);
    check(sawA && sawB, 'both boards received their own module');

    // The assertion that matters. With two boards speaking, the transcript
    // prefixes each line with the board that produced it — so a crossed link
    // shows up as one board's prefix carrying the other's coordinates.
    const lines = combined.split('\n').filter((l) => /\d{4}\.0000/.test(l));
    const speakers = new Set(lines.map((l) => /^\[([^\]]+)\]/.exec(l)?.[1] ?? ''));
    console.log(`   speakers: ${[...speakers].join(' | ')} over ${lines.length} line(s)`);
    check(speakers.size >= 2 && !speakers.has(''), `both boards are attributed (${speakers.size})`);

    const bySpeaker = new Map<string, Set<string>>();
    for (const line of lines) {
      const who = /^\[([^\]]+)\]/.exec(line)?.[1] ?? '?';
      const coord = /(\d{4}\.0000)/.exec(line)?.[1] ?? '?';
      const set = bySpeaker.get(who) ?? new Set<string>();
      set.add(coord);
      bySpeaker.set(who, set);
    }
    for (const [who, coords] of bySpeaker) {
      check(coords.size === 1, `${who} saw exactly one module (${[...coords].join(', ')})`);
    }
    const allCoords = new Set([...bySpeaker.values()].flatMap((c) => [...c]));
    check(allCoords.size === 2, 'and the two boards saw different ones — the links are per instance');
  }
  simulationController.stop();
}

// =================================================== 8. the part as shipped =
section('8. the GPS in the library');
{
  const def = defOf('comp.gps');
  check(def !== undefined, 'the NEO-6M is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    check(def.simulationAdapterId === 'sim.gps', 'on the GPS adapter');
    for (const key of ['latitude', 'longitude', 'satellites', 'hasFix', 'baud']) {
      check(def.properties.some((pp) => pp.key === key), `it exposes ${key}`);
    }
    // The privacy rule, as a check on the description.
    check(
      /nothing reads a host location/.test(def.description ?? ''),
      'and says outright that it never reads a real location',
    );
    check(/ESP32-C3 and C6 have none/.test(def.description ?? ''), 'and names the boards it cannot run on');
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.gps');
  check(cov?.status === 'simulated', 'recorded as simulated');
  check((cov?.tests ?? []).includes('tests/uart.link.mts'), 'and names this file as its proof');
}

console.log(
  failures === 0
    ? `\nUART link checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
