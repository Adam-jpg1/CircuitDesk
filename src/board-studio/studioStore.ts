// The state behind the Board Studio.
//
// Kept separate from its React components on purpose: the flow through the
// Studio is where the honesty rules of this milestone are enforced, and rules
// that live in a component can only be tested by driving a browser. Everything
// here runs in a test with no DOM.
//
// The rules, in the order a user meets them:
//
//   * a board never guesses its processor. An import may SUGGEST one, with the
//     evidence it suggested it from, and the user confirms. Until they do, the
//     board is wiring-only, which is a real and usable thing rather than a
//     failure state.
//   * the pipeline follows the processor. Choosing an RP2040 chooses the
//     RP2040 toolchain and the RP2040 runtime, because there is exactly one
//     honest answer; Advanced mode lets you change it and the mismatch checker
//     tells you when the combination cannot work.
//   * capability is never typed. It is read back out of the profiles after
//     every change, so a user watches "wiring only" become "simulated" the
//     moment the thing that makes it true is set.
//   * validation is live and complete. Every problem in the draft, all the
//     time, not the first one at save time.

import { create } from 'zustand';
import {
  CUSTOM_BOARD_LIMITS,
  type CustomBoardDefinition,
  type CustomBoardPin,
  type PinRole,
} from '../custom-boards/schema';
import { validateCustomBoard, isError, type BoardProblem } from '../custom-boards/validate';
import { capabilitySummary } from '../custom-boards/resolve';
import { newCustomBoard } from '../custom-boards/projectBoards';
import {
  pinsFromCsv,
  suggestProcessors,
  suggestedPipeline,
  type ProcessorSuggestion,
} from '../custom-boards/import';
import { sanitizeBoardSvg, looksHostile } from '../custom-boards/svgSanitize';
import { importBoardBundle, duplicateBoard } from '../custom-boards/bundle';
import {
  checkPipeline,
  compileProfile,
  runtimeProfile,
  type PipelineMismatch,
} from '../boards/pipelineProfiles';
import { withNextRevision } from './boardLibrary';

export type StudioStep =
  | 'start'
  | 'identity'
  | 'outline'
  | 'artwork'
  | 'processor'
  | 'pins'
  | 'placement'
  | 'pipeline'
  | 'review';

export type StudioMode = 'simple' | 'advanced';

/**
 * The steps, in order, for each mode.
 *
 * Simple mode is not a cut-down Studio; it is the same Studio with the two
 * steps that have a correct default already applied. Artwork is optional — a
 * board without it gets a drawn PCB — and the pipeline follows the processor.
 * Both are still reachable from the review step, so "simple" never means
 * "you cannot".
 */
const SIMPLE_STEPS: StudioStep[] = ['start', 'identity', 'outline', 'processor', 'pins', 'placement', 'review'];
const ADVANCED_STEPS: StudioStep[] = [
  'start', 'identity', 'outline', 'artwork', 'processor', 'pins', 'placement', 'pipeline', 'review',
];

export function stepsFor(mode: StudioMode): StudioStep[] {
  return mode === 'simple' ? SIMPLE_STEPS : ADVANCED_STEPS;
}

export const STEP_TITLE: Record<StudioStep, string> = {
  start: 'Start',
  identity: 'What is it called',
  outline: 'How big is it',
  artwork: 'What does it look like',
  processor: 'What chip is on it',
  pins: 'What pins does it have',
  placement: 'Where are the pins',
  pipeline: 'How is it built and run',
  review: 'What it can do',
};

/** A note about where the draft came from, kept visible while it is edited. */
export interface StudioNote {
  kind: 'info' | 'warning';
  text: string;
}

interface StudioState {
  open: boolean;
  mode: StudioMode;
  step: StudioStep;
  draft: CustomBoardDefinition | null;
  /** The saved revision this draft started from, or null for a new board. */
  baseline: CustomBoardDefinition | null;
  problems: BoardProblem[];
  mismatches: PipelineMismatch[];
  notes: StudioNote[];
  /** Processor suggestions from an import, with their evidence. Never applied. */
  suggestions: ProcessorSuggestion[];
  selectedPinId: string | null;
  /** Set once the draft has been stored, so the UI can say so. */
  savedRevision: number | null;

  openNew(name?: string): void;
  openEdit(board: CustomBoardDefinition): void;
  openDuplicate(board: CustomBoardDefinition, name: string): void;
  openBundle(text: string): boolean;
  close(): void;

  setMode(mode: StudioMode): void;
  goTo(step: StudioStep): void;
  next(): void;
  back(): void;

