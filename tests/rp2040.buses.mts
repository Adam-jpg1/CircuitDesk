// Raspberry Pi Pico I2C and SPI, exercised through the production code paths.
//
// Every sketch here is ordinary Arduino code compiled by the real backend and
// executed unmodified by the production RP2040 runner. The devices are the
// same models the AVR engine drives — not Pico-specific copies — attached
// through the same `I2cBus`, `SpiBus` and `CircuitBinding` a user's project
// goes through. Circuits are built the way a user would build them: a board,
// some parts, and wires between named pins.
//
// The sketches use only the `Wire` and `SPI` libraries bundled with the
// Arduino-Pico core, so what is proven is the protocol reaching the device,
// not a third-party driver's behaviour.
//
// Every negative case reuses the *same firmware* as its positive case with
// different wiring, which is the only way to show that the failure comes from
// the circuit rather than from the program.

import { getSimulatorAdapter } from '../src/simulation/adapters';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { getBoardDefinition } from '../src/boards/definitions';
import { emptyProject } from '../src/project/templates';
import type { BoardRunner } from '../src/simulation/boardRunner';
import {
  readI2cPins,
  readSpiPins,
  rp2040I2cRole,
  rp2040SpiRole,
  FUNCSEL_I2C,
  FUNCSEL_SPI,
  FUNCSEL_SIO,
  ARDUINO_PICO_DEFAULT_I2C,
  ARDUINO_PICO_DEFAULT_SPI,
} from '../src/simulation/rp2040/busPins';
import type { CircuitProject } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const PICO = 'board.raspberry-pi-pico';
const PICO_W = 'board.raspberry-pi-pico-w';

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
function finish(): never {
  console.log(
    failures === 0
      ? `\nRP2040 bus checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- compiling

interface Artifact {
  data: string;
  format: string;
}
const compiled = new Map<string, Artifact | null>();

async function compile(source: string, boardId = PICO, fqbn = 'rp2040:rp2040:rpipico'): Promise<Artifact | null> {
  const key = `${boardId}\u0000${source}`;
  if (compiled.has(key)) return compiled.get(key)!;
  let result: Artifact | null = null;
  try {
    // Retried on a transport failure, not on an HTTP answer. A pooled
    // keep-alive connection can be closed between requests, and the fetch that
    // reuses it fails before the compiler sees it -- which used to skip this
    // whole section as though the sketch would not build.
    const payload = JSON.stringify({ boardId, fqbn, files: [{ name: 'sketch.ino', content: source }] });
    let res: Response | null = null;
    let transportError: unknown;
    for (let attempt = 0; attempt < 3 && res === null; attempt++) {
      try {
        res = await fetch(`${BASE}/api/compiler/compile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
      } catch (err) {
        transportError = err;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (!res) throw transportError;
    const json = (await res.json()) as { success: boolean; firmware?: Artifact; error?: string; stderr?: string };
    if (json.success && json.firmware) result = json.firmware;
    else console.log('      compile failed:', (json.error ?? '').slice(0, 100), String(json.stderr ?? '').slice(0, 200));
  } catch (err) {
    console.log('      compile request failed:', String(err).slice(0, 120));
  }
  compiled.set(key, result);
  return result;
}

// ------------------------------------------------------------ project building

let nextId = 0;
const newId = (prefix: string) => `${prefix}${++nextId}`;

type Wire = [string, string, string, string];

function buildProject(
  boardId: string,
  parts: { key: string; defId: string; props?: Record<string, unknown> }[],
  wire: (ids: Record<string, string> & { board: string }) => Wire[],
): { project: CircuitProject; ids: Record<string, string> & { board: string } } {
  const project = emptyProject('rp2040-buses');
  const board = newId('b');
  project.boardInstances.push({
    id: board,
    definitionId: boardId,
    x: 100,
    y: 100,
    rotation: 0,
    properties: {},
    simulationState: {},
  } as never);
  const ids = { board } as Record<string, string> & { board: string };
  for (const part of parts) {
    const instId = newId('c');
    ids[part.key] = instId;
    project.componentInstances.push({
      id: instId,
      definitionId: part.defId,
      x: 300,
      y: 100,
      rotation: 0,
      properties: part.props ?? {},
      simulationState: {},
    } as never);
  }
  project.connections = wire(ids).map(([a, ap, b, bp]) => ({
    id: newId('w'),
    sourceComponentId: a,
    sourcePinId: ap,
    targetComponentId: b,
    targetPinId: bp,
    netId: '',
    color: '#e8590c',
    points: [],
    routing: 'smooth' as const,
  }));
  return { project, ids };
}

/** Standard 3V3/GND supply wiring for a two-wire module. */
const power = (board: string, part: string, gnd = 'GND1'): Wire[] => [
  [board, '3V3', part, 'vcc'],
  [part, 'gnd', board, gnd],
];

interface RunOutcome {
  runner: BoardRunner;
  binding: CircuitBinding;
  serial: string;
  lines: string[];
}

/**
 * Boots firmware against a circuit and runs it until the sketch says it is
 * done, updating the binding the way the application's tick loop does.
 */
