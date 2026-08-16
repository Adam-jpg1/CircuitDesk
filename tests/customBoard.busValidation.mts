// Bus validation on a board CircuitDesk has never seen, in the maker's words.
//
// The rule this proves is the whole point of the custom-board milestone applied
// to one feature: a board somebody designed last week gets the SAME I2C, SPI
// and UART advice a Raspberry Pi Pico gets, derived the same way, with no entry
// anywhere that names their board.
//
// It is worth being precise about what "the same way" means, because the naive
// version does not work. The capability tables are written in PADS — GP4, PC5 —
// because pads are what the silicon has. A Pico's pins are also called GP4, so
// for years the check could get away with treating the two as one thing. On a
// board whose maker printed SENSOR_SDA next to that pad, they are not one
// thing, and every message that names a pad is a message the user cannot act
// on. So the resolution runs through the board's own pin map, and the messages
// say `MOTOR_PWM (GP15)` — the name on the silkscreen, and the pad it stands
// for so the advice can be checked against a datasheet.
//
// Two boards here, deliberately different in ROUTING as well as in name: an
// RP2040 whose lines are muxable, and an ATmega328P whose lines are bonded. The
// same code path serves both, out of their processor profiles.

import { validateProject } from '../src/validation/validator';
import { emptyProject } from '../src/project/templates';
import { embedBoard } from '../src/custom-boards/projectBoards';
import { validateCustomBoard, isError } from '../src/custom-boards/validate';
import { resolveCustomBoard } from '../src/custom-boards/resolve';
import { getBoardBusProfile, classifyBusPin, describeBusPin } from '../src/boards/busProfile';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition } from '../src/custom-boards/schema';
import type { CircuitProject, ComponentInstance, ValidationIssue } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

// ------------------------------------------------------------ the two boards

/** A muxable part: an RP2040, wired to a maker's own names. */
const ROBOT: CustomBoardDefinition = {
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.robot-controller',
  revision: 1,
  identity: { name: 'Robot Controller', creator: 'Bench Robotics' },
  outline: { widthMm: 50, heightMm: 60, color: '#123f5e' },
  pins: [
    { id: 'V5', label: '5V', pad: null, xMm: 3, yMm: 4, type: 'power-5v', capabilities: [], voltage: 5 },
    { id: 'V3', label: '3V3', pad: null, xMm: 3, yMm: 9, type: 'power-3v3', capabilities: [], voltage: 3.3 },
    { id: 'GND', label: 'GND', pad: null, xMm: 3, yMm: 14, type: 'ground', capabilities: [] },
    // I2C, on the pads the Arduino-Pico core starts Wire on.
    { id: 'SENSOR_SDA', label: 'SENSOR_SDA', pad: 'GP4', xMm: 3, yMm: 19, type: 'digital', capabilities: [] },
    { id: 'SENSOR_SCL', label: 'SENSOR_SCL', pad: 'GP5', xMm: 3, yMm: 24, type: 'digital', capabilities: [] },
    // The same controller, different pads: legal, but firmware has to say so.
    { id: 'AUX_SDA', label: 'AUX_SDA', pad: 'GP8', xMm: 3, yMm: 29, type: 'digital', capabilities: [] },
    { id: 'AUX_SCL', label: 'AUX_SCL', pad: 'GP9', xMm: 3, yMm: 34, type: 'digital', capabilities: [] },
    // The OTHER I2C controller, for the split-bus case.
    { id: 'EXP_SCL', label: 'EXP_SCL', pad: 'GP3', xMm: 3, yMm: 39, type: 'digital', capabilities: [] },
    // Not an I2C pad at all, and the pin the spec's example wires an OLED to.
    { id: 'MOTOR_PWM', label: 'MOTOR_PWM', pad: 'GP15', xMm: 47, yMm: 19, type: 'digital', capabilities: [] },
    // SPI, on the core's defaults.
    { id: 'SD_MISO', label: 'SD_MISO', pad: 'GP16', xMm: 47, yMm: 24, type: 'digital', capabilities: [] },
    { id: 'SD_CS', label: 'SD_CS', pad: 'GP17', xMm: 47, yMm: 29, type: 'digital', capabilities: [] },
    { id: 'SD_SCK', label: 'SD_SCK', pad: 'GP18', xMm: 47, yMm: 34, type: 'digital', capabilities: [] },
    { id: 'SD_MOSI', label: 'SD_MOSI', pad: 'GP19', xMm: 47, yMm: 39, type: 'digital', capabilities: [] },
    // Serial1's defaults.
    { id: 'TELEM_TX', label: 'TELEM_TX', pad: 'GP0', xMm: 47, yMm: 44, type: 'digital', capabilities: [] },
    { id: 'TELEM_RX', label: 'TELEM_RX', pad: 'GP1', xMm: 47, yMm: 49, type: 'digital', capabilities: [] },
  ],
  processorProfileId: 'proc.rp2040',
  compileProfileId: 'compile.rp2040-arduino',
  runtimeProfileId: 'runtime.rp2040js',
};

