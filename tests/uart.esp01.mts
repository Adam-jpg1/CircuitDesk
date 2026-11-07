// The ESP-01 AT modem, the network it is really on, and the one it is not.
//
// Three things are proved here.
//
// The first: the AT modem is real. It parses commands, echoes them back the
// way real firmware does, gates everything on CH_PD and RST as actual wires,
// and joins a simulated access point only when the credentials match.
//
// The second: ESP-01s on one canvas share a LAN, and TCP between them works —
// a server listens, a client connects, bytes sent on one side arrive as +IPD
// on the other, and closing either end closes both.
//
// The third: the internet does NOT exist. AT+CIPSTART to a host name or to an
// address no module holds fails, and the part says why — a modem that
// answered CONNECT to example.com would make a sketch believe it had reached a
// server, and the day someone "fixes" that by returning success is the day
// the model starts lying to every sketch that uses it.

import { Esp01Device, Esp01Network, DEFAULT_ACCESS_POINT } from '../src/simulation/devices/esp01';
import { simulationController } from '../src/simulation/simulationController';
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

/** Sends a command line and reads back everything the module answered. */
function talk(device: Esp01Device, line: string): string {
  for (const ch of `${line}\r\n`) device.onByteFromBoard(ch.charCodeAt(0), 0);
  return String.fromCharCode(...device.takeBytesForBoard(0));
}
/** A running module with its banner already consumed. */
function running(): Esp01Device {
  const d = new Esp01Device('e');
  d.setChipEnable(true);
  d.takeBytesForBoard(0);
  return d;
}

// ================================================= 1. CH_PD is not a flag ====
section('1. a module held in reset answers nothing');
{
  const d = new Esp01Device('e');
  check(!d.isEnabled, 'a module powers up held in reset');
  check(talk(d, 'AT') === '', 'and answers nothing at all — the classic ESP-01 fault');

  d.setChipEnable(true);
  const banner = String.fromCharCode(...d.takeBytesForBoard(0));
  check(banner.includes('ready'), `releasing CH_PD prints the boot banner ("${banner.trim()}")`);
  check(talk(d, 'AT').includes('OK'), 'and now AT answers OK');

  d.setChipEnable(false);
  check(talk(d, 'AT') === '', 'pulling it low again silences it');
}

// ================================================== 2. the command parser ====
section('2. the AT commands a sketch actually sends');
{
  const d = running();

  const echoed = talk(d, 'AT');
  check(echoed.startsWith('AT\r\n'), 'a command is echoed back before its answer, as real firmware does');
  check(echoed.trim().endsWith('OK'), 'then answered');

  const off = talk(d, 'ATE0');
  check(off.includes('OK'), 'ATE0 is accepted');
  check(talk(d, 'AT') === 'OK\r\n', 'and the echo stops');
  check(!d.echoOn, 'which the model records');

  const gmr = talk(d, 'AT+GMR');
  check(/AT version:/.test(gmr) && /SDK version:/.test(gmr), 'AT+GMR reports versions');

  talk(d, 'AT+CWMODE=1');
  check(d.wifiMode === 1, 'the mode can be set');
  check(talk(d, 'AT+CWMODE?').includes('+CWMODE:1'), 'and read back');
  check(talk(d, 'AT+CWMODE=9').trim() === 'ERROR', 'an impossible mode is refused');

  const bogus = talk(d, 'AT+NOTHING');
  check(bogus.trim() === 'ERROR', `an unknown command answers ERROR ("${bogus.trim()}")`);
  check(d.unknown.length === 1, 'and is recorded');
}

// ==================================== 3. joining is checked, not assumed =====
section('3. the association depends on the credentials');
{
  const d = running();
  talk(d, 'ATE0');

  const wrongAp = talk(d, 'AT+CWJAP="SomewhereElse","simulated"');
  check(wrongAp.includes('FAIL'), 'an access point that does not exist fails');
  check(wrongAp.includes('+CWJAP:3'), 'with the "not found" code');
  check(!d.isJoined, 'and nothing is joined');

  const wrongPassword = talk(d, `AT+CWJAP="${DEFAULT_ACCESS_POINT.ssid}","wrong"`);
  check(wrongPassword.includes('FAIL'), 'the wrong password fails');
  check(wrongPassword.includes('+CWJAP:1'), 'with the "wrong password" code');
  check(!d.isJoined, 'and still nothing is joined');

  check(talk(d, 'AT+CIFSR').trim() === 'ERROR', 'an unassociated module has no address');
  check(talk(d, 'AT+CIPSTATUS').includes('STATUS:5'), 'and reports itself not connected');

  const joined = talk(d, `AT+CWJAP="${DEFAULT_ACCESS_POINT.ssid}","${DEFAULT_ACCESS_POINT.password}"`);
  check(joined.includes('WIFI CONNECTED') && joined.includes('OK'), 'the right credentials join');
  check(d.isJoined, 'and the model records it');
  check(talk(d, 'AT+CIFSR').includes('+CIFSR:STAIP'), 'now it has an address');
  check(talk(d, 'AT+CIPSTATUS').includes('STATUS:2'), 'and reports itself associated');
  check(talk(d, 'AT+CWJAP?').includes(DEFAULT_ACCESS_POINT.ssid), 'and names the AP it is on');

  const scan = talk(d, 'AT+CWLAP');
  check(scan.includes(DEFAULT_ACCESS_POINT.ssid), 'a scan finds the simulated access point');
  check(scan.split('+CWLAP:').length === 2, 'and only that one — nothing scans a real radio');

  talk(d, 'AT+CWQAP');
  check(!d.isJoined, 'and it can leave again');
}