async function run(
  firmware: Artifact,
  project: CircuitProject,
  options: { until?: string; simMs?: number; boardId?: string; onFrame?: (o: { runner: BoardRunner; binding: CircuitBinding; controls: ReturnType<typeof emptyControls> }) => void } = {},
): Promise<RunOutcome> {
  const board = getBoardDefinition(options.boardId ?? PICO)!;
  const runner = await getSimulatorAdapter(board)!.createRunner(firmware, board);
  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();
  let serial = '';
  runner.onSerialByte = (b) => {
    serial += String.fromCharCode(b);
  };
  const budget = options.simMs ?? 1200;
  for (let done = 0; done < budget; done += 2) {
    runner.runFor(2);
    binding.update(controls);
    options.onFrame?.({ runner, binding, controls });
    if (options.until && serial.includes(options.until)) break;
  }
  return {
    runner,
    binding,
    serial,
    lines: serial
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  };
}

/** Value of a `KEY=value` line the sketch printed. */
function field(lines: string[], key: string): string | undefined {
  const hit = lines.find((l) => l.startsWith(`${key}=`));
  return hit?.slice(key.length + 1);
}

// ================================================ 1. pin mapping, in isolation
//
// The function-table arithmetic is asserted directly, because getting it wrong
// would silently move a bus to the wrong pins.
{
  check(rp2040I2cRole(0)?.line === 'sda' && rp2040I2cRole(0)?.instance === 0, 'GP0 is I2C0 SDA');
  check(rp2040I2cRole(1)?.line === 'scl' && rp2040I2cRole(1)?.instance === 0, 'GP1 is I2C0 SCL');
  check(rp2040I2cRole(2)?.instance === 1, 'GP2 belongs to I2C1');
  check(rp2040I2cRole(4)?.line === 'sda' && rp2040I2cRole(4)?.instance === 0, 'GP4 is I2C0 SDA again');
  check(rp2040I2cRole(5)?.line === 'scl' && rp2040I2cRole(5)?.instance === 0, 'GP5 is I2C0 SCL');
  check(rp2040I2cRole(27)?.line === 'scl' && rp2040I2cRole(27)?.instance === 1, 'GP27 is I2C1 SCL');

  check(rp2040SpiRole(16)?.line === 'miso' && rp2040SpiRole(16)?.instance === 0, 'GP16 is SPI0 RX/MISO');
  check(rp2040SpiRole(17)?.line === 'cs', 'GP17 is a hardware chip-select');
  check(rp2040SpiRole(18)?.line === 'sck' && rp2040SpiRole(18)?.instance === 0, 'GP18 is SPI0 SCK');
  check(rp2040SpiRole(19)?.line === 'mosi' && rp2040SpiRole(19)?.instance === 0, 'GP19 is SPI0 TX/MOSI');
  check(rp2040SpiRole(10)?.instance === 1 && rp2040SpiRole(10)?.line === 'sck', 'GP10 is SPI1 SCK');
  check(rp2040SpiRole(24)?.instance === 1, 'GP24 belongs to SPI1');

  // Reading the pads back.
  const pads = Array.from({ length: 30 }, () => ({ functionSelect: FUNCSEL_SIO }));
  check(readI2cPins(pads).sda === undefined, 'no I2C pins are reported before the firmware muxes any');
  check(readSpiPins(pads).sck === undefined, 'no SPI pins are reported before the firmware muxes any');
  pads[2] = { functionSelect: FUNCSEL_I2C };
  pads[3] = { functionSelect: FUNCSEL_I2C };
  const moved = readI2cPins(pads);
  check(moved.sda === 2 && moved.scl === 3 && moved.instance === 1, `a sketch that moves I2C to GP2/GP3 is followed (${moved.sda}/${moved.scl})`);
  pads[10] = { functionSelect: FUNCSEL_SPI };
  pads[11] = { functionSelect: FUNCSEL_SPI };
  const spi1 = readSpiPins(pads);
  check(spi1.sck === 10 && spi1.mosi === 11 && spi1.instance === 1, `a sketch using SPI1 on GP10/GP11 is followed (${spi1.sck}/${spi1.mosi})`);
}

// ---------------------------------------------------------------- firmware

const EEPROM_SKETCH = `#include <Wire.h>
void setup() {
  Serial1.begin(115200);
  Wire.begin();
  Wire.beginTransmission(0x50);
  Wire.write((uint8_t)0); Wire.write((uint8_t)0); Wire.write(0xA5);
  Serial1.print("W="); Serial1.println(Wire.endTransmission());
  delay(10);
  Wire.beginTransmission(0x50);
  Wire.write((uint8_t)0); Wire.write((uint8_t)0);
  Serial1.print("A="); Serial1.println(Wire.endTransmission(false));
  Wire.requestFrom(0x50, 1);
  Serial1.print("R="); Serial1.println(Wire.read(), HEX);
  Serial1.println("DONE");
}
void loop() { delay(50); }`;

const eepromFirmware = await compile(EEPROM_SKETCH);
if (!eepromFirmware) {
  skip('the Pico toolchain is unavailable — no bus sections can run');
  finish();
}

const picoBoard = getBoardDefinition(PICO)!;

