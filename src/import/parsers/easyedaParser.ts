// Real EasyEDA JSON importer: detects EasyEDA document structures and extracts
// the board shape, pads and component references from the `shape` array
// (EasyEDA encodes objects as ~-separated strings).

import { ImportError, type ImportParseResult, type ImportedPin, type ImportedComponentRef } from '../types';

const MIL_TO_MM = 0.254; // EasyEDA canvas units are 10 mil

export function parseEasyEda(text: string, fileName: string): ImportParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError('Not valid JSON.');
  }
  const doc = json as Record<string, unknown>;
  const shapes: string[] = [];
  collectShapes(doc, shapes);
  if (shapes.length === 0 && !doc.head && !doc.canvas) {
    throw new ImportError('This JSON does not look like an EasyEDA document (no head/canvas/shape structures).');
  }

  const warnings: string[] = [];
  const pins: ImportedPin[] = [];
  const components: ImportedComponentRef[] = [];
  const counts: Record<string, number> = {};

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const touch = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };

  for (const shape of shapes) {
    const kind = shape.split('~')[0];
    counts[kind] = (counts[kind] ?? 0) + 1;
    const parts = shape.split('~');
    if (kind === 'PAD') {
      // PAD~shape~x~y~w~h~layer~net~number~...
      const x = Number(parts[2]) * MIL_TO_MM;
      const y = Number(parts[3]) * MIL_TO_MM;
      const net = parts[7] || undefined;
      const number = parts[8] || String(pins.length + 1);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        pins.push({ id: `pad-${pins.length}`, label: number, xMm: x, yMm: y, net });
        touch(x, y);
      }
    } else if (kind === 'TRACK' || kind === 'ARC') {
      // TRACK~width~layer~net~x1 y1 x2 y2...~id
      const coords = (parts[4] ?? '').split(/\s+/).map(Number);
      for (let i = 0; i + 1 < coords.length; i += 2) touch(coords[i] * MIL_TO_MM, coords[i + 1] * MIL_TO_MM);
    } else if (kind === 'LIB') {
      // LIB~x~y~package~...
      const x = Number(parts[1]) * MIL_TO_MM;
      const y = Number(parts[2]) * MIL_TO_MM;
      const pkgAttrs = parts[3] ?? '';
      const pkg = /package`([^`]+)`/.exec(pkgAttrs)?.[1];
      components.push({ name: pkg ?? `part ${components.length + 1}`, xMm: x, yMm: y, footprint: pkg });
      touch(x, y);
    }
  }

  const head = doc.head as Record<string, unknown> | undefined;
  const cPara = head?.c_para as Record<string, unknown> | undefined;
  const name =
    (typeof doc.title === 'string' && doc.title) ||
    (typeof cPara?.name === 'string' && (cPara.name as string)) ||
    (typeof head?.title === 'string' && (head.title as string)) ||
    fileName.replace(/\.(easyeda\.)?json$/i, '');

  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 60; maxY = 40;
    warnings.push('No coordinates found — this may be a schematic-only document.');
  }
  for (const p of pins) {
    p.xMm -= minX;
    p.yMm -= minY;
  }
  for (const c of components) {
    c.xMm -= minX;
    c.yMm -= minY;
  }
  if (pins.length === 0) warnings.push('No PAD objects found. Objects seen: ' + Object.keys(counts).join(', '));

  return {
    format: 'easyeda',
    name,
    warnings,
    pins,
    components,
    outline: { widthMm: Math.max(5, maxX - minX), heightMm: Math.max(5, maxY - minY) },
    objectCounts: counts,
  };
}

function collectShapes(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 20_000) return;
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.shape)) {
    for (const s of obj.shape) if (typeof s === 'string') out.push(s);
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') collectShapes(value, out, depth + 1);
  }
}
