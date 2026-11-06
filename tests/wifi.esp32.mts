// Wi-Fi on the ESP32 family, the ESP8266 and the Pico W, through the
// firmware's own network stack.
//
// Espressif's Wi-Fi driver is closed and drives a radio; the simulator
// provides its API (src/simulation/wifi/idfDriver.ts; for the ESP8266, the
// NONOS SDK's station API in src/simulation/wifi/esp8266Driver.ts; for the
// Pico W, the CYW43439 at its SPI bus in src/simulation/wifi/cyw43Chip.ts) and
// the rest — Arduino's WiFi library, esp_netif, the event loop and lwIP — runs as
// compiled. The access point is a part on the canvas (comp.wifi-ap) whose
// DHCP, DNS and ARP the network model answers. Checked here:
//   * a scan finds the access point by SSID;
//   * WiFi.begin() with the right SSID and password connects, and DHCP gives
//     the board 192.168.1.x with the access point as gateway and DNS;
//   * a wrong password fails, and so does an SSID nobody broadcasts;
//   * two boards on the canvas reach each other, RISC-V and Xtensa alike: one
//     runs WebServer, the other finds it by hostname and fetches a page with
//     HTTPClient;
//   * the same on the ESP8266 NodeMCU: its scan, connection and failure
//     statuses, and an ESP8266WebServer an ESP32 and the workbench both reach;
//   * and on the Pico W, whose cyw43-driver and lwIP run as built against the
//     chip model: scan, WPA2 join, DHCP, the driver's own failure states, the
//     on-board LED (a CYW43 GPIO), and a WebServer an ESP32 fetches.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, code } from '../src/project/templates';
import { WifiNetwork } from '../src/simulation/wifi/network';
import { fetchFromBoard } from '../src/simulation/wifi/workbenchHost';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const cli = await detectArduinoCli();
if (!cli.available) {
  console.log('SKIP: arduino-cli is not available here');
  process.exit(0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;

const BOARDS = [
  { id: 'board.esp32-devkit', fqbn: 'esp32:esp32:esp32' },
  { id: 'board.esp32-cam', fqbn: 'esp32:esp32:esp32' },
  { id: 'board.esp32-s3', fqbn: 'esp32:esp32:esp32s3' },
  { id: 'board.esp32-c3', fqbn: 'esp32:esp32:esp32c3' },
  { id: 'board.esp32-c3-supermini', fqbn: 'esp32:esp32:esp32c3' },
  { id: 'board.esp32-c6-devkitc-1', fqbn: 'esp32:esp32:esp32c6' },
] as const;

async function boot(boardId: string, fqbn: string, sketch: string, network: WifiNetwork): Promise<{ r: Runner; out: () => string } | null> {
  const def = getBoardDefinition(boardId)!;
  const built = await compileProject({ fqbn, boardId: def.serverTargetId ?? def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: ${boardId} did not build here (${built.errors?.[0]?.message ?? built.error ?? ''})`);
    skipped++;
    return null;
  }
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  r.attachWifi?.(network, { id: `${boardId}-test`, label: def.name });
  let text = '';
  r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
  return { r, out: () => text };
}
const run = (r: Runner, ms: number) => {
  for (let t = 0; t < ms; t += 10) r.runFor(10);
};
const last = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]).at(-1);

for (const B of BOARDS.filter((x) => !process.env.ONLY || x.id === process.env.ONLY)) {
  const name = getBoardDefinition(B.id)!.name;

  section(`${name}: scan, connect, and what DHCP gave it`);
  {
    const net = new WifiNetwork();
    net.setAccessPoints([{ id: 'ap', ssid: 'BenchNet', password: 'correct-horse', channel: 6 }]);
    const s = await boot(B.id, B.fqbn, `#include <WiFi.h>
void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  Serial.print("scan "); Serial.println(n);
  for (int i = 0; i < n; i++) { Serial.print("ap "); Serial.print(WiFi.SSID(i)); Serial.print(' '); Serial.println(WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "secured"); }
  WiFi.begin("BenchNet", "correct-horse");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 5000) delay(20);
  Serial.print("status "); Serial.println(WiFi.status());
  Serial.print("ip "); Serial.println(WiFi.localIP());
  Serial.print("gw "); Serial.println(WiFi.gatewayIP());
  Serial.print("dns "); Serial.println(WiFi.dnsIP());
  Serial.print("ssid "); Serial.println(WiFi.SSID());
  Serial.print("mac "); Serial.println(WiFi.macAddress());
}
void loop() { delay(100); }`, net);
    if (s) {
      const t0 = performance.now();
      run(s.r, 2500);
      const wall = performance.now() - t0;
      const out = s.out();
      check(s.r.wifi != null, 'the build links the Wi-Fi driver, and the runner provides it');
      check(last(out, /scan (\d+)/g) === '1' && /ap BenchNet secured/.test(out), `a scan finds the access point (${JSON.stringify(out.match(/scan[^\n]*|ap [^\n]*/g))})`);
      check(last(out, /status (\d+)/g) === '3', `WiFi.begin() connects: WL_CONNECTED (${last(out, /status (\d+)/g)})`);
      check(/^192\.168\.1\.1\d\d$/.test(last(out, /ip ([\d.]+)/g) ?? ''), `DHCP gives it an address on the access point's subnet (${last(out, /ip ([\d.]+)/g)})`);
      check(last(out, /gw ([\d.]+)/g) === '192.168.1.1' && last(out, /dns ([\d.]+)/g) === '192.168.1.1', 'with the access point as its gateway and DNS server');
      check(last(out, /ssid (\S+)/g) === 'BenchNet', 'and WiFi.SSID() names the network');
      const station = net.stations()[0];
      check(station?.ssid === 'BenchNet' && station.mac.toUpperCase() === last(out, /mac ([0-9A-F:]+)/gi), `the network sees the board under the MAC the firmware reports (${station?.mac})`);
      check(s.r.fault == null, `nothing in the firmware stopped (${s.r.fault ?? 'no fault'})`);
      console.log(`  (2.5 s simulated in ${wall.toFixed(0)} ms)`);
    }
  }

  section(`${name}: a wrong password, and an SSID nobody broadcasts`);
  {
    const net = new WifiNetwork();
    net.setAccessPoints([{ id: 'ap', ssid: 'BenchNet', password: 'correct-horse', channel: 6 }]);
    const s = await boot(B.id, B.fqbn, `#include <WiFi.h>
int reason = -1;
void setup() {
  Serial.begin(115200);
  WiFi.onEvent([](arduino_event_id_t e, arduino_event_info_t info) { reason = info.wifi_sta_disconnected.reason; }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.begin("BenchNet", "wrong-password");
  delay(1500);
  Serial.print("wrong "); Serial.print(WiFi.status()); Serial.print(' '); Serial.println(reason);
  WiFi.disconnect(); delay(200); reason = -1;
  WiFi.begin("NoSuchNet", "whatever123");
  delay(1500);
  Serial.print("missing "); Serial.print(WiFi.status()); Serial.print(' '); Serial.println(reason);
}
void loop() { delay(100); }`, net);
    if (s) {
      run(s.r, 4000);
      const out = s.out();
      const wrong = /wrong (\d+) (-?\d+)/.exec(out);
      const missing = /missing (\d+) (-?\d+)/.exec(out);
      check(wrong !== null && wrong[1] !== '3' && wrong[2] === '202', `a wrong password does not connect, with reason AUTH_FAIL (202) (${wrong?.slice(1).join(' ')})`);
      check(missing !== null && missing[1] === '1' && missing[2] === '201', `an unknown SSID is WL_NO_SSID_AVAIL, reason NO_AP_FOUND (201) (${missing?.slice(1).join(' ')})`);
      check(net.stations().length === 0, 'and neither joined the network');
    }
  }
}