// ==================================================== 2. EEPROM: the full shape
//
// One transaction that exercises everything the bus has to get right: address
// ACK, multi-byte write, repeated START, and a read that returns real data.
{
  const { project, ids } = buildProject(PICO, [{ key: 'eeprom', defId: 'comp.eeprom-24c' }], (i) => [
    [i.board, 'GP4', i.eeprom, 'sda'],
    [i.board, 'GP5', i.eeprom, 'scl'],
    ...power(i.board, i.eeprom),
  ]);
  const out = await run(eepromFirmware, project, { until: 'DONE' });

  check(field(out.lines, 'W') === '0', `the write is acknowledged (endTransmission = ${field(out.lines, 'W')})`);
  check(field(out.lines, 'A') === '0', `the address phase of the read is acknowledged (${field(out.lines, 'A')})`);
  check(field(out.lines, 'R') === 'A5', `the byte written is the byte read back (${field(out.lines, 'R')})`);

  const bus = out.runner.i2cBus!;
  check(bus.unclaimedAddressCount === 0, 'nothing on the bus went unanswered');
  const log = (bus as unknown as { log: { kind: string; address?: number; ack?: boolean }[] }).log;
  check(log.some((e) => e.kind === 'address' && e.address === 0x50 && e.ack === true), 'the EEPROM ACKed its own address');
  const starts = log.filter((e) => e.kind === 'start').length;
  check(starts >= 2, `the transfer used a repeated START (${starts} STARTs)`);
  check(log.some((e) => e.kind === 'read'), 'a real read phase happened on the bus');

  // The pins were discovered, not assumed: the sketch never says GP4/GP5.
  const active = (out.runner as unknown as { activeI2cPins(): { sda?: number; scl?: number } }).activeI2cPins();
  check(active.sda === 4 && active.scl === 5, `the bus pins were read back from the pads (SDA GP${active.sda}, SCL GP${active.scl})`);
}

// ------------------------------- the same firmware, wired wrong --------------

{
  // SDA and SCL swapped.
  const { project, ids } = buildProject(PICO, [{ key: 'eeprom', defId: 'comp.eeprom-24c' }], (i) => [
    [i.board, 'GP5', i.eeprom, 'sda'],
    [i.board, 'GP4', i.eeprom, 'scl'],
    ...power(i.board, i.eeprom),
  ]);
  const out = await run(eepromFirmware, project, { until: 'DONE' });
  check(field(out.lines, 'W') !== '0', `swapped SDA/SCL is not acknowledged (endTransmission = ${field(out.lines, 'W')})`);
  check(out.runner.i2cBus!.unclaimedAddressCount > 0, 'the swapped wiring leaves the address unclaimed');
}

{
  // On the wrong pins entirely.
  const { project, ids } = buildProject(PICO, [{ key: 'eeprom', defId: 'comp.eeprom-24c' }], (i) => [
    [i.board, 'GP6', i.eeprom, 'sda'],
    [i.board, 'GP7', i.eeprom, 'scl'],
    ...power(i.board, i.eeprom),
  ]);
  const out = await run(eepromFirmware, project, { until: 'DONE' });
  check(field(out.lines, 'W') !== '0', `a device on pins the bus is not using does not answer (${field(out.lines, 'W')})`);
}

{
  // Correctly wired, but unpowered.
  const { project, ids } = buildProject(PICO, [{ key: 'eeprom', defId: 'comp.eeprom-24c' }], (i) => [
    [i.board, 'GP4', i.eeprom, 'sda'],
    [i.board, 'GP5', i.eeprom, 'scl'],
    [i.eeprom, 'gnd', i.board, 'GND1'],
  ]);
  const out = await run(eepromFirmware, project, { until: 'DONE' });
  check(field(out.lines, 'W') !== '0', `an unpowered device does not answer (${field(out.lines, 'W')})`);
}

{
  // Powered and wired, but the sketch talks to the wrong address. The EEPROM
  // answers 0x50; this firmware asks for 0x50 too, so the address is changed
  // on the device instead, which is the same mistake from the other side.
  const { project, ids } = buildProject(
    PICO,
    [{ key: 'eeprom', defId: 'comp.eeprom-24c', props: { i2cAddress: 0x53 } }],
    (i) => [
      [i.board, 'GP4', i.eeprom, 'sda'],
      [i.board, 'GP5', i.eeprom, 'scl'],
      ...power(i.board, i.eeprom),
    ],
  );
  const out = await run(eepromFirmware, project, { until: 'DONE' });
  check(field(out.lines, 'W') !== '0', `a device at a different address does not answer (${field(out.lines, 'W')})`);
  check(out.runner.i2cBus!.unclaimedAddressCount > 0, 'the wrong address is reported as unclaimed, not silently ignored');
}

// ========================================= 3. each I2C device, from real firmware

/** Reads one register from an I2C device and prints it, using raw Wire calls. */
const readRegisterSketch = (address: number, register: number) => `#include <Wire.h>
void setup() {
  Serial1.begin(115200);
  Wire.begin();
  Wire.beginTransmission(0x${address.toString(16)});
  Wire.write(0x${register.toString(16)});
  Serial1.print("A="); Serial1.println(Wire.endTransmission(false));
  Wire.requestFrom(0x${address.toString(16)}, 1);
  Serial1.print("V="); Serial1.println(Wire.read(), HEX);
  Serial1.println("DONE");
}
void loop() { delay(50); }`;

