// Turning what an importer found into a board somebody can run.
//
// The importers already extract geometry and pads from KiCad, Eagle, Fritzing,
// EasyEDA, Gerber, SVG and CSV. What none of them can do — and must never do —
// is decide which processor the board carries. A pad table says where the
// copper is, not what is soldered to it, and a wrong guess produces a board
// that compiles for the wrong chip and fails somewhere far away from the import.
//
// So this file does two things. It converts an import into a CustomBoardDefinition
// with NO processor selected, which is the honest starting state and a
// perfectly usable board on its own. And it SUGGESTS a processor when the file
// says one unambiguously, as a question with the evidence attached, never as an
// assignment.
//
// The CSV path is deliberately forgiving. The flagship workflow is "here are my
// pin names and which pad each goes to" — two columns — and everything else is
// optional, because a person who has to fill in eight columns before they can
// see anything will not finish.

import { CUSTOM_BOARD_SCHEMA_VERSION, CUSTOM_BOARD_LIMITS, type CustomBoardDefinition, type CustomBoardPin, type PinRole } from './schema';
import { PROCESSOR_PROFILES, processorProfile, hasPad } from '../boards/processorProfiles';
import { compileProfilesFor, runtimeProfilesFor } from '../boards/pipelineProfiles';

/** One row of a pin map, before it is a pin. */
export interface PinRow {
  /** Row number in the source, so an error can point at it. */
  row: number;
  values: Record<string, string>;
}

export interface CsvPinImport {
  pins: CustomBoardPin[];
  /** Row-level problems. Bad rows are reported, never silently dropped. */
  errors: { row: number; message: string }[];
  warnings: string[];
  /** Columns that were recognised, so the preview can say what it used. */
  usedColumns: Record<string, string>;
}

