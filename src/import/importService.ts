// Import center dispatch: detects file type, runs the matching real parser.

import JSZip from 'jszip';
import { ImportError, type ImportParseResult, type ImportedPin } from './types';
import { checkFileSize, sanitizeSvg, safeZipEntries } from './security';
import { parseKicadPcb } from './parsers/kicadParser';
import { parseEagle } from './parsers/eagleParser';
import { parseFritzing } from './parsers/fritzingParser';
import { parseEasyEda } from './parsers/easyedaParser';
import { parseGerberLayer, gerberResult } from './parsers/gerberParser';
import { normalizeProject } from '../project/projectService';
import { uid, type CircuitProject } from '../types';

export interface ImportFormatInfo {
  id: string;
  name: string;
  extensions: string[];
  description: string;
  capability: string;
}

export const IMPORT_FORMATS: ImportFormatInfo[] = [
  {
    id: 'circuitdesk',
    name: 'CircuitDesk project',
    extensions: ['.cdproj.json', '.json'],
    description: 'Full project restore: canvas, wiring, code, tests, custom parts, settings.',
    capability: 'Complete restore',
  },
  {
    id: 'csv',
    name: 'CSV pin map',
    extensions: ['.csv'],
    description: 'Pin tables (pin, label, x, y, type, voltage…) with column mapping and manual editing.',
    capability: 'Pins → custom board',
  },
  {
    id: 'kicad',
    name: 'KiCad',
    extensions: ['.kicad_pcb', '.kicad_mod', '.zip'],
    description: 'Parses .kicad_pcb/.kicad_mod: Edge.Cuts outline, footprints, pads with numbers, positions and nets.',
    capability: 'Real s-expression parsing',
  },
  {
    id: 'fritzing',
    name: 'Fritzing',
    extensions: ['.fzz', '.fzpz', '.fzp'],
    description: 'Opens part archives, extracts connector ids/names, SVG artwork and maps connectors to SVG elements.',
    capability: 'Real archive + XML extraction',
  },
  {
    id: 'eagle',
    name: 'Autodesk Eagle',
    extensions: ['.brd', '.sch', '.lbr'],
    description: 'Parses Eagle XML: layer-20 outline, elements, packages, pads/SMDs, signal names.',
    capability: 'Real XML parsing',
  },
  {
    id: 'easyeda',
    name: 'EasyEDA',
    extensions: ['.json', '.easyeda.json'],
    description: 'Detects EasyEDA document structures; extracts board shape, pads, components and coordinates.',
    capability: 'Real JSON structure parsing',
  },
  {
    id: 'gerber',
    name: 'Gerber / drill',
    extensions: ['.gbr', '.ger', '.gtl', '.gbl', '.gto', '.gbo', '.gts', '.gbs', '.gm1', '.gko', '.drl', '.zip'],
    description: 'Parses RS-274X apertures/draws/flashes and Excellon drills; renders layers as a visual reference.',
    capability: 'Visual reference with layer toggles',
  },
  {
    id: 'svg',
    name: 'SVG board art',
    extensions: ['.svg'],
    description: 'Sanitized SVG artwork with physical dimensions and manual pin placement.',
    capability: 'Artwork → custom board',
  },
  {
    id: 'zip-bundle',
    name: 'Zipped part bundle',
    extensions: ['.zip'],
    description: 'metadata.json + board.svg + pinmap.csv (+ optional docs) → complete custom part.',
    capability: 'Complete part import',
  },
];

const GERBER_EXT = /\.(gbr|ger|gtl|gbl|gto|gbo|gts|gbs|gm1|gko|g2|g3|drl|xln)$/i;