async function twoWireDevice(
  label: string,
  defId: string,
  address: number,
  register: number,
  expected: number,
): Promise<void> {
  const firmware = await compile(readRegisterSketch(address, register));
  if (!firmware) {
    skip(`${label}: sketch did not compile`);
    return;
  }
  const { project, ids } = buildProject(PICO, [{ key: 'dev', defId }], (i) => [
    [i.board, 'GP4', i.dev, 'sda'],
    [i.board, 'GP5', i.dev, 'scl'],
    ...power(i.board, i.dev),
  ]);
  const out = await run(firmware, project, { until: 'DONE' });
  check(field(out.lines, 'A') === '0', `${label}: answers at 0x${address.toString(16)} (${field(out.lines, 'A')})`);
  check(
    field(out.lines, 'V')?.toUpperCase() === expected.toString(16).toUpperCase(),
    `${label}: register 0x${register.toString(16)} reads 0x${expected.toString(16)} (got 0x${field(out.lines, 'V')})`,
  );
}

await twoWireDevice('BMP280', 'comp.bmp280', 0x76, 0xd0, 0x58);
await twoWireDevice('MPU-6050', 'comp.mpu6050', 0x68, 0x75, 0x68);
await twoWireDevice('DS3231', 'comp.ds3231', 0x68, 0x0e, 0x1c);

// The SSD1306 and the LCD backpack are write-only, so they are proven by the
// state they end up in rather than by a register read.
{
  const firmware = await compile(`#include <Wire.h>
void setup() {
  Serial1.begin(115200);
  Wire.begin();
  // Display on, then one page of pixel data.
  Wire.beginTransmission(0x3C); Wire.write(0x00); Wire.write(0xAF);
  Serial1.print("C="); Serial1.println(Wire.endTransmission());
  Wire.beginTransmission(0x3C); Wire.write(0x40);
  for (int i = 0; i < 16; i++) Wire.write(0xFF);
  Serial1.print("D="); Serial1.println(Wire.endTransmission());
  Serial1.println("DONE");
}
void loop() { delay(50); }`);
  if (!firmware) {
    skip('SSD1306: sketch did not compile');
  } else {
    const { project, ids } = buildProject(PICO, [{ key: 'oled', defId: 'comp.oled' }], (i) => [
      [i.board, 'GP4', i.oled, 'sda'],
      [i.board, 'GP5', i.oled, 'scl'],
      ...power(i.board, i.oled),
    ]);
    let lastDisplay: { pixels: Uint8Array | null; on: boolean } | undefined;
    const out = await run(firmware, project, {
      until: 'DONE',
      onFrame: ({ binding, controls }) => {
        const v = binding.update(controls).visuals.get(ids.oled) as { display?: { pixels: Uint8Array | null; on: boolean } } | undefined;
        if (v?.display) lastDisplay = v.display;
      },
    });
    check(field(out.lines, 'C') === '0', `SSD1306: accepts a command (${field(out.lines, 'C')})`);
    check(field(out.lines, 'D') === '0', `SSD1306: accepts pixel data (${field(out.lines, 'D')})`);
    check(lastDisplay?.on === true, 'SSD1306: the display turned on from the real 0xAF command');
    const lit = lastDisplay?.pixels ? [...lastDisplay.pixels].filter((b) => b !== 0).length : 0;
    check(lit >= 16, `SSD1306: the pixel data reached display RAM (${lit} non-blank bytes)`);
  }
}

{
  const firmware = await compile(`#include <Wire.h>
static void nibble(uint8_t v) {
  Wire.beginTransmission(0x27); Wire.write(v | 0x0C); Wire.endTransmission();
  Wire.beginTransmission(0x27); Wire.write(v & ~0x04); Wire.endTransmission();
}
static void cmd(uint8_t c) { nibble(c & 0xF0); nibble((c << 4) & 0xF0); }
static void chr(uint8_t c) { nibble((c & 0xF0) | 0x01); nibble(((c << 4) & 0xF0) | 0x01); }
void setup() {
  Serial1.begin(115200);
  Wire.begin();
  Wire.beginTransmission(0x27); Wire.write(0x08);
  Serial1.print("P="); Serial1.println(Wire.endTransmission());
  nibble(0x30); nibble(0x30); nibble(0x30); nibble(0x20);
  cmd(0x28); cmd(0x0C); cmd(0x01); delay(5); cmd(0x06);
  chr('P'); chr('I'); chr('C'); chr('O');
  Serial1.println("DONE");
}
void loop() { delay(50); }`);
  if (!firmware) {
    skip('LCD1602: sketch did not compile');
  } else {
    const { project, ids } = buildProject(PICO, [{ key: 'lcd', defId: 'comp.lcd1602' }], (i) => [
      [i.board, 'GP4', i.lcd, 'sda'],
      [i.board, 'GP5', i.lcd, 'scl'],
      ...power(i.board, i.lcd),
    ]);
    let text: string[] = [];
    const out = await run(firmware, project, {
      until: 'DONE',
      onFrame: ({ binding, controls }) => {
        const v = binding.update(controls).visuals.get(ids.lcd) as { readout?: string[] } | undefined;
        if (v?.readout) text = v.readout;
      },
    });
    check(field(out.lines, 'P') === '0', `LCD1602: the PCF8574 backpack answers at 0x27 (${field(out.lines, 'P')})`);
    check(
      text.join('').includes('PICO'),
      `LCD1602: four-bit nibbles latched real characters into DDRAM (${JSON.stringify(text)})`,
    );
  }
}

