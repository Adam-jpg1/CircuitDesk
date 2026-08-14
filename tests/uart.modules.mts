// The HC-05 and the DFPlayer: two modules on the same UART endpoint.
//
// Both are behavioural in a specific, stated way, and both have one behaviour
// that decides whether a model is worth having.
//
// For the HC-05 it is the AT/data split. The module only interprets commands
// while KEY is held high; otherwise every byte is passed through. A model that
// always answered AT would make a sketch that works here fail on a bench.
// There is no Bluetooth here at all, and the test asserts the description says
// so rather than letting the part's name imply it.
//
// For the DFPlayer it is the checksum. Every command is a ten-byte frame whose
// checksum is the negated sum of six of them, and a real module ignores a frame
// that gets it wrong. Hand-rolled DFPlayer code gets it wrong constantly, so a
// model that accepted anything beginning with 0x7E would make broken code look
// correct — which is the opposite of useful.

import { Hc05Device } from '../src/simulation/devices/hc05';
import { DfPlayerDevice, dfplayerFrame, DFPLAYER_CMD, checksumOf } from '../src/simulation/devices/dfplayer';
import { UartLink } from '../src/simulation/devices/uartEndpoint';
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

/** Sends a line to a device the way a sketch does, and reads the reply. */
function talk(device: Hc05Device, line: string): string {
  for (const ch of `${line}\r\n`) device.onByteFromBoard(ch.charCodeAt(0), 0);
  return String.fromCharCode(...device.takeBytesForBoard(0));
}

// ============================================= 1. the HC-05's AT/data split =
section('1. AT mode only when KEY says so');
{
  const hc = new Hc05Device('h');
  check(hc.currentMode === 'data', 'a module powers up transparent');

  // In data mode, "AT" is just two bytes to send onwards.
  const inData = talk(hc, 'AT');
  check(inData === '', `no reply in data mode ("${inData.trim()}")`);
  check(hc.transparentBytes.length === 4, `and the bytes were passed through (${hc.transparentBytes.length})`);

  hc.setKeyPin(true);
  check(hc.currentMode === 'at', 'holding KEY high enters AT mode');
  check(talk(hc, 'AT').trim() === 'OK', 'and now AT answers OK');
}

// ================================================= 2. the AT subset that works
section('2. the commands a sketch actually sends');
{
  const hc = new Hc05Device('h');
  hc.setKeyPin(true);

  check(talk(hc, 'AT+NAME=RobotArm').trim() === 'OK', 'the name can be set');
  check(talk(hc, 'AT+NAME?').includes('+NAME:RobotArm'), 'and read back');
  check(hc.deviceName === 'RobotArm', 'the module holds it');

  check(talk(hc, 'AT+ROLE=1').trim() === 'OK', 'the role can be set');
  check(talk(hc, 'AT+ROLE?').includes('+ROLE:1'), 'and read back as master');

  check(talk(hc, 'AT+PSWD=4321').trim() === 'OK', 'the PIN can be set');
  check(talk(hc, 'AT+PSWD?').includes('4321'), 'and read back');

  // Setting the UART changes the rate the link then has to match.
  talk(hc, 'AT+UART=38400,0,0');
  check(hc.uartConfig().baud === 38400, `AT+UART changes the module's own baud (${hc.uartConfig().baud})`);

  check(talk(hc, 'AT+VERSION?').includes('+VERSION:'), 'the version query answers');

  // The important negative: nonsense gets ERROR, not OK.
  const bogus = talk(hc, 'AT+NONSENSE');
  check(bogus.startsWith('ERROR'), `an unknown command answers ERROR ("${bogus.trim()}")`);
  check(hc.unknown.length === 1, 'and is recorded');
}

