// Bluetooth Low Energy on the ESP32 family, through the firmware's own host.
//
// The ESP32 builds with Bluedroid and the S3 and C3 with NimBLE; both run as
// compiled, on top of the simulator's controller (src/simulation/bluetooth),
// which they reach through ESP-IDF's VHCI. Checked here:
//   * a GATT server sketch advertises its name and service, and the
//     workbench's central (as a phone would be) connects, discovers the
//     services, reads a value, gets notifications, and writes one the sketch's
//     callback sees; when it leaves, the sketch advertises again;
//   * two boards on one canvas: an ESP32 server and a C3 client that scans
//     for it by service, connects, reads and subscribes;
//   * the Pico W, whose BTstack reaches the same controller over the CYW43;
//   * the ESP32-C6, whose controller is not modelled, refuses Bluetooth's
//     start plainly and keeps running.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, code } from '../src/project/templates';
import { BleAir } from '../src/simulation/bluetooth/air';
import { BleCentral, settle } from '../src/simulation/bluetooth/central';

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

async function boot(boardId: string, fqbn: string, sketch: string, air: BleAir, id: string): Promise<{ r: Runner; out: () => string } | null> {
  const def = getBoardDefinition(boardId)!;
  const built = await compileProject({ fqbn, boardId: def.serverTargetId ?? def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: ${boardId} did not build here (${built.errors?.[0]?.message ?? built.error ?? ''})`);
    skipped++;
    return null;
  }
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  r.attachBluetooth?.(air, { id, label: id });
  let text = '';
  r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
  return { r, out: () => text };
}

const SERVER = `#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
BLECharacteristic *temp;
BLECharacteristic *setp;
bool connected = false;
class Conn : public BLEServerCallbacks {
  void onConnect(BLEServer *s) { connected = true; Serial.println("central connected"); }
  void onDisconnect(BLEServer *s) { connected = false; Serial.println("central left"); BLEDevice::startAdvertising(); }
};
class Set : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) { Serial.print("setpoint "); Serial.println(c->getValue().c_str()); }
};
void setup() {
  Serial.begin(115200);
  BLEDevice::init("Thermo");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new Conn());
  BLEService *svc = server->createService("181A");
  temp = svc->createCharacteristic("2A6E", BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  temp->addDescriptor(new BLE2902());
  temp->setValue("21.5");
  setp = svc->createCharacteristic("2A6F", BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE);
  setp->setCallbacks(new Set());
  setp->setValue("20");
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID("181A");
  adv->start();
  Serial.println("advertising");
}
int n = 0;
void loop() { delay(500); if (connected) { char b[16]; snprintf(b, sizeof b, "t%d", ++n); temp->setValue(b); temp->notify(); } }`;

const BOARDS = [
  { id: 'board.esp32-devkit', fqbn: 'esp32:esp32:esp32', host: 'Bluedroid' },
  { id: 'board.esp32-s3', fqbn: 'esp32:esp32:esp32s3', host: 'NimBLE' },
  { id: 'board.esp32-c3', fqbn: 'esp32:esp32:esp32c3', host: 'NimBLE' },
] as const;

for (const B of BOARDS.filter((x) => !process.env.ONLY || x.id === process.env.ONLY)) {
  const name = getBoardDefinition(B.id)!.name;
  section(`${name} (${B.host}): a GATT server, and the workbench as its central`);
  const air = new BleAir();
  const s = await boot(B.id, B.fqbn, SERVER, air, 'thermo');
  if (!s) continue;
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 10) s.r.runFor(10);
    if (s.r.fault) throw new Error(s.r.fault);
  };
  try {
    advance(1500);
    check(s.r.bluetooth != null && s.r.fault == null, `the build links Bluetooth and the runner provides the controller (${s.r.fault ?? 'no fault'})`);
    const central = new BleCentral(air);
    const entry = central.scan().find((e) => e.name === 'Thermo');
    check(entry !== undefined && entry.connectable && entry.services.includes('181A'), `it advertises its name and service, connectable (${JSON.stringify(central.scan())})`);
    if (entry) {
      await settle(central.connect(entry.address), advance);
      // The host hears LE Connection Complete when its own task next runs.
      advance(100);
      check(central.connected && /central connected/.test(s.out()), 'the workbench connects, and the sketch\'s onConnect runs');
      check((await settle(central.exchangeMtu(), advance)) > 23, 'the MTU exchange is answered');
      const services = await settle(central.discover(), advance);
      const env = services.find((v) => v.uuid === '181A');
      const t = env?.characteristics.find((c) => c.uuid === '2A6E');
      const sp = env?.characteristics.find((c) => c.uuid === '2A6F');
      check(!!t && !!sp && t.properties.notify && t.cccdHandle !== undefined && sp.properties.write, `discovery finds the service, both characteristics and the CCCD (${services.map((v) => v.uuid).join(', ')})`);
      if (t && sp) {
        check(new TextDecoder().decode(await settle(central.read(t.valueHandle), advance)) === '21.5', 'a read returns the value the sketch set');
        const notes: string[] = [];
        central.onNotify = (h, v) => h === t.valueHandle && notes.push(new TextDecoder().decode(v));
        await settle(central.subscribe(t), advance);
        advance(1600);
        check(notes.length >= 2 && /^t\d+$/.test(notes[0]), `notifications arrive once subscribed (${notes.join(',')})`);
        await settle(central.write(sp.valueHandle, new TextEncoder().encode('23')), advance);
        advance(100);
        check(/setpoint 23/.test(s.out()), "a write reaches the sketch's onWrite");
      }
      central.disconnect();
      advance(800);
      check(/central left/.test(s.out()) && air.devices().some((d) => d.advertising), 'on disconnect the sketch hears it and advertises again');
      // Reset: the controller goes down with the chip, and the rebooted
      // sketch brings it up again from the start.
      await settle(central.connect(entry.address), advance);
      s.r.reset();
      const before = (s.out().match(/advertising/g) ?? []).length;
      advance(1500);
      check(!central.connected, 'a board reset drops the link');
      check(
        (s.out().match(/advertising/g) ?? []).length > before && new BleCentral(air).scan().some((e) => e.name === 'Thermo'),
        `after the reset the sketch starts Bluetooth again and advertises (${s.r.fault ?? 'no fault'})`,
      );
    }
  } catch (e) {
    check(false, `the exchange completed (${(e as Error).message})`);
  }
}

if (!process.env.ONLY || process.env.ONLY === 'pair') {
  section('two boards: an ESP32 GATT server and a C3 client on one canvas');
  const p = emptyProject('ble pair');
  const server = inst('board.esp32-devkit', 0, 0);
  const client = inst('board.esp32-c3', 300, 0);
  server.label = 'Thermo';
  client.label = 'Display';
  const serverCode = code('thermo.ino', SERVER);
  const clientCode = code('display.ino', `#include <BLEDevice.h>
BLEAdvertisedDevice *found = nullptr;
class Found : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice d) {
    if (d.haveServiceUUID() && d.isAdvertisingService(BLEUUID("181A"))) { BLEDevice::getScan()->stop(); found = new BLEAdvertisedDevice(d); }
  }
};
void notified(BLERemoteCharacteristic *c, uint8_t *data, size_t len, bool isNotify) { Serial.print("note "); Serial.write(data, len); Serial.println(); }
void setup() {
  Serial.begin(115200);
  BLEDevice::init("");
  BLEScan *scan = BLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(new Found());
  scan->setActiveScan(true);
  scan->start(5, false);
  if (!found) { Serial.println("not found"); return; }
  Serial.print("found "); Serial.println(found->getName().c_str());
  BLEClient *c = BLEDevice::createClient();
  if (!c->connect(found)) { Serial.println("connect failed"); return; }
  BLERemoteService *svc = c->getService(BLEUUID("181A"));
  BLERemoteCharacteristic *t = svc ? svc->getCharacteristic(BLEUUID("2A6E")) : nullptr;
  if (!t) { Serial.println("no characteristic"); return; }
  Serial.print("temp "); Serial.println(t->readValue().c_str());
  t->registerForNotify(notified);
}
void loop() { delay(100); }`);
  server.sketchId = serverCode.id;
  client.sketchId = clientCode.id;
  p.boardInstances = [server, client];
  p.codeFiles = [serverCode, clientCode];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log('SKIP: the pair did not build or start here');
    skipped++;
  } else {
    simulationController.pause();
    for (let t = 0; t < 5000 && simulationController.advance(50); t += 50);
    simulationController.publishNow();
    const state = useSimulationStore.getState();
    const text = state.serialText ?? '';
    check(state.status !== 'error', `both boards run (${state.error ?? 'no error'})`);
    check(/found Thermo/.test(text), `the C3's scan finds the ESP32 by its service (${text.match(/found [^\r\n]*|not found/)?.[0] ?? 'nothing'})`);
    check(/temp 21\.5/.test(text), `it connects and reads the temperature (${text.match(/temp [^\r\n]*|connect failed|no characteristic/)?.[0] ?? 'nothing'})`);
    check((text.match(/note t\d+/g) ?? []).length >= 2, `and receives the ESP32's notifications (${(text.match(/note t\d+/g) ?? []).join(' ')})`);
    const devices = simulationController.bluetoothAir.devices();
    check(devices.some((d) => d.label === 'Thermo' && d.connections === 1), `the air shows the link, under the boards' names (${JSON.stringify(devices)})`);
    simulationController.stop();
  }
}

