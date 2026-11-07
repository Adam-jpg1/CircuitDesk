// A community card's picture: the layout of a project, as numbers.
//
// A shared project is someone else's data, so its preview is not markup. It is
// rectangles and lines — positions, sizes, a kind, a hex colour — which the
// server checks are exactly that, and which this file turns back into an SVG
// drawn through <img>. Nothing a publisher sends can become a tag or an
// attribute on anybody else's page.

import type { CircuitProject } from '../types';
import { resolveDefinition } from '../project/partsRegistry';
import { safeColour } from '../canvas/thumbnail';
import { partBounds, pinAbsolute } from '../canvas/geometry';

export interface CommunityPreview {
  /** `c` is a hex colour: the board's PCB, an LED's lens, a part's body. */
  rects: { x: number; y: number; w: number; h: number; k: 'board' | 'part' | 'breadboard' | 'led'; c?: string }[];
  lines: { x1: number; y1: number; x2: number; y2: number; c: string }[];
}

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : 0;
};

const LED_COLOURS: Record<string, string> = {
  red: '#ff4d4f', green: '#51cf66', yellow: '#ffd43b', blue: '#4dabf7', white: '#f8f9fa', orange: '#ff922b',
};
const CATEGORY_COLOURS: Record<string, string> = {
  Sensors: '#7048e8', Displays: '#0b7285', Modules: '#3b5bdb', Input: '#495057', Inputs: '#495057',
  Motors: '#868e96', ICs: '#25262b', Memory: '#25262b', Power: '#c92a2a', Basic: '#d9b77a', Output: '#343a40',
  Logic: '#25262b', LEDs: '#e64980',
};

/** The layout of a project, for publishing: where things are and what colour, nothing else. */
export function projectPreview(project: CircuitProject): CommunityPreview {
  const instances = [...project.boardInstances, ...project.componentInstances].slice(0, 400);
  const byId = new Map(instances.map((i) => [i.id, i] as const));
  const rects = instances.flatMap((inst): CommunityPreview['rects'] => {
    const def = resolveDefinition(inst.definitionId, project);
    if (!def) return [];
    const b = partBounds(inst, def);
    const box = { x: n(b.x), y: n(b.y), w: n(b.w), h: n(b.h) };
    if (def.isBoard) {
      const colour = typeof def.metadata?.color === 'string' ? def.metadata.color : def.id === 'board.arduino-uno' ? '#1a6fb0' : '#0b3d5e';
      return [{ ...box, k: 'board', c: safeColour(colour, '#1a6fb0') }];
    }
    if (def.category === 'Breadboards') return [{ ...box, k: 'breadboard' }];
    if (def.id === 'comp.led') {
      return [{ ...box, k: 'led', c: LED_COLOURS[String(inst.properties.color ?? 'red')] ?? '#ff4d4f' }];
    }
    return [{ ...box, k: 'part', c: CATEGORY_COLOURS[def.category] ?? '#8a99a6' }];
  });
  const lines: CommunityPreview['lines'] = [];
  for (const c of project.connections) {
    if (lines.length >= 300) break;
    const a = byId.get(c.sourceComponentId);
    const b = byId.get(c.targetComponentId);
    if (!a || !b) continue;
    const da = resolveDefinition(a.definitionId, project);
    const db = resolveDefinition(b.definitionId, project);
    const pa = da?.pins.find((p) => p.id === c.sourcePinId);
    const pb = db?.pins.find((p) => p.id === c.targetPinId);
    if (!da || !db || !pa || !pb) continue;
    const A = pinAbsolute(a, da, pa);
    const B = pinAbsolute(b, db, pb);
    lines.push({ x1: n(A.x), y1: n(A.y), x2: n(B.x), y2: n(B.y), c: safeColour(c.color) });
  }
  return { rects, lines };
}