// ================================ 4. the connection that must not be faked ===
section('4. AT+CIPSTART to the internet fails, because there is no internet');
{
  const d = running();
  talk(d, 'ATE0');
  talk(d, `AT+CWJAP="${DEFAULT_ACCESS_POINT.ssid}","${DEFAULT_ACCESS_POINT.password}"`);
  check(d.isJoined, 'a module that has joined the simulated AP');

  const started = talk(d, 'AT+CIPSTART="TCP","example.com",80');
  check(started.includes('ERROR'), 'still cannot open a socket');
  check(!/\bOK\b/.test(started), 'and does not answer OK');
  check(!/CONNECT/.test(started), 'and does not answer CONNECT');
  check(started.includes('CLOSED'), 'it closes, as a module that cannot reach a host does');
  check(d.refusedConnectionCount === 1, 'the refusal is counted so the inspector can explain it');

  check(talk(d, 'AT+CIPSEND=4').includes('ERROR'), 'and sending over the link that never opened fails');
  check(!talk(d, 'AT+CIPSTATUS').includes('STATUS:3'), 'the module never claims a live connection');

  // The status line has to say this out loud, not bury it.
  const status = d.snapshot().status;
  check(/refused/.test(status) && /only modules on this canvas/.test(status), `the inspector says why ("${status}")`);
  check(d.snapshot().log.some((l) => /no DNS and no route to the internet/.test(l)), 'and the log names the missing DNS and route');
  const raw = talk(d, 'AT+CIPSTART="TCP","93.184.216.34",80');
  check(raw.includes('ERROR') && !/CONNECT/.test(raw), 'an internet address fails too: nothing on the canvas holds it');
}

section('4b. two modules on one canvas talk TCP');
{
  const net = new Esp01Network();
  const join = (index: number) => {
    const d = running();
    d.setNetwork(net, index);
    talk(d, 'ATE0');
    talk(d, `AT+CWJAP="${DEFAULT_ACCESS_POINT.ssid}","${DEFAULT_ACCESS_POINT.password}"`);
    return d;
  };
  const server = join(0);
  const client = join(1);
  check(server.address === '192.168.4.2' && client.address === '192.168.4.3', `each has its own address (${server.address}, ${client.address})`);

  check(talk(server, 'AT+CIPSERVER=1,80').includes('ERROR'), 'a server needs AT+CIPMUX=1 first, as on the real firmware');
  talk(server, 'AT+CIPMUX=1');
  check(talk(server, 'AT+CIPSERVER=1,80').trim() === 'OK', 'with it, the server listens on port 80');

  const wrongPort = talk(client, 'AT+CIPSTART="TCP","192.168.4.2",81');
  check(wrongPort.includes('ERROR') && !/CONNECT/.test(wrongPort), 'a port nobody listens on is refused');

  const opened = talk(client, 'AT+CIPSTART="TCP","192.168.4.2",80');
  check(/CONNECT[\s\S]*OK/.test(opened), `the client connects (${JSON.stringify(opened)})`);
  check(String.fromCharCode(...server.takeBytesForBoard(0)).includes('0,CONNECT'), 'and the server sees link 0 connect');
  check(talk(client, 'AT+CIPSTATUS').includes('STATUS:3'), 'the client reports a live connection');

  const prompt = talk(client, 'AT+CIPSEND=5');
  check(prompt.includes('OK') && prompt.endsWith('> '), 'AT+CIPSEND prompts for the payload');
  for (const ch of 'hello') client.onByteFromBoard(ch.charCodeAt(0), 0);
  const sent = String.fromCharCode(...client.takeBytesForBoard(0));
  check(/Recv 5 bytes[\s\S]*SEND OK/.test(sent), 'the client is told the bytes went');
  const got = String.fromCharCode(...server.takeBytesForBoard(0));
  check(got.includes('+IPD,0,5:hello'), `the server receives them as +IPD on link 0 (${JSON.stringify(got)})`);

  talk(server, 'AT+CIPSEND=0,2');
  for (const ch of 'hi') server.onByteFromBoard(ch.charCodeAt(0), 0);
  server.takeBytesForBoard(0);
  check(String.fromCharCode(...client.takeBytesForBoard(0)).includes('+IPD,2:hi'), 'and the reply arrives at the client');

  check(talk(server, 'AT+CIPCLOSE=0').includes('0,CLOSED'), 'the server hangs up');
  check(String.fromCharCode(...client.takeBytesForBoard(0)).includes('CLOSED'), 'and the client sees the connection close');
  check(client.openConnections === 0 && server.openConnections === 0, 'nothing is left open on either side');

  const other = running();
  other.setNetwork(net, 2);
  talk(other, 'ATE0');
  talk(other, 'AT+CWJAP="SomewhereElse","x"');
  check(talk(client, 'AT+CIPSTART="TCP","192.168.4.4",80').includes('ERROR'), 'a module that never joined this AP cannot be reached');
}

