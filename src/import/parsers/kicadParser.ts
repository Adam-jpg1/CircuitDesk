// Real KiCad .kicad_pcb parser: a small s-expression reader that extracts the
// board outline (Edge.Cuts), footprints, pads (number, position, size, net).

import type { ImportParseResult, ImportedPin, ImportedComponentRef } from '../types';
import { ImportError } from '../types';

type SExpr = string | SExpr[];

export function parseSExpression(text: string): SExpr {
  let i = 0;
  function skipWs() {
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  function parse(): SExpr {
    skipWs();
    if (text[i] === '(') {
      i++;
      const list: SExpr[] = [];
      for (;;) {
        skipWs();
        if (i >= text.length) throw new ImportError('Unbalanced parentheses in KiCad file.');
        if (text[i] === ')') {
          i++;
          return list;
        }
        list.push(parse());
      }
    }
    if (text[i] === '"') {
      i++;
      let out = '';
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          out += text[i + 1];
          i += 2;
        } else {
          out += text[i++];
        }
      }
      i++;
      return out;
    }
    let out = '';
    while (i < text.length && !/[\s()]/.test(text[i])) out += text[i++];
    return out;
  }
  const result = parse();
  return result;
}

function isList(e: SExpr): e is SExpr[] {
  return Array.isArray(e);
}

function head(e: SExpr): string {
  return isList(e) && typeof e[0] === 'string' ? e[0] : '';
}

function findAll(list: SExpr[], name: string): SExpr[][] {
  return list.filter((e): e is SExpr[] => isList(e) && head(e) === name);
}

function find(list: SExpr[], name: string): SExpr[] | undefined {
  return findAll(list, name)[0];
}

function num(e: SExpr | undefined): number {
  return typeof e === 'string' ? Number(e) : NaN;
}

export function parseKicadPcb(text: string): ImportParseResult {
  const root = parseSExpression(text);
  if (!isList(root) || (head(root) !== 'kicad_pcb' && head(root) !== 'kicad_mod' && head(root) !== 'footprint' && head(root) !== 'module')) {
    throw new ImportError('Not a recognizable KiCad board or footprint file.');
  }
  const warnings: string[] = [];
  const pins: ImportedPin[] = [];
  const components: ImportedComponentRef[] = [];
  const nets = new Set<string>();

  // board outline bbox from Edge.Cuts graphics
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const touch = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };

  const scanGraphics = (list: SExpr[]) => {
    for (const kind of ['gr_line', 'gr_rect', 'gr_arc', 'gr_circle', 'gr_poly', 'segment']) {
      for (const g of findAll(list, kind)) {
        const layer = find(g, 'layer');
        const layerName = layer && typeof layer[1] === 'string' ? layer[1] : '';
        if (!layerName.includes('Edge.Cuts')) continue;
        for (const ptName of ['start', 'end', 'center', 'mid']) {
          const pt = find(g, ptName);
          if (pt) touch(num(pt[1]), num(pt[2]));
        }
        const ptsNode = find(g, 'pts');
        if (ptsNode) {
          for (const xy of findAll(ptsNode, 'xy')) touch(num(xy[1]), num(xy[2]));
        }
      }
    }
  };
  scanGraphics(root);

  const footprintNodes = [...findAll(root, 'footprint'), ...findAll(root, 'module')];
  // a bare .kicad_mod file IS a footprint
  if (footprintNodes.length === 0 && (head(root) === 'footprint' || head(root) === 'module')) {
    footprintNodes.push(root);
  }

  let padCounter = 0;
  for (const fp of footprintNodes) {
    const fpName = typeof fp[1] === 'string' ? fp[1] : 'footprint';
    const at = find(fp, 'at');
    const fx = at ? num(at[1]) : 0;
    const fy = at ? num(at[2]) : 0;
    const rotDeg = at && at[3] !== undefined ? num(at[3]) : 0;
    const refNode = findAll(fp, 'fp_text').find((t) => t[1] === 'reference');
    const ref = refNode && typeof refNode[2] === 'string' ? refNode[2] : fpName.split(':').pop() ?? fpName;
    components.push({ name: ref, xMm: fx, yMm: fy, footprint: fpName });

    for (const pad of findAll(fp, 'pad')) {
      const padName = typeof pad[1] === 'string' ? pad[1] : String(++padCounter);
      const padAt = find(pad, 'at');
      if (!padAt) continue;
      const px = num(padAt[1]);
      const py = num(padAt[2]);
      const rad = (rotDeg * Math.PI) / 180;
      const gx = fx + px * Math.cos(rad) - py * Math.sin(rad);
      const gy = fy + px * Math.sin(rad) + py * Math.cos(rad);
      const netNode = find(pad, 'net');
      const netName = netNode && typeof netNode[2] === 'string' ? netNode[2] : undefined;
      if (netName) nets.add(netName);
      const sizeNode = find(pad, 'size');
      pins.push({
        id: `${ref}-${padName}-${pins.length}`,
        label: `${ref}.${padName}`,
        xMm: gx,
        yMm: gy,
        net: netName,
        notes: sizeNode ? `pad ${num(sizeNode[1]).toFixed(1)}×${num(sizeNode[2]).toFixed(1)} mm` : undefined,
      });
      touch(gx, gy);
    }
  }

  if (!Number.isFinite(minX)) {
    warnings.push('No Edge.Cuts outline found: using the pad bounding box for board size.');
    minX = Math.min(...pins.map((p) => p.xMm), 0);
    minY = Math.min(...pins.map((p) => p.yMm), 0);
    maxX = Math.max(...pins.map((p) => p.xMm), 50);
    maxY = Math.max(...pins.map((p) => p.yMm), 40);
  }

  // normalize pins so the board origin is (0,0)
  for (const p of pins) {
    p.xMm -= minX;
    p.yMm -= minY;
  }
  for (const c of components) {
    c.xMm -= minX;
    c.yMm -= minY;
  }

  const generalTitle = find(root, 'title_block');
  const title = generalTitle && find(generalTitle, 'title');

  if (pins.length === 0) warnings.push('No pads were found in this file.');

  return {
    format: 'kicad',
    name: (title && typeof title[1] === 'string' && title[1]) || 'KiCad board',
    warnings,
    pins,
    components,
    nets: [...nets].filter((n) => n.length > 0),
    outline: {
      widthMm: Math.max(5, maxX - minX),
      heightMm: Math.max(5, maxY - minY),
    },
    objectCounts: { footprints: footprintNodes.length, pads: pins.length, nets: nets.size },
  };
}
