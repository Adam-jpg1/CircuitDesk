// The five things a person should be able to do, done end to end.
//
// Not unit tests: journeys. Each one starts where a user starts — with a file
// somebody sent them, or a spreadsheet, or a mistake — and ends where they
// need to be, with the real toolchain and the real emulator in between. The
// narration is part of the output on purpose, because the claim being made is
// about an experience and the log should read like one.
//
// A. A board that arrived as a spreadsheet and a picture.
// B. A board file from somebody else, on a machine with nothing installed.
// C. The wrong chip, caught and named before it cost anything.
// D. A revision that costs a wire, priced before it is paid.
// E. A board that cannot run, saying so, and never built as something else.

import { simulationController } from '../src/simulation/simulationController';
import { emptyProject } from '../src/project/templates';
import { normalizeProject } from '../src/project/projectService';
import { useStudioStore, draftCapability } from '../src/board-studio/studioStore';
import { embedBoard, embeddedBoards, previewUpgrade, upgradeEmbeddedBoard } from '../src/custom-boards/projectBoards';
import { exportBoardBundle } from '../src/custom-boards/bundle';
import { resolveDefinition } from '../src/project/partsRegistry';
import { resolveWorkspaceTargets } from '../src/compiler/targets';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import { validateProject } from '../src/validation/validator';
import { isError } from '../src/custom-boards/validate';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? '  PASS:' : '  FAIL:', msg);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log('  SKIP:', msg);
  skipped++;
}
function demo(letter: string, title: string) {
  console.log(`\n=== Demo ${letter}. ${title}`);
}
function say(line: string) {
  console.log(`  · ${line}`);
}

const studio = () => useStudioStore.getState();
let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

function placeBoard(project: CircuitProject, definitionId: string): ComponentInstance {
  const instance: ComponentInstance = {
    id: uid('b'), definitionId, x: 40, y: 40, rotation: 0, properties: {}, simulationState: {},
  };
  project.boardInstances.push(instance);
  return instance;
}

const blink = (n: number) => [
  'void setup() { pinMode(' + n + ', OUTPUT); }',
  'void loop() { digitalWrite(' + n + ', HIGH); delay(30); digitalWrite(' + n + ', LOW); delay(30); }',
].join('\n');

/** Runs a project and reports whether the named pin toggled. */
async function runAndWatch(project: CircuitProject, instanceId: string, index: number): Promise<'no-toolchain' | boolean> {
  simulationController.stop();
  const report = await simulationController.build(project);
  say(`build: ${report.builds[0]?.detail}`);
  if (!report.anyRunnable) return 'no-toolchain';
  if (!(await simulationController.start())) return false;
  simulationController.pause();
  const runner = simulationController.runnerFor(instanceId);
  let high = false;
  let low = false;
  for (let i = 0; i < 120 && !(high && low); i++) {
    simulationController.advance(10);
    const level = runner?.digitalPinLevel(index);
    if (level === 'high') high = true;
    if (level === 'low') low = true;
  }
  simulationController.stop();
  return high && low;
}

// ============================================================== Demo A =======
demo('A', 'A board that arrived as a spreadsheet and a picture');
{
  say('Someone exports the pin map of their own board from a spreadsheet, and the outline from their PCB tool.');

  studio().openNew('Orchard Node');
  studio().setOutline({ widthMm: 34, heightMm: 52, color: '#2f4a2f' });

  const csv = [
    'Pin Name,Processor Pin,Type',
    'BATT,,power',
    'GND,,ground',
    'VALVE,GP15,digital',
    'FLOW,GP16,digital',
    'PROBE_SDA,GP4,digital',
    'PROBE_SCL,GP5,digital',
    'MOISTURE,GP26,analog',
  ].join('\n');
  const imported = studio().importPinCsv(csv);
  say(`the spreadsheet gives ${imported.added} pins, and no processor`);
  check(imported.added === 7, `seven pins came in (${imported.added})`);
  check(studio().draft?.processorProfileId === null, 'and CircuitDesk has not decided what chip is on it');
  check(draftCapability(studio().draft)?.supportLevel === 'wiring', 'so the board is wiring-only, which is a real board');
  check(studio().suggestions.length > 0, `it does offer a guess with its reasoning: ${studio().suggestions[0]?.evidence}`);

  say('They confirm the chip. Everything downstream follows from that one answer.');
  studio().setProcessor('proc.rp2040');
  check(draftCapability(studio().draft)?.supportLevel === 'simulated', 'the board becomes simulated');
  check(studio().draft?.compileProfileId === 'compile.rp2040-arduino', 'with a toolchain nobody had to choose');

  const board = studio().readyToSave();
  check(board !== null, `and it is ready to save${studio().problems.filter(isError).map((p) => ` — ${p.message}`).join('')}`);

  const project = emptyProject('orchard');
  embedBoard(project, board!);
  const instance = placeBoard(project, board!.id);
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: blink(15), language: 'cpp' }];

  say('Their firmware drives GP15. Their board calls that pin VALVE. Both are true.');
  const def = resolveDefinition(board!.id, project)!;
  check(runnerPinIndex(def, 'VALVE') === 15, 'VALVE is pad GP15');
  const result = await runAndWatch(project, instance.id, 15);
  if (result === 'no-toolchain') skip('the RP2040 toolchain is unavailable here');
  else check(result === true, 'and it compiles and runs, with VALVE toggling');
}

