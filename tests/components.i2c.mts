// I2C component suite — proves the SSD1306, BMP280 and MPU-6050 are driven by
// real firmware traffic.
//
// Every check below compiles a Wire sketch through the backend and runs it on
// the AVR emulator; the pixels and sensor readings asserted come from bytes the
// firmware actually moved over the emulated TWI bus. The sensor sketches run
// the manufacturers' own compensation/scaling arithmetic over calibration data
// they read off the bus, so nothing is short-circuited. Wire is part of the
// Arduino AVR core, so these sketches compile with no extra libraries.

import { AVRRunner, F_CPU } from '../src/simulation/avrRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { AVR_BOARD_PROFILES } from '../src/boards/pinMaps';
import { Ssd1306Device } from '../src/simulation/devices/ssd1306';
import { Bmp280Device } from '../src/simulation/devices/bmp280';
import { Mpu6050Device } from '../src/simulation/devices/mpu6050';
import { emptyProject } from '../src/project/templates';
import { uid, type CircuitProject } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const UNO = AVR_BOARD_PROFILES['board.arduino-uno'];

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

async function compileUno(source: string): Promise<string> {
  const res = await fetch(`${BASE}/api/compiler/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      boardId: 'board.arduino-uno',
      fqbn: 'arduino:avr:uno',
      files: [{ name: 'sketch.ino', content: source }],
    }),
  });
  const j = (await res.json()) as { success: boolean; firmware?: { data: string }; error?: string; stderr?: string };
  if (!j.success || !j.firmware) throw new Error('compile failed: ' + (j.error ?? '') + (j.stderr ?? '').slice(0, 300));
  return j.firmware.data;
}

const inst = (definitionId: string, properties: Record<string, unknown> = {}) => ({
  id: uid('i'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});
const wire = (a: { id: string }, ap: string, b: { id: string }, bp: string) => ({
  id: uid('w'), sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b.id, targetPinId: bp,
  netId: '', color: '#000', points: [], routing: 'smooth' as const,
});

/** Uno + OLED wired correctly: SDA->A4, SCL->A5, VCC->5V, GND->GND. */
function oledProject(opts: { sda?: string; scl?: string; power?: boolean; address?: number } = {}) {
  const board = inst('board.arduino-uno');
  const oled = inst('comp.oled', opts.address !== undefined ? { i2cAddress: opts.address } : {});
  const connections = [
    wire(oled, 'sda', board, opts.sda ?? 'A4'),
    wire(oled, 'scl', board, opts.scl ?? 'A5'),
    wire(oled, 'gnd', board, 'GND_PWR1'),
  ];
  if (opts.power !== false) connections.push(wire(oled, 'vcc', board, '5V'));
  const project: CircuitProject = {
    ...emptyProject('oled'),
    boardInstances: [board],
    componentInstances: [oled],
    connections,
  };
  return { project, oledId: oled.id };
}

function run(runner: AVRRunner, binding: CircuitBinding, ms: number) {
  const controls = emptyControls();
  const target = runner.cpu.cycles + (ms / 1000) * F_CPU;
  while (runner.cpu.cycles < target) {
    runner.runToCycles(Math.min(target, runner.cpu.cycles + F_CPU / 1000));
    binding.update(controls);
  }
}

// A minimal SSD1306 init + fill, written with raw Wire so it needs no library.
const INIT_AND_FILL = `#include <Wire.h>
void cmd(uint8_t c){ Wire.beginTransmission(0x3C); Wire.write(0x00); Wire.write(c); Wire.endTransmission(); }
void setup(){
  Wire.begin();
  cmd(0xAE);              // display off
  cmd(0x20); cmd(0x00);   // horizontal addressing mode
  cmd(0x21); cmd(0); cmd(127);  // column range
  cmd(0x22); cmd(0); cmd(7);    // page range
  cmd(0x8D); cmd(0x14);   // charge pump on
  cmd(0xAF);              // display on
  for (uint8_t page = 0; page < 8; page++) {
    for (uint8_t chunk = 0; chunk < 8; chunk++) {
      Wire.beginTransmission(0x3C);
      Wire.write(0x40);                       // data control byte
      for (uint8_t i = 0; i < 16; i++) Wire.write(0xFF);
      Wire.endTransmission();
    }
  }
}
void loop(){}`;

// ---------- 1. Real firmware traffic lights the panel ----------
{
  const hex = await compileUno(INIT_AND_FILL);
  const { project, oledId } = oledProject();
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.i2cBus.attachedCount === 1, `correctly wired OLED attaches to the I2C bus (${runner.i2cBus.attachedCount})`);

  run(runner, binding, 400);
  const device = runner.i2cBus.deviceFor(oledId) as Ssd1306Device;
  check(device instanceof Ssd1306Device, 'device model is an SSD1306');
  check(device.isOn, 'firmware turned the display on (0xAF decoded from real bus traffic)');
  check(device.litPixels === 128 * 64, `every pixel lit after a full 0xFF fill (${device.litPixels}/8192)`);
  check(device.unhandledCommands.length === 0, `no unhandled SSD1306 commands (${device.unhandledCommands.map((c) => '0x' + c.toString(16)).join(',') || 'none'})`);

  const visuals = binding.update(emptyControls()).visuals;
  const vis = visuals.get(oledId);
  check(vis?.display?.on === true && vis.display.pixels !== null, 'canvas visual exposes live display RAM');
  check(vis?.display?.pixels?.length === 1024, `display RAM is 1024 bytes (${vis?.display?.pixels?.length})`);
}

// ---------- 2. Pixels come from the bytes firmware wrote ----------
{
  // Writes a distinctive pattern to page 0 only: columns 0..15 = 0b00000001,
  // i.e. exactly one lit row at y=0.
  const hex = await compileUno(`#include <Wire.h>
void cmd(uint8_t c){ Wire.beginTransmission(0x3C); Wire.write(0x00); Wire.write(c); Wire.endTransmission(); }
void setup(){
  Wire.begin();
  cmd(0x20); cmd(0x00); cmd(0x21); cmd(0); cmd(127); cmd(0x22); cmd(0); cmd(7);
  cmd(0xAF);
  Wire.beginTransmission(0x3C); Wire.write(0x40);
  for (uint8_t i = 0; i < 16; i++) Wire.write(0x01);
  Wire.endTransmission();
}
void loop(){}`);
  const { project, oledId } = oledProject();
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  run(runner, binding, 300);
  const d = runner.i2cBus.deviceFor(oledId) as Ssd1306Device;
  check(d.litPixels === 16, `exactly the 16 written pixels are lit (${d.litPixels})`);
  check(d.pixel(0, 0) && d.pixel(15, 0), 'pixels (0,0) and (15,0) are lit');
  check(!d.pixel(16, 0) && !d.pixel(0, 1), 'neighbouring pixels stay dark — no invented content');
}

// ---------- 3. Wrong address is NACKed, display stays dark ----------
{
  const hex = await compileUno(INIT_AND_FILL.replace(/0x3C/g, '0x3D'));
  const { project, oledId } = oledProject(); // device still at 0x3C
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  run(runner, binding, 400);
  const d = runner.i2cBus.deviceFor(oledId) as Ssd1306Device;
  check(!d.isOn && d.litPixels === 0, 'display addressed at 0x3D stays dark when strapped to 0x3C');
  check(runner.i2cBus.unclaimedAddressCount > 0, `unclaimed addresses are counted, not hidden (${runner.i2cBus.unclaimedAddressCount})`);
}

// ---------- 4. The same firmware works when the device is strapped to 0x3D ----------
{
  const hex = await compileUno(INIT_AND_FILL.replace(/0x3C/g, '0x3D'));
  const { project, oledId } = oledProject({ address: 0x3d });
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  run(runner, binding, 400);
  const d = runner.i2cBus.deviceFor(oledId) as Ssd1306Device;
  check(d.isOn && d.litPixels === 128 * 64, 'a 0x3D-strapped display responds to 0x3D traffic');
}

// ---------- 5. Invalid wiring does not work ----------
{
  const hex = await compileUno(INIT_AND_FILL);
  for (const [label, opts] of [
    ['SDA on the wrong pin (D7)', { sda: 'D7' }],
    ['SCL on the wrong pin (D8)', { scl: 'D8' }],
    ['no power to VCC', { power: false }],
  ] as const) {
    const { project, oledId } = oledProject(opts);
    const runner = new AVRRunner(hex, UNO);
    const binding = new CircuitBinding(project, runner);
    run(runner, binding, 300);
    check(runner.i2cBus.attachedCount === 0, `${label}: device is not attached to the bus`);
    const vis = binding.update(emptyControls()).visuals.get(oledId);
    check(vis?.display?.on !== true, `${label}: panel stays dark`);
  }
}

// ---------- 6. Reset clears the display ----------
{
  const hex = await compileUno(INIT_AND_FILL);
  const { project, oledId } = oledProject();
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  run(runner, binding, 400);
  const d = runner.i2cBus.deviceFor(oledId) as Ssd1306Device;
  check(d.litPixels > 0, 'display has content before reset');
  d.reset();
  check(!d.isOn && d.litPixels === 0, 'reset() returns the panel to the datasheet power-on state (off, RAM cleared)');
  check(d.snapshot().status.includes('off'), `snapshot reports the reset state (${d.snapshot().status.slice(0, 48)})`);
}

// ---------- 7. Device state survives a circuit re-bind (wiring edit) ----------
{
  const hex = await compileUno(INIT_AND_FILL);
  const { project, oledId } = oledProject();
  const runner = new AVRRunner(hex, UNO);
  let binding = new CircuitBinding(project, runner);
  run(runner, binding, 400);
  const before = (runner.i2cBus.deviceFor(oledId) as Ssd1306Device).litPixels;
  binding = new CircuitBinding(project, runner); // e.g. a wire was moved
  const after = (runner.i2cBus.deviceFor(oledId) as Ssd1306Device).litPixels;
  check(before > 0 && before === after, `re-binding the circuit does not wipe display RAM (${before} -> ${after})`);
}

// ---------- 8. Unit-level protocol checks ----------
{
  const d = new Ssd1306Device('unit', 0x3c);
  check(d.matchesAddress(0x3c) && !d.matchesAddress(0x3d), 'address matching is exact');

  // Command/data distinction: 0x00 control byte marks commands.
  d.start(0x3c, true);
  d.writeByte(0x00);
  d.writeByte(0xaf);
  check(d.isOn, 'control byte 0x00 routes the following byte to the command decoder');

  d.start(0x3c, true);
  d.writeByte(0x40);
  d.writeByte(0xff);
  check(d.litPixels === 8, 'control byte 0x40 routes the following bytes into display RAM');

  // Page addressing wraps within the column window rather than spilling.
  d.reset();
  d.start(0x3c, true);
  d.writeByte(0x00);
  d.writeByte(0xaf);
  d.start(0x3c, true);
  d.writeByte(0x40);
  for (let i = 0; i < 200; i++) d.writeByte(0xff);
  check(d.litPixels === 128 * 8, `page mode fills one page and wraps, not past it (${d.litPixels})`);

  // An unknown command is recorded, never silently swallowed.
  d.start(0x3c, true);
  d.writeByte(0x00);
  d.writeByte(0x99);
  check(d.unhandledCommands.includes(0x99), 'an unknown command is recorded as unhandled');
  check(d.snapshot().log.some((l) => /unhandled/.test(l)), 'the device log names the unhandled command');
}

// ============================ BMP280 ============================

/** Builds a Uno + arbitrary I2C parts project; each part is wired the same way. */
function busProject(parts: { def: string; props?: Record<string, unknown>; sda?: string; scl?: string; power?: boolean; ad0?: boolean }[]) {
  const board = inst('board.arduino-uno');
  const instances = parts.map((p) => inst(p.def, p.props ?? {}));
  const connections: ReturnType<typeof wire>[] = [];
  parts.forEach((p, i) => {
    const c = instances[i];
    connections.push(wire(c, 'sda', board, p.sda ?? 'A4'));
    connections.push(wire(c, 'scl', board, p.scl ?? 'A5'));
    connections.push(wire(c, 'gnd', board, 'GND_PWR1'));
    if (p.power !== false) connections.push(wire(c, 'vcc', board, '5V'));
    if (p.ad0) connections.push(wire(c, 'ad0', board, '3V3'));
  });
  const project: CircuitProject = {
    ...emptyProject('bus'),
    boardInstances: [board],
    componentInstances: instances,
    connections,
  };
  return { project, ids: instances.map((c) => c.id) };
}

/** Runs firmware while capturing everything the sketch prints on Serial. */
function runCapturing(runner: AVRRunner, binding: CircuitBinding, ms: number): string {
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, ms);
  runner.onSerialByte = null;
  return out;
}

// The datasheet's own fixed-point compensation, run by the sketch itself. The
// sketch reads the calibration block off the bus first, so every number below
// comes from the device model rather than from anything baked into the firmware.
const BMP280_SKETCH = `#include <Wire.h>
uint16_t dig_T1, dig_P1;
int16_t dig_T2, dig_T3, dig_P2, dig_P3, dig_P4, dig_P5, dig_P6, dig_P7, dig_P8, dig_P9;
int32_t t_fine;
void readRegs(uint8_t reg, uint8_t n, uint8_t *out) {
  Wire.beginTransmission(0x76); Wire.write(reg); Wire.endTransmission(false);
  Wire.requestFrom((int)0x76, (int)n);
  for (uint8_t i = 0; i < n; i++) out[i] = Wire.read();
}
int32_t compT(int32_t adc_T) {
  int32_t var1 = ((((adc_T >> 3) - ((int32_t)dig_T1 << 1))) * ((int32_t)dig_T2)) >> 11;
  int32_t var2 = (((((adc_T >> 4) - ((int32_t)dig_T1)) * ((adc_T >> 4) - ((int32_t)dig_T1))) >> 12) * ((int32_t)dig_T3)) >> 14;
  t_fine = var1 + var2;
  return (t_fine * 5 + 128) >> 8;
}
uint32_t compP(int32_t adc_P) {
  int32_t var1 = (((int32_t)t_fine) >> 1) - (int32_t)64000;
  int32_t var2 = (((var1 >> 2) * (var1 >> 2)) >> 11) * ((int32_t)dig_P6);
  var2 = var2 + ((var1 * ((int32_t)dig_P5)) << 1);
  var2 = (var2 >> 2) + (((int32_t)dig_P4) << 16);
  var1 = (((dig_P3 * (((var1 >> 2) * (var1 >> 2)) >> 13)) >> 3) + ((((int32_t)dig_P2) * var1) >> 1)) >> 18;
  var1 = ((((32768 + var1)) * ((int32_t)dig_P1)) >> 15);
  if (var1 == 0) return 0;
  uint32_t p = (((uint32_t)(((int32_t)1048576) - adc_P) - (var2 >> 12))) * 3125;
  if (p < 0x80000000) p = (p << 1) / ((uint32_t)var1); else p = (p / (uint32_t)var1) * 2;
  var1 = (((int32_t)dig_P9) * ((int32_t)(((p >> 3) * (p >> 3)) >> 13))) >> 12;
  var2 = (((int32_t)(p >> 2)) * ((int32_t)dig_P8)) >> 13;
  return (uint32_t)((int32_t)p + ((var1 + var2 + dig_P7) >> 4));
}
void setup() {
  Serial.begin(9600); Wire.begin();
  uint8_t id[1]; readRegs(0xD0, 1, id);
  Serial.print("ID"); Serial.println(id[0], HEX);
  uint8_t raw[6]; readRegs(0xF7, 6, raw);
  Serial.print("SLEEP"); Serial.println(raw[0], HEX);   // reset value while asleep
  uint8_t c[24]; readRegs(0x88, 24, c);
  dig_T1 = c[0] | (c[1] << 8);   dig_T2 = c[2] | (c[3] << 8);   dig_T3 = c[4] | (c[5] << 8);
  dig_P1 = c[6] | (c[7] << 8);   dig_P2 = c[8] | (c[9] << 8);   dig_P3 = c[10] | (c[11] << 8);
  dig_P4 = c[12] | (c[13] << 8); dig_P5 = c[14] | (c[15] << 8); dig_P6 = c[16] | (c[17] << 8);
  dig_P7 = c[18] | (c[19] << 8); dig_P8 = c[20] | (c[21] << 8); dig_P9 = c[22] | (c[23] << 8);
  Serial.print("T1"); Serial.println(dig_T1);
  Wire.beginTransmission(0x76); Wire.write(0xF4); Wire.write(0x27); Wire.endTransmission();
}
void loop() {
  uint8_t r[6]; readRegs(0xF7, 6, r);
  int32_t adc_P = ((uint32_t)r[0] << 12) | ((uint32_t)r[1] << 4) | (r[2] >> 4);
  int32_t adc_T = ((uint32_t)r[3] << 12) | ((uint32_t)r[4] << 4) | (r[5] >> 4);
  int32_t t = compT(adc_T);
  uint32_t p = compP(adc_P);
  Serial.print("T="); Serial.print(t); Serial.print(" P="); Serial.println(p);
  delay(20);
}`;

/** Last "T=<centi-degrees> P=<pascals>" line the sketch printed. */
function lastReading(out: string): { t: number; p: number } | null {
  const m = [...out.matchAll(/T=(-?\d+) P=(\d+)/g)];
  if (m.length === 0) return null;
  const last = m[m.length - 1];
  return { t: Number(last[1]) / 100, p: Number(last[2]) };
}

// ---------- 9. BMP280 register protocol, unit level ----------
{
  const d = new Bmp280Device('unit', 0x76);
  check(d.matchesAddress(0x76) && !d.matchesAddress(0x77), 'BMP280 address matching is exact');

  const read = (reg: number, n: number) => {
    d.start(0x76, true);
    d.writeByte(reg);
    d.start(0x76, false);
    const bytes: number[] = [];
    for (let i = 0; i < n; i++) bytes.push(d.readByte());
    d.stop();
    return bytes;
  };
  check(read(0xd0, 1)[0] === 0x58, 'chip id register 0xD0 reads 0x58');
  const calib = read(0x88, 6);
  check(
    (calib[0] | (calib[1] << 8)) === 27504 && ((calib[2] | (calib[3] << 8)) << 16) >> 16 === 26435,
    `calibration block streams with an auto-incrementing pointer (dig_T1=${calib[0] | (calib[1] << 8)})`,
  );
  check(read(0xf7, 1)[0] === 0x80 && read(0xfa, 1)[0] === 0x80, 'measurement registers hold the reset value while asleep');

  d.start(0x76, true);
  d.writeByte(0xf4);
  d.writeByte(0x27);
  d.stop();
  check(d.isMeasuring && read(0xf4, 1)[0] === 0x27, 'ctrl_meas write is stored and read back');
  check(read(0xf7, 1)[0] !== 0x80, 'measurement registers change once a mode is selected');

  // Unknown registers are recorded, never answered with invented data.
  check(read(0x10, 1)[0] === 0x00 && d.unhandledRegisters.reads.includes(0x10), 'an unmapped register read is recorded as unhandled');

  d.start(0x76, true);
  d.writeByte(0xe0);
  d.writeByte(0xb6);
  d.stop();
  check(!d.isMeasuring, 'soft reset (0xE0 <- 0xB6) returns the part to sleep');
}

// ---------- 10. BMP280 driven by real firmware ----------
{
  const hex = await compileUno(BMP280_SKETCH);
  const { project, ids } = busProject([{ def: 'comp.bmp280' }]);
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.i2cBus.attachedCount === 1, `correctly wired BMP280 attaches to the I2C bus (${runner.i2cBus.attachedCount})`);
  const device = runner.i2cBus.deviceFor(ids[0]) as Bmp280Device;
  check(device instanceof Bmp280Device, 'device model is a BMP280');

  const out = runCapturing(runner, binding, 900);
  check(/ID58/.test(out), `firmware read chip id 0x58 off the bus (${out.slice(0, 12).replace(/\n/g, ' ')})`);
  check(/SLEEP80/.test(out), 'firmware saw the 0x80 reset value before selecting a mode');
  check(/T127504/.test(out), 'firmware read dig_T1 = 27504 out of the calibration block');
  check(device.isMeasuring, 'firmware put the sensor into normal mode (ctrl_meas decoded from real traffic)');

  const first = lastReading(out);
  check(
    first !== null && Math.abs(first.t - 25) < 0.3,
    `sketch compensation recovers the simulated 25.0 °C (${first?.t ?? 'no reading'} °C)`,
  );
  check(
    first !== null && Math.abs(first.p - 101325) < 150,
    `sketch compensation recovers the simulated 1013.25 hPa (${first?.p ?? 'no reading'} Pa)`,
  );

  // Change the environment; the same firmware must follow it.
  device.temperatureC = 40.5;
  device.pressureHpa = 950;
  const out2 = runCapturing(runner, binding, 600);
  const second = lastReading(out2);
  check(
    second !== null && Math.abs(second.t - 40.5) < 0.3,
    `a changed simulated temperature reaches the sketch (${second?.t ?? 'no reading'} °C)`,
  );
  check(
    second !== null && Math.abs(second.p - 95000) < 150,
    `a changed simulated pressure reaches the sketch (${second?.p ?? 'no reading'} Pa)`,
  );

  const vis = binding.update(emptyControls()).visuals.get(ids[0]);
  check(vis?.readout?.[0] === '40.5 C' && vis.readout[1] === '950 hPa', `canvas readout tracks the model (${vis?.readout?.join(' ')})`);
}

// ---------- 11. BMP280 wiring and addressing failures ----------
{
  const hex = await compileUno(BMP280_SKETCH);
  for (const [label, part] of [
    ['SDA on the wrong pin (D7)', { def: 'comp.bmp280', sda: 'D7' }],
    ['SCL on the wrong pin (D8)', { def: 'comp.bmp280', scl: 'D8' }],
    ['no power to VCC', { def: 'comp.bmp280', power: false }],
  ] as const) {
    const { project } = busProject([part]);
    const runner = new AVRRunner(hex, UNO);
    const binding = new CircuitBinding(project, runner);
    const out = runCapturing(runner, binding, 500);
    check(runner.i2cBus.attachedCount === 0, `BMP280 with ${label}: not attached to the bus`);
    check(!/ID58/.test(out), `BMP280 with ${label}: firmware reads no chip id`);
  }

  // Strapped to 0x77 while the sketch talks to 0x76 — a genuine NACK.
  const { project } = busProject([{ def: 'comp.bmp280', props: { i2cAddress: 0x77 } }]);
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  const out = runCapturing(runner, binding, 500);
  check(runner.i2cBus.attachedCount === 1, 'a 0x77-strapped BMP280 is still attached');
  check(!/ID58/.test(out), 'firmware addressing 0x76 does not reach a 0x77 sensor');
  check(runner.i2cBus.unclaimedAddressCount > 0, `the unanswered address is counted (${runner.i2cBus.unclaimedAddressCount})`);
}

// ============================ MPU-6050 ============================

const MPU_SKETCH = `#include <Wire.h>
uint8_t rd8(uint8_t reg) {
  Wire.beginTransmission(0x68); Wire.write(reg); Wire.endTransmission(false);
  Wire.requestFrom((int)0x68, 1);
  return Wire.read();
}
void wr8(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(0x68); Wire.write(reg); Wire.write(v); Wire.endTransmission();
}
void burst(int16_t *v) {
  Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(false);
  Wire.requestFrom((int)0x68, 14);
  for (uint8_t i = 0; i < 7; i++) {
    uint8_t h = Wire.read();
    uint8_t l = Wire.read();
    v[i] = (int16_t)(((uint16_t)h << 8) | l);
  }
}
void setup() {
  Serial.begin(9600); Wire.begin();
  Serial.print("WHO"); Serial.println(rd8(0x75), HEX);
  int16_t s[7]; burst(s);
  Serial.print("ASLEEP"); Serial.println(s[2]);   // accel Z before waking
  wr8(0x6B, 0x00);                                // clear SLEEP
  wr8(0x1C, 0x00);                                // accel ±2 g
  wr8(0x1B, 0x00);                                // gyro ±250 °/s
}
void loop() {
  int16_t v[7]; burst(v);
  Serial.print("A "); Serial.print(v[0]); Serial.print(' '); Serial.print(v[1]); Serial.print(' '); Serial.print(v[2]);
  Serial.print(" T "); Serial.print(v[3]);
  Serial.print(" G "); Serial.print(v[4]); Serial.print(' '); Serial.print(v[5]); Serial.print(' '); Serial.println(v[6]);
  delay(20);
}`;

/** Last "A ax ay az T t G gx gy gz" line the sketch printed. */
function lastMotion(out: string): number[] | null {
  const m = [...out.matchAll(/A (-?\d+) (-?\d+) (-?\d+) T (-?\d+) G (-?\d+) (-?\d+) (-?\d+)/g)];
  if (m.length === 0) return null;
  return m[m.length - 1].slice(1).map(Number);
}

// ---------- 12. MPU-6050 register protocol, unit level ----------
{
  const d = new Mpu6050Device('unit', 0x68);
  check(d.matchesAddress(0x68) && !d.matchesAddress(0x69), 'MPU-6050 address matching is exact');

  const read = (reg: number, n: number) => {
    d.start(0x68, true);
    d.writeByte(reg);
    d.start(0x68, false);
    const bytes: number[] = [];
    for (let i = 0; i < n; i++) bytes.push(d.readByte());
    d.stop();
    return bytes;
  };
  const word = (bytes: number[], i: number) => {
    const raw = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
    return raw >= 0x8000 ? raw - 0x10000 : raw;
  };
  check(read(0x75, 1)[0] === 0x68, 'WHO_AM_I (0x75) reads 0x68');
  check(!d.isAwake && read(0x6b, 1)[0] === 0x40, 'the part boots asleep with PWR_MGMT_1 = 0x40');
  check(read(0x3b, 14).every((b) => b === 0), 'measurement registers read zero until firmware clears SLEEP');

  d.start(0x68, true);
  d.writeByte(0x6b);
  d.writeByte(0x00);
  d.stop();
  check(d.isAwake, 'clearing the SLEEP bit wakes the device');

  const flat = read(0x3b, 14);
  check(word(flat, 0) === 0 && word(flat, 1) === 0 && word(flat, 2) === 16384, `at rest, accel Z reads +1 g = 16384 counts (${word(flat, 2)})`);
  check(word(flat, 3) === 0, `die temperature 36.53 °C is the datasheet zero count (${word(flat, 3)})`);
  check(word(flat, 4) === 0 && word(flat, 6) === 0, 'a stationary part reports zero angular rate');

  d.motion.accelG = { x: 0.5, y: -0.25, z: 0 };
  d.motion.gyroDps = { x: 0, y: 0, z: 120 };
  const moved = read(0x3b, 14);
  check(word(moved, 0) === 8192 && word(moved, 1) === -4096, `simulated acceleration scales at 16384 LSB/g (${word(moved, 0)}, ${word(moved, 1)})`);
  check(word(moved, 6) === Math.round(120 * 131), `simulated rotation scales at 131 LSB/(°/s) (${word(moved, 6)})`);

  // Changing the full-scale range changes the counts, exactly as on hardware.
  d.start(0x68, true);
  d.writeByte(0x1c);
  d.writeByte(0x10); // AFS_SEL = 2 -> ±8 g
  d.stop();
  check(d.accelFullScaleG === 8 && word(read(0x3b, 14), 0) === 2048, `±8 g range rescales 0.5 g to 2048 counts (${word(read(0x3b, 14), 0)})`);

  check(read(0x0f, 1)[0] === 0x00 && d.unhandledRegisters.reads.includes(0x0f), 'an unmapped MPU register read is recorded as unhandled');
  d.reset();
  check(!d.isAwake && d.accelFullScaleG === 2, 'reset() restores the datasheet power-on state');
}

// ---------- 13. MPU-6050 driven by real firmware ----------
{
  const hex = await compileUno(MPU_SKETCH);
  const { project, ids } = busProject([{ def: 'comp.mpu6050' }]);
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.i2cBus.attachedCount === 1, `correctly wired MPU-6050 attaches to the I2C bus (${runner.i2cBus.attachedCount})`);
  const device = runner.i2cBus.deviceFor(ids[0]) as Mpu6050Device;
  device.motion.accelG = { x: 0.25, y: -0.5, z: 0.8 };
  device.motion.gyroDps = { x: 10, y: -20, z: 30 };
  device.motion.temperatureC = 36.53;

  const out = runCapturing(runner, binding, 900);
  check(/WHO68/.test(out), `firmware read WHO_AM_I = 0x68 off the bus (${out.slice(0, 12).replace(/\n/g, ' ')})`);
  check(/ASLEEP0\b/.test(out), 'firmware read zeros before clearing the SLEEP bit');
  check(device.isAwake, 'firmware woke the device (PWR_MGMT_1 write decoded from real traffic)');

  const m = lastMotion(out);
  check(m !== null && m[0] === Math.round(0.25 * 16384), `sketch reads accel X = ${Math.round(0.25 * 16384)} (${m?.[0] ?? 'no reading'})`);
  check(m !== null && m[1] === Math.round(-0.5 * 16384), `sketch reads accel Y = ${Math.round(-0.5 * 16384)} (${m?.[1] ?? 'no reading'})`);
  check(m !== null && m[2] === Math.round(0.8 * 16384), `sketch reads accel Z = ${Math.round(0.8 * 16384)} (${m?.[2] ?? 'no reading'})`);
  check(m !== null && m[6] === Math.round(30 * 131), `sketch reads gyro Z = ${Math.round(30 * 131)} (${m?.[6] ?? 'no reading'})`);

  device.motion.accelG = { x: 0, y: 0, z: 1 };
  device.motion.gyroDps = { x: 0, y: 0, z: -90 };
  const m2 = lastMotion(runCapturing(runner, binding, 400));
  check(m2 !== null && m2[2] === 16384 && m2[6] === Math.round(-90 * 131), `changed motion state reaches the sketch (${m2?.slice(4).join(',') ?? 'none'})`);

  const vis = binding.update(emptyControls()).visuals.get(ids[0]);
  check(/0\.00 0\.00 1\.00 g/.test(vis?.readout?.[0] ?? ''), `canvas readout tracks the model (${vis?.readout?.join(' | ')})`);
}

// ---------- 14. MPU-6050 AD0 strap and wiring failures ----------
{
  const hex = await compileUno(MPU_SKETCH);
  const { project, ids } = busProject([{ def: 'comp.mpu6050', ad0: true }]);
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  const device = runner.i2cBus.deviceFor(ids[0]) as Mpu6050Device;
  check(device.matchesAddress(0x69) && !device.matchesAddress(0x68), 'AD0 tied to a supply moves the device to 0x69');
  const out = runCapturing(runner, binding, 500);
  check(!/WHO68/.test(out), 'firmware addressing 0x68 does not reach a 0x69-strapped device');
  check(runner.i2cBus.unclaimedAddressCount > 0, `the unanswered address is counted (${runner.i2cBus.unclaimedAddressCount})`);

  for (const [label, part] of [
    ['SDA on the wrong pin (D7)', { def: 'comp.mpu6050', sda: 'D7' }],
    ['SCL on the wrong pin (D8)', { def: 'comp.mpu6050', scl: 'D8' }],
    ['no power to VCC', { def: 'comp.mpu6050', power: false }],
  ] as const) {
    const p = busProject([part]);
    const r = new AVRRunner(hex, UNO);
    const b = new CircuitBinding(p.project, r);
    const o = runCapturing(r, b, 500);
    check(r.i2cBus.attachedCount === 0, `MPU-6050 with ${label}: not attached to the bus`);
    check(!/WHO68/.test(o), `MPU-6050 with ${label}: firmware reads no WHO_AM_I`);
  }
}

// ---------- 15. Three devices sharing one bus ----------
{
  // One sketch drives an OLED, a BMP280 and an MPU-6050 on the same two wires.
  const hex = await compileUno(`#include <Wire.h>
void cmd(uint8_t c){ Wire.beginTransmission(0x3C); Wire.write(0x00); Wire.write(c); Wire.endTransmission(); }
uint8_t rd(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr); Wire.write(reg); Wire.endTransmission(false);
  Wire.requestFrom((int)addr, 1);
  return Wire.read();
}
void setup() {
  Serial.begin(9600); Wire.begin();
  cmd(0x20); cmd(0x00); cmd(0x21); cmd(0); cmd(127); cmd(0x22); cmd(0); cmd(7); cmd(0xAF);
  Wire.beginTransmission(0x3C); Wire.write(0x40);
  for (uint8_t i = 0; i < 16; i++) Wire.write(0xFF);
  Wire.endTransmission();
  Serial.print("BMP"); Serial.println(rd(0x76, 0xD0), HEX);
  Serial.print("MPU"); Serial.println(rd(0x68, 0x75), HEX);
  Serial.print("NONE"); Serial.println(rd(0x1E, 0x00), HEX);   // nothing at 0x1E
  Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0x00); Wire.endTransmission();
  Wire.beginTransmission(0x76); Wire.write(0xF4); Wire.write(0x27); Wire.endTransmission();
}
void loop() {
  Serial.print("AZ"); Serial.print((int16_t)((rd(0x68, 0x3F) << 8) | rd(0x68, 0x40)));
  Serial.print(" PM"); Serial.println(rd(0x76, 0xF7));
  delay(30);
}`);
  const { project, ids } = busProject([{ def: 'comp.oled' }, { def: 'comp.bmp280' }, { def: 'comp.mpu6050' }]);
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.i2cBus.attachedCount === 3, `all three devices share one bus (${runner.i2cBus.attachedCount})`);

  const oled = runner.i2cBus.deviceFor(ids[0]) as Ssd1306Device;
  const bmp = runner.i2cBus.deviceFor(ids[1]) as Bmp280Device;
  const mpu = runner.i2cBus.deviceFor(ids[2]) as Mpu6050Device;
  mpu.motion.accelG = { x: 0, y: 0, z: 0.5 };

  const out = runCapturing(runner, binding, 900);
  check(/BMP58/.test(out), 'the BMP280 answers 0x76 while two other devices are attached');
  check(/MPU68/.test(out), 'the MPU-6050 answers 0x68 while two other devices are attached');
  check(/NONEFF/.test(out), 'an address no attached device claims is still NACKed (bus idle level read back)');
  check(oled.isOn && oled.litPixels === 128, `the OLED still decodes its own traffic (${oled.litPixels} pixels)`);
  check(bmp.isMeasuring, 'the BMP280 received its ctrl_meas write');
  check(mpu.isAwake, 'the MPU-6050 received its wake-up write');
  check(/AZ8192\b/.test(out), `each device answered only for itself — accel Z reads 8192 (${(out.match(/AZ-?\d+/g) ?? ['none']).slice(-1)[0]})`);

  const visuals = binding.update(emptyControls()).visuals;
  check(visuals.get(ids[0])?.display?.on === true, 'OLED visual still live with a shared bus');
  check(visuals.get(ids[1])?.readout?.[0] === '25.0 C', `BMP280 visual live with a shared bus (${visuals.get(ids[1])?.readout?.join(' ')})`);
  check(/0\.50 g/.test(visuals.get(ids[2])?.readout?.[0] ?? ''), `MPU-6050 visual live with a shared bus (${visuals.get(ids[2])?.readout?.[0]})`);
}

console.log(failures === 0 ? '\nAll I2C component checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