section('an ESP32-C6 web server and an ESP32 client on a canvas access point');
{
  const p = emptyProject('wifi pair');
  const server = inst('board.esp32-c6-devkitc-1', 0, 0);
  const client = inst('board.esp32-devkit', 300, 0);
  const ap = inst('comp.wifi-ap', 150, 300);
  ap.properties = { ssid: 'Workshop', password: 'solder-fumes', channel: 11 };
  server.label = 'Server';
  client.label = 'Client';
  const serverCode = code('server.ino', `#include <WiFi.h>
#include <WebServer.h>
WebServer web(80);
void setup() {
  Serial.begin(115200);
  WiFi.setHostname("thermostat");
  WiFi.begin("Workshop", "solder-fumes");
  while (WiFi.status() != WL_CONNECTED) delay(20);
  web.on("/", []() { web.send(200, "text/plain", "temperature=21.5"); });
  web.begin();
  Serial.print("serving on "); Serial.println(WiFi.localIP());
}
void loop() { web.handleClient(); delay(2); }`);
  const clientCode = code('client.ino', `#include <WiFi.h>
#include <HTTPClient.h>
void setup() {
  Serial.begin(115200);
  WiFi.begin("Workshop", "solder-fumes");
  while (WiFi.status() != WL_CONNECTED) delay(20);
  delay(300);
  HTTPClient http;
  http.begin("http://thermostat/");
  int code = http.GET();
  Serial.print("code "); Serial.println(code);
  if (code == 200) { Serial.print("body "); Serial.println(http.getString()); }
  http.end();
}
void loop() { delay(100); }`);
  server.sketchId = serverCode.id;
  client.sketchId = clientCode.id;
  p.boardInstances = [server, client];
  p.componentInstances = [ap];
  p.codeFiles = [serverCode, clientCode];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log('SKIP: the pair did not build or start here');
    skipped++;
  } else {
    simulationController.pause();
    for (let t = 0; t < 3000 && simulationController.advance(50); t += 50);
    simulationController.publishNow();
    const state = useSimulationStore.getState();
    const text = state.serialText ?? '';
    const stations = simulationController.wifiNetwork.stations();
    check(state.status !== 'error', `both boards run (${state.error ?? 'no error'})`);
    check(stations.length === 2 && stations.every((s) => s.ssid === 'Workshop' && s.ip), `both joined "Workshop" with addresses (${stations.map((s) => `${s.label}=${s.ip}`).join(', ')})`);
    check(stations.some((s) => s.label === 'Server' && s.hostname === 'thermostat'), 'the server is known by the hostname it gave DHCP');
    check(/code 200/.test(text), `the client's HTTP GET gets 200 (${text.match(/code -?\d+/)?.[0] ?? 'nothing'})`);
    check(/body temperature=21\.5/.test(text), `and the server's page (${text.match(/body [^\r\n]*/)?.[0] ?? 'nothing'})`);
    // The workbench, on the same access point, opens the page too.
    const page = await fetchFromBoard(simulationController.wifiNetwork, 'http://thermostat/', (ms) => {
      simulationController.advance(ms);
    }).catch((e: Error) => e);
    check(
      !(page instanceof Error) && page.status === 200 && new TextDecoder().decode(page.body) === 'temperature=21.5',
      `the workbench fetches http://thermostat/ itself (${page instanceof Error ? page.message : `${page.status} ${new TextDecoder().decode(page.body)}`})`,
    );
    const missing = await fetchFromBoard(simulationController.wifiNetwork, 'http://nobody/', () => {}).catch((e: Error) => e);
    check(missing instanceof Error && /No board/.test(missing.message), 'and a name no board has is refused plainly');
    simulationController.stop();
  }
}