// ============================================ 4. MCP4725 → canvas → GP26 ADC
//
// The end-to-end analog proof. Firmware writes a DAC over I2C, the DAC's
// output becomes a voltage on a canvas net, that net reaches an ADC pin, and
// the firmware reads it back. Every stage is shared with the AVR engine.
{
  const firmware = await compile(`#include <Wire.h>
static void dac(uint16_t v) {
  Wire.beginTransmission(0x60);
  Wire.write(0x40);
  Wire.write(v >> 4);
  Wire.write((v & 0x0F) << 4);
  Wire.endTransmission();
}
void setup() {
  Serial1.begin(115200);
  analogReadResolution(12);
  Wire.begin();
  dac(0);    delay(20); Serial1.print("LO="); Serial1.println(analogRead(26));
  dac(2048); delay(20); Serial1.print("MID="); Serial1.println(analogRead(26));
  dac(4095); delay(20); Serial1.print("HI="); Serial1.println(analogRead(26));
  Serial1.println("DONE");
}
void loop() { delay(50); }`);
  if (!firmware) {
    skip('MCP4725 loopback: sketch did not compile');
  } else {
    const { project, ids } = buildProject(PICO, [{ key: 'dac', defId: 'comp.mcp4725' }], (i) => [
      [i.board, 'GP4', i.dac, 'sda'],
      [i.board, 'GP5', i.dac, 'scl'],
      // The DAC's analog output feeds an ADC pin through an ordinary canvas net.
      [i.dac, 'vout', i.board, 'GP26'],
      ...power(i.board, i.dac),
    ]);
    const out = await run(firmware, project, { until: 'DONE', simMs: 2000 });
    const lo = Number(field(out.lines, 'LO'));
    const mid = Number(field(out.lines, 'MID'));
    const hi = Number(field(out.lines, 'HI'));
    console.log(`      MCP4725 -> GP26: ${lo} at 0, ${mid} at half scale, ${hi} at full scale`);
    check(Number.isFinite(lo) && Number.isFinite(mid) && Number.isFinite(hi), 'the loopback sketch reported three readings');
    check(lo < 120, `a DAC output of 0 reads near zero (${lo})`);
    check(hi > 3900, `a full-scale DAC output reads near full scale (${hi})`);
    check(mid > 1800 && mid < 2300, `a half-scale DAC output reads about half scale (${mid})`);
    check(lo < mid && mid < hi, 'the ADC reading tracks the DAC monotonically');
  }
}

// ================================================= 5. several devices, one bus
{
  const firmware = await compile(`#include <Wire.h>
static int reg(uint8_t addr, uint8_t r) {
  Wire.beginTransmission(addr); Wire.write(r);
  if (Wire.endTransmission(false) != 0) return -1;
  Wire.requestFrom((int)addr, 1);
  return Wire.available() ? Wire.read() : -2;
}
void setup() {
  Serial1.begin(115200);
  Wire.begin();
  Serial1.print("BMP="); Serial1.println(reg(0x76, 0xD0), HEX);
  Serial1.print("MPU="); Serial1.println(reg(0x68, 0x75), HEX);
  Wire.beginTransmission(0x3C); Wire.write(0x00); Wire.write(0xAF);
  Serial1.print("OLED="); Serial1.println(Wire.endTransmission());
  Serial1.print("NONE="); Serial1.println(reg(0x22, 0x00), HEX);
  Serial1.println("DONE");
}
void loop() { delay(50); }`);
  if (!firmware) {
    skip('multi-device I2C: sketch did not compile');
  } else {
    const { project, ids } = buildProject(
      PICO,
      [
        { key: 'bmp', defId: 'comp.bmp280' },
        { key: 'mpu', defId: 'comp.mpu6050' },
        { key: 'oled', defId: 'comp.oled' },
      ],
      (i) => [
        [i.board, 'GP4', i.bmp, 'sda'],
        [i.board, 'GP5', i.bmp, 'scl'],
        [i.board, 'GP4', i.mpu, 'sda'],
        [i.board, 'GP5', i.mpu, 'scl'],
        [i.board, 'GP4', i.oled, 'sda'],
        [i.board, 'GP5', i.oled, 'scl'],
        ...power(i.board, i.bmp),
        ...power(i.board, i.mpu, 'GND2'),
        ...power(i.board, i.oled, 'GND3'),
      ],
    );
    const out = await run(firmware, project, { until: 'DONE', simMs: 2000 });
    check(field(out.lines, 'BMP')?.toUpperCase() === '58', `three devices share one bus: BMP280 answers (0x${field(out.lines, 'BMP')})`);
    check(field(out.lines, 'MPU')?.toUpperCase() === '68', `MPU-6050 answers independently (0x${field(out.lines, 'MPU')})`);
    check(field(out.lines, 'OLED') === '0', `SSD1306 answers independently (${field(out.lines, 'OLED')})`);
    // The sketch returns -1 on NACK, which Serial1.println(..., HEX) prints as
  // a two's-complement FFFFFFFF.
  check(field(out.lines, 'NONE')?.toUpperCase() === 'FFFFFFFF', `an address nobody occupies still NACKs (${field(out.lines, 'NONE')})`);
    check(out.runner.i2cBus!.unclaimedAddressCount === 1, `exactly one address went unanswered (${out.runner.i2cBus!.unclaimedAddressCount})`);
  }
}

// ==================================================== 6. SPI, from real firmware