/**
 * Column names accepted for each field.
 *
 * Generous on purpose: a pin map exported from a spreadsheet, a datasheet table
 * or another tool will spell these a dozen ways, and rejecting a file because
 * its header says "Pin Name" instead of "label" is a bad first experience.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  id: ['id', 'pin_id', 'pinid', 'key', 'name'],
  label: ['label', 'pin', 'pin_name', 'pinname', 'signal', 'net', 'silkscreen', 'text'],
  pad: ['processor_pin', 'processorpin', 'pad', 'gpio', 'mcu_pin', 'mcupin', 'chip_pin', 'port', 'processor'],
  x: ['x', 'x_mm', 'xmm', 'pos_x', 'posx'],
  y: ['y', 'y_mm', 'ymm', 'pos_y', 'posy'],
  side: ['side', 'edge', 'row'],
  type: ['type', 'kind', 'role', 'function'],
};

/** Pin roles a CSV may name, in the words people actually write. */
const TYPE_WORDS: Record<string, PinRole> = {
  digital: 'digital', gpio: 'digital', io: 'digital', signal: 'digital',
  analog: 'analog', analogue: 'analog', adc: 'analog',
  power: 'power-5v', vcc: 'power-5v', '5v': 'power-5v', vin: 'power-vin', vsys: 'power-vin',
  '3v3': 'power-3v3', '3.3v': 'power-3v3', vdd: 'power-3v3',
  gnd: 'ground', ground: 'ground', vss: 'ground',
  reset: 'reset', rst: 'reset', aref: 'aref', nc: 'nc',
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** An id that is safe and stable, derived from a label when none was given. */
function idFromLabel(label: string, taken: Set<string>): string {
  const base = label.trim().toUpperCase().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'PIN';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

/**
 * Reads a pin map.
 *
 * Only a label is genuinely required — the flagship CSV is two columns, and the
 * user places the pins visually afterwards. Everything else is filled in when
 * present and left for the editor when not.
 */
export function pinsFromCsv(
  headers: string[],
  rows: string[][],
  processorProfileId: string | null,
): CsvPinImport {
  const errors: CsvPinImport['errors'] = [];
  const warnings: string[] = [];
  const normalized = headers.map(normalizeHeader);
  const usedColumns: Record<string, string> = {};
  const columnFor = (field: string): number => {
    for (const alias of COLUMN_ALIASES[field] ?? []) {
      const index = normalized.indexOf(alias);
      if (index >= 0) {
        usedColumns[field] = headers[index];
        return index;
      }
    }
    return -1;
  };

  const cols = {
    id: columnFor('id'),
    label: columnFor('label'),
    pad: columnFor('pad'),
    x: columnFor('x'),
    y: columnFor('y'),
    side: columnFor('side'),
    type: columnFor('type'),
  };

  if (cols.label < 0 && cols.id < 0) {
    errors.push({ row: 0, message: 'The pin map needs at least a "label" or "id" column. Found: ' + headers.join(', ') });
    return { pins: [], errors, warnings, usedColumns };
  }

  const processor = processorProfileId ? processorProfile(processorProfileId) : undefined;
  const pins: CustomBoardPin[] = [];
  const taken = new Set<string>();
  const seenPads = new Map<string, number>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // header is row 1, as a spreadsheet counts
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    const label = cell(cols.label) || cell(cols.id);
    if (!label) {
      // A trailing blank line is not an error; a row with data but no name is.
      if (row.some((v) => v.trim() !== '')) {
        errors.push({ row: rowNumber, message: 'no pin label or id in this row' });
      }
      return;
    }
    if (pins.length >= CUSTOM_BOARD_LIMITS.maxPins) {
      errors.push({ row: rowNumber, message: `more than ${CUSTOM_BOARD_LIMITS.maxPins} pins; the rest were not read` });
      return;
    }

    const explicitId = cell(cols.id);
    const id = explicitId && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(explicitId)
      ? (taken.add(explicitId), explicitId)
      : idFromLabel(label, taken);

    let pad: string | null = cell(cols.pad) || null;
    if (pad && processor) {
      // Matched case-insensitively and then stored in the chip's own spelling,
      // because a spreadsheet will say "gp15" and the profile says "GP15".
      const match = processor.pads.find((p) => p.toLowerCase() === pad!.toLowerCase());
      if (match) pad = match;
      else {
        const pads = processor.pads;
        errors.push({
          row: rowNumber,
          message:
            `processor pin ${pad} does not exist on ${processor.name}` +
            (pads.length > 0 ? ` (it has ${pads[0]}-${pads[pads.length - 1]})` : ''),
        });
        pad = null;
      }
    }
    if (pad) {
      const previous = seenPads.get(pad);
      if (previous !== undefined) {
        warnings.push(`Rows ${previous} and ${rowNumber} both map to ${pad}; they will behave as one signal.`);
      } else seenPads.set(pad, rowNumber);
    }

    const typeWord = cell(cols.type).toLowerCase();
    const guessed = TYPE_WORDS[typeWord] ?? TYPE_WORDS[label.trim().toLowerCase()];
    const type: PinRole = guessed ?? (pad && processor && processor.adcChannels[pad] !== undefined && /a(in|dc)?\d*/i.test(label)
      ? 'analog'
      : 'digital');

    const x = Number(cell(cols.x));
    const y = Number(cell(cols.y));
    const hasPosition = Number.isFinite(x) && Number.isFinite(y) && cell(cols.x) !== '' && cell(cols.y) !== '';

    pins.push({
      id,
      label: label.slice(0, CUSTOM_BOARD_LIMITS.maxLabelLength),
      pad,
      // Laid out down the left edge when the file has no coordinates. The user
      // places them visually next, which is the intended flagship workflow —
      // the alternative is refusing a two-column file, which helps nobody.
      xMm: hasPosition ? x : 2.54,
      yMm: hasPosition ? y : 2.54 + pins.length * 2.54,
      type,
      capabilities: [],
    });
  });

  if (pins.length > 0 && cols.x < 0) {
    warnings.push(`The pin map has no coordinates, so the ${pins.length} pins were stacked down the left edge for you to place.`);
  }
  if (cols.pad < 0) {
    warnings.push('No processor-pin column was found, so no pin is mapped to the processor yet.');
  }

  return { pins, errors, warnings, usedColumns };
}

export interface ProcessorSuggestion {
  processorProfileId: string;
  /** What in the file suggested it, quoted, so the user can judge. */
  evidence: string;
  confidence: 'unambiguous' | 'likely';
}

/**
 * What processor the imported file appears to describe.
 *
 * Returns candidates, never a decision. A pad table says where the copper is,
 * not what is soldered to it — and a board silently compiled for the wrong chip
 * fails a long way from the import that caused it. The caller asks the user.
 */
