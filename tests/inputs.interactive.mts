// Every part that senses something can be told what to sense.
//
// A temperature sensor you cannot set to 20 °C is a picture of a temperature
// sensor. Before the input-control registry, five parts had a slider and the
// rest read a control key nothing ever wrote — the LM35, the thermistor, the
// soil probe, the PIR, the Hall switch, the BME280 and SHT31 all sat at their
// defaults for ever, and the BMP280 and MPU6050 were not connected to any
// control at all.
//
// This holds three things:
//
//   1. coverage — every simulated sensor or input part either has declared
//      controls or is one of the contact parts clicked on the canvas;
//   2. sanity — every declared range is a range, every default is inside it,
//      and a typed value outside it is clamped rather than passed through;
//   3. effect — a value set through the same store call the inspector makes
//      reaches compiled firmware, read the way a real sketch reads it: through
//      the ADC, a digital pin, or raw I2C registers and the datasheet's own
//      conversion. "Set it to 20 °C and the sketch prints 20" is the claim, so
//      that is what is checked.
//
// The firmware sections skip cleanly when the AVR toolchain is unavailable.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, PROJECT_TEMPLATES } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { ANALOG_SENSORS } from '../src/simulation/devices/analogSensors';
import {
  CANVAS_CONTACT_ADAPTERS,
  clampQuantity,
  controlKey,
  gravityFor,
  inputControlsFor,
  quantityOf,
} from '../src/simulation/inputControls';
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
const near = (a: number | undefined, b: number, tol: number) => a !== undefined && Math.abs(a - b) <= tol;

function part(p: CircuitProject, definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance {
  const inst: ComponentInstance = {
    id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
  };
  p.componentInstances.push(inst);
  return inst;
}
function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#e8590c', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}
function unoProject(name: string, source: string): { p: CircuitProject; board: ComponentInstance } {
  const p = emptyProject(name);
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances = [board];
  p.componentInstances = [];
  p.connections = [];
  p.codeFiles = [{ id: 'f', name: 'sketch.ino', content: source, language: 'cpp' }];
  return { p, board };
}

/** Builds and starts a project, paused. False if the toolchain is not here. */
async function boot(p: CircuitProject, what: string): Promise<boolean> {
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable) {
    skip(`the toolchain is unavailable — ${what} cannot run`);
    return false;
  }
  const build = report.builds[0];
  check(build?.status === 'built', `${what} compiles (${build?.status}${build?.status !== 'built' ? `: ${build?.detail}` : ''})`);
  if (build?.status !== 'built') return false;
  const started = await simulationController.start();
  check(started, `${what} starts`);
  if (started) simulationController.pause();
  return started;
}

/** Runs until a fresh serial line matching `re` arrives, and returns its groups. */
function nextReading(re: RegExp, ms = 400): RegExpExecArray | null {
  simulationController.publishNow();
  const before = useSimulationStore.getState().serialText.length;
  for (let t = 0; t < ms; t += 20) {
    simulationController.advance(20);
    simulationController.publishNow();
    const text = useSimulationStore.getState().serialText;
    const fresh = text.slice(Math.max(0, before - 1));
    const lines = fresh.split('\n').filter((l) => l.endsWith('\r') || l.length > 0);
    // Only complete lines: the one after the last newline may be half-written.
    const complete = fresh.includes('\n') ? lines.slice(0, -1) : [];
    for (let i = complete.length - 1; i >= 0; i--) {
      const m = re.exec(complete[i]);
      if (m) return m;
    }
  }
  return null;
}

const setSensor = (key: string, v: number) => useSimulationStore.getState().setSensor(key, v);