/** A wire as the canvas draws a smooth one: a gentle S between its two pins. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const bend = Math.min(Math.max(dx, dy) * 0.45, 90);
  if (dx >= dy) {
    const s = Math.sign(x2 - x1) || 1;
    return `M${x1} ${y1}C${x1 + s * bend} ${y1} ${x2 - s * bend} ${y2} ${x2} ${y2}`;
  }
  const s = Math.sign(y2 - y1) || 1;
  return `M${x1} ${y1}C${x1} ${y1 + s * bend} ${x2} ${y2 - s * bend} ${x2} ${y2}`;
}

function drawRect(r: CommunityPreview['rects'][number]): string {
  const x = n(r.x), y = n(r.y), w = n(r.w), h = n(r.h);
  const k = r.k === 'board' || r.k === 'breadboard' || r.k === 'led' ? r.k : 'part';
  if (k === 'board') {
    const fill = safeColour(r.c, '#1a6fb0');
    const long = w >= h;
    const chipW = Math.min(w, h) * 0.34;
    const hole = Math.max(2.5, Math.min(w, h) * 0.035);
    const inset = Math.min(w, h) * 0.06;
    const strip = Math.max(3, Math.min(w, h) * 0.05);
    const headers = long
      ? `<line x1="${x + w * 0.12}" y1="${y + inset}" x2="${x + w * 0.88}" y2="${y + inset}" stroke="#0b0f13" stroke-width="${strip}" stroke-dasharray="${strip * 0.9} ${strip * 0.6}"/>` +
        `<line x1="${x + w * 0.12}" y1="${y + h - inset}" x2="${x + w * 0.88}" y2="${y + h - inset}" stroke="#0b0f13" stroke-width="${strip}" stroke-dasharray="${strip * 0.9} ${strip * 0.6}"/>`
      : `<line x1="${x + inset}" y1="${y + h * 0.1}" x2="${x + inset}" y2="${y + h * 0.9}" stroke="#0b0f13" stroke-width="${strip}" stroke-dasharray="${strip * 0.9} ${strip * 0.6}"/>` +
        `<line x1="${x + w - inset}" y1="${y + h * 0.1}" x2="${x + w - inset}" y2="${y + h * 0.9}" stroke="#0b0f13" stroke-width="${strip}" stroke-dasharray="${strip * 0.9} ${strip * 0.6}"/>`;
    return (
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w, h) * 0.05}" fill="${fill}" stroke="#05080b" stroke-width="2"/>` +
      `<rect x="${x + 3}" y="${y + 3}" width="${Math.max(0, w - 6)}" height="${Math.max(0, h - 6)}" rx="${Math.min(w, h) * 0.04}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>` +
      headers +
      `<rect x="${x + w / 2 - chipW / 2}" y="${y + h / 2 - chipW / 2}" width="${chipW}" height="${chipW}" rx="2" fill="#15191e" stroke="#3a434d" stroke-width="1.2"/>` +
      [[0.06, 0.08], [0.94, 0.08], [0.06, 0.92], [0.94, 0.92]]
        .map(([fx, fy]) => `<circle cx="${x + w * fx}" cy="${y + h * fy}" r="${hole}" fill="#0d1117" stroke="#c9a227" stroke-width="1"/>`)
        .join('')
    );
  }
  if (k === 'breadboard') {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#e3e6ea" stroke="#9aa3ab" stroke-width="1.5"/>` +
      `<line x1="${x + 6}" y1="${y + h / 2}" x2="${x + w - 6}" y2="${y + h / 2}" stroke="#b8c0c8" stroke-width="${Math.max(2, h * 0.04)}"/>`;
  }
  if (k === 'led') {
    const c = safeColour(r.c, '#ff4d4f');
    const radius = Math.max(4, Math.min(w, h) * 0.42);
    const cx = x + w / 2, cy = y + h * 0.4;
    return `<circle cx="${cx}" cy="${cy}" r="${radius * 2.2}" fill="${c}" opacity="0.16"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${c}" stroke="#0b1015" stroke-width="1.5"/>` +
      `<circle cx="${cx - radius * 0.3}" cy="${cy - radius * 0.35}" r="${radius * 0.3}" fill="#fff" opacity="0.55"/>`;
  }
  const c = safeColour(r.c, '#8a99a6');
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(4, Math.min(w, h) * 0.2)}" fill="${c}" stroke="#0b1015" stroke-width="1.5"/>` +
    `<rect x="${x + 1.5}" y="${y + 1.5}" width="${Math.max(0, w - 3)}" height="${Math.max(0, h * 0.35)}" rx="2" fill="#fff" opacity="0.07"/>`;
}

/** The preview as an SVG string. Every value is re-coerced, so a bad payload draws nothing odd. */
export function renderPreviewSvg(preview: CommunityPreview | undefined): string {
  const rects = Array.isArray(preview?.rects) ? preview!.rects : [];
  const lines = Array.isArray(preview?.lines) ? preview!.lines : [];
  if (rects.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#10161c"/></svg>';
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, n(r.x)); minY = Math.min(minY, n(r.y));
    maxX = Math.max(maxX, n(r.x) + n(r.w)); maxY = Math.max(maxY, n(r.y) + n(r.h));
  }
  const pad = Math.max(30, Math.max(maxX - minX, maxY - minY) * 0.08);
  const w = Math.max(maxX - minX + pad * 2, 120);
  const h = Math.max(maxY - minY + pad * 2, 90);
  // Boards first, then wires over them, then parts on top — the order a desk is
  // seen in, and the one that keeps a wire's end on its part.
  const order = (k: string) => (k === 'board' ? 0 : k === 'breadboard' ? -1 : 2);
  const sorted = [...rects].sort((a, b) => order(a.k) - order(b.k));
  const body = [
    `<defs><radialGradient id="g" cx="50%" cy="35%" r="80%"><stop offset="0" stop-color="#1c2833"/><stop offset="1" stop-color="#0b1015"/></radialGradient>` +
      `<pattern id="d" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#ffffff" opacity="0.07"/></pattern></defs>`,
    `<rect x="${minX - pad}" y="${minY - pad}" width="${w}" height="${h}" fill="url(#g)"/>`,
    `<rect x="${minX - pad}" y="${minY - pad}" width="${w}" height="${h}" fill="url(#d)"/>`,
    ...sorted.filter((r) => r.k === 'board' || r.k === 'breadboard').map(drawRect),
    ...lines.map(
      (l) =>
        `<path d="${curve(n(l.x1), n(l.y1), n(l.x2), n(l.y2))}" fill="none" stroke="#000" stroke-opacity="0.45" stroke-width="6" stroke-linecap="round"/>` +
        `<path d="${curve(n(l.x1), n(l.y1), n(l.x2), n(l.y2))}" fill="none" stroke="${safeColour(l.c)}" stroke-width="3.2" stroke-linecap="round"/>`,
    ),
    ...sorted.filter((r) => r.k !== 'board' && r.k !== 'breadboard').map(drawRect),
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${minY - pad} ${w} ${h}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}