  patch(patch: Partial<CustomBoardDefinition>): void;
  setIdentity(patch: Partial<CustomBoardDefinition['identity']>): void;
  setOutline(patch: Partial<CustomBoardDefinition['outline']>): void;
  setArtwork(svg: string): { accepted: boolean; message: string };
  clearArtwork(): void;

  setProcessor(processorProfileId: string | null): void;
  setCompileProfile(id: string): void;
  setRuntimeProfile(id: string): void;
  setFqbnOverride(fqbn: string | undefined): void;

  addPin(pin?: Partial<CustomBoardPin>): string | null;
  updatePin(pinId: string, patch: Partial<CustomBoardPin>): void;
  movePin(pinId: string, xMm: number, yMm: number): void;
  removePin(pinId: string): void;
  selectPin(pinId: string | null): void;
  importPinCsv(text: string): { added: number; errors: { row: number; message: string }[] };

  /** The definition to store, with its revision resolved. Null when invalid. */
  readyToSave(): CustomBoardDefinition | null;
  markSaved(stored: CustomBoardDefinition): void;
}

const EMPTY: Pick<StudioState, 'draft' | 'baseline' | 'problems' | 'mismatches' | 'notes' | 'suggestions' | 'selectedPinId' | 'savedRevision'> = {
  draft: null,
  baseline: null,
  problems: [],
  mismatches: [],
  notes: [],
  suggestions: [],
  selectedPinId: null,
  savedRevision: null,
};

/** Re-derives everything that is derived. Called after every change. */
function derive(draft: CustomBoardDefinition): { problems: BoardProblem[]; mismatches: PipelineMismatch[] } {
  const { problems } = validateCustomBoard(draft);
  const compile = compileProfile(draft.compileProfileId);
  const runtime = runtimeProfile(draft.runtimeProfileId);
  const mismatches =
    draft.processorProfileId && compile && runtime
      ? checkPipeline(draft.processorProfileId, compile, runtime)
      : [];
  return { problems, mismatches };
}

function clampMm(value: number): number {
  if (!Number.isFinite(value)) return CUSTOM_BOARD_LIMITS.minBoardMm;
  return Math.min(CUSTOM_BOARD_LIMITS.maxBoardMm, Math.max(CUSTOM_BOARD_LIMITS.minBoardMm, value));
}

/** A pin id nothing else on the board is using. */
function freePinId(draft: CustomBoardDefinition, base: string): string {
  const taken = new Set(draft.pins.map((p) => p.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Splits a CSV into a header row and data rows, tolerating quotes and CRLF. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === '\t' || ch === ';') { out.push(cell); cell = ''; }
      else cell += ch;
    }
    out.push(cell);
    return out.map((c) => c.trim());
  };
  const [head, ...rest] = lines;
  return { headers: split(head), rows: rest.map(split) };
}

