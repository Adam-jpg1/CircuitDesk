// Validation that knows which board it is talking about.
//
// The bug this covers: a Raspberry Pi Pico with an I2C LCD on GP4/GP5 — the
// Pico core's own default SDA/SCL — was told "SDA not on an I2C-capable pin",
// "SDA should connect to the board's SDA (A4) pin", "Fix: Move this wire to
// A4/SDA". Three wrong statements about a correct circuit, all because the
// check had one board's pinout compiled into it.
//
// So these tests are not about the LCD. They are about whether validation goes
// through the board instance's own capability profile, which means:
//
//   * the Uno's fixed A4/A5 still validate,
//   * the Pico's GP4/GP5 validate, on the Pico's authority and not the Uno's,
//   * a genuinely wrong Pico pin is still caught, and named in Pico terms,
//   * two board families on one canvas each get their own verdict,
//   * and when the board is known, nothing ever falls back to Arduino pins.

import { validateProject } from '../src/validation/validator';
import { getBoardDefinition } from '../src/boards/definitions';
import {
  getBoardBusProfile,
  classifyBusPin,
  channelsCarryingAll,
  suggestedPinsFor,
} from '../src/boards/busProfile';
import { emptyProject } from '../src/project/templates';
import type { CircuitProject, ComponentInstance, ValidationIssue } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const UNO = 'board.arduino-uno';
const PICO = 'board.raspberry-pi-pico';
const MEGA = 'board.arduino-mega2560';
const C6 = 'board.esp32-c6-devkitc-1';

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

interface Placement {
  boards: { id: string; definitionId: string }[];
  parts: { id: string; definitionId: string }[];
  wires: [string, string, string, string][];
}