const FLASH_SKETCH = `#include <SPI.h>
static uint8_t CS = 17;
void setup() {
  Serial1.begin(115200);
  pinMode(CS, OUTPUT); digitalWrite(CS, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CS, LOW);
  SPI.transfer(0x9F);
  uint8_t a = SPI.transfer(0), b = SPI.transfer(0), c = SPI.transfer(0);
  digitalWrite(CS, HIGH);
  SPI.endTransaction();
  Serial1.print("ID="); Serial1.print(a, HEX); Serial1.print(","); Serial1.print(b, HEX); Serial1.print(","); Serial1.println(c, HEX);
  Serial1.println("DONE");
}
void loop() { delay(50); }`;

const flashFirmware = await compile(FLASH_SKETCH);
if (!flashFirmware) {
  skip('SPI flash: sketch did not compile');
} else {
  const spiWiring = (i: Record<string, string> & { board: string }, part: string, cs: string): Wire[] => [
    [i.board, 'GP18', i[part], 'sck'],
    [i.board, 'GP19', i[part], 'mosi'],
    [i.board, 'GP16', i[part], 'miso'],
    [i.board, cs, i[part], 'cs'],
    ...power(i.board, i[part]),
  ];

  {
    const { project, ids } = buildProject(PICO, [{ key: 'flash', defId: 'comp.spi-flash' }], (i) => spiWiring(i, 'flash', 'GP17'));
    const out = await run(flashFirmware, project, { until: 'DONE' });
    check(field(out.lines, 'ID') === 'EF,40,14', `SPI flash returns its real JEDEC id (${field(out.lines, 'ID')})`);

    const log = (out.runner.spiBus as unknown as { log: { mosi: number; miso: number; selected: string[]; mode: number }[] }).log;
    check(log.length >= 4, `real bytes were clocked on the bus (${log.length})`);
    check(log[0]?.mosi === 0x9f, 'the first byte on MOSI is the command the sketch sent');
    check(log.every((e) => e.mode === 0), 'SSPCR0 reports the datasheet mode the sketch selected (mode 0)');
    check(log.slice(0, 4).every((e) => e.selected.includes(ids.flash)), 'the flash was selected for the whole transaction');

    // The active SPI pins were discovered, not assumed.
    const active = (out.runner as unknown as { activeSpiPins(): { sck?: number; mosi?: number; miso?: number } }).activeSpiPins();
    check(
      active.sck === 18 && active.mosi === 19 && active.miso === 16,
      `the SPI pins were read back from the pads (SCK GP${active.sck}, MOSI GP${active.mosi}, MISO GP${active.miso})`,
    );
  }

  {
    // Same firmware, MOSI and MISO swapped.
    const { project, ids } = buildProject(PICO, [{ key: 'flash', defId: 'comp.spi-flash' }], (i) => [
      [i.board, 'GP18', i.flash, 'sck'],
      [i.board, 'GP16', i.flash, 'mosi'],
      [i.board, 'GP19', i.flash, 'miso'],
      [i.board, 'GP17', i.flash, 'cs'],
      ...power(i.board, i.flash),
    ]);
    const out = await run(flashFirmware, project, { until: 'DONE' });
    check(field(out.lines, 'ID') !== 'EF,40,14', `swapped MOSI/MISO does not read the id (${field(out.lines, 'ID')})`);
  }

  {
    // Same firmware, SCK on a pin the bus is not using.
    const { project, ids } = buildProject(PICO, [{ key: 'flash', defId: 'comp.spi-flash' }], (i) => [
      [i.board, 'GP20', i.flash, 'sck'],
      [i.board, 'GP19', i.flash, 'mosi'],
      [i.board, 'GP16', i.flash, 'miso'],
      [i.board, 'GP17', i.flash, 'cs'],
      ...power(i.board, i.flash),
    ]);
    const out = await run(flashFirmware, project, { until: 'DONE' });
    check(field(out.lines, 'ID') !== 'EF,40,14', `a device off the clock line does not respond (${field(out.lines, 'ID')})`);
  }

  {
    // Same firmware, chip-select on the wrong pin: the sketch toggles GP17 but
    // the device listens on GP20, so it is never selected.
    const { project, ids } = buildProject(PICO, [{ key: 'flash', defId: 'comp.spi-flash' }], (i) => spiWiring(i, 'flash', 'GP20'));
    const out = await run(flashFirmware, project, { until: 'DONE' });
    check(field(out.lines, 'ID') !== 'EF,40,14', `a device whose CS is never asserted stays quiet (${field(out.lines, 'ID')})`);
    const log = (out.runner.spiBus as unknown as { log: { selected: string[] }[] }).log;
    check(log.every((e) => e.selected.length === 0), 'nothing was selected during the transfer');
  }

  {
    // Correct wiring, no power.
    const { project, ids } = buildProject(PICO, [{ key: 'flash', defId: 'comp.spi-flash' }], (i) => [
      [i.board, 'GP18', i.flash, 'sck'],
      [i.board, 'GP19', i.flash, 'mosi'],
      [i.board, 'GP16', i.flash, 'miso'],
      [i.board, 'GP17', i.flash, 'cs'],
      [i.flash, 'gnd', i.board, 'GND1'],
    ]);
    const out = await run(flashFirmware, project, { until: 'DONE' });
    check(field(out.lines, 'ID') !== 'EF,40,14', `an unpowered SPI device does not answer (${field(out.lines, 'ID')})`);
  }
}

// ---------------------------------------------------- SD card, 595, 165 ------

