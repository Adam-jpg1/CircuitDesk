// Walking somebody through making a board, without a browser.
//
// The Studio's job is not to collect fields. It is to stop a person ending up
// with a board that claims something untrue, and to do that without making them
// answer a question they should never have been asked. Those are behaviours,
// they live in the store, and this is where they are held to account:
//
//   * the processor is never guessed. An import suggests, with evidence; the
//     board stays wiring-only until a person confirms.
//   * capability is derived after every change and cannot be typed anywhere.
//   * choosing a chip chooses its pipeline, because there is one right answer.
//   * an incoherent pipeline is named as incoherent rather than silently fixed.
//   * a save that changed nothing is not a new revision; a save that changed
//     something always takes the NEXT number, whatever the file claims.
//   * artwork that is not a drawing is refused with the reason.

import {
  useStudioStore,
  stepsFor,
  draftCapability,
  parseCsv,
} from '../src/board-studio/studioStore';
import { withNextRevision, boardChanged, libraryEntryFor, libraryBoards, compareRevisions } from '../src/board-studio/boardLibrary';
import { isError } from '../src/custom-boards/validate';
import { CUSTOM_BOARD_LIMITS } from '../src/custom-boards/schema';
import { exportBoardBundle } from '../src/custom-boards/bundle';
import type { CustomDefinition } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const studio = () => useStudioStore.getState();

// ================================================= 1. the shape of the flow ==
section('1. the flow is short by default and complete when asked');
{
  check(stepsFor('simple').length < stepsFor('advanced').length, 'simple mode asks fewer questions');
  check(
    stepsFor('simple').every((s) => stepsFor('advanced').includes(s)),
    'and asks nothing advanced mode does not — it is the same flow with the answered steps applied',
  );
  check(
    !stepsFor('simple').includes('pipeline'),
    'the pipeline is not a question in simple mode, because the processor answers it',
  );
  check(stepsFor('simple').includes('placement'), 'but placing the pins is, because nothing else can answer that');

  studio().openNew('Bench Board');
  check(studio().open, 'the studio opens');
  check(studio().draft?.identity.name === 'Bench Board', 'on a draft with the name it was given');
  check(studio().draft?.pins.length === 0, 'and no pins yet');

  studio().next();
  check(studio().step === 'outline', `next moves through the steps in order (${studio().step})`);
  studio().back();
  check(studio().step === 'identity', 'and back goes back');
  studio().setMode('advanced');
  check(studio().step === 'identity', 'switching mode keeps you where you are when the step exists in both');
}

// ============================== 2. a board starts honest and stays honest ====
section('2. a new board is wiring-only, and says so');
{
  studio().openNew('Bench Board');
  const before = draftCapability(studio().draft);
  check(before?.supportLevel === 'wiring', `a board with no chip is wiring-only (${before?.supportLevel})`);
  check(before?.processor === 'None (wiring only)', 'named plainly, not left blank');
  check(before?.supported.length === 0, 'claiming no APIs');
  check(
    !studio().problems.some((p) => p.code === 'no-processor-but-compiles'),
    'and having no processor is not itself an error — it is a kind of board',
  );

  // The one thing a user must not be able to do: type a capability.
  check(
    !('supportLevel' in (studio().draft as unknown as Record<string, unknown>)),
    'the draft has no capability field to type into',
  );
}