function projectOf(p: Placement): CircuitProject {
  const project = emptyProject('bus-pin-validation');
  for (const b of p.boards) {
    project.boardInstances.push({
      id: b.id, definitionId: b.definitionId, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
    } as ComponentInstance);
  }
  for (const c of p.parts) {
    project.componentInstances.push({
      id: c.id, definitionId: c.definitionId, x: 200, y: 0, rotation: 0, properties: {}, simulationState: {},
    } as ComponentInstance);
  }
  for (const [a, ap, b, bp] of p.wires) {
    project.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#888', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }
  return project;
}

/** Issues from the bus-pin rules only — the rest of the validator is elsewhere. */
const BUS_RULES = ['i2c-pins', 'bus-pins-need-config', 'bus-pins-split-controller', 'uart-pins'];
const busIssues = (project: CircuitProject): ValidationIssue[] =>
  validateProject(project).filter((i) => BUS_RULES.includes(i.ruleId));

const text = (issues: ValidationIssue[]) =>
  issues.map((i) => `${i.title} | ${i.description} | ${i.suggestedFix ?? ''}`).join('\n');

/** An LCD wired for power and I2C to one board's chosen pins. */
function lcdOn(boardId: string, boardDefId: string, sdaPin: string, sclPin: string, gnd: string, vcc: string) {
  const lcd = uid('lcd');
  return {
    lcd,
    placement: {
      boards: [{ id: boardId, definitionId: boardDefId }],
      parts: [{ id: lcd, definitionId: 'comp.lcd1602' }],
      wires: [
        [lcd, 'sda', boardId, sdaPin],
        [lcd, 'scl', boardId, sclPin],
        [lcd, 'gnd', boardId, gnd],
        [lcd, 'vcc', boardId, vcc],
      ] as [string, string, string, string][],
    },
  };
}

// ================================================== 1. the profiles themselves
{
  const uno = getBoardBusProfile(getBoardDefinition(UNO));
  const pico = getBoardBusProfile(getBoardDefinition(PICO));
  const mega = getBoardBusProfile(getBoardDefinition(MEGA));
  const c6 = getBoardBusProfile(getBoardDefinition(C6));

  check(uno?.routing === 'fixed', `the Uno's buses are bonded silicon (${uno?.routing})`);
  check(pico?.routing === 'muxable', `the Pico's can be muxed (${pico?.routing})`);
  check(c6?.routing === 'matrix', `and the C6's go through a GPIO matrix (${c6?.routing})`);

  check(classifyBusPin(uno!, 'i2c-sda', 'A4').kind === 'default', 'A4 is the Uno\'s default SDA');
  check(classifyBusPin(uno!, 'i2c-scl', 'A5').kind === 'default', 'and A5 its default SCL');
  check(classifyBusPin(uno!, 'i2c-sda', 'D7').kind === 'incapable', 'D7 cannot be the Uno\'s SDA');
  // A4 and the dedicated SDA header pin are the same pad brought out twice.
  // Neither is an "alternate" needing configuration, because there is nothing
  // to configure — the TWI line is bonded to that pad.
  check(classifyBusPin(uno!, 'i2c-sda', 'SDA').kind === 'default', 'and the Uno\'s dedicated SDA pin is equally the default');
  check(classifyBusPin(uno!, 'i2c-scl', 'SCL').kind === 'default', 'as is its SCL pin');

  // The heart of the reported bug, asserted directly.
  check(classifyBusPin(pico!, 'i2c-sda', 'GP4').kind === 'default', 'GP4 is the Pico core\'s default SDA');
  check(classifyBusPin(pico!, 'i2c-scl', 'GP5').kind === 'default', 'and GP5 its default SCL');
  check(classifyBusPin(pico!, 'i2c-sda', 'A4').kind === 'incapable', 'the Pico has no A4 to offer');

  const alt = classifyBusPin(pico!, 'i2c-sda', 'GP0');
  check(alt.kind === 'alternate', `GP0 is a valid but non-default Pico SDA (${alt.kind})`);
  check(
    alt.kind === 'alternate' && alt.configuration === 'Wire.setSDA(0)',
    `and the fix names the call that selects it (${alt.kind === 'alternate' ? alt.configuration : '-'})`,
  );
  check(classifyBusPin(pico!, 'i2c-sda', 'GP1').kind === 'incapable', 'GP1 is an SCL pad, so it cannot be SDA');
  check(classifyBusPin(pico!, 'i2c-scl', 'GP1').kind === 'alternate', 'though it is a perfectly good SCL');

  // Alternates belong to a controller, and both halves must be on the same one.
  check(
    channelsCarryingAll(pico!, [{ line: 'i2c-sda', pinId: 'GP4' }, { line: 'i2c-scl', pinId: 'GP5' }]).length === 1,
    'GP4/GP5 are one I2C controller',
  );
  check(
    channelsCarryingAll(pico!, [{ line: 'i2c-sda', pinId: 'GP4' }, { line: 'i2c-scl', pinId: 'GP3' }]).length === 0,
    'GP4 with GP3 are two different ones, so they are not a bus',
  );

  check(classifyBusPin(mega!, 'i2c-sda', 'D20').kind === 'default', 'the Mega\'s SDA is D20');
  check(classifyBusPin(mega!, 'i2c-sda', 'A4').kind === 'incapable', 'and not A4, which is the Uno\'s');

  // The C6's matrix genuinely can put I2C anywhere it brings a GPIO out.
  check(classifyBusPin(c6!, 'i2c-sda', 'IO23').kind === 'default', 'IO23 is the C6 variant\'s default SDA');
  check(classifyBusPin(c6!, 'i2c-sda', 'IO2').kind === 'alternate', 'and the matrix can move it to IO2');
  check(classifyBusPin(c6!, 'i2c-sda', 'IO14').kind === 'incapable', 'but not to a pad the board does not bring out');

  // Suggestions must be this board's own pins, never another board's.
  check(suggestedPinsFor(pico!, 'i2c-sda').every((p) => p.startsWith('GP')), `Pico SDA suggestions are GP pins (${suggestedPinsFor(pico!, 'i2c-sda').join(', ')})`);
  check(suggestedPinsFor(pico!, 'i2c-sda')[0] === 'GP4', 'and lead with the default');
  check(suggestedPinsFor(uno!, 'i2c-sda')[0] === 'A4', 'while the Uno\'s lead with A4');
}

// ============================================ 2. Uno with an LCD on A4/A5: fine
{
  const board = uid('b');
  const { placement } = lcdOn(board, UNO, 'A4', 'A5', 'GND1', '5V');
  const issues = busIssues(projectOf(placement));
  check(issues.length === 0, `an Uno LCD on A4/A5 raises nothing (${issues.length}: ${text(issues)})`);

  // The same board wired to the dedicated SDA/SCL header pins instead. Same
  // silicon, same verdict — nothing to say.
  const alt = uid('b');
  const viaHeader = lcdOn(alt, UNO, 'SDA', 'SCL', 'GND1', '5V');
  const headerIssues = busIssues(projectOf(viaHeader.placement));
  check(headerIssues.length === 0, `and so does the SDA/SCL header pair (${headerIssues.length}: ${text(headerIssues)})`);
}

// ======================================= 3. Pico with an LCD on GP4/GP5: fine
//
// The exact circuit that was wrongly rejected.
{
  const board = uid('b');
  const { placement } = lcdOn(board, PICO, 'GP4', 'GP5', 'GND1', '3V3');
  const issues = busIssues(projectOf(placement));
  check(issues.length === 0, `a Pico LCD on GP4/GP5 raises nothing (${issues.length}: ${text(issues)})`);
  const all = validateProject(projectOf(placement));
  check(
    !all.some((i) => /\bA4\b|\bA5\b/.test(`${i.title} ${i.description} ${i.suggestedFix ?? ''}`)),
    'and nothing anywhere mentions A4 or A5 to a Pico user',
  );
}

// ============================== 4. Pico with an LCD on pins that cannot do it
{
  const board = uid('b');
  // GP1 is an I2C0 SCL pad and GP7 an I2C1 SCL pad — neither can be SDA.
  const { lcd, placement } = lcdOn(board, PICO, 'GP1', 'GP7', 'GND1', '3V3');
  const issues = busIssues(projectOf(placement));
  check(issues.length > 0, `a Pico LCD with SDA on GP1 is reported (${issues.length})`);
  const body = text(issues);
  check(/Raspberry Pi Pico/.test(body), 'the message names the actual board');
  check(/GP1/.test(body), 'and the actual pin');
  check(!/\bA4\b|\bA5\b/.test(body), `and never mentions A4/A5 (${body})`);
  check(/GP4/.test(body), 'while suggesting a pin the Pico really has');
  check(issues.every((i) => i.affectedComponentIds.includes(lcd)), 'and points at the LCD');
  check(
    issues.some((i) => i.affectedConnectionIds.length > 0),
    'and at the wire that is wrong',
  );
}

// ========================= 5. Pico LCD on a valid but non-default pin pair
{
  const board = uid('b');
  // GP8/GP9 are I2C0 SDA/SCL — legal, one controller, but not the defaults.
  const { placement } = lcdOn(board, PICO, 'GP8', 'GP9', 'GND1', '3V3');
  const issues = busIssues(projectOf(placement));
  check(issues.length === 2, `both lines are flagged as alternates (${issues.length})`);
  check(issues.every((i) => i.severity === 'info'), 'as information, not as errors — the circuit can work');
  const body = text(issues);
  check(/Wire\.setSDA\(8\)/.test(body), `and the fix is the call that makes it work (${body.slice(0, 160)})`);
  check(/Wire\.setSCL\(9\)/.test(body), 'for both lines');
  check(!/A4|A5/.test(body), 'still with no Arduino pins in sight');
}

// ============ 6. Pico LCD split across two I2C controllers: capable, but wrong
{
  const board = uid('b');
  // GP4 is I2C0 SDA and GP3 is I2C1 SCL. Each pad is I2C-capable; together they
  // are not a bus. Checking the pins one at a time cannot see this.
  const { placement } = lcdOn(board, PICO, 'GP4', 'GP3', 'GND1', '3V3');
  const issues = busIssues(projectOf(placement));
  const split = issues.filter((i) => i.ruleId === 'bus-pins-split-controller');
  check(split.length === 1, `the split bus is reported once (${issues.length} issue(s), ${split.length} split)`);
  check(/different I2C controllers/i.test(split[0]?.title ?? ''), `and says so (${split[0]?.title})`);
  check(/Wire \(GP4\/GP5\)/.test(split[0]?.suggestedFix ?? ''), `offering a pair that works (${split[0]?.suggestedFix})`);
  check(
    issues.every((i) => i.ruleId !== 'i2c-pins'),
    'and does not also claim either pin is incapable, because neither is',
  );
}

// ================== 7. two board families on one canvas, each judged as itself
{
  const uno = uid('b');
  const pico = uid('b');
  const unoLcd = uid('lcd');
  const picoLcd = uid('lcd');
  const project = projectOf({
    boards: [{ id: uno, definitionId: UNO }, { id: pico, definitionId: PICO }],
    parts: [{ id: unoLcd, definitionId: 'comp.lcd1602' }, { id: picoLcd, definitionId: 'comp.lcd1602' }],
    wires: [
      // Correct on each board, by that board's own rules.
      [unoLcd, 'sda', uno, 'A4'], [unoLcd, 'scl', uno, 'A5'],
      [unoLcd, 'gnd', uno, 'GND1'], [unoLcd, 'vcc', uno, '5V'],
      [picoLcd, 'sda', pico, 'GP4'], [picoLcd, 'scl', pico, 'GP5'],
      [picoLcd, 'gnd', pico, 'GND1'], [picoLcd, 'vcc', pico, '3V3'],
    ],
  });
  const issues = busIssues(project);
  check(issues.length === 0, `both boards' correct wiring passes together (${issues.length}: ${text(issues)})`);

  // Now break only the Pico's, and check the Uno's LCD is not implicated.
  const broken = projectOf({
    boards: [{ id: uno, definitionId: UNO }, { id: pico, definitionId: PICO }],
    parts: [{ id: unoLcd, definitionId: 'comp.lcd1602' }, { id: picoLcd, definitionId: 'comp.lcd1602' }],
    wires: [
      [unoLcd, 'sda', uno, 'A4'], [unoLcd, 'scl', uno, 'A5'],
      [unoLcd, 'gnd', uno, 'GND1'], [unoLcd, 'vcc', uno, '5V'],
      [picoLcd, 'sda', pico, 'GP1'], [picoLcd, 'scl', pico, 'GP5'],
      [picoLcd, 'gnd', pico, 'GND1'], [picoLcd, 'vcc', pico, '3V3'],
    ],
  });
  const brokenIssues = busIssues(broken);
  check(brokenIssues.length > 0, `the Pico's mistake is caught (${brokenIssues.length})`);
  check(
    brokenIssues.every((i) => i.affectedComponentIds.includes(picoLcd)),
    'and only the Pico\'s LCD is implicated',
  );
  check(
    brokenIssues.every((i) => !i.affectedComponentIds.includes(unoLcd)),
    'the Uno\'s LCD is untouched by its neighbour\'s problem',
  );
  check(
    /Raspberry Pi Pico/.test(text(brokenIssues)) && !/Arduino Uno/.test(text(brokenIssues)),
    `and the message names the Pico, not the Uno (${text(brokenIssues).slice(0, 140)})`,
  );
}

// ======================= 8. no Arduino fallback anywhere the board is known
//
// The failure mode was structural: with no model of the board, the only pins
// the checker could name were the ones written into it. This sweeps every
// simulated non-AVR board with a deliberately wrong LCD and insists nothing
// Arduino-shaped comes out.
{
  const nonAvr = [PICO, 'board.raspberry-pi-pico-w', C6, 'board.esp32-c3'];
  for (const boardId of nonAvr) {
    const def = getBoardDefinition(boardId);
    if (!def) {
      check(false, `${boardId} exists`);
      continue;
    }
    const profile = getBoardBusProfile(def);
    if (!profile) {
      // No profile is allowed — but then nothing may be claimed either.
      const board = uid('b');
      const sda = def.pins.find((p) => /^(GP|IO)\d+$/.test(p.id))!.id;
      const scl = def.pins.filter((p) => /^(GP|IO)\d+$/.test(p.id))[1].id;
      const gnd = def.pins.find((p) => p.type === 'ground')!.id;
      const vcc = def.pins.find((p) => p.type === 'power-3v3')!.id;
      const { placement } = lcdOn(board, boardId, sda, scl, gnd, vcc);
      check(busIssues(projectOf(placement)).length === 0, `${def.name} has no profile and so claims nothing`);
      continue;
    }
    // A pin that definitely cannot be SDA on this board, if one exists.
    const capable = new Set(profile.channels.flatMap((c) => c.pins['i2c-sda'] ?? []));
    const wrong = def.pins.find((p) => /^(GP|IO)\d+$/.test(p.id) && !capable.has(p.id));
    const gnd = def.pins.find((p) => p.type === 'ground')!.id;
    const vcc = def.pins.find((p) => p.type === 'power-3v3')?.id ?? def.pins.find((p) => p.type === 'power-5v')!.id;
    const goodScl = profile.channels.map((c) => c.defaults['i2c-scl']).find((p): p is string => p !== undefined)!;
    if (!wrong) {
      check(profile.routing === 'matrix', `${def.name} can put SDA on any exposed GPIO, which only a matrix part may claim`);
      continue;
    }
    const board = uid('b');
    const { placement } = lcdOn(board, boardId, wrong.id, goodScl, gnd, vcc);
    const body = text(busIssues(projectOf(placement)));
    check(body.length > 0, `${def.name}: SDA on ${wrong.id} is reported`);
    check(!/\bA4\b|\bA5\b|Arduino/.test(body), `${def.name}: with no Arduino pins in the message (${body.slice(0, 120)})`);
    check(body.includes(def.name), `${def.name}: and the board named correctly`);
  }
}

// ================================= 9. the UART crossing check still holds
{
  const board = uid('b');
  const gps = uid('gps');
  const project = projectOf({
    boards: [{ id: board, definitionId: UNO }],
    parts: [{ id: gps, definitionId: 'comp.gps' }],
    wires: [
      [gps, 'tx', board, 'D1'], // board D1 is TX: TX into TX
      [gps, 'gnd', board, 'GND1'],
      [gps, 'vcc', board, '5V'],
    ],
  });
  const issues = busIssues(project).filter((i) => i.ruleId === 'uart-pins');
  check(issues.length === 1, `TX wired to TX is still caught (${issues.length})`);
  check(/cross/i.test(issues[0]?.description ?? ''), 'and explains that serial lines cross');

  const crossed = projectOf({
    boards: [{ id: board, definitionId: UNO }],
    parts: [{ id: gps, definitionId: 'comp.gps' }],
    wires: [
      [gps, 'tx', board, 'D0'], // board D0 is RX: correct
      [gps, 'gnd', board, 'GND1'],
      [gps, 'vcc', board, '5V'],
    ],
  });
  check(
    busIssues(crossed).filter((i) => i.ruleId === 'uart-pins').length === 0,
    'and a correctly crossed pair is not',
  );
}

// The XIAO RP2040's own variant. Its Wire is the RP2040's i2c1, on the pads
// printed SDA and SCL (D4 and D5, which are GP6 and GP7); built as a Pico it
// would have been i2c0 on GP4/GP5. What the board says must be its variant's.
{
  const xiao = getBoardBusProfile(getBoardDefinition('board.seeed-xiao-rp2040'));
  const wire = xiao?.channels.find((c) => c.name === 'Wire');
  check(wire?.controllerId === 'i2c1', `on the XIAO, Wire is the RP2040's i2c1 (${wire?.controllerId})`);
  check(wire?.defaults['i2c-sda'] === 'D4' && wire?.defaults['i2c-scl'] === 'D5', `and starts on D4/D5, the pads printed SDA and SCL (${wire?.defaults['i2c-sda']}/${wire?.defaults['i2c-scl']})`);
  const spi = xiao?.channels.find((c) => c.name === 'SPI');
  check(spi?.defaults['spi-sck'] === 'D8' && spi?.defaults['spi-mosi'] === 'D10' && spi?.defaults['spi-miso'] === 'D9', `SPI starts on D8/D10/D9 (${spi?.defaults['spi-sck']}/${spi?.defaults['spi-mosi']}/${spi?.defaults['spi-miso']})`);
  const wire1 = xiao?.channels.find((c) => c.name === 'Wire1');
  check(!wire1 || Object.keys(wire1.defaults).length === 0, 'and Wire1, which the XIAO does not pin out, claims no default pads');
  const picoWire = getBoardBusProfile(getBoardDefinition(PICO))?.channels.find((c) => c.name === 'Wire');
  check(picoWire?.controllerId === 'i2c0' && picoWire.defaults['i2c-sda'] === 'GP4', 'while the Pico\'s Wire is unchanged: i2c0 on GP4/GP5');
}

console.log(failures === 0 ? '\nBus-pin validation checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