{
  const firmware = await compile(`#include <SPI.h>
static uint8_t CS = 17;
static uint8_t cmd(uint8_t c, uint32_t arg, uint8_t crc) {
  SPI.transfer(0x40 | c);
  SPI.transfer(arg >> 24); SPI.transfer(arg >> 16); SPI.transfer(arg >> 8); SPI.transfer(arg);
  SPI.transfer(crc);
  for (int i = 0; i < 8; i++) { uint8_t r = SPI.transfer(0xFF); if (!(r & 0x80)) return r; }
  return 0xFF;
}
void setup() {
  Serial1.begin(115200);
  pinMode(CS, OUTPUT); digitalWrite(CS, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(400000, MSBFIRST, SPI_MODE0));
  for (int i = 0; i < 10; i++) SPI.transfer(0xFF);
  digitalWrite(CS, LOW);
  Serial1.print("CMD0="); Serial1.println(cmd(0, 0, 0x95), HEX);
  digitalWrite(CS, HIGH);
  SPI.endTransaction();
  Serial1.println("DONE");
}
void loop() { delay(50); }`);
  if (!firmware) {
    skip('SD card: sketch did not compile');
  } else {
    const { project, ids } = buildProject(PICO, [{ key: 'sd', defId: 'comp.sd-card' }], (i) => [
      [i.board, 'GP18', i.sd, 'sck'],
      [i.board, 'GP19', i.sd, 'mosi'],
      [i.board, 'GP16', i.sd, 'miso'],
      [i.board, 'GP17', i.sd, 'cs'],
      ...power(i.board, i.sd),
    ]);
    const out = await run(firmware, project, { until: 'DONE' });
    check(field(out.lines, 'CMD0') === '1', `SD card enters idle state on CMD0 (R1 = 0x${field(out.lines, 'CMD0')})`);
  }
}

{
  const firmware = await compile(`#include <SPI.h>
static uint8_t LATCH = 20;
void setup() {
  Serial1.begin(115200);
  pinMode(LATCH, OUTPUT); digitalWrite(LATCH, LOW);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  SPI.transfer(0xA3);
  digitalWrite(LATCH, HIGH); digitalWrite(LATCH, LOW);
  SPI.endTransaction();
  Serial1.println("DONE");
}
void loop() { delay(50); }`);
  if (!firmware) {
    skip('74HC595: sketch did not compile');
  } else {
    const { project, ids } = buildProject(PICO, [{ key: 'sr', defId: 'comp.hc595' }], (i) => [
      [i.board, 'GP18', i.sr, 'srclk'],
      [i.board, 'GP19', i.sr, 'ser'],
      [i.board, 'GP20', i.sr, 'rclk'],
      [i.board, 'GND1', i.sr, 'oe'],
      [i.board, '3V3', i.sr, 'srclr'],
      [i.board, '3V3', i.sr, 'vcc'],
      [i.sr, 'gnd', i.board, 'GND2'],
    ]);
    let readout: string[] = [];
    const out = await run(firmware, project, {
      until: 'DONE',
      onFrame: ({ binding, controls }) => {
        const v = binding.update(controls).visuals.get(ids.sr) as { readout?: string[] } | undefined;
        if (v?.readout?.[0]?.includes('Q7')) readout = v.readout;
      },
    });
    check(
      readout[0]?.includes('10100011'),
      `74HC595 latched the byte the firmware clocked out (${JSON.stringify(readout[0] ?? 'none')})`,
    );
  }
}

{
  const firmware = await compile(`#include <SPI.h>
static uint8_t PL = 20;
void setup() {
  Serial1.begin(115200);
  pinMode(PL, OUTPUT); digitalWrite(PL, HIGH);
  SPI.begin();
  digitalWrite(PL, LOW); digitalWrite(PL, HIGH);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  Serial1.print("IN="); Serial1.println(SPI.transfer(0x00), HEX);
  SPI.endTransaction();
  Serial1.println("DONE");
}
void loop() { delay(50); }`);
  if (!firmware) {
    skip('74HC165: sketch did not compile');
  } else {
    const { project, ids } = buildProject(PICO, [{ key: 'sr', defId: 'comp.hc165' }], (i) => [
      [i.board, 'GP18', i.sr, 'cp'],
      [i.board, 'GP16', i.sr, 'qh'],
      [i.board, 'GP20', i.sr, 'pl'],
      [i.board, 'GND1', i.sr, 'ce'],
      [i.board, '3V3', i.sr, 'vcc'],
      [i.sr, 'gnd', i.board, 'GND2'],
      // A recognisable pattern on the parallel inputs: D7 and D0 high.
      [i.board, '3V3', i.sr, 'd7'],
      [i.board, '3V3', i.sr, 'd0'],
      [i.board, 'GND3', i.sr, 'd1'],
      [i.board, 'GND4', i.sr, 'd2'],
    ]);
    const out = await run(firmware, project, { until: 'DONE' });
    const value = field(out.lines, 'IN');
    check(value !== undefined && value !== 'FF' && value !== '0', `74HC165 shifted its parallel inputs in (0x${value})`);
    const parsed = Number.parseInt(value ?? '', 16);
    check(Number.isFinite(parsed) && (parsed & 0x81) === 0x81, `the pins wired high read back high (0x${value})`);
  }
}