if (!process.env.ONLY || process.env.ONLY === 'board.raspberry-pi-pico-w') {
  // Arduino-Pico's BLE library over BTstack, which reaches the simulated
  // controller through the CYW43's Bluetooth bus. The compiler turns on the
  // core's Bluetooth stack itself when the sketch includes BLE.h.
  section('Raspberry Pi Pico W (BTstack): a GATT server, and the workbench as its central');
  const air = new BleAir();
  const s = await boot('board.raspberry-pi-pico-w', 'rp2040:rp2040:rpipicow', `#include <BLE.h>
BLECharacteristic *temp;
BLECharacteristic *setp;
class Set : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) { Serial1.print("setpoint "); Serial1.write((const uint8_t *)c->valueData(), c->valueLen()); Serial1.println(); }
};
class Conn : public BLEServerCallbacks {
  void onConnect(BLEServer *s) { Serial1.println("central connected"); }
  void onDisconnect(BLEServer *s) { Serial1.println("central left"); BLE.startAdvertising(); }
};
BLEService svc(BLEUUID((uint16_t)0x181A));
void setup() {
  Serial1.begin(115200);
  temp = new BLECharacteristic(BLEUUID((uint16_t)0x2A6E), BLERead | BLENotify, "Temperature");
  temp->setValue(String("21.5"));
  setp = new BLECharacteristic(BLEUUID((uint16_t)0x2A6F), BLERead | BLEWrite, "Setpoint");
  setp->setValue(String("20"));
  setp->setCallbacks(new Set());
  svc.addCharacteristic(temp);
  svc.addCharacteristic(setp);
  BLE.begin("PicoThermo");
  BLE.server()->setCallbacks(new Conn());
  BLE.server()->addService(&svc);
  BLE.startAdvertising();
  Serial1.println("advertising");
}
int n = 0;
void loop() { delay(500); char b[16]; snprintf(b, sizeof b, "t%d", ++n); temp->setValue(String(b)); }`, air, 'picothermo');
  if (s) {
    const advance = (ms: number) => {
      for (let t = 0; t < ms; t += 10) s.r.runFor(10);
      if (s.r.fault) throw new Error(s.r.fault);
    };
    try {
      advance(2500);
      const central = new BleCentral(air);
      const entry = central.scan().find((e) => e.name === 'PicoThermo');
      check(entry !== undefined && entry.connectable && entry.services.includes('181A'), `it advertises its name and service (${JSON.stringify(central.scan())})`);
      if (entry) {
        await settle(central.connect(entry.address), advance);
        advance(100);
        check(central.connected && /central connected/.test(s.out()), "the workbench connects, and the sketch's onConnect runs");
        check((await settle(central.exchangeMtu(), advance)) > 23, 'the MTU exchange is answered');
        const services = await settle(central.discover(), advance);
        const env = services.find((v) => v.uuid === '181A');
        const t = env?.characteristics.find((c) => c.uuid === '2A6E');
        const sp = env?.characteristics.find((c) => c.uuid === '2A6F');
        check(!!t && !!sp && t.cccdHandle !== undefined, `discovery finds the service and both characteristics (${services.map((v) => v.uuid).join(', ')})`);
        if (t && sp) {
          check(/^t\d+$|^21\.5$/.test(new TextDecoder().decode(await settle(central.read(t.valueHandle), advance))), 'a read returns the value the sketch set');
          const notes: string[] = [];
          central.onNotify = (h, v) => h === t.valueHandle && notes.push(new TextDecoder().decode(v));
          await settle(central.subscribe(t), advance);
          advance(1600);
          check(notes.length >= 2 && /^t\d+$/.test(notes[0]), `notifications arrive once subscribed (${notes.join(',')})`);
          await settle(central.write(sp.valueHandle, new TextEncoder().encode('23')), advance);
          advance(100);
          check(/setpoint 23/.test(s.out()), "a write reaches the sketch's onWrite");
        }
        central.disconnect();
        advance(800);
        check(/central left/.test(s.out()) && air.devices().some((d) => d.advertising), 'on disconnect the sketch hears it and advertises again');
      }
    } catch (e) {
      check(false, `the exchange completed (${(e as Error).message})`);
    }
  }
}

if (!process.env.ONLY || process.env.ONLY === 'board.esp32-c6-devkitc-1') {
  section('ESP32-C6: Bluetooth is refused plainly, and the sketch carries on');
  const air = new BleAir();
  const s = await boot('board.esp32-c6-devkitc-1', 'esp32:esp32:esp32c6', `#include <BLEDevice.h>
void setup() {
  Serial.begin(115200);
  BLEDevice::init("C6");
  Serial.println("after init");
}
void loop() { Serial.println("still running"); delay(300); }`, air, 'c6');
  if (s) {
    for (let t = 0; t < 1500; t += 10) s.r.runFor(10);
    check(s.r.fault == null, `nothing in the firmware stopped (${s.r.fault ?? 'no fault'})`);
    check(/after init/.test(s.out()) && /still running/.test(s.out()), 'the sketch continues past BLEDevice::init()');
    check(air.devices().length === 0, 'and nothing of it is on the air');
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