export const useStudioStore = create<StudioState>((set, get) => {
  /** Applies a change to the draft and re-derives everything downstream. */
  const change = (fn: (draft: CustomBoardDefinition) => CustomBoardDefinition) => {
    const current = get().draft;
    if (!current) return;
    const draft = fn(current);
    set({ draft, savedRevision: null, ...derive(draft) });
  };

  return {
    open: false,
    mode: 'simple',
    step: 'start',
    ...EMPTY,

    openNew(name = 'My board') {
      const draft = newCustomBoard(name);
      set({
        open: true,
        step: 'identity',
        draft,
        baseline: null,
        notes: [],
        suggestions: [],
        selectedPinId: null,
        savedRevision: null,
        ...derive(draft),
      });
    },

    openEdit(board) {
      set({
        open: true,
        step: 'identity',
        draft: board,
        baseline: board,
        notes: [{
          kind: 'info',
          text:
            `Editing revision ${board.revision}. Saving a change makes revision ${board.revision + 1}; ` +
            'projects already built with this board keep the revision they have until you upgrade them.',
        }],
        suggestions: [],
        selectedPinId: null,
        savedRevision: null,
        ...derive(board),
      });
    },

    openDuplicate(board, name) {
      const draft = duplicateBoard(board, name);
      set({
        open: true,
        step: 'identity',
        draft,
        baseline: null,
        notes: [{
          kind: 'info',
          text:
            `A copy of ${board.identity.name}, with a new identity and its revision restarted at 1. ` +
            'It is a new board that looks like another, not a later version of it.',
        }],
        suggestions: [],
        selectedPinId: null,
        savedRevision: null,
        ...derive(draft),
      });
    },

    openBundle(text) {
      const { board, problems } = importBoardBundle(text);
      if (!board) {
        set({
          open: true,
          step: 'start',
          draft: null,
          baseline: null,
          problems,
          mismatches: [],
          notes: problems.map((p) => ({ kind: 'warning' as const, text: p.message })),
          suggestions: [],
          selectedPinId: null,
          savedRevision: null,
        });
        return false;
      }
      set({
        open: true,
        step: 'review',
        draft: board,
        baseline: null,
        notes: [
          { kind: 'info', text: `Imported ${board.identity.name} — identity, pins, pads and pipeline all came from the file.` },
          ...problems.filter((p) => !isError(p)).map((p) => ({ kind: 'warning' as const, text: p.message })),
        ],
        suggestions: [],
        selectedPinId: null,
        savedRevision: null,
        ...derive(board),
      });
      return true;
    },

    close() {
      set({ open: false, step: 'start', ...EMPTY });
    },

    setMode(mode) {
      const steps = stepsFor(mode);
      const step = steps.includes(get().step) ? get().step : 'review';
      set({ mode, step });
    },

    goTo(step) {
      set({ step });
    },

    next() {
      const steps = stepsFor(get().mode);
      const i = steps.indexOf(get().step);
      if (i >= 0 && i < steps.length - 1) set({ step: steps[i + 1] });
    },

    back() {
      const steps = stepsFor(get().mode);
      const i = steps.indexOf(get().step);
      if (i > 0) set({ step: steps[i - 1] });
    },

    patch(patch) {
      change((draft) => ({ ...draft, ...patch }));
    },

    setIdentity(patch) {
      change((draft) => ({ ...draft, identity: { ...draft.identity, ...patch } }));
    },

    setOutline(patch) {
      change((draft) => ({
        ...draft,
        outline: {
          ...draft.outline,
          ...patch,
          ...(patch.widthMm !== undefined ? { widthMm: clampMm(patch.widthMm) } : {}),
          ...(patch.heightMm !== undefined ? { heightMm: clampMm(patch.heightMm) } : {}),
        },
      }));
    },

    /**
     * Takes artwork, or refuses it with a reason.
     *
     * Two gates, deliberately in this order. `looksHostile` refuses the whole
     * file when it contains something that has no business in a drawing, so the
     * message is "this file contains a script" rather than a silently emptier
     * picture. Then the sanitiser rebuilds what is left from an allowlist, so
     * what is stored is only ever elements and attributes we chose.
     */
    setArtwork(svg) {
      const hostile = looksHostile(svg);
      if (hostile) {
        set({
          notes: [...get().notes, { kind: 'warning', text: `Artwork refused: ${hostile}.` }],
        });
        return { accepted: false, message: `That file was refused: ${hostile}. Board artwork may only contain drawing instructions.` };
      }
      const result = sanitizeBoardSvg(svg);
      if (!result.svg) {
        return { accepted: false, message: result.removed[0] ?? 'Nothing in that file could be drawn.' };
      }
      const clean = result.svg;
      change((draft) => ({ ...draft, outline: { ...draft.outline, artworkSvg: clean } }));
      if (result.removed.length > 0) {
        set({ notes: [...get().notes, ...result.removed.map((text) => ({ kind: 'warning' as const, text }))] });
      }
      return {
        accepted: true,
        message: result.removed.length > 0
          ? `Artwork added. ${result.removed.length} thing(s) were removed because artwork may only draw.`
          : 'Artwork added.',
      };
    },

    clearArtwork() {
      change((draft) => {
        const { artworkSvg: _artworkSvg, ...outline } = draft.outline;
        return { ...draft, outline };
      });
    },

    /**
     * Sets the chip, and with it the pipeline that chip actually has.
     *
     * The pipeline follows because there is one honest answer per processor and
     * making the user find it twice is not a choice, it is a chore. Advanced
     * mode can still change either half afterwards.
     */
    setProcessor(processorProfileId) {
      change((draft) => ({
        ...draft,
        processorProfileId,
        ...suggestedPipeline(processorProfileId),
        // An FQBN override belongs to the pipeline it was typed for.
        fqbnOverride: undefined,
      }));
      set({ suggestions: [] });
    },

    setCompileProfile(id) {
      change((draft) => ({ ...draft, compileProfileId: id, fqbnOverride: undefined }));
    },

    setRuntimeProfile(id) {
      change((draft) => ({ ...draft, runtimeProfileId: id }));
    },

    setFqbnOverride(fqbn) {
      change((draft) => ({ ...draft, fqbnOverride: fqbn && fqbn.trim() ? fqbn.trim() : undefined }));
    },

    addPin(patch = {}) {
      const draft = get().draft;
      if (!draft) return null;
      if (draft.pins.length >= CUSTOM_BOARD_LIMITS.maxPins) {
        set({ notes: [...get().notes, { kind: 'warning', text: `A board may have at most ${CUSTOM_BOARD_LIMITS.maxPins} pins.` }] });
        return null;
      }
      const id = freePinId(draft, patch.id ?? `PIN${draft.pins.length + 1}`);
      // Stacked down the left edge, which is where the placement step expects
      // to find pins nobody has put anywhere yet.
      const pin: CustomBoardPin = {
        id,
        label: patch.label ?? id,
        pad: patch.pad ?? null,
        xMm: patch.xMm ?? 2,
        yMm: patch.yMm ?? Math.min(draft.outline.heightMm - 2, 2 + draft.pins.length * 2.54),
        type: (patch.type ?? 'digital') as PinRole,
        capabilities: patch.capabilities ?? [],
        ...(patch.description ? { description: patch.description } : {}),
      };
      change((d) => ({ ...d, pins: [...d.pins, pin] }));
      set({ selectedPinId: id });
      return id;
    },

    updatePin(pinId, patch) {
      change((draft) => ({
        ...draft,
        pins: draft.pins.map((p) => (p.id === pinId ? { ...p, ...patch } : p)),
      }));
      if (patch.id && patch.id !== pinId) set({ selectedPinId: patch.id });
    },

    movePin(pinId, xMm, yMm) {
      change((draft) => ({
        ...draft,
        pins: draft.pins.map((p) =>
          p.id === pinId
            ? {
                ...p,
                xMm: Math.min(draft.outline.widthMm, Math.max(0, Math.round(xMm * 100) / 100)),
                yMm: Math.min(draft.outline.heightMm, Math.max(0, Math.round(yMm * 100) / 100)),
              }
            : p,
        ),
      }));
    },

    removePin(pinId) {
      change((draft) => ({ ...draft, pins: draft.pins.filter((p) => p.id !== pinId) }));
      if (get().selectedPinId === pinId) set({ selectedPinId: null });
    },

    selectPin(pinId) {
      set({ selectedPinId: pinId });
    },

    /**
     * Reads a pin map into the draft.
     *
     * Rows that cannot be read are REPORTED, never dropped quietly: a user who
     * imports 40 pins and gets 38 needs to know which two and why. The
     * processor is passed in only so pads can be checked against it — a CSV
     * never selects a chip.
     */
    importPinCsv(text) {
      const draft = get().draft;
      if (!draft) return { added: 0, errors: [] };
      const { headers, rows } = parseCsv(text);
      const result = pinsFromCsv(headers, rows, draft.processorProfileId);
      if (result.pins.length > 0) {
        const taken = new Set(draft.pins.map((p) => p.id));
        const merged = [...draft.pins];
        for (const pin of result.pins) {
          if (taken.has(pin.id)) {
            // Same id twice means the same pin twice: the imported row wins,
            // because importing a pin map is how a user corrects one.
            const at = merged.findIndex((p) => p.id === pin.id);
            merged[at] = pin;
          } else {
            merged.push(pin);
            taken.add(pin.id);
          }
        }
        change((d) => ({ ...d, pins: merged.slice(0, CUSTOM_BOARD_LIMITS.maxPins) }));
      }
      // The suggestion is offered with its evidence, and applied by nobody.
      const suggestions = suggestProcessors(text, result.pins.map((p) => p.pad ?? '').filter(Boolean));
      set({
        suggestions,
        notes: [
          ...get().notes,
          {
            kind: 'info',
            text:
              `Read ${result.pins.length} pin(s)` +
              (Object.keys(result.usedColumns).length > 0
                ? ` using the columns ${Object.values(result.usedColumns).join(', ')}.`
                : '.') +
              (result.errors.length > 0 ? ` ${result.errors.length} row(s) could not be read.` : ''),
          },
          ...result.warnings.map((text) => ({ kind: 'warning' as const, text })),
        ],
      });
      return { added: result.pins.length, errors: result.errors };
    },

    readyToSave() {
      const { draft, baseline } = get();
      if (!draft) return null;
      const { problems, board } = validateCustomBoard(draft);
      if (!board || problems.some(isError)) return null;
      return withNextRevision(board, baseline ?? undefined);
    },

    markSaved(stored) {
      set({ draft: stored, baseline: stored, savedRevision: stored.revision, ...derive(stored) });
    },
  };
});

/**
 * What the draft can do, right now, for the capability panel.
 *
 * Read out of the profiles on every call rather than stored, which is what
 * makes it impossible for the Studio to display a capability the board does
 * not have: there is nowhere to put one.
 */
export function draftCapability(draft: CustomBoardDefinition | null) {
  if (!draft) return null;
  // Deliberately NOT gated on the draft being fully valid. A board halfway
  // through being made is not valid — it has no pins yet — and that is exactly
  // when a person most needs to see what choosing a chip would give them.
  // Capability reads only the three profile ids, so it is answerable from an
  // incomplete draft without inventing anything.
  return capabilitySummary(draft);
}