export async function detectAndParse(file: File): Promise<ImportParseResult> {
  checkFileSize(file);
  const name = file.name;
  const lower = name.toLowerCase();

  if (lower.endsWith('.kicad_pcb') || lower.endsWith('.kicad_mod') || lower.endsWith('.kicad_sym') || lower.endsWith('.kicad_sch')) {
    if (lower.endsWith('.kicad_sym') || lower.endsWith('.kicad_sch')) {
      const result = parseKicadPcb(await file.text());
      result.warnings.push('Schematic/symbol file: only coordinates present in the file could be used. For full pad data import the .kicad_pcb.');
      return result;
    }
    return parseKicadPcb(await file.text());
  }
  if (lower.endsWith('.fzz') || lower.endsWith('.fzpz') || lower.endsWith('.fzp')) return parseFritzing(file);
  if (lower.endsWith('.brd') || lower.endsWith('.sch') || lower.endsWith('.lbr')) return parseEagle(await file.text(), name);
  if (lower.endsWith('.svg')) return parseSvgBoard(await file.text(), name);
  if (GERBER_EXT.test(lower)) {
    const layer = parseGerberLayer(await file.text(), name);
    return gerberResult([layer], name.replace(GERBER_EXT, ''));
  }
  if (lower.endsWith('.csv')) return parseCsvPinMap(await file.text(), name);
  if (lower.endsWith('.json')) {
    const text = await file.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (json.kind === 'circuitdesk-project' || (json.boardInstances && json.codeFiles)) {
        return parseCircuitDeskProject(json, name);
      }
      if (json.kind === 'board-definition' && json.definition) {
        return boardDefinitionResult(json, name);
      }
    } catch (err) {
      if (err instanceof ImportError) throw err;
      throw new ImportError('The file is not valid JSON.');
    }
    return parseEasyEda(text, name);
  }
  if (lower.endsWith('.zip')) return parseZipAuto(file);

  throw new ImportError(
    `Unsupported file type "${name.split('.').pop()}". Supported: ${IMPORT_FORMATS.flatMap((f) => f.extensions).join(', ')}`,
  );
}

// ---------- CircuitDesk project ----------

function parseCircuitDeskProject(json: Record<string, unknown>, fileName: string): ImportParseResult {
  const project = normalizeProject(json);
  // fresh id so imports never overwrite an existing project silently
  const imported: CircuitProject = { ...project, id: uid('proj') };
  return {
    format: 'circuitdesk',
    name: project.name || fileName,
    warnings: [],
    project: imported,
    objectCounts: {
      boards: imported.boardInstances.length,
      components: imported.componentInstances.length,
      wires: imported.connections.length,
      codeFiles: imported.codeFiles.length,
      tests: imported.tests.length,
      customParts: imported.customDefinitions.length,
    },
  };
}

function boardDefinitionResult(json: Record<string, unknown>, fileName: string): ImportParseResult {
  const def = json.definition as { name?: string; pins?: { id: string; label: string; x: number; y: number }[]; widthMm?: number; heightMm?: number };
  const pins: ImportedPin[] = (def.pins ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    xMm: p.x / 4,
    yMm: p.y / 4,
  }));
  return {
    format: 'circuitdesk',
    name: def.name ?? fileName,
    warnings: [],
    pins,
    outline: { widthMm: def.widthMm ?? 40, heightMm: def.heightMm ?? 30 },
    metadata: { boardDefinition: json.definition },
    objectCounts: { pins: pins.length },
  };
}

// ---------- CSV ----------

export function parseCsvText(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim().length > 0)) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);
  if (rows.length === 0) throw new ImportError('The CSV file is empty.');
  return { headers: rows[0].map((h) => h.trim()), rows: rows.slice(1) };
}