// ===================================================== 1. coverage ===========
section('1. every simulated sensor and input can be set');
{
  const inputs = COMPONENT_DEFINITIONS.filter(
    (d) => d.supportLevel === 'simulated' && /^(Sensors|Input|Inputs)$/.test(d.category),
  );
  check(inputs.length >= 25, `the catalogue has its sensors and inputs (${inputs.length})`);
  for (const d of inputs) {
    const spec = inputControlsFor(d.id);
    const contact = CANVAS_CONTACT_ADAPTERS.has(d.simulationAdapterId ?? '');
    check(
      spec !== undefined || contact,
      `${d.name} — ${spec ? `${spec.kind === 'quantities' ? spec.quantities.map((q) => q.label).join(', ') : `trigger "${spec.label}"`}` : 'clicked on the canvas'}`,
    );
  }
  // And the two modules that sense something without being in those
  // categories.
  check(inputControlsFor('comp.ds3231') !== undefined, 'the DS3231\'s die temperature can be set');
  check(inputControlsFor('comp.mpu6050') !== undefined, 'the MPU6050 can be tilted and turned');
}

// ======================================================= 2. sanity ============
section('2. every range is a range, and typing outside it is clamped');
{
  const all = COMPONENT_DEFINITIONS.map((d) => [d, inputControlsFor(d.id)] as const).filter(([, s]) => s);
  let bad = 0;
  for (const [d, spec] of all) {
    if (spec!.kind !== 'quantities') continue;
    for (const q of spec!.quantities) {
      const ok = q.min < q.max && q.step > 0 && q.default >= q.min && q.default <= q.max && q.unit.length > 0;
      if (!ok) {
        bad++;
        console.log(`   ${d.id} ${q.label}: min ${q.min} max ${q.max} step ${q.step} default ${q.default}`);
      }
    }
  }
  check(bad === 0, `all ${all.length} declared controls have a sane range, step, default and unit`);

  const lm35 = quantityOf('comp.lm35');
  check(clampQuantity(lm35, 500) === 110, 'typing 500 °C into an LM35 clamps to its 110 °C limit');
  check(clampQuantity(lm35, -80) === -10, 'and -80 °C clamps to -10 °C');
  check(clampQuantity(lm35, Number.NaN) === lm35.default, 'and nonsense falls back to the default');
  check(clampQuantity(lm35, 20) === 20, 'while 20 °C is taken as typed');

  // The analog sensors' controls are derived from the transfer-function table,
  // so the two cannot drift apart.
  for (const [id, spec] of Object.entries(ANALOG_SENSORS)) {
    const q = quantityOf(id);
    check(
      q.min === spec.quantity.min && q.max === spec.quantity.max && q.default === spec.quantity.default,
      `${id}: the control's range is the model's range`,
    );
  }

  const flat = gravityFor(0, 0);
  check(flat.x === 0 && flat.y === 0 && flat.z === 1, 'level, gravity is straight down the Z axis');
  const tilted = gravityFor(30, -20);
  const pitch = (Math.atan2(-tilted.x, Math.hypot(tilted.y, tilted.z)) * 180) / Math.PI;
  const roll = (Math.atan2(tilted.y, tilted.z) * 180) / Math.PI;
  check(near(pitch, 30, 1e-9) && near(roll, -20, 1e-9), 'and the standard atan2 arithmetic recovers a dialled pitch and roll');
}

