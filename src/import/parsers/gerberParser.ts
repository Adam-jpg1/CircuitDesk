// Real (minimal) Gerber RS-274X + Excellon drill parser: apertures, draw/move/
// flash operations, coordinate format handling — enough to render a useful
// visual reference of each layer.

import type { GerberLayerData, ImportParseResult } from '../types';

interface CoordFormat {
  intDigits: number;
  decDigits: number;
  unitScale: number; // to mm
  zeroOmission: 'leading' | 'trailing';
}

function classifyLayer(name: string): GerberLayerData['kind'] {
  const n = name.toLowerCase();
  if (/\.(drl|xln|txt)$/.test(n) || n.includes('drill')) return 'drill';
  if (/\.(gko|gm1)$/.test(n) || n.includes('outline') || n.includes('edge')) return 'outline';
  if (/\.(gto|gbo)$/.test(n) || n.includes('silk')) return 'silk';
  if (/\.(gts|gbs)$/.test(n) || n.includes('mask')) return 'mask';
  if (/\.(gtl|gbl|g2|g3)$/.test(n) || n.includes('copper')) return 'copper';
  return 'other';
}

export function parseGerberLayer(text: string, fileName: string): GerberLayerData {
  const kind = classifyLayer(fileName);
  if (kind === 'drill' || /^M48/m.test(text)) return parseExcellon(text, fileName);

  const fmt: CoordFormat = { intDigits: 3, decDigits: 5, unitScale: 25.4, zeroOmission: 'leading' };
  const apertures = new Map<string, number>(); // code -> diameter mm (approx for non-circle)
  let currentAperture = 0.15;
  let x = 0, y = 0;
  const paths: { x: number; y: number }[][] = [];
  const flashes: { x: number; y: number; d: number }[] = [];
  let currentPath: { x: number; y: number }[] = [];

  const flushPath = () => {
    if (currentPath.length > 1) paths.push(currentPath);
    currentPath = [];
  };

  const parseCoord = (raw: string): number => {
    const negative = raw.startsWith('-');
    let digits = raw.replace('-', '');
    const total = fmt.intDigits + fmt.decDigits;
    if (digits.length < total) {
      digits =
        fmt.zeroOmission === 'leading'
          ? digits.padStart(total, '0')
          : digits.padEnd(total, '0');
    }
    const value = Number(digits) / Math.pow(10, fmt.decDigits);
    return (negative ? -value : value) * fmt.unitScale;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const fs = /%FS([LT])A?X(\d)(\d)Y\d\d\*%/.exec(line);
    if (fs) {
      fmt.zeroOmission = fs[1] === 'T' ? 'trailing' : 'leading';
      fmt.intDigits = Number(fs[2]);
      fmt.decDigits = Number(fs[3]);
      continue;
    }
    if (line.includes('%MOMM')) { fmt.unitScale = 1; continue; }
    if (line.includes('%MOIN')) { fmt.unitScale = 25.4; continue; }

    const ad = /%ADD(\d+)([A-Z]+),?([\d.X]*)\*%/.exec(line);
    if (ad) {
      const params = (ad[3] ?? '').split('X').map(Number);
      const d = Number.isFinite(params[0]) && params[0] > 0 ? params[0] * (fmt.unitScale === 1 ? 1 : 25.4) : 1;
      apertures.set(ad[1], d);
      continue;
    }
    const tool = /^(?:G54)?D(\d+)\*?$/.exec(line);
    if (tool && Number(tool[1]) >= 10) {
      flushPath();
      currentAperture = apertures.get(tool[1]) ?? 0.2;
      continue;
    }

    // coordinate ops: X..Y..[I..J..]D0n
    const op = /^(?:G0[123])?(?:X(-?\d+))?(?:Y(-?\d+))?(?:I-?\d+)?(?:J-?\d+)?D0([123])\*?$/.exec(line);
    if (op) {
      if (op[1] !== undefined) x = parseCoord(op[1]);
      if (op[2] !== undefined) y = parseCoord(op[2]);
      const code = op[3];
      if (code === '1') {
        if (currentPath.length === 0) currentPath.push({ x, y });
        else currentPath.push({ x, y });
        if (currentPath.length === 1) currentPath.unshift({ x, y });
        currentPath.push({ x, y });
        currentPath = dedupeTail(currentPath);
      } else if (code === '2') {
        flushPath();
        currentPath = [{ x, y }];
      } else if (code === '3') {
        flushPath();
        flashes.push({ x, y, d: currentAperture });
        currentPath = [{ x, y }];
      }
      continue;
    }
  }
  flushPath();

  return { name: fileName, kind, paths, flashes, visible: kind !== 'mask' };
}

function dedupeTail(path: { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out;
}

function parseExcellon(text: string, fileName: string): GerberLayerData {
  const flashes: { x: number; y: number; d: number }[] = [];
  const tools = new Map<string, number>();
  let unitScale = 25.4;
  let currentTool = 1;
  let decimalCoords = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === 'METRIC' || line.startsWith('METRIC,')) { unitScale = 1; continue; }
    if (line === 'INCH' || line.startsWith('INCH,')) { unitScale = 25.4; continue; }
    const toolDef = /^T(\d+).*C([\d.]+)/.exec(line);
    if (toolDef) {
      tools.set(toolDef[1], Number(toolDef[2]) * unitScale);
      continue;
    }
    const toolSel = /^T(\d+)$/.exec(line);
    if (toolSel) {
      currentTool = Number(toolSel[1]);
      continue;
    }
    const hit = /^X(-?[\d.]+)Y(-?[\d.]+)/.exec(line);
    if (hit) {
      decimalCoords = hit[1].includes('.') || hit[2].includes('.');
      const scale = decimalCoords ? unitScale : unitScale / 10000; // common 2.4 format
      flashes.push({
        x: Number(hit[1]) * scale,
        y: Number(hit[2]) * scale,
        d: tools.get(String(currentTool)) ?? 0.8,
      });
    }
  }
  return { name: fileName, kind: 'drill', paths: [], flashes, visible: true };
}

export function gerberResult(layers: GerberLayerData[], name: string): ImportParseResult {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const layer of layers) {
    for (const path of layer.paths) for (const p of path) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    for (const f of layer.flashes) {
      minX = Math.min(minX, f.x - f.d); minY = Math.min(minY, f.y - f.d);
      maxX = Math.max(maxX, f.x + f.d); maxY = Math.max(maxY, f.y + f.d);
    }
  }
  const warnings: string[] = [];
  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 60; maxY = 40;
    warnings.push('No drawable geometry was found in the Gerber data.');
  }
  // rebase to origin and flip Y (Gerber Y is up)
  for (const layer of layers) {
    for (const path of layer.paths) for (const p of path) {
      p.x -= minX;
      p.y = maxY - p.y;
    }
    for (const f of layer.flashes) {
      f.x -= minX;
      f.y = maxY - f.y;
    }
  }
  const empty = layers.filter((l) => l.paths.length === 0 && l.flashes.length === 0);
  if (empty.length > 0) warnings.push(`Layers with no parsed geometry: ${empty.map((l) => l.name).join(', ')}`);

  return {
    format: 'gerber',
    name,
    warnings,
    layers,
    outline: { widthMm: Math.max(5, maxX - minX), heightMm: Math.max(5, maxY - minY) },
    objectCounts: Object.fromEntries(layers.map((l) => [l.name, l.paths.length + l.flashes.length])),
  };
}