// ============================================ 7. two SPI devices on one bus
{
  const firmware = await compile(`#include <SPI.h>
void setup() {
  Serial1.begin(115200);
  pinMode(17, OUTPUT); digitalWrite(17, HIGH);
  pinMode(20, OUTPUT); digitalWrite(20, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(17, LOW);
  SPI.transfer(0x9F);
  uint8_t a = SPI.transfer(0), b = SPI.transfer(0), c = SPI.transfer(0);
  digitalWrite(17, HIGH);
  Serial1.print("FLASH="); Serial1.print(a, HEX); Serial1.print(","); Serial1.print(b, HEX); Serial1.print(","); Serial1.println(c, HEX);
  for (int i = 0; i < 10; i++) SPI.transfer(0xFF);
  digitalWrite(20, LOW);
  SPI.transfer(0x40); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0x95);
  uint8_t r = 0xFF;
  for (int i = 0; i < 8; i++) { r = SPI.transfer(0xFF); if (!(r & 0x80)) break; }
  digitalWrite(20, HIGH);
  Serial1.print("SD="); Serial1.println(r, HEX);
  SPI.endTransaction();
  Serial1.println("DONE");
}
void loop() { delay(50); }`);
  if (!firmware) {
    skip('two SPI devices: sketch did not compile');
  } else {
    const { project, ids } = buildProject(
      PICO,
      [
        { key: 'flash', defId: 'comp.spi-flash' },
        { key: 'sd', defId: 'comp.sd-card' },
      ],
      (i) => [
        // One clock, one MOSI and one MISO, shared. Only CS differs.
        [i.board, 'GP18', i.flash, 'sck'],
        [i.board, 'GP19', i.flash, 'mosi'],
        [i.board, 'GP16', i.flash, 'miso'],
        [i.board, 'GP17', i.flash, 'cs'],
        [i.board, 'GP18', i.sd, 'sck'],
        [i.board, 'GP19', i.sd, 'mosi'],
        [i.board, 'GP16', i.sd, 'miso'],
        [i.board, 'GP20', i.sd, 'cs'],
        ...power(i.board, i.flash),
        ...power(i.board, i.sd, 'GND2'),
      ],
    );
    const out = await run(firmware, project, { until: 'DONE', simMs: 2000 });
    check(field(out.lines, 'FLASH') === 'EF,40,14', `the flash answers when its CS is low (${field(out.lines, 'FLASH')})`);
    check(field(out.lines, 'SD') === '1', `the SD card answers when its CS is low (0x${field(out.lines, 'SD')})`);

    const log = (out.runner.spiBus as unknown as { log: { selected: string[]; contention?: boolean }[] }).log;
    const both = log.filter((e) => e.selected.length > 1).length;
    check(both === 0, `the two devices are never selected at once (${both} contended transfers)`);
    check(
      log.some((e) => e.selected.includes(ids.flash)) && log.some((e) => e.selected.includes(ids.sd)),
      'both devices took part in the same run',
    );
    const idle = log.filter((e) => e.selected.length === 0).length;
    check(idle > 0, `the bus idles between transactions with nothing selected (${idle} idle transfers)`);
  }
}

// ================================================= 8. the Pico W, same silicon
{
  const firmware = await compile(EEPROM_SKETCH, PICO_W, 'rp2040:rp2040:rpipicow');
  if (!firmware) {
    skip('Pico W: sketch did not compile');
  } else {
    const { project, ids } = buildProject(PICO_W, [{ key: 'eeprom', defId: 'comp.eeprom-24c' }], (i) => [
      [i.board, 'GP4', i.eeprom, 'sda'],
      [i.board, 'GP5', i.eeprom, 'scl'],
      ...power(i.board, i.eeprom),
    ]);
    const out = await run(firmware, project, { until: 'DONE', boardId: PICO_W });
    check(field(out.lines, 'R') === 'A5', `the Pico W drives the same bus and devices (read back 0x${field(out.lines, 'R')})`);
    check(out.runner.engine === 'rp2040js', 'the Pico W runs on the RP2040 engine');
  }
}

// ================================================== 9. no AVR fallback, ever
{
  check(getSimulatorAdapter(picoBoard)?.engine === 'rp2040js', 'the Pico still resolves only to the RP2040 adapter');
  const uno = getBoardDefinition('board.arduino-uno')!;
  // An adapter claims PROCESSORS, not board ids — a board is matched to an
  // engine through the chip on it, which is what lets a board nobody added
  // reach the right emulator. The AVR adapter must never claim the RP2040.
  check(
    !getSimulatorAdapter(uno)?.processorProfileIds.includes('proc.rp2040'),
    'the AVR adapter does not claim the RP2040',
  );
  check(
    getSimulatorAdapter(picoBoard)?.processorProfileIds.includes('proc.rp2040') === true,
    'and the RP2040 adapter claims it by the chip rather than by the board',
  );
  // The RP2040 default bus pins are GP numbers, not Arduino pin numbers.
  check(ARDUINO_PICO_DEFAULT_I2C.sda === 4 && ARDUINO_PICO_DEFAULT_I2C.scl === 5, 'the documented I2C default is GP4/GP5');
  check(
    ARDUINO_PICO_DEFAULT_SPI.sck === 18 && ARDUINO_PICO_DEFAULT_SPI.mosi === 19 && ARDUINO_PICO_DEFAULT_SPI.miso === 16,
    'the documented SPI default is GP18/GP19/GP16',
  );
  check(picoBoard.metadata.i2cPins === undefined, 'the Pico does not carry an AVR-style static i2cPins list');
}

finish();