// ============================================================== Demo B =======
demo('B', 'A board file from somebody else, on a machine with nothing installed');
{
  say('The first person exports their board. One file, no archive, no assets to lose.');
  studio().openNew('Orchard Node');
  studio().setOutline({ widthMm: 34, heightMm: 52 });
  studio().setProcessor('proc.esp32c6');
  studio().addPin({ id: 'BEACON', label: 'BEACON', pad: 'IO15' });
  studio().addPin({ id: 'GND', label: 'GND', pad: null, type: 'ground' });
  const original = studio().readyToSave()!;
  const { json, problems } = exportBoardBundle(original);
  check(problems.length === 0, `the export carries nothing personal${problems.map((p) => ` — ${p.message}`).join('')}`);
  say(`the file is ${Math.round(json.length / 1024) || 1} KB of JSON`);

  say('The second person opens it. They have never seen this board.');
  studio().close();
  const opened = studio().openBundle(json);
  check(opened, 'the file opens as a board');
  check(studio().draft?.identity.name === original.identity.name, 'with its name');
  check(studio().draft?.pins.length === original.pins.length, 'and its pins');

  const project = emptyProject('received');
  embedBoard(project, studio().draft!);
  const instance = placeBoard(project, original.id);
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: blink(15), language: 'cpp' }];

  say('They send the whole project on to a third person, who opens it cold.');
  const third = normalizeProject(JSON.parse(JSON.stringify(project)));
  const def = resolveDefinition(original.id, third);
  check(def?.name === original.identity.name, 'the project opens with the board in it');
  check(resolveWorkspaceTargets(third).targets.length === 1, 'and it builds, with nothing installed');

  const result = await runAndWatch(third, third.boardInstances[0].id, 15);
  if (result === 'no-toolchain') skip('the ESP32 toolchain is unavailable here');
  else check(result === true, 'BEACON toggles on a machine that has never heard of this board');
  void instance;
}

// ============================================================== Demo C =======
demo('C', 'The wrong chip, caught and named before it cost anything');
{
  say('A pin map full of GP names, and a user who picks an ATmega328P by mistake.');
  studio().openNew('Mislabelled Board');
  studio().importPinCsv([
    'label,processor_pin',
    'LAMP,GP15',
    'BTN,GP16',
    'SDA,GP4',
    'SCL,GP5',
  ].join('\n'));
  studio().setProcessor('proc.atmega328p');

  const wrong = studio().problems.filter(isError);
  check(wrong.length > 0, `the mistake is caught immediately (${wrong.length} problems)`);
  check(
    wrong.some((p) => p.code === 'pad-not-on-processor'),
    'and named for what it is: pads that do not exist on that chip',
  );
  say(wrong[0].message);
  check(studio().readyToSave() === null, 'the board cannot be saved in this state');
  check(
    draftCapability(studio().draft)?.supportLevel === 'simulated',
    'the capability panel still describes what an ATmega328P board WOULD be, so the choice is legible',
  );

  say('They pick the right chip. Nothing else has to be redone.');
  studio().setProcessor('proc.rp2040');
  check(studio().problems.filter(isError).length === 0, 'every problem is gone');
  check(studio().readyToSave() !== null, 'and the board is saveable');
  check(studio().draft?.pins.length === 4, 'with the pin map they imported still intact');
}