/** A bonded part: an ATmega328P, likewise renamed. */
const SENSOR_NODE: CustomBoardDefinition = {
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.sensor-node',
  revision: 1,
  identity: { name: 'Sensor Node', creator: 'Bench Robotics' },
  outline: { widthMm: 30, heightMm: 40, color: '#2b4d2b' },
  pins: [
    { id: 'V5', label: '5V', pad: null, xMm: 3, yMm: 4, type: 'power-5v', capabilities: [], voltage: 5 },
    { id: 'GND', label: 'GND', pad: null, xMm: 3, yMm: 9, type: 'ground', capabilities: [] },
    { id: 'I2C_DATA', label: 'I2C_DATA', pad: 'PC4', xMm: 3, yMm: 14, type: 'digital', capabilities: [] },
    { id: 'I2C_CLK', label: 'I2C_CLK', pad: 'PC5', xMm: 3, yMm: 19, type: 'digital', capabilities: [] },
    { id: 'RELAY', label: 'RELAY', pad: 'PD4', xMm: 27, yMm: 14, type: 'digital', capabilities: [] },
    { id: 'LAMP', label: 'LAMP', pad: 'PB5', xMm: 27, yMm: 19, type: 'digital', capabilities: [] },
    { id: 'DBG_TX', label: 'DBG_TX', pad: 'PD1', xMm: 27, yMm: 24, type: 'digital', capabilities: [] },
    { id: 'DBG_RX', label: 'DBG_RX', pad: 'PD0', xMm: 27, yMm: 29, type: 'digital', capabilities: [] },
  ],
  processorProfileId: 'proc.atmega328p',
  compileProfileId: 'compile.avr-arduino',
  runtimeProfileId: 'runtime.avr8js-328p',
};

// ------------------------------------------------------------------ harness

interface Wire { from: string; fromPin: string; to: string; toPin: string }

