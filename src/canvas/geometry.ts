import type { ComponentInstance, Connection, PartDefinition, PinDefinition } from '../types';
import { MM } from '../boards/pinHelpers';

export interface Pt {
  x: number;
  y: number;
}

export function partSize(def: PartDefinition): { w: number; h: number } {
  return { w: def.widthMm * MM, h: def.heightMm * MM };
}

/** Absolute canvas position of a pin, honoring instance rotation about the part center. */
export function pinAbsolute(instance: ComponentInstance, def: PartDefinition, pin: PinDefinition): Pt {
  const { w, h } = partSize(def);
  const cx = w / 2;
  const cy = h / 2;
  const rad = (instance.rotation * Math.PI) / 180;
  const dx = pin.x - cx;
  const dy = pin.y - cy;
  return {
    x: instance.x + cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: instance.y + cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

export function partBounds(instance: ComponentInstance, def: PartDefinition): { x: number; y: number; w: number; h: number } {
  const { w, h } = partSize(def);
  if (instance.rotation % 180 === 90) {
    const cx = instance.x + w / 2;
    const cy = instance.y + h / 2;
    return { x: cx - h / 2, y: cy - w / 2, w: h, h: w };
  }
  return { x: instance.x, y: instance.y, w, h };
}

export function wirePath(a: Pt, b: Pt, waypoints: number[], routing: Connection['routing']): string {
  const pts: Pt[] = [a];
  for (let i = 0; i + 1 < waypoints.length; i += 2) pts.push({ x: waypoints[i], y: waypoints[i + 1] });
  pts.push(b);

  if (routing === 'straight' || pts.length > 6) {
    return `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')}`;
  }
  if (routing === 'orthogonal') {
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const midX = (prev.x + cur.x) / 2;
      d += ` L ${midX} ${prev.y} L ${midX} ${cur.y} L ${cur.x} ${cur.y}`;
    }
    return d;
  }
  // smooth: catmull-rom-ish curve through points
  if (pts.length === 2) {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const bend = Math.min(Math.max(dx, dy) * 0.45, 90);
    const horizontal = dx >= dy;
    const c1 = horizontal ? { x: a.x + Math.sign(b.x - a.x) * bend, y: a.y } : { x: a.x, y: a.y + Math.sign(b.y - a.y) * bend };
    const c2 = horizontal ? { x: b.x - Math.sign(b.x - a.x) * bend, y: b.y } : { x: b.x, y: b.y - Math.sign(b.y - a.y) * bend };
    return `M ${a.x} ${a.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 2)];
    const p1 = pts[i - 1];
    const p2 = pts[i];
    const p3 = pts[Math.min(pts.length - 1, i + 1)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
  }
  return d;
}

export const GRID = 5;

export function snap(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid;
}