// ========================== 5. through a real board, over a real wire ========
section('5. an executed sketch talking to a wired ESP-01');
{
  const SOURCE = [
    'void setup() {',
    '  pinMode(4, OUTPUT);',
    '  digitalWrite(4, HIGH);',   // CH_PD
    '  pinMode(5, OUTPUT);',
    '  digitalWrite(5, HIGH);',   // RST released
    '  Serial.begin(9600);',
    '  delay(30);',
    '  Serial.print("ATE0\\r\\n");',
    '  delay(10);',
    '  Serial.print("AT+CWJAP=\\"SimulatedAP\\",\\"simulated\\"\\r\\n");',
    '  delay(10);',
    '  Serial.print("AT+CIPSTART=\\"TCP\\",\\"example.com\\",80\\r\\n");',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('esp01');
  const board = inst('board.arduino-uno');
  const esp = inst('comp.esp01', { baud: 9600 });
  p.boardInstances.push(board);
  p.componentInstances.push(esp);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  wire(p, board.id, '3V3', esp.id, 'vcc');
  wire(p, board.id, 'GND_TOP', esp.id, 'gnd');
  wire(p, board.id, 'D4', esp.id, 'ch_pd');
  wire(p, board.id, 'D5', esp.id, 'rst');
  wire(p, board.id, 'D1', esp.id, 'rx');
  wire(p, board.id, 'D0', esp.id, 'tx');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired ESP-01 test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(500);
    const binding = (simulationController as unknown as {
      binding: { uartDeviceFor(id: string): unknown } | null;
    }).binding;
    const device = binding?.uartDeviceFor(esp.id);
    if (device instanceof Esp01Device) {
      console.log(`   module: ${device.snapshot().status}`);
      check(device.isEnabled, 'the CH_PD wire brought the module up');
      check(device.commandCount >= 3, `the commands arrived (${device.commandCount})`);
      check(device.isJoined, 'the sketch joined the simulated access point');
      check(device.address !== null, `and was given an address (${device.address})`);
      check(
        device.refusedConnectionCount === 1,
        `and its connection attempt was refused, not faked (${device.refusedConnectionCount})`,
      );
    } else {
      check(false, 'the ESP-01 model was reachable from the binding');
    }
  }
  simulationController.stop();
}

// =============================================== 6. the part as shipped ======
section('6. the ESP-01 in the library');
{
  const def = defOf('comp.esp01');
  check(def !== undefined, 'the ESP-01 is in the library');
  if (def) {
    // Simulated, with the limit stated: the LAN between canvas modules is
    // real, and the description says plainly that the internet is not there.
    check(def.supportLevel === 'simulated', `badged Simulated (${def.supportLevel})`);
    check(/no internet/i.test(def.description ?? ''), 'the description says there is no internet behind it');
    check(/AT\+CIPSTART/.test(def.description ?? ''), 'and names the socket commands');
    for (const key of ['ssid', 'password', 'baud']) {
      check(def.properties.some((pp) => pp.key === key), `it exposes ${key}`);
    }
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.esp01');
  check(cov?.status === 'behavioral', 'recorded as behavioural');
  check(!(cov?.dependencies ?? []).includes('network-stack'), 'with the network no longer listed as a blocker');
  check((cov?.tests ?? []).includes('tests/uart.esp01.mts'), 'and names this file as its proof');
}

console.log(
  failures === 0
    ? `\nESP-01 checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