function projectWith(
  board: CustomBoardDefinition,
  parts: { id: string; definitionId: string }[],
  wires: Wire[],
): CircuitProject {
  const project = emptyProject('custom-bus-validation');
  embedBoard(project, board);
  project.boardInstances.push({
    id: 'board1', definitionId: board.id, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  } as ComponentInstance);
  for (const p of parts) {
    project.componentInstances.push({
      id: p.id, definitionId: p.definitionId, x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
    } as ComponentInstance);
  }
  for (const w of wires) {
    project.connections.push({
      id: uid('w'), sourceComponentId: w.from, sourcePinId: w.fromPin,
      targetComponentId: w.to, targetPinId: w.toPin,
      netId: '', color: '#888', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }
  return project;
}

const BUS_RULES = [
  'i2c-pins', 'bus-pins-need-config', 'bus-pins-split-controller',
  'uart-pins', 'uart-pins-need-config',
];
const busIssues = (project: CircuitProject): ValidationIssue[] =>
  validateProject(project).filter((i) => BUS_RULES.includes(i.ruleId));
const text = (issues: ValidationIssue[]) =>
  issues.map((i) => `${i.title} | ${i.description} | ${i.suggestedFix ?? ''}`).join('\n');

/** An I2C LCD wired to two chosen board pins, plus power. */
function lcdOn(sda: string, scl: string): { parts: { id: string; definitionId: string }[]; wires: Wire[] } {
  return {
    parts: [{ id: 'lcd', definitionId: 'comp.lcd1602' }],
    wires: [
      { from: 'lcd', fromPin: 'sda', to: 'board1', toPin: sda },
      { from: 'lcd', fromPin: 'scl', to: 'board1', toPin: scl },
      { from: 'lcd', fromPin: 'gnd', to: 'board1', toPin: 'GND' },
      { from: 'lcd', fromPin: 'vcc', to: 'board1', toPin: 'V5' },
    ],
  };
}

// ============================ 1. the profile comes out of the pad map ========
section('1. a custom board has a bus profile, built from its processor and its pad map');
{
  for (const definition of [ROBOT, SENSOR_NODE]) {
    const { problems } = validateCustomBoard(definition);
    check(
      problems.filter(isError).length === 0,
      `${definition.identity.name} is a valid board${problems.filter(isError).map((p) => ` — ${p.message}`).join('')}`,
    );
  }

  const robot = getBoardBusProfile(resolveCustomBoard(ROBOT).board);
  check(robot !== undefined, 'the Robot Controller has a bus profile at all');
  check(robot?.routing === 'muxable', `and knows its lines are muxable (${robot?.routing})`);
  check(
    robot?.channels.some((c) => c.name === 'Wire') === true,
    'with a channel named the way a sketch names it',
  );

  // The decisive assertion: the channel lists the MAKER's pin, not the pad.
  const wire = robot?.channels.find((c) => c.name === 'Wire');
  check(
    wire?.pins['i2c-sda']?.includes('SENSOR_SDA') === true,
    `Wire's SDA pins are the board's own (${wire?.pins['i2c-sda']?.join(', ')})`,
  );
  check(
    wire?.pins['i2c-sda']?.includes('GP4') === false,
    'and not the pads, which are not pins on this board',
  );
  check(
    wire?.defaults['i2c-sda'] === 'SENSOR_SDA' && wire?.defaults['i2c-scl'] === 'SENSOR_SCL',
    `the core's default SDA/SCL land on this board's own pins (${wire?.defaults['i2c-sda']}/${wire?.defaults['i2c-scl']})`,
  );

  const node = getBoardBusProfile(resolveCustomBoard(SENSOR_NODE).board);
  check(node?.routing === 'fixed', `the ATmega328P board knows its lines are bonded (${node?.routing})`);
  const twi = node?.channels.find((c) => c.name === 'Wire');
  check(
    twi?.defaults['i2c-sda'] === 'I2C_DATA' && twi?.defaults['i2c-scl'] === 'I2C_CLK',
    `and that TWI reaches its I2C_DATA/I2C_CLK (${twi?.defaults['i2c-sda']}/${twi?.defaults['i2c-scl']})`,
  );

  // Native boards are untouched by any of this: they carry no pad map, so a
  // message about them says GP4, exactly as before.
  check(describeBusPin(robot!, 'MOTOR_PWM') === 'MOTOR_PWM (GP15)', 'a custom pin is described with its pad');
  check(describeBusPin(robot!, 'GND') === 'GND', 'and a pin with no pad is described plainly');
}

// ================================ 2. correct wiring validates clean ==========
section('2. an I2C device on the maker\'s I2C pins is simply correct');
{
  const { parts, wires } = lcdOn('SENSOR_SDA', 'SENSOR_SCL');
  const issues = busIssues(projectWith(ROBOT, parts, wires));
  check(issues.length === 0, `no bus complaints (${issues.length})${issues.length ? `\n${text(issues)}` : ''}`);
}

// ============================== 3. the spec's example, word for word =========
section('3. an I2C device on MOTOR_PWM is an error that names MOTOR_PWM');
{
  const { parts, wires } = lcdOn('MOTOR_PWM', 'SENSOR_SCL');
  const issues = busIssues(projectWith(ROBOT, parts, wires));
  const body = text(issues);
  check(issues.length >= 1, `the mistake is caught (${issues.length})`);
  check(body.includes('MOTOR_PWM (GP15)'), `and names the pin the maker printed, with its pad\n   ${body.split('\n')[0]}`);
  check(body.includes('Robot Controller'), 'and the board by its own name');
  check(body.includes('SENSOR_SDA (GP4)'), 'while the suggestion is also in the maker\'s words');
  check(!/\bA4\b|\bA5\b/.test(body), 'with no Arduino Uno pin anywhere in it');
  check(
    issues.some((i) => i.ruleId === 'i2c-pins' && i.severity === 'warning'),
    'reported as a wiring error, not as a note',
  );
}

// ==================================== 4. an alternate pad is not an error =====
section('4. an I2C device on an alternate pad is information, with the call that makes it work');
{
  const { parts, wires } = lcdOn('AUX_SDA', 'AUX_SCL');
  const issues = busIssues(projectWith(ROBOT, parts, wires));
  const body = text(issues);
  check(issues.length === 2, `both lines are noted (${issues.length})`);
  check(issues.every((i) => i.severity === 'info'), 'as information — the circuit can work');
  check(body.includes('AUX_SDA (GP8)'), 'named as the maker named them');
  check(
    body.includes('Wire.setSDA(8)') && body.includes('Wire.setSCL(9)'),
    'and the fix is the call, with the PAD number the call actually takes',
  );
  check(body.includes('SENSOR_SDA (GP4)'), 'while naming the default it is an alternative to');
}

// ============================ 5. two controllers is still not one bus ========
section('5. SDA and SCL on different I2C controllers is caught on a custom board too');
{
  const { parts, wires } = lcdOn('SENSOR_SDA', 'EXP_SCL');
  const issues = busIssues(projectWith(ROBOT, parts, wires));
  const split = issues.filter((i) => i.ruleId === 'bus-pins-split-controller');
  check(split.length === 1, `the split bus is reported once (${split.length})`);
  check(
    split[0]?.description.includes('SENSOR_SDA (GP4)') && split[0]?.description.includes('EXP_SCL (GP3)'),
    `naming both pins as the maker did\n   ${split[0]?.description}`,
  );
  check(
    (split[0]?.suggestedFix ?? '').includes('Wire (SENSOR_SDA (GP4)/SENSOR_SCL (GP5))'),
    `and offering a pair on one controller\n   ${split[0]?.suggestedFix}`,
  );
}

// ======================================= 6. SPI, by the same derivation ======
section('6. SPI is validated from the same profiles');
{
  const spiParts = [{ id: 'sd', definitionId: 'comp.sd-card' }];
  const spiWires = (sck: string, mosi: string, miso: string, cs: string): Wire[] => [
    { from: 'sd', fromPin: 'sck', to: 'board1', toPin: sck },
    { from: 'sd', fromPin: 'mosi', to: 'board1', toPin: mosi },
    { from: 'sd', fromPin: 'miso', to: 'board1', toPin: miso },
    { from: 'sd', fromPin: 'cs', to: 'board1', toPin: cs },
    { from: 'sd', fromPin: 'gnd', to: 'board1', toPin: 'GND' },
    { from: 'sd', fromPin: 'vcc', to: 'board1', toPin: 'V5' },
  ];

  const good = busIssues(projectWith(ROBOT, spiParts, spiWires('SD_SCK', 'SD_MOSI', 'SD_MISO', 'SD_CS')));
  check(good.length === 0, `the card on the SPI pins is clean (${good.length})${good.length ? `\n${text(good)}` : ''}`);

  // GP15 carries SPI1's MOSI but never a clock, so a clock there is a real
  // error — and the message has to be about MOTOR_PWM, not about GP15.
  const bad = busIssues(projectWith(ROBOT, spiParts, spiWires('MOTOR_PWM', 'SD_MOSI', 'SD_MISO', 'SD_CS')));
  const body = text(bad);
  check(bad.some((i) => i.severity === 'warning'), `a clock on MOTOR_PWM is an error (${bad.length})`);
  check(body.includes('MOTOR_PWM (GP15)') && body.includes('SCK'), `named in the maker's words\n   ${body.split('\n')[0]}`);
  check(body.includes('SD_SCK (GP18)'), 'with the board\'s real clock pin offered instead');
}

// ============================================ 7. UART, likewise ==============
section('7. serial lines are checked against the board\'s own UART pads');
{
  const gps = [{ id: 'gps', definitionId: 'comp.gps' }];
  const gpsWires = (tx: string, rx: string): Wire[] => [
    { from: 'gps', fromPin: 'tx', to: 'board1', toPin: rx },
    { from: 'gps', fromPin: 'rx', to: 'board1', toPin: tx },
    { from: 'gps', fromPin: 'gnd', to: 'board1', toPin: 'GND' },
    { from: 'gps', fromPin: 'vcc', to: 'board1', toPin: 'V5' },
  ];

  const good = busIssues(projectWith(ROBOT, gps, gpsWires('TELEM_TX', 'TELEM_RX')));
  check(good.length === 0, `crossed onto Serial1's own pins, nothing to say (${good.length})${good.length ? `\n${text(good)}` : ''}`);

  // The device's TX has to reach a pad the UART can receive on. MOTOR_PWM is
  // not one, and on an RP2040 that is worth knowing but is not fatal — a
  // software serial port drives any pin.
  const wrong = busIssues(projectWith(ROBOT, gps, gpsWires('TELEM_TX', 'MOTOR_PWM')));
  const body = text(wrong);
  check(wrong.length >= 1, `a serial line on a non-UART pad is reported (${wrong.length})`);
  check(wrong.every((i) => i.severity === 'info'), 'as information, because software serial exists');
  check(body.includes('MOTOR_PWM (GP15)'), `naming the maker's pin\n   ${body.split('\n')[0]}`);
  check(body.includes('software serial'), 'and saying what the usual answer is');
  check(body.includes('TELEM_RX (GP1)'), 'while pointing at the hardware RX pin');
}

// ================================= 8. the bonded board, same treatment =======
section('8. the ATmega328P board gets the same derivation with a different verdict');
{
  const correct = lcdOn('I2C_DATA', 'I2C_CLK');
  const clean = busIssues(projectWith(SENSOR_NODE, correct.parts, correct.wires));
  check(clean.length === 0, `TWI's own pins are correct (${clean.length})${clean.length ? `\n${text(clean)}` : ''}`);

  const { parts, wires } = lcdOn('RELAY', 'I2C_CLK');
  const issues = busIssues(projectWith(SENSOR_NODE, parts, wires));
  const body = text(issues);
  check(issues.some((i) => i.severity === 'warning'), `SDA on RELAY is an error (${issues.length})`);
  check(body.includes('RELAY (PD4)'), `named for the maker's pin and its AVR pad\n   ${body.split('\n')[0]}`);
  check(body.includes('I2C_DATA (PC4)'), 'with the board\'s real SDA offered');
  check(
    issues.some((i) => (i.why ?? '').includes('bonded')),
    'and the reason given is that AVR TWI cannot move',
  );
  check(!body.includes('setSDA'), 'no firmware call is suggested, because there is none to make');
}

// ================================== 9. nothing here knows any board's name ===
section('9. the derivation names no board, native or custom');
{
  const profile = getBoardBusProfile(resolveCustomBoard(ROBOT).board)!;
  check(
    classifyBusPin(profile, 'i2c-sda', 'SENSOR_SDA').kind === 'default',
    'the custom board reaches a verdict through its processor profile alone',
  );
  const source = await import('node:fs').then((fs) => fs.readFileSync('src/boards/busProfile.ts', 'utf8'));
  check(
    !/board\.id\s*===/.test(source) && !source.includes('board.raspberry-pi-pico') && !source.includes('board.arduino-uno'),
    'and the bus profile source contains no board-id comparison of any kind',
  );
}

console.log(failures === 0 ? '\nCustom-board bus validation checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