function parseCsvPinMap(text: string, fileName: string): ImportParseResult {
  const csv = parseCsvText(text);
  const warnings: string[] = [];
  if (csv.rows.length === 0) warnings.push('The CSV has a header but no data rows.');
  // auto-map common columns for the preview; the wizard lets the user remap
  const pins = autoMapCsvPins(csv.headers, csv.rows);
  return {
    format: 'csv',
    name: fileName.replace(/\.csv$/i, ''),
    warnings,
    csv,
    pins,
    outline: pins.length > 0 ? {
      widthMm: Math.max(10, ...pins.map((p) => p.xMm + 4)),
      heightMm: Math.max(10, ...pins.map((p) => p.yMm + 4)),
    } : undefined,
    objectCounts: { rows: csv.rows.length, columns: csv.headers.length },
  };
}

export function autoMapCsvPins(headers: string[], rows: string[][], mapping?: Record<string, number>): ImportedPin[] {
  const lower = headers.map((h) => h.toLowerCase());
  const col = (names: string[], fallback: number = -1): number => {
    for (const n of names) {
      const idx = lower.indexOf(n);
      if (idx >= 0) return idx;
    }
    return fallback;
  };
  const m = {
    pin: mapping?.pin ?? col(['pin', 'number', 'id'], 0),
    label: mapping?.label ?? col(['label', 'name'], col(['pin'], 0)),
    x: mapping?.x ?? col(['x', 'x_mm', 'xmm']),
    y: mapping?.y ?? col(['y', 'y_mm', 'ymm']),
    type: mapping?.type ?? col(['type']),
    voltage: mapping?.voltage ?? col(['voltage', 'v']),
    maxCurrent: mapping?.maxCurrent ?? col(['maxcurrent', 'max_current', 'maxcurrentma', 'current']),
    capabilities: mapping?.capabilities ?? col(['capabilities', 'caps']),
    notes: mapping?.notes ?? col(['notes', 'description']),
  };
  return rows.map((row, i) => {
    const get = (idx: number) => (idx >= 0 && idx < row.length ? row[idx].trim() : '');
    const x = Number(get(m.x));
    const y = Number(get(m.y));
    return {
      id: get(m.pin) || `pin${i + 1}`,
      label: get(m.label) || get(m.pin) || `Pin ${i + 1}`,
      xMm: Number.isFinite(x) && get(m.x) !== '' ? x : 2 + (i % 20) * 2.54,
      yMm: Number.isFinite(y) && get(m.y) !== '' ? y : 2 + Math.floor(i / 20) * 2.54,
      type: (get(m.type) || undefined) as ImportedPin['type'],
      voltage: get(m.voltage) ? Number(get(m.voltage)) : undefined,
      maxCurrentMa: get(m.maxCurrent) ? Number(get(m.maxCurrent)) : undefined,
      capabilities: get(m.capabilities) ? get(m.capabilities).split(/[|;]/).map((s) => s.trim()) : undefined,
      notes: get(m.notes) || undefined,
    };
  });
}

// ---------- SVG ----------

function parseSvgBoard(text: string, fileName: string): ImportParseResult {
  const svg = sanitizeSvg(text);
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  const parseLen = (v: string | null | undefined): number | null => {
    if (!v) return null;
    const m = /^([\d.]+)\s*(mm|cm|in|px)?$/.exec(v.trim());
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === 'mm' ? n : m[2] === 'cm' ? n * 10 : m[2] === 'in' ? n * 25.4 : n / 3.7795; // px @96dpi
  };
  let widthMm = parseLen(svgEl?.getAttribute('width'));
  let heightMm = parseLen(svgEl?.getAttribute('height'));
  const warnings: string[] = [];
  if (!widthMm || !heightMm) {
    const vb = svgEl?.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
    if (vb && vb.length === 4) {
      widthMm = vb[2] / 3.7795;
      heightMm = vb[3] / 3.7795;
      warnings.push('The SVG has no physical units — dimensions estimated from the viewBox at 96 dpi. Adjust them in the mapping step.');
    } else {
      widthMm = 50;
      heightMm = 35;
      warnings.push('The SVG declares no size — defaulting to 50×35 mm. Adjust in the mapping step.');
    }
  }
  return {
    format: 'svg',
    name: fileName.replace(/\.svg$/i, ''),
    warnings,
    svg,
    pins: [],
    outline: { widthMm, heightMm },
  };
}