// ======================= 3. analog and digital sensors, through firmware =====
section('3. analog and digital sensors reach the ADC and the pins');
{
  const SKETCH = [
    'void setup() { Serial.begin(115200); pinMode(2, INPUT); pinMode(3, INPUT); }',
    'void loop() {',
    '  int lm = analogRead(A0), ntc = analogRead(A1), tmp = analogRead(A2), soil = analogRead(A3);',
    '  Serial.print("LM="); Serial.print(lm);',
    '  Serial.print(" LMC="); Serial.print(lm * 500.0 / 1023.0, 1);',
    '  Serial.print(" NTC="); Serial.print(ntc);',
    '  Serial.print(" TMP="); Serial.print(tmp);',
    '  Serial.print(" SOIL="); Serial.print(soil);',
    '  Serial.print(" PIR="); Serial.print(digitalRead(2));',
    '  Serial.print(" HALL="); Serial.println(digitalRead(3));',
    '  delay(15);',
    '}',
  ].join('\n');
  const { p, board } = unoProject('analog inputs', SKETCH);
  const lm35 = part(p, 'comp.lm35');
  const ntc = part(p, 'comp.ntc-thermistor');
  const tmp36 = part(p, 'comp.tmp36');
  const soil = part(p, 'comp.soil-moisture');
  const pir = part(p, 'comp.pir');
  const hall = part(p, 'comp.hall-sensor');
  for (const s of [lm35, ntc, tmp36, soil, pir, hall]) {
    wire(p, board.id, '5V', s.id, 'vcc');
    wire(p, board.id, 'GND_PWR1', s.id, 'gnd');
  }
  wire(p, board.id, 'A0', lm35.id, 'vout');
  wire(p, board.id, 'A1', ntc.id, 'vout');
  wire(p, board.id, 'A2', tmp36.id, 'vout');
  wire(p, board.id, 'A3', soil.id, 'vout');
  wire(p, board.id, 'D2', pir.id, 'out');
  wire(p, board.id, 'D3', hall.id, 'out');

  const RE = /LM=(\d+) LMC=([\d.]+) NTC=(\d+) TMP=(\d+) SOIL=(\d+) PIR=(\d) HALL=(\d)/;
  const counts = (volts: number) => (volts / 5) * 1023;

  if (await boot(p, 'the analog/digital sketch')) {
    // The values a user types into the inspector, written the way it writes them.
    setSensor(controlKey(lm35.id, quantityOf('comp.lm35')), 20);
    setSensor(controlKey(ntc.id, quantityOf('comp.ntc-thermistor')), 40);
    setSensor(controlKey(tmp36.id, quantityOf('comp.tmp36')), 20);
    setSensor(controlKey(soil.id, quantityOf('comp.soil-moisture')), 75);
    let m = nextReading(RE, 600);
    check(m !== null, `the sketch is reporting (${m?.[0]})`);
    if (m) {
      const lmC = Number(m[2]);
      check(near(lmC, 20, 0.5), `LM35 set to 20 °C: the sketch's own conversion prints ${lmC} °C`);
      check(near(Number(m[1]), counts(ANALOG_SENSORS['comp.lm35'].volts(20, 5)), 2), `  (raw ${m[1]} counts)`);
      check(
        near(Number(m[3]), counts(ANALOG_SENSORS['comp.ntc-thermistor'].volts(40, 5)), 2),
        `NTC set to 40 °C reads ${m[3]} counts, as the beta-model divider gives`,
      );
      check(near(Number(m[4]), counts(0.5 + 20 * 0.01), 2), `TMP36 set to 20 °C reads ${m[4]} counts (0.70 V)`);
      check(near(Number(m[5]), counts(5 * 0.25), 2), `soil set to 75 % wet reads ${m[5]} counts — low, as these modules read when wet`);
      check(m[6] === '0', 'the PIR is idle until something moves');
      check(m[7] === '1', 'the Hall switch is high with no magnet (active low)');
    }

    // Change them while it runs: the very next readings follow.
    setSensor(controlKey(lm35.id, quantityOf('comp.lm35')), 37.5);
    setSensor(pir.id, 1);
    setSensor(hall.id, 1);
    m = nextReading(RE, 400);
    if (m) {
      check(near(Number(m[2]), 37.5, 0.5), `turning the LM35 up to 37.5 °C mid-run is read as ${m[2]} °C`);
      check(m[6] === '1', 'motion in front of the PIR drives its output high');
      check(m[7] === '0', 'a magnet at the Hall switch pulls its output low');
    } else {
      check(false, 'the sketch kept reporting after the values changed');
    }
  }
  simulationController.stop();
}