// ================================ 3. choosing the chip chooses the pipeline ==
section('3. the chip decides the toolchain and the runtime');
{
  studio().openNew('Bench Board');
  studio().setProcessor('proc.rp2040');
  const draft = studio().draft!;
  check(draft.compileProfileId === 'compile.rp2040-arduino', `the RP2040 toolchain follows (${draft.compileProfileId})`);
  check(draft.runtimeProfileId === 'runtime.rp2040js', `and the RP2040 runtime (${draft.runtimeProfileId})`);
  check(studio().mismatches.length === 0, 'and the combination is coherent');

  const after = draftCapability(studio().draft);
  check(after?.supportLevel === 'simulated', `which makes the board simulated (${after?.supportLevel})`);
  check((after?.supported.length ?? 0) > 0, 'with the APIs the runtime actually provides');
  check(
    after?.notSimulated.some((s) => /PIO|USB|second core/i.test(s)),
    `and the chip's own limits inherited, not opted out of (${after?.notSimulated.join('; ')})`,
  );

  // Advanced mode may set an incoherent pipeline. It must be told, not fixed.
  studio().setCompileProfile('compile.avr-arduino');
  check(studio().mismatches.length > 0, `an AVR toolchain on an RP2040 is reported (${studio().mismatches.length})`);
  check(
    studio().mismatches.some((m) => m.code === 'processor-not-compilable'),
    `by the reason it is wrong (${studio().mismatches.map((m) => m.code).join(', ')})`,
  );
  check(
    draftCapability(studio().draft)?.supportLevel === 'wiring',
    'and the board stops claiming it compiles, because it does not',
  );

  studio().setProcessor('proc.rp2040');
  check(studio().mismatches.length === 0, 'reselecting the chip puts the pipeline back');
}

// ================================= 4. an import suggests and never decides ===
section('4. a pin map suggests a processor with its evidence, and applies nothing');
{
  studio().openNew('Imported Board');
  const csv = [
    'Pin Name,Processor Pin,Type',
    'SENSOR_SDA,GP4,digital',
    'SENSOR_SCL,GP5,digital',
    'STATUS,GP15,digital',
    'MOTOR,GP16,digital',
    'ENCODER,GP17,digital',
    'VBUS,,power',
    'GND,,ground',
  ].join('\n');
  const result = studio().importPinCsv(csv);

  check(result.added === 7, `seven pins came in (${result.added})`);
  check(result.errors.length === 0, 'with no unreadable rows');
  check(studio().draft?.pins.find((p) => p.id === 'SENSOR_SDA')?.pad === 'GP4', 'carrying their pads');
  check(studio().draft?.processorProfileId === null, 'and the board still has NO processor');
  check(studio().suggestions.length > 0, `while a suggestion is offered (${studio().suggestions.length})`);
  check(
    studio().suggestions[0]?.processorProfileId === 'proc.rp2040',
    `naming the RP2040 (${studio().suggestions[0]?.processorProfileId})`,
  );
  check(
    studio().suggestions[0]?.confidence === 'likely',
    'as likely rather than certain, because pad names are weak evidence',
  );
  check(
    (studio().suggestions[0]?.evidence ?? '').length > 0,
    `with the evidence it was suggested from (${studio().suggestions[0]?.evidence})`,
  );
  check(
    draftCapability(studio().draft)?.supportLevel === 'wiring',
    'the imported board is wiring-only until somebody confirms the chip',
  );

  // The pads are checked against the chip only once there IS a chip.
  studio().setProcessor('proc.rp2040');
  check(studio().problems.filter(isError).length === 0, 'confirming the RP2040 leaves a valid board');
  studio().setProcessor('proc.atmega328p');
  check(
    studio().problems.filter(isError).some((p) => p.code === 'pad-not-on-processor'),
    'and confirming the WRONG chip says which pads do not exist on it',
  );
}

// ================================================ 5. rows that cannot be read
section('5. unreadable rows are reported, never dropped quietly');
{
  studio().openNew('Partly Broken');
  const csv = [
    'label,processor_pin',
    'GOOD,GP1',
    ',GP2',
    'ALSO_GOOD,GP3',
  ].join('\n');
  const result = studio().importPinCsv(csv);
  check(result.added === 2, `the readable rows came in (${result.added})`);
  check(result.errors.length === 1, `and the unreadable one is reported (${result.errors.length})`);
  check(result.errors[0]?.row === 3, `pointing at the row it was on (${result.errors[0]?.row})`);
  check(
    studio().notes.some((n) => n.text.includes('could not be read')),
    'with a note the user sees rather than a silent shortfall',
  );
}

