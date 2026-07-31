// I2C component suite — proves the SSD1306 is driven by real firmware traffic.
//
// Every display check below compiles a Wire sketch through the backend and runs
// it on the AVR emulator; the pixels asserted come from bytes the firmware
// actually wrote over the emulated TWI bus. Wire is part of the Arduino AVR
// core, so these sketches compile with no extra libraries.

import { AVRRunner, F_CPU } from '../src/simulation/avrRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { AVR_BOARD_PROFILES } from '../src/boards/pinMaps';
import { Ssd1306Device } from '../src/simulation/devices/ssd1306';
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

console.log(failures === 0 ? '\nAll I2C component checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