// ======================== 4. the BMP280 showcase prints what was dialled =====
section('4. "make it read 20 degrees": the BMP280 showcase');
{
  const template = PROJECT_TEMPLATES.find((t) => t.id === 'show.i2c-sensor-bus');
  check(template !== undefined, 'the I2C sensor-bus showcase exists');
  if (template) {
    const p = template.build();
    const bmp = p.componentInstances.find((c) => c.definitionId === 'comp.bmp280');
    check(bmp !== undefined, 'with a BMP280 in it');
    if (bmp && (await boot(p, 'the BMP280 showcase'))) {
      const RE = /temperature (-?\d+)\.(\d) C/;
      const key = controlKey(bmp.id, quantityOf('comp.bmp280', 'temperature'));
      setSensor(key, 20);
      // The sketch reads every 400 ms; give it two rounds.
      let m = nextReading(RE, 1000);
      check(m !== null && `${m[1]}.${m[2]}` === '20.0', `set to 20 °C, the firmware prints "${m?.[0]}"`);
      setSensor(key, 31.5);
      m = nextReading(RE, 1000);
      check(m !== null && `${m[1]}.${m[2]}` === '31.5', `set to 31.5 °C, it prints "${m?.[0]}"`);
    }
    simulationController.stop();
  }
}

// ================== 5. I2C environment sensors, read register by register ===
section('5. SHT31, DS3231 and BME280 serve what was set');
{
  const SKETCH = [
    '#include <Wire.h>',
    'void setup() {',
    '  Serial.begin(115200); Wire.begin();',
    '  // BME280 into normal mode, so it is measuring.',
    '  Wire.beginTransmission(0x76); Wire.write(0xF2); Wire.write(0x01); Wire.endTransmission();',
    '  Wire.beginTransmission(0x76); Wire.write(0xF4); Wire.write(0x27); Wire.endTransmission();',
    '}',
    'void loop() {',
    '  Wire.beginTransmission(0x44); Wire.write(0x24); Wire.write(0x00); Wire.endTransmission();',
    '  delay(20);',
    '  Wire.requestFrom(0x44, 6);',
    '  uint16_t rt = (Wire.read() << 8) | Wire.read(); Wire.read();',
    '  uint16_t rh = (Wire.read() << 8) | Wire.read(); Wire.read();',
    '  float t = -45.0 + 175.0 * rt / 65535.0, h = 100.0 * rh / 65535.0;',
    '  Wire.beginTransmission(0x68); Wire.write(0x11); Wire.endTransmission();',
    '  Wire.requestFrom(0x68, 2);',
    '  int8_t whole = (int8_t)Wire.read(); uint8_t frac = Wire.read() >> 6;',
    '  Serial.print("SHT_T="); Serial.print(t, 1);',
    '  Serial.print(" SHT_H="); Serial.print(h, 1);',
    '  Serial.print(" RTC_T="); Serial.println(whole + frac * 0.25, 2);',
    '  delay(20);',
    '}',
  ].join('\n');
  const { p, board } = unoProject('i2c environment', SKETCH);
  const sht = part(p, 'comp.sht31');
  const rtc = part(p, 'comp.ds3231');
  const bme = part(p, 'comp.bme280');
  for (const s of [sht, rtc, bme]) {
    wire(p, board.id, '5V', s.id, 'vcc');
    wire(p, board.id, 'GND_PWR1', s.id, 'gnd');
    wire(p, board.id, 'A4', s.id, 'sda');
    wire(p, board.id, 'A5', s.id, 'scl');
  }
  const RE = /SHT_T=(-?[\d.]+) SHT_H=([\d.]+) RTC_T=(-?[\d.]+)/;
  if (await boot(p, 'the I2C environment sketch')) {
    setSensor(controlKey(sht.id, quantityOf('comp.sht31', 'temperature')), 20);
    setSensor(controlKey(sht.id, quantityOf('comp.sht31', 'humidity')), 62);
    setSensor(controlKey(rtc.id, quantityOf('comp.ds3231', 'temperature')), 18.25);
    setSensor(controlKey(bme.id, quantityOf('comp.bme280', 'temperature')), 27);
    setSensor(controlKey(bme.id, quantityOf('comp.bme280', 'humidity')), 33);
    setSensor(controlKey(bme.id, quantityOf('comp.bme280', 'pressure')), 990);
    const m = nextReading(RE, 600);
    check(m !== null, `the sketch is reporting (${m?.[0]})`);
    if (m) {
      check(near(Number(m[1]), 20, 0.1), `SHT31 set to 20 °C: the datasheet formula gives ${m[1]} °C`);
      check(near(Number(m[2]), 62, 0.1), `and 62 %RH gives ${m[2]} %RH`);
      check(near(Number(m[3]), 18.25, 0.001), `DS3231 die set to 18.25 °C reads ${m[3]} °C in quarter degrees`);
    }
    simulationController.publishNow();
    const readout = useSimulationStore.getState().visuals[bme.id]?.readout?.join(' ') ?? '';
    check(/27\.0 C/.test(readout) && /33%/.test(readout) && /990 hPa/.test(readout), `the BME280 is serving 27 °C, 33 %, 990 hPa (${readout})`);
  }
  simulationController.stop();
}