// ===================================================== 6. pins and placement
section('6. pins can be added, named, placed and removed');
{
  studio().openNew('Hand Made');
  studio().setOutline({ widthMm: 30, heightMm: 40 });
  const id = studio().addPin({ label: 'LED', pad: null });
  check(id !== null, 'a pin is added');
  check(studio().selectedPinId === id, 'and selected, because it is the thing just made');
  studio().updatePin(id!, { id: 'STATUS_LED', label: 'STATUS' });
  check(studio().draft?.pins[0]?.id === 'STATUS_LED', 'it can be renamed');
  check(studio().selectedPinId === 'STATUS_LED', 'and the selection follows the rename');

  studio().movePin('STATUS_LED', 12.345, 20.5);
  const pin = studio().draft?.pins[0];
  check(pin?.xMm === 12.35 && pin?.yMm === 20.5, `placement is stored to a hundredth of a mm (${pin?.xMm}, ${pin?.yMm})`);
  studio().movePin('STATUS_LED', 900, -50);
  const clamped = studio().draft?.pins[0];
  check(
    clamped?.xMm === 30 && clamped?.yMm === 0,
    `a pin cannot be dragged off its own board (${clamped?.xMm}, ${clamped?.yMm})`,
  );

  studio().addPin({ id: 'STATUS_LED' });
  check(
    studio().draft?.pins.length === 2 && studio().draft?.pins[1].id !== 'STATUS_LED',
    `a second pin cannot take the first one's id (${studio().draft?.pins[1].id})`,
  );

  const spare = studio().selectedPinId!;
  studio().removePin(spare);
  check(studio().draft?.pins.length === 1, 'a pin can be removed');
  check(studio().selectedPinId === null, 'and removing the selected pin clears the selection');
  studio().removePin('STATUS_LED');
  check(studio().draft?.pins.length === 0, 'as can the last one');
}

// ============================================== 7. artwork must be a drawing
section('7. artwork that is not a drawing is refused, with the reason');
{
  studio().openNew('Arty');
  const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//x")</script><rect width="10" height="10"/></svg>';
  const refusal = studio().setArtwork(hostile);
  check(!refusal.accepted, 'a file containing a script is refused');
  check(/script/i.test(refusal.message), `and the message says what was in it (${refusal.message})`);
  check(studio().draft?.outline.artworkSvg === undefined, 'nothing was stored');
  check(
    studio().notes.some((n) => n.kind === 'warning' && /refused/i.test(n.text)),
    'and the refusal stays visible in the studio',
  );
}

// ================================================ 8. limits are real limits
section('8. the limits hold');
{
  studio().openNew('Big');
  studio().setOutline({ widthMm: 5000, heightMm: -3 });
  check(
    studio().draft?.outline.widthMm === CUSTOM_BOARD_LIMITS.maxBoardMm,
    `an absurd width is clamped (${studio().draft?.outline.widthMm})`,
  );
  check(
    studio().draft?.outline.heightMm === CUSTOM_BOARD_LIMITS.minBoardMm,
    `and a negative height (${studio().draft?.outline.heightMm})`,
  );
}

// ============================================ 9. revisions mean something ===
section('9. a revision is a change, not a save');
{
  studio().openNew('Revisioned');
  studio().setProcessor('proc.rp2040');
  studio().addPin({ id: 'LED', pad: 'GP15' });

  const first = studio().readyToSave();
  check(first !== null, 'a valid board is ready to save');
  check(first?.revision === 1, `a first save is revision 1 (${first?.revision})`);
  studio().markSaved(first!);

  const unchanged = studio().readyToSave();
  check(unchanged?.revision === 1, `saving again without editing is still revision 1 (${unchanged?.revision})`);

  studio().addPin({ id: 'BUTTON', pad: 'GP16' });
  const second = studio().readyToSave();
  check(second?.revision === 2, `an edit makes revision 2 (${second?.revision})`);
  check(second?.id === first?.id, 'with the same id, because it is the same board');
  check(second?.updatedAt !== undefined, 'and a time it was changed');

  // A file that claims a revision does not get to keep it.
  // A definition's own revision number is never believed. An unchanged board
  // that claims 99 keeps the revision it really is; a changed one takes the
  // next real number rather than the number it asked for.
  const liar = { ...second!, revision: 99 };
  check(
    withNextRevision(liar, second!).revision === 2,
    `an unchanged board claiming revision 99 stays at 2 (${withNextRevision(liar, second!).revision})`,
  );
  const changedLiar = { ...liar, identity: { ...liar.identity, name: 'Renamed' } };
  check(
    withNextRevision(changedLiar, second!).revision === 3,
    `and a changed one takes the next real number (${withNextRevision(changedLiar, second!).revision})`,
  );
  check(!boardChanged(second!, { ...second!, revision: 50 }), 'the revision number itself is not a change');
  check(boardChanged(second!, { ...second!, identity: { ...second!.identity, name: 'Other' } }), 'a rename is');
}

