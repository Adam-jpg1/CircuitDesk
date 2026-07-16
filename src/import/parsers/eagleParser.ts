// Real Autodesk Eagle XML parser (.brd boards, .sch schematics, .lbr libraries).

import { parseXmlSafe } from '../security';
import { ImportError, type ImportParseResult, type ImportedPin, type ImportedComponentRef } from '../types';

export function parseEagle(text: string, fileName: string): ImportParseResult {
  const doc = parseXmlSafe(text, 'Eagle file');
  const eagle = doc.querySelector('eagle');
  if (!eagle) throw new ImportError('Not an Eagle XML file (missing <eagle> root). Old binary Eagle files are not supported — re-save as XML from Eagle 6+.');

  const warnings: string[] = [];
  const pins: ImportedPin[] = [];
  const components: ImportedComponentRef[] = [];
  const nets = new Set<string>();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const touch = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };

  // package pad library: library -> package -> pads
  const packagePads = new Map<string, { name: string; x: number; y: number; kind: string }[]>();
  for (const lib of doc.querySelectorAll('library')) {
    const libName = lib.getAttribute('name') ?? '';
    for (const pkg of lib.querySelectorAll('package')) {
      const pkgName = pkg.getAttribute('name') ?? '';
      const pads: { name: string; x: number; y: number; kind: string }[] = [];
      for (const pad of pkg.querySelectorAll('pad')) {
        pads.push({
          name: pad.getAttribute('name') ?? `p${pads.length + 1}`,
          x: Number(pad.getAttribute('x') ?? 0),
          y: Number(pad.getAttribute('y') ?? 0),
          kind: 'through-hole',
        });
      }
      for (const smd of pkg.querySelectorAll('smd')) {
        pads.push({
          name: smd.getAttribute('name') ?? `s${pads.length + 1}`,
          x: Number(smd.getAttribute('x') ?? 0),
          y: Number(smd.getAttribute('y') ?? 0),
          kind: 'smd',
        });
      }
      packagePads.set(`${libName}:${pkgName}`, pads);
      packagePads.set(pkgName, pads);
    }
  }

  // board outline: wires on layer 20 (Dimension)
  for (const wire of doc.querySelectorAll('plain > wire, board > plain > wire')) {
    if (wire.getAttribute('layer') === '20') {
      touch(Number(wire.getAttribute('x1')), Number(wire.getAttribute('y1')));
      touch(Number(wire.getAttribute('x2')), Number(wire.getAttribute('y2')));
    }
  }

  // board elements (placed parts)
  for (const el of doc.querySelectorAll('elements > element')) {
    const name = el.getAttribute('name') ?? 'EL';
    const pkgKey = `${el.getAttribute('library') ?? ''}:${el.getAttribute('package') ?? ''}`;
    const ex = Number(el.getAttribute('x') ?? 0);
    const ey = Number(el.getAttribute('y') ?? 0);
    let rot = 0;
    const rotAttr = el.getAttribute('rot');
    if (rotAttr) {
      const m = /R(-?\d+(\.\d+)?)/.exec(rotAttr);
      if (m) rot = Number(m[1]);
    }
    components.push({ name, xMm: ex, yMm: ey, footprint: el.getAttribute('package') ?? undefined });
    const pads = packagePads.get(pkgKey) ?? packagePads.get(el.getAttribute('package') ?? '') ?? [];
    const rad = (rot * Math.PI) / 180;
    for (const pad of pads) {
      const gx = ex + pad.x * Math.cos(rad) - pad.y * Math.sin(rad);
      const gy = ey + pad.x * Math.sin(rad) + pad.y * Math.cos(rad);
      pins.push({ id: `${name}-${pad.name}-${pins.length}`, label: `${name}.${pad.name}`, xMm: gx, yMm: gy, notes: pad.kind });
      touch(gx, gy);
    }
  }

  // signals / nets
  for (const sig of doc.querySelectorAll('signals > signal, nets > net')) {
    const n = sig.getAttribute('name');
    if (n) nets.add(n);
  }

  // library-only file: expose the first package's pads directly
  if (pins.length === 0 && packagePads.size > 0) {
    const [pkgName, pads] = [...packagePads.entries()].find(([, v]) => v.length > 0) ?? ['', []];
    for (const pad of pads) {
      pins.push({ id: `${pad.name}-${pins.length}`, label: pad.name, xMm: pad.x, yMm: pad.y, notes: pad.kind });
      touch(pad.x, pad.y);
    }
    if (pads.length > 0) warnings.push(`Library file: imported pads from package "${pkgName.split(':').pop()}".`);
  }

  // schematic-only file: parts without coordinates
  if (pins.length === 0 && components.length === 0) {
    for (const part of doc.querySelectorAll('parts > part')) {
      components.push({ name: part.getAttribute('name') ?? '?', xMm: 0, yMm: 0 });
    }
    if (components.length > 0) warnings.push('Schematic file: extracted the part list; positions are not available in schematics.');
  }

  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 60; maxY = 40;
    if (pins.length > 0) warnings.push('No layer-20 outline found — board size estimated from pads.');
  }

  // Eagle Y axis points up; flip so it matches CircuitDesk (Y down) and rebase to 0,0.
  for (const p of pins) {
    p.xMm -= minX;
    p.yMm = maxY - p.yMm;
  }
  for (const c of components) {
    c.xMm -= minX;
    c.yMm = maxY - c.yMm;
  }

  if (pins.length === 0 && components.length === 0) {
    warnings.push('No pads, elements or parts could be extracted from this Eagle file.');
  }

  return {
    format: 'eagle',
    name: fileName.replace(/\.(brd|sch|lbr)$/i, ''),
    warnings,
    pins,
    components,
    nets: [...nets],
    outline: { widthMm: Math.max(5, maxX - minX), heightMm: Math.max(5, maxY - minY) },
    objectCounts: { elements: components.length, pads: pins.length, signals: nets.size },
  };
}