export function suggestProcessors(text: string, padNames: string[] = []): ProcessorSuggestion[] {
  const suggestions: ProcessorSuggestion[] = [];
  const haystack = text.slice(0, 200_000).toLowerCase();

  // A part number in the file is good evidence: it is somebody naming the chip.
  // Left-anchored on a word boundary but NOT right-anchored: part numbers turn
  // up inside identifiers all the time — a KiCad footprint is "RP2040_QFN56",
  // a schematic symbol is "ATmega328P-AU" — and requiring a boundary after the
  // number is how a file that plainly names the chip reports nothing.
  const byName: [string, RegExp][] = [
    ['proc.rp2040', /\brp2040/],
    ['proc.atmega328p', /\batmega\s*-?\s*328p?/],
    ['proc.atmega2560', /\batmega\s*-?\s*2560/],
    ['proc.atmega32u4', /\batmega\s*-?\s*32u4/],
    ['proc.esp32c3', /\besp32[-_\s]?c3/],
    ['proc.esp32c6', /\besp32[-_\s]?c6/],
  ];
  for (const [id, pattern] of byName) {
    const match = pattern.exec(haystack);
    if (match) {
      suggestions.push({
        processorProfileId: id,
        evidence: `the file mentions "${match[0]}"`,
        confidence: 'unambiguous',
      });
    }
  }

  // Pad NAMES are weaker evidence — a board can label a header GP0 without
  // carrying an RP2040 — so they only ever produce a "likely".
  if (suggestions.length === 0 && padNames.length > 0) {
    for (const profile of PROCESSOR_PROFILES) {
      const hits = padNames.filter((p) => hasPad(profile, p.toUpperCase())).length;
      if (hits >= 4 && hits >= padNames.length * 0.5) {
        suggestions.push({
          processorProfileId: profile.id,
          evidence: `${hits} of ${padNames.length} pin names match ${profile.name} pads`,
          confidence: 'likely',
        });
      }
    }
  }

  return suggestions;
}

/**
 * The pipeline CircuitDesk recommends for a processor.
 *
 * This is what Simple Mode uses: somebody who chose "RP2040" should not have to
 * know that UF2 is a format or that rp2040js exists. There is exactly one
 * known-good combination per processor today, and it is picked here rather than
 * presented as a question with one answer.
 */
export function suggestedPipeline(processorProfileId: string | null): {
  compileProfileId: string;
  runtimeProfileId: string;
} {
  if (!processorProfileId) return { compileProfileId: 'compile.none', runtimeProfileId: 'runtime.none' };
  const compile = compileProfilesFor(processorProfileId)[0];
  const runtime = runtimeProfilesFor(processorProfileId)[0];
  return {
    compileProfileId: compile?.id ?? 'compile.none',
    runtimeProfileId: runtime?.id ?? 'runtime.none',
  };
}

export interface BoardFromImportInput {
  name: string;
  creator?: string;
  description?: string;
  widthMm: number;
  heightMm: number;
  artworkSvg?: string;
  pins: CustomBoardPin[];
  /** Null unless the user has confirmed a processor. Never guessed here. */
  processorProfileId?: string | null;
}

/**
 * Assembles a definition from an import.
 *
 * Starts with no processor unless the caller passes one the user has confirmed,
 * which makes the honest default a wiring-only board — a real, usable, saveable
 * thing that nobody has to lie about.
 */
export function boardFromImport(input: BoardFromImportInput): CustomBoardDefinition {
  const processorProfileId = input.processorProfileId ?? null;
  const pipeline = suggestedPipeline(processorProfileId);
  const random = Math.random().toString(36).slice(2, 10);
  return {
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: `custom.${Date.now().toString(36)}${random}`,
    revision: 1,
    identity: {
      name: input.name.slice(0, CUSTOM_BOARD_LIMITS.maxNameLength),
      ...(input.creator ? { creator: input.creator.slice(0, CUSTOM_BOARD_LIMITS.maxNameLength) } : {}),
      ...(input.description ? { description: input.description.slice(0, CUSTOM_BOARD_LIMITS.maxDescriptionLength) } : {}),
    },
    outline: {
      widthMm: Math.min(CUSTOM_BOARD_LIMITS.maxBoardMm, Math.max(CUSTOM_BOARD_LIMITS.minBoardMm, input.widthMm)),
      heightMm: Math.min(CUSTOM_BOARD_LIMITS.maxBoardMm, Math.max(CUSTOM_BOARD_LIMITS.minBoardMm, input.heightMm)),
      ...(input.artworkSvg ? { artworkSvg: input.artworkSvg } : {}),
    },
    pins: input.pins.slice(0, CUSTOM_BOARD_LIMITS.maxPins),
    processorProfileId,
    ...pipeline,
    createdAt: new Date().toISOString(),
  };
}