// ---------- ZIP (bundle / kicad / gerber auto-detect) ----------

async function parseZipAuto(file: File): Promise<ImportParseResult> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer()).catch(() => {
    throw new ImportError('Could not open the ZIP archive (corrupt file?).');
  });
  const entries = safeZipEntries(zip);
  const names = entries.map((e) => e.path.toLowerCase());

  // part bundle?
  if (names.some((n) => n.endsWith('metadata.json'))) {
    return parsePartBundle(entries, file.name);
  }
  // kicad project zip?
  const kicad = entries.find((e) => e.path.toLowerCase().endsWith('.kicad_pcb'));
  if (kicad) {
    const result = parseKicadPcb(await kicad.entry.async('text'));
    result.warnings.unshift(`Parsed ${kicad.path} from the archive.`);
    return result;
  }
  // eagle board?
  const brd = entries.find((e) => e.path.toLowerCase().endsWith('.brd'));
  if (brd) return parseEagle(await brd.entry.async('text'), brd.path);
  // gerber set?
  const gerbers = entries.filter((e) => GERBER_EXT.test(e.path.toLowerCase()));
  if (gerbers.length > 0) {
    const layers = [];
    for (const g of gerbers.slice(0, 24)) {
      layers.push(parseGerberLayer(await g.entry.async('text'), g.path.split('/').pop()!));
    }
    return gerberResult(layers, file.name.replace(/\.zip$/i, ''));
  }
  throw new ImportError(
    'The ZIP does not contain a recognizable part bundle (metadata.json), KiCad board, Eagle board or Gerber set.',
  );
}

async function parsePartBundle(entries: { path: string; entry: JSZip.JSZipObject }[], fileName: string): Promise<ImportParseResult> {
  const warnings: string[] = [];
  const findFile = (suffix: string) => entries.find((e) => e.path.toLowerCase().endsWith(suffix));

  const metaEntry = findFile('metadata.json')!;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(await metaEntry.entry.async('text')) as Record<string, unknown>;
  } catch {
    throw new ImportError('metadata.json is not valid JSON.');
  }

  const svgEntry = findFile('board.svg') ?? entries.find((e) => e.path.toLowerCase().endsWith('.svg'));
  const svg = svgEntry ? sanitizeSvg(await svgEntry.entry.async('text')) : undefined;
  if (!svgEntry) warnings.push('Optional board.svg is missing — the part will use a generic body.');

  const csvEntry = findFile('pinmap.csv') ?? entries.find((e) => e.path.toLowerCase().endsWith('.csv'));
  let pins: ImportedPin[] = [];
  let csv: { headers: string[]; rows: string[][] } | undefined;
  if (csvEntry) {
    csv = parseCsvText(await csvEntry.entry.async('text'));
    pins = autoMapCsvPins(csv.headers, csv.rows);
  } else {
    warnings.push('Optional pinmap.csv is missing — place pins manually in the mapping step.');
  }
  if (!findFile('datasheet.pdf')) warnings.push('Optional datasheet.pdf not included.');

  const widthMm = typeof meta.widthMm === 'number' ? meta.widthMm : pins.length > 0 ? Math.max(10, ...pins.map((p) => p.xMm + 4)) : 40;
  const heightMm = typeof meta.heightMm === 'number' ? meta.heightMm : pins.length > 0 ? Math.max(10, ...pins.map((p) => p.yMm + 4)) : 30;

  return {
    format: 'zip-bundle',
    name: (typeof meta.name === 'string' && meta.name) || fileName.replace(/\.zip$/i, ''),
    warnings,
    svg,
    csv,
    pins,
    outline: { widthMm, heightMm },
    metadata: meta,
    objectCounts: { files: entries.length, pins: pins.length },
  };
}