// ==================================== 3. no Bluetooth is claimed anywhere ====
section('3. the part does not pretend to have a radio');
{
  const def = defOf('comp.hc05');
  check(def !== undefined, 'the HC-05 is in the library');
  check(/NO Bluetooth/i.test(def?.description ?? ''), 'the description says there is no Bluetooth');
  for (const absent of ['pairing', 'RFCOMM', 'profiles']) {
    check((def?.description ?? '').includes(absent), `and names ${absent} as absent`);
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.hc05');
  check(cov?.status === 'behavioral', 'it is recorded as behavioural, not simulated');
  check(
    (cov?.dependencies ?? []).includes('bluetooth-channel'),
    `with a concrete blocker (${(cov?.dependencies ?? []).join(', ')})`,
  );
}

// ============================================= 4. the DFPlayer's checksum ====
section('4. a frame with a bad checksum is ignored, as on the hardware');
{
  const df = new DfPlayerDevice('d');
  const send = (frame: number[]) => {
    for (const b of frame) df.onByteFromBoard(b, 0);
  };

  const good = dfplayerFrame(DFPLAYER_CMD.PLAY_TRACK, 3);
  send(good);
  check(df.playback === 'playing' && df.currentTrack === 3, `a valid frame plays track 3 (${df.currentTrack})`);
  check(df.frameCount === 1, 'and is counted');

  // The same frame with the checksum corrupted.
  const bad = dfplayerFrame(DFPLAYER_CMD.PLAY_TRACK, 7);
  bad[7] ^= 0xff;
  send(bad);
  check(df.currentTrack === 3, `a bad checksum changes nothing (still track ${df.currentTrack})`);
  check(df.badChecksumCount === 1, 'and is counted rather than silently dropped');

  // A partial frame must not desynchronise the module for ever.
  send([0x7e, 0xff, 0x06]);
  send(dfplayerFrame(DFPLAYER_CMD.PLAY_TRACK, 5));
  check(df.currentTrack === 5, `a following valid frame still works (${df.currentTrack})`);
}

// ============================================== 5. playback state is real ====
section('5. the state a sketch can read back');
{
  const df = new DfPlayerDevice('d');
  df.setTrackCount(4);
  const send = (cmd: number, param = 0) => {
    for (const b of dfplayerFrame(cmd, param)) df.onByteFromBoard(b, 0);
  };

  send(DFPLAYER_CMD.SET_VOLUME, 22);
  check(df.currentVolume === 22, `volume is set (${df.currentVolume})`);
  send(DFPLAYER_CMD.VOLUME_UP);
  check(df.currentVolume === 23, 'and steps up');

  send(DFPLAYER_CMD.PLAY_TRACK, 2);
  check(df.playback === 'playing', 'playing');
  check(df.busyPinLow, 'and BUSY goes low while it plays, which sketches poll');

  send(DFPLAYER_CMD.PAUSE);
  check(df.playback === 'paused', 'pause holds the track');
  check(df.currentTrack === 2, `at track 2 (${df.currentTrack})`);
  check(!df.busyPinLow, 'and BUSY releases');

  send(DFPLAYER_CMD.PLAY);
  check(df.playback === 'playing', 'play resumes');
  send(DFPLAYER_CMD.NEXT);
  check(df.currentTrack === 3, `next advances (${df.currentTrack})`);
  send(DFPLAYER_CMD.STOP);
  check(df.playback === 'stopped', 'stop stops');

  // A track that is not on the card does not play.
  send(DFPLAYER_CMD.PLAY_TRACK, 99);
  check(df.playback === 'stopped', 'a track past the end of the card does not play');

  // A query answers with a well-formed frame the library can parse.
  df.takeBytesForBoard(0);
  send(DFPLAYER_CMD.QUERY_VOLUME);
  const reply = df.takeBytesForBoard(0);
  check(reply.length === 10, `a query answers with a ten-byte frame (${reply.length})`);
  check(reply[0] === 0x7e && reply[9] === 0xef, 'framed correctly');
  const sum = checksumOf(reply);
  check(((reply[7] << 8) | reply[8]) === sum, "and with a checksum the sketch's library will accept");
  check(reply[6] === 23, `carrying the volume (${reply[6]})`);
}

// ============================= 6. through a real board and a real wire =======
section('6. an executed sketch driving a wired DFPlayer');
{
  // The sketch builds the frames itself, checksum and all — no library, so this
  // is the protocol being exercised rather than an API.
  const SOURCE = [
    'void frame(uint8_t cmd, uint16_t param) {',
    '  uint8_t f[10] = {0x7E, 0xFF, 0x06, cmd, 0x00, (uint8_t)(param >> 8), (uint8_t)(param & 0xFF), 0, 0, 0xEF};',
    '  uint16_t sum = 0;',
    '  for (uint8_t i = 1; i <= 6; i++) sum += f[i];',
    '  sum = -sum;',
    '  f[7] = sum >> 8; f[8] = sum & 0xFF;',
    '  for (uint8_t i = 0; i < 10; i++) Serial.write(f[i]);',
    '}',
    'void setup() {',
    '  Serial.begin(9600);',
    '  delay(20);',
    '  frame(0x06, 18);',  // volume 18
    '  frame(0x03, 4);',   // play track 4
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('dfplayer');
  const board = inst('board.arduino-uno');
  const df = inst('comp.dfplayer', { trackCount: 8 });
  p.boardInstances.push(board);
  p.componentInstances.push(df);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  wire(p, board.id, '5V', df.id, 'vcc');
  wire(p, board.id, 'GND_TOP', df.id, 'gnd');
  wire(p, board.id, 'D1', df.id, 'rx'); // board TX drives the module's RX
  wire(p, board.id, 'D0', df.id, 'tx');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired DFPlayer test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    const binding = (simulationController as unknown as {
      binding: { uartDeviceFor(id: string): unknown } | null;
    }).binding;
    const device = binding?.uartDeviceFor(df.id);
    if (device instanceof DfPlayerDevice) {
      console.log(`   module: ${device.snapshot().status}`);
      check(device.frameCount >= 2, `the module received the frames (${device.frameCount})`);
      check(device.badChecksumCount === 0, 'with correct checksums');
      check(device.currentVolume === 18, `volume 18 (${device.currentVolume})`);
      check(device.playback === 'playing' && device.currentTrack === 4, `playing track 4 (${device.currentTrack})`);
    } else {
      check(false, 'the DFPlayer model was reachable from the binding');
    }
  }
  simulationController.stop();
}

// ============================ 6b. the HC-05's KEY pin is a wire, not a flag ==
section('6b. an executed sketch putting an HC-05 into AT mode');
{
  // The sketch drives EN high and then sends AT+NAME=. If the KEY pin were
  // decorative the module would take the bytes as data instead, and the name
  // would never change — which is exactly the bench failure this models.
  const SOURCE = [
    'void setup() {',
    '  pinMode(2, OUTPUT);',
    '  digitalWrite(2, HIGH);',
    '  Serial.begin(9600);',
    '  delay(30);',
    '  Serial.print("AT+NAME=DESKBOT\\r\\n");',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('hc05-at');
  const board = inst('board.arduino-uno');
  const hc = inst('comp.hc05');
  p.boardInstances.push(board);
  p.componentInstances.push(hc);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  wire(p, board.id, '5V', hc.id, 'vcc');
  wire(p, board.id, 'GND_TOP', hc.id, 'gnd');
  wire(p, board.id, 'D2', hc.id, 'en');
  wire(p, board.id, 'D1', hc.id, 'rxd');
  wire(p, board.id, 'D0', hc.id, 'txd');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired HC-05 test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    const binding = (simulationController as unknown as {
      binding: { uartDeviceFor(id: string): unknown } | null;
    }).binding;
    const device = binding?.uartDeviceFor(hc.id);
    if (device instanceof Hc05Device) {
      console.log(`   module: ${device.snapshot().status}`);
      check(device.currentMode === 'at', 'the EN wire put the module into AT mode');
      check(device.deviceName === 'DESKBOT', `and the command took effect (${device.deviceName})`);
      check(device.transparentBytes.length === 0, 'with nothing swallowed as data');
    } else {
      check(false, 'the HC-05 model was reachable from the binding');
    }
  }
  simulationController.stop();
}

// ==================================================== 7. the parts as shipped
section('7. the parts in the library');
{
  const df = defOf('comp.dfplayer');
  check(df !== undefined, 'the DFPlayer is in the library');
  if (df) {
    check(df.supportLevel === 'simulated', 'badged Simulated');
    for (const pinId of ['tx', 'rx', 'busy', 'vcc', 'gnd']) {
      check(df.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    check(/Nothing decodes an MP3/.test(df.description ?? ''), 'and disclaims audio outright');
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.dfplayer');
  check(cov?.status === 'behavioral', 'recorded as behavioural');
  check((cov?.dependencies ?? []).includes('audio-decoder'), 'with audio-decoder as its blocker');

  // The endpoint's semantics must not have regressed while adding devices.
  const link = new UartLink('b', new Hc05Device('x'));
  check(typeof link.boardTransmitted === 'function', 'the shared endpoint is still the path devices use');
}

console.log(
  failures === 0
    ? `\nUART module checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