// ============================================================== Demo D =======
demo('D', 'A revision that costs a wire, priced before it is paid');
{
  say('A project built on revision 1 of a board, with an LCD on two of its pins.');
  studio().openNew('Bench Rig');
  studio().setProcessor('proc.rp2040');
  studio().addPin({ id: 'V3', label: '3V3', pad: null, type: 'power-3v3' });
  studio().addPin({ id: 'GND', label: 'GND', pad: null, type: 'ground' });
  studio().addPin({ id: 'RIG_SDA', label: 'RIG_SDA', pad: 'GP4' });
  studio().addPin({ id: 'RIG_SCL', label: 'RIG_SCL', pad: 'GP5' });
  const v1 = studio().readyToSave()!;

  const project = emptyProject('bench rig');
  embedBoard(project, v1);
  const board = placeBoard(project, v1.id);
  project.componentInstances.push({
    id: 'lcd', definitionId: 'comp.lcd1602', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  } as ComponentInstance);
  for (const [ap, bp] of [['sda', 'RIG_SDA'], ['scl', 'RIG_SCL'], ['gnd', 'GND'], ['vcc', 'V3']]) {
    project.connections.push({
      id: uid('w'), sourceComponentId: 'lcd', sourcePinId: ap, targetComponentId: board.id, targetPinId: bp,
      netId: '', color: '#888', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }
  const issues = validateProject(project).filter((i) => i.ruleId === 'i2c-pins');
  check(issues.length === 0, 'the LCD is on the board\'s own I2C pins and nothing complains');

  say('Later they revise the board and drop RIG_SCL. CircuitDesk prices that before applying it.');
  const v2 = { ...v1, revision: 2, pins: v1.pins.filter((p) => p.id !== 'RIG_SCL') };
  const preview = previewUpgrade(project, v2)!;
  check(preview.droppedPins.length === 1, `one pin would go: ${preview.droppedPins[0].pinId}`);
  check(preview.droppedPins[0].connectionIds.length === 1, 'taking one wire with it');
  check(embeddedBoards(project).get(v1.id)?.revision === 1, 'and nothing has happened yet');
  say(`upgrading from revision ${preview.fromRevision} to ${preview.toRevision} would remove ${preview.droppedPins[0].connectionIds.length} wire`);

  say('They accept. The cost is exactly what they were quoted.');
  const before = project.connections.length;
  upgradeEmbeddedBoard(project, v2);
  check(project.connections.length === before - 1, `one wire removed (${before} → ${project.connections.length})`);
  check(embeddedBoards(project).get(v1.id)?.revision === 2, 'and the project is on revision 2');
  const after = validateProject(project).filter((i) => i.ruleId === 'i2c-pins' || i.ruleId === 'unconnected-pin');
  check(after.length > 0, 'with the now-dangling LCD pin reported rather than ignored');
}

// ============================================================== Demo E =======
demo('E', 'A board that cannot run, saying so, and never built as something else');
{
  say('A passive breakout. There is no chip on it, and there is nothing to pretend about.');
  studio().openNew('Thermocouple Breakout');
  studio().setOutline({ widthMm: 20, heightMm: 16 });
  studio().setProcessor(null);
  for (const id of ['V3', 'GND', 'SO', 'CS', 'SCK']) studio().addPin({ id, label: id });
  const board = studio().readyToSave();
  check(board !== null, 'a board with no processor is a legal board');

  const capability = draftCapability(studio().draft)!;
  check(capability.supportLevel === 'wiring', `it is wiring-only (${capability.supportLevel})`);
  check(capability.processor === 'None (wiring only)', 'and says so in words, not by leaving a field blank');
  check(capability.supported.length === 0, 'it claims no APIs');

  const project = emptyProject('breakout');
  embedBoard(project, board!);
  placeBoard(project, board!.id);
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: blink(13), language: 'cpp' }];

  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  check(targets.length === 0, 'nothing is built for it');
  check(unbuildable.length === 1, 'and the reason is given rather than swallowed');
  say(unbuildable[0].reason);
  check(
    !/uno|pico|esp32|mega|leonardo/i.test(unbuildable[0].reason),
    'with no other board\'s identity anywhere near it',
  );

  simulationController.stop();
  const report = await simulationController.build(project);
  check(!report.anyRunnable, 'Run does not start something that cannot run');
  check(
    report.builds.every((b) => b.status !== 'built'),
    `and no artifact is produced (${report.builds.map((b) => b.status).join(', ') || 'no builds'})`,
  );
  simulationController.stop();
}

console.log(
  failures === 0
    ? `\nAll five demos hold${skipped ? ` (${skipped} skipped for a missing toolchain)` : ''}.`
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