// ---------------------------------------------------------------- ESP8266
const NODEMCU = { id: 'board.esp8266-nodemcu', fqbn: 'esp8266:esp8266:nodemcuv2' };
if (!process.env.ONLY || process.env.ONLY === NODEMCU.id) {
  const name = getBoardDefinition(NODEMCU.id)!.name;
  section(`${name}: scan, connect, and what DHCP gave it`);
  {
    const net = new WifiNetwork();
    net.setAccessPoints([{ id: 'ap', ssid: 'BenchNet', password: 'correct-horse', channel: 6 }]);
    const s = await boot(NODEMCU.id, NODEMCU.fqbn, `#include <ESP8266WiFi.h>
void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  Serial.print("scan "); Serial.println(n);
  for (int i = 0; i < n; i++) { Serial.print("ap "); Serial.print(WiFi.SSID(i)); Serial.print(' '); Serial.println(WiFi.encryptionType(i) == ENC_TYPE_NONE ? "open" : "secured"); }
  WiFi.begin("BenchNet", "correct-horse");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 5000) delay(20);
  Serial.print("status "); Serial.println(WiFi.status());
  Serial.print("ip "); Serial.println(WiFi.localIP());
  Serial.print("gw "); Serial.println(WiFi.gatewayIP());
  Serial.print("dns "); Serial.println(WiFi.dnsIP());
  Serial.print("ssid "); Serial.println(WiFi.SSID());
  Serial.print("mac "); Serial.println(WiFi.macAddress());
  Serial.printf("fmt %u %X\\n", 1234567u, 0xbeefu);
}
void loop() { delay(100); }`, net);
    if (s) {
      run(s.r, 2500);
      const out = s.out();
      check(s.r.wifi != null, 'the build reaches the SDK station API, and the runner provides it');
      check(last(out, /scan (\d+)/g) === '1' && /ap BenchNet secured/.test(out), `a scan finds the access point (${JSON.stringify(out.match(/scan[^\n]*|ap [^\n]*/g))})`);
      check(last(out, /status (\d+)/g) === '3', `WiFi.begin() connects: WL_CONNECTED (${last(out, /status (\d+)/g)})`);
      check(/^192\.168\.1\.1\d\d$/.test(last(out, /ip ([\d.]+)/g) ?? ''), `lwIP's DHCP gets an address on the access point's subnet (${last(out, /ip ([\d.]+)/g)})`);
      check(last(out, /gw ([\d.]+)/g) === '192.168.1.1' && last(out, /dns ([\d.]+)/g) === '192.168.1.1', 'with the access point as its gateway and DNS server');
      check(last(out, /ssid (\S+)/g) === 'BenchNet', 'and WiFi.SSID() names the network');
      const station = net.stations()[0];
      check(station?.mac.toUpperCase() === last(out, /mac ([0-9A-F:]+)/gi) && /^18:fe:34:/.test(station.mac), `the network sees the board under the MAC the SDK reads from its eFuse (${station?.mac})`);
      check(station?.hostname === `ESP-${station?.mac.replace(/:/g, '').slice(6).toUpperCase()}`, `and under the SDK's default hostname (${station?.hostname})`);
      check(/fmt 1234567 BEEF/.test(out), `printf formats numbers in full (${out.match(/fmt [^\r\n]*/)?.[0]})`);
      check(s.r.machine.fault == null, `nothing in the firmware stopped (${s.r.machine.fault ?? 'no fault'})`);
    }
  }

  section(`${name}: a wrong password, and an SSID nobody broadcasts`);
  {
    const net = new WifiNetwork();
    net.setAccessPoints([{ id: 'ap', ssid: 'BenchNet', password: 'correct-horse', channel: 6 }]);
    const s = await boot(NODEMCU.id, NODEMCU.fqbn, `#include <ESP8266WiFi.h>
int reason = -1;
WiFiEventHandler onDrop;
void setup() {
  Serial.begin(115200);
  onDrop = WiFi.onStationModeDisconnected([](const WiFiEventStationModeDisconnected& e) { reason = e.reason; });
  WiFi.mode(WIFI_STA);
  WiFi.begin("BenchNet", "wrong-password");
  delay(1500);
  Serial.printf("wrong %d %d\\n", WiFi.status(), reason);
  WiFi.disconnect(); delay(200); reason = -1;
  WiFi.begin("NoSuchNet", "whatever123");
  delay(1500);
  Serial.printf("missing %d %d\\n", WiFi.status(), reason);
}
void loop() { delay(100); }`, net);
    if (s) {
      run(s.r, 4000);
      const out = s.out();
      const wrong = /wrong (\d+) (-?\d+)/.exec(out);
      const missing = /missing (\d+) (-?\d+)/.exec(out);
      check(wrong !== null && wrong[1] === '6' && wrong[2] === '202', `a wrong password is WL_WRONG_PASSWORD, reason AUTH_FAIL (202) (${wrong?.slice(1).join(' ')})`);
      check(missing !== null && missing[1] === '1' && missing[2] === '201', `an unknown SSID is WL_NO_SSID_AVAIL, reason NO_AP_FOUND (201) (${missing?.slice(1).join(' ')})`);
      check(net.stations().length === 0, 'and neither joined the network');
    }
  }

  section('an ESP8266 web server and an ESP32 client on a canvas access point');
  {
    const p = emptyProject('wifi esp8266 pair');
    const server = inst(NODEMCU.id, 0, 0);
    const client = inst('board.esp32-devkit', 300, 0);
    const ap = inst('comp.wifi-ap', 150, 300);
    ap.properties = { ssid: 'Workshop', password: 'solder-fumes', channel: 1 };
    server.label = 'Weather';
    client.label = 'Client';
    const serverCode = code('weather.ino', `#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
ESP8266WebServer web(80);
void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.hostname("weather");
  WiFi.begin("Workshop", "solder-fumes");
  while (WiFi.status() != WL_CONNECTED) delay(20);
  web.on("/", []() { web.send(200, "text/plain", "pressure=1013"); });
  web.begin();
  Serial.print("serving on "); Serial.println(WiFi.localIP());
}
void loop() { web.handleClient(); }`);
    const clientCode = code('client.ino', `#include <WiFi.h>
#include <HTTPClient.h>
void setup() {
  Serial.begin(115200);
  WiFi.begin("Workshop", "solder-fumes");
  while (WiFi.status() != WL_CONNECTED) delay(20);
  delay(500);
  HTTPClient http;
  http.begin("http://weather/");
  int code = http.GET();
  Serial.print("code "); Serial.println(code);
  if (code == 200) { Serial.print("body "); Serial.println(http.getString()); }
  http.end();
}
void loop() { delay(100); }`);
    server.sketchId = serverCode.id;
    client.sketchId = clientCode.id;
    p.boardInstances = [server, client];
    p.componentInstances = [ap];
    p.codeFiles = [serverCode, clientCode];
    simulationController.stop();
    const report = await simulationController.build(p);
    if (!report.anyRunnable || !(await simulationController.start())) {
      console.log('SKIP: the ESP8266 pair did not build or start here');
      skipped++;
    } else {
      simulationController.pause();
      for (let t = 0; t < 3000 && simulationController.advance(50); t += 50);
      simulationController.publishNow();
      const state = useSimulationStore.getState();
      const text = state.serialText ?? '';
      const stations = simulationController.wifiNetwork.stations();
      check(state.status !== 'error', `both boards run (${state.error ?? 'no error'})`);
      check(stations.some((s) => s.label === 'Weather' && s.hostname === 'weather' && s.ip), `the ESP8266 joined "Workshop" as "weather" (${stations.map((s) => `${s.label}=${s.hostname}@${s.ip}`).join(', ')})`);
      check(/code 200/.test(text) && /body pressure=1013/.test(text), `the ESP32's GET reaches the ESP8266's server (${text.match(/code -?\d+|body [^\r\n]*/g)?.join(' ') ?? 'nothing'})`);
      const page = await fetchFromBoard(simulationController.wifiNetwork, 'http://weather/', (ms) => {
        simulationController.advance(ms);
      }).catch((e: Error) => e);
      check(
        !(page instanceof Error) && page.status === 200 && new TextDecoder().decode(page.body) === 'pressure=1013',
        `the workbench fetches http://weather/ itself (${page instanceof Error ? page.message : `${page.status} ${new TextDecoder().decode(page.body)}`})`,
      );
      simulationController.stop();
    }
  }
}