// ======================================== 6. the MPU6050 can be tilted =====
section('6. tilting the MPU6050 is what a pitch/roll sketch measures');
{
  const SKETCH = [
    '#include <Wire.h>',
    'int16_t rd() { return (Wire.read() << 8) | Wire.read(); }',
    'void setup() {',
    '  Serial.begin(115200); Wire.begin();',
    '  Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0); Wire.endTransmission();',
    '}',
    'void loop() {',
    '  Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission();',
    '  Wire.requestFrom(0x68, 14);',
    '  float ax = rd(), ay = rd(), az = rd(), tc = rd(), gx = rd(), gy = rd(), gz = rd();',
    '  float roll = atan2(ay, az) * 57.29578, pitch = atan2(-ax, sqrt(ay * ay + az * az)) * 57.29578;',
    '  Serial.print("P="); Serial.print(pitch, 1);',
    '  Serial.print(" R="); Serial.print(roll, 1);',
    '  Serial.print(" GZ="); Serial.print(gz / 131.0, 1);',
    '  Serial.print(" T="); Serial.println(tc / 340.0 + 36.53, 1);',
    '  delay(15);',
    '}',
  ].join('\n');
  const { p, board } = unoProject('mpu tilt', SKETCH);
  const mpu = part(p, 'comp.mpu6050');
  wire(p, board.id, '3V3', mpu.id, 'vcc');
  wire(p, board.id, 'GND_PWR1', mpu.id, 'gnd');
  wire(p, board.id, 'A4', mpu.id, 'sda');
  wire(p, board.id, 'A5', mpu.id, 'scl');
  const RE = /P=(-?[\d.]+) R=(-?[\d.]+) GZ=(-?[\d.]+) T=(-?[\d.]+)/;
  if (await boot(p, 'the MPU6050 sketch')) {
    let m = nextReading(RE, 400);
    check(m !== null && near(Number(m[1]), 0, 0.2) && near(Number(m[2]), 0, 0.2), `untouched, it lies flat (${m?.[0]})`);
    setSensor(controlKey(mpu.id, quantityOf('comp.mpu6050', 'pitch')), 30);
    setSensor(controlKey(mpu.id, quantityOf('comp.mpu6050', 'roll')), -20);
    setSensor(controlKey(mpu.id, quantityOf('comp.mpu6050', 'gz')), 45);
    setSensor(controlKey(mpu.id, quantityOf('comp.mpu6050', 'temperature')), 22);
    m = nextReading(RE, 400);
    check(m !== null, `the sketch is reporting (${m?.[0]})`);
    if (m) {
      check(near(Number(m[1]), 30, 0.3), `tilted 30° forward, the sketch computes pitch ${m[1]}°`);
      check(near(Number(m[2]), -20, 0.3), `rolled -20°, it computes roll ${m[2]}°`);
      check(near(Number(m[3]), 45, 0.2), `turning at 45 °/s reads ${m[3]} °/s on the gyro`);
      check(near(Number(m[4]), 22, 0.2), `and the die temperature set to 22 °C reads ${m[4]} °C`);
    }
  }
  simulationController.stop();
}

section(`${failures} failing, ${skipped} skipped`);
process.exit(failures > 0 ? 1 : 0);