// ================================= 10. the library holds boards, not copies ==
section('10. My Boards stores what can be reopened, and compares revisions');
{
  studio().openNew('Library Board');
  studio().setProcessor('proc.esp32c6');
  studio().addPin({ id: 'LED', pad: 'IO15' });
  const board = studio().readyToSave()!;

  const { entry, problems } = libraryEntryFor(board);
  check(entry !== undefined, `a valid board makes a library entry${problems.map((p) => ` — ${p.message}`).join('')}`);
  check(entry?.kind === 'board', 'stored as a board');
  check(entry?.definition.id === board.id, 'resolvable by the id its instances reference');
  check(
    (entry as unknown as { spec: { pins: unknown[] } }).spec.pins.length === board.pins.length,
    'and carrying the definition it was built from, so it can be edited again',
  );

  const parts = [entry!] as CustomDefinition[];
  check(libraryBoards(parts).length === 1, 'the library lists it');
  check(libraryBoards(parts)[0].id === board.id, 'as itself');

  const newer = { ...board, revision: board.revision + 1 };
  check(compareRevisions(newer, board) === 'library-newer', 'a newer library copy is reported as newer');
  check(compareRevisions(board, board) === 'same', 'and an unchanged one as the same');
  check(compareRevisions(undefined, board) === 'no-library-copy', 'a project board with no library copy says so');
}

// ============================== 11. a bundle reopens into the studio =========
section('11. a board file opens as a board, and a bad one does not');
{
  studio().openNew('Travelling Board');
  studio().setProcessor('proc.rp2040');
  studio().addPin({ id: 'LED', pad: 'GP15' });
  const board = studio().readyToSave()!;
  const { json } = exportBoardBundle(board);

  studio().close();
  const ok = studio().openBundle(json);
  check(ok, 'an exported board opens again');
  check(studio().draft?.id === board.id, 'as the same board');
  check(studio().draft?.pins.length === board.pins.length, 'with all its pins');
  check(studio().step === 'review', 'landing on the review step, because there is nothing left to ask');

  const bad = studio().openBundle('{"kind":"something-else"}');
  check(!bad, 'a JSON file that is not a board is refused');
  check(studio().draft === null, 'with no draft left behind');
  check(
    studio().problems.some((p) => p.code === 'not-a-board-bundle'),
    `and a reason (${studio().problems.map((p) => p.code).join(', ')})`,
  );
}

// ===================================================== 12. the CSV reader ====
section('12. the CSV reader survives real spreadsheets');
{
  const parsed = parseCsv('label,pad\r\n"Pin, one",GP1\r\n"He said ""hi""",GP2\r\n');
  check(parsed.headers.length === 2, `two columns (${parsed.headers.length})`);
  check(parsed.rows[0][0] === 'Pin, one', `a quoted comma stays in the cell (${parsed.rows[0][0]})`);
  check(parsed.rows[1][0] === 'He said "hi"', `and a doubled quote is one quote (${parsed.rows[1][0]})`);
  check(parseCsv('a\tb\n1\t2').rows[0].length === 2, 'tabs separate too, because exports use them');
  check(parseCsv('').headers.length === 0, 'and an empty file is empty rather than an exception');
}

console.log(failures === 0 ? '\nBoard Studio flow checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