// ---------------------------------------------------------------- Pico W
const PICOW = { id: 'board.raspberry-pi-pico-w', fqbn: 'rp2040:rp2040:rpipicow' };
if (!process.env.ONLY || process.env.ONLY === PICOW.id) {
  section('Pico W: scan, connect, and what DHCP gave it');
  {
    const net = new WifiNetwork();
    net.setAccessPoints([{ id: 'ap', ssid: 'BenchNet', password: 'correct-horse', channel: 6 }]);
    const s = await boot(PICOW.id, PICOW.fqbn, `#include <WiFi.h>
void setup() {
  Serial1.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
  int n = WiFi.scanNetworks();
  Serial1.print("scan "); Serial1.println(n);
  for (int i = 0; i < n; i++) { Serial1.print("ap "); Serial1.print(WiFi.SSID(i)); Serial1.print(' '); Serial1.println(WiFi.encryptionType(i) == ENC_TYPE_NONE ? "open" : "secured"); }
  WiFi.begin("BenchNet", "correct-horse");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 8000) delay(20);
  Serial1.print("status "); Serial1.println(WiFi.status());
  Serial1.print("ip "); Serial1.println(WiFi.localIP());
  Serial1.print("gw "); Serial1.println(WiFi.gatewayIP());
  Serial1.print("dns "); Serial1.println(WiFi.dnsIP());
  Serial1.print("ssid "); Serial1.println(WiFi.SSID());
  Serial1.print("mac "); Serial1.println(WiFi.macAddress());
}
void loop() { delay(100); }`, net);
    if (s) {
      run(s.r, 3000);
      const out = s.out();
      check(s.r.wifi != null, 'the build drives a CYW43, and the runner provides the chip');
      check(last(out, /scan (\d+)/g) === '1' && /ap BenchNet secured/.test(out), `a scan finds the access point as WPA2 (${JSON.stringify(out.match(/scan[^\n]*|ap [^\n]*/g))})`);
      check(last(out, /status (\d+)/g) === '3', `WiFi.begin() connects: WL_CONNECTED (${last(out, /status (\d+)/g)})`);
      check(/^192\.168\.1\.1\d\d$/.test(last(out, /ip ([\d.]+)/g) ?? ''), `lwIP's DHCP gets an address on the access point's subnet (${last(out, /ip ([\d.]+)/g)})`);
      check(last(out, /gw ([\d.]+)/g) === '192.168.1.1' && last(out, /dns ([\d.]+)/g) === '192.168.1.1', 'with the access point as its gateway and DNS server');
      check(last(out, /ssid (\S+)/g) === 'BenchNet', 'and WiFi.SSID() names the network');
      const station = net.stations()[0];
      check(station?.mac.toUpperCase() === last(out, /mac ([0-9A-F:]+)/gi)?.toUpperCase() && station?.hostname === 'PicoW', `the network sees the board under its MAC and hostname (${station?.mac}, ${station?.hostname})`);
      check((s.r.wifi.gpio & 1) === 1, 'LED_BUILTIN, the CYW43\'s GPIO0, is lit through the chip');
    }
  }

  section('Pico W: a wrong password, and an SSID nobody broadcasts');
  {
    const net = new WifiNetwork();
    net.setAccessPoints([{ id: 'ap', ssid: 'BenchNet', password: 'correct-horse', channel: 6 }]);
    const s = await boot(PICOW.id, PICOW.fqbn, `#include <WiFi.h>
void setup() {
  Serial1.begin(115200);
  WiFi.setTimeout(1500);
  WiFi.begin("BenchNet", "wrong-password");
  Serial1.printf("wrong %d %d\\n", WiFi.status(), cyw43_wifi_link_status(&cyw43_state, CYW43_ITF_STA));
  WiFi.disconnect(); delay(200);
  WiFi.begin("NoSuchNet", "whatever123");
  Serial1.printf("missing %d %d\\n", WiFi.status(), cyw43_wifi_link_status(&cyw43_state, CYW43_ITF_STA));
}
void loop() { delay(100); }`, net);
    if (s) {
      // Arduino-Pico's begin() waits up to twice its timeout.
      run(s.r, 9000);
      const out = s.out();
      const wrong = /wrong (\d+) (-?\d+)/.exec(out);
      const missing = /missing (\d+) (-?\d+)/.exec(out);
      check(wrong !== null && wrong[1] === '4' && wrong[2] === '-3', `a wrong password is WL_CONNECT_FAILED, the driver's CYW43_LINK_BADAUTH (${wrong?.slice(1).join(' ')})`);
      check(missing !== null && missing[1] === '4' && missing[2] === '-2', `an unknown SSID is CYW43_LINK_NONET (${missing?.slice(1).join(' ')})`);
      check(net.stations().length === 0, 'and neither joined the network');
    }
  }

  section('a Pico W web server and an ESP32 client on a canvas access point');
  {
    const p = emptyProject('wifi pico w pair');
    const server = inst(PICOW.id, 0, 0);
    const client = inst('board.esp32-devkit', 300, 0);
    const ap = inst('comp.wifi-ap', 150, 300);
    ap.properties = { ssid: 'Workshop', password: 'solder-fumes', channel: 3 };
    server.label = 'Greenhouse';
    client.label = 'Client';
    const serverCode = code('greenhouse.ino', `#include <WiFi.h>
#include <WebServer.h>
WebServer web(80);
void setup() {
  Serial1.begin(115200);
  WiFi.setHostname("greenhouse");
  WiFi.begin("Workshop", "solder-fumes");
  while (WiFi.status() != WL_CONNECTED) delay(20);
  web.on("/", []() { web.send(200, "text/plain", "humidity=64"); });
  web.begin();
  Serial1.print("serving on "); Serial1.println(WiFi.localIP());
}
void loop() { web.handleClient(); }`);
    const clientCode = code('client.ino', `#include <WiFi.h>
#include <HTTPClient.h>
void setup() {
  Serial.begin(115200);
  WiFi.begin("Workshop", "solder-fumes");
  while (WiFi.status() != WL_CONNECTED) delay(20);
  delay(800);
  HTTPClient http;
  http.begin("http://greenhouse/");
  int code = http.GET();
  Serial.print("code "); Serial.println(code);
  if (code == 200) { Serial.print("body "); Serial.println(http.getString()); }
  http.end();
}
void loop() { delay(100); }`);
    server.sketchId = serverCode.id;
    client.sketchId = clientCode.id;
    p.boardInstances = [server, client];
    p.componentInstances = [ap];
    p.codeFiles = [serverCode, clientCode];
    simulationController.stop();
    const report = await simulationController.build(p);
    if (!report.anyRunnable || !(await simulationController.start())) {
      console.log('SKIP: the Pico W pair did not build or start here');
      skipped++;
    } else {
      simulationController.pause();
      for (let t = 0; t < 4000 && simulationController.advance(50); t += 50);
      simulationController.publishNow();
      const state = useSimulationStore.getState();
      const text = state.serialText ?? '';
      const stations = simulationController.wifiNetwork.stations();
      check(state.status !== 'error', `both boards run (${state.error ?? 'no error'})`);
      check(stations.some((s) => s.label === 'Greenhouse' && s.hostname === 'greenhouse' && s.ip), `the Pico W joined "Workshop" as "greenhouse" (${stations.map((s) => `${s.label}=${s.hostname}@${s.ip}`).join(', ')})`);
      check(/code 200/.test(text) && /body humidity=64/.test(text), `the ESP32's GET reaches the Pico W's server (${text.match(/code -?\d+|body [^\r\n]*/g)?.join(' ') ?? 'nothing'})`);
      const page = await fetchFromBoard(simulationController.wifiNetwork, 'http://greenhouse/', (ms) => {
        simulationController.advance(ms);
      }).catch((e: Error) => e);
      check(
        !(page instanceof Error) && page.status === 200 && new TextDecoder().decode(page.body) === 'humidity=64',
        `the workbench fetches http://greenhouse/ itself (${page instanceof Error ? page.message : `${page.status} ${new TextDecoder().decode(page.body)}`})`,
      );
      simulationController.stop();
    }
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
