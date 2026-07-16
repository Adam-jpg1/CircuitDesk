import type { CircuitProject } from '../types';
import { resolveDefinition } from '../project/partsRegistry';
import { MM } from '../boards/pinHelpers';

/** Renders a small, cheap SVG thumbnail of the project layout for dashboard cards. */
export function renderProjectThumbnail(project: CircuitProject): string {
  const instances = [...project.boardInstances, ...project.componentInstances];
  if (instances.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#141a20"/><text x="100" y="64" fill="#5c6a76" font-size="11" text-anchor="middle" font-family="sans-serif">Empty canvas</text></svg>`;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rects: { x: number; y: number; w: number; h: number; fill: string; rx: number }[] = [];
  for (const inst of instances) {
    const def = resolveDefinition(inst.definitionId, project);
    const w = (def?.widthMm ?? 10) * MM;
    const h = (def?.heightMm ?? 10) * MM;
    const isBoard = Boolean(def?.isBoard);
    rects.push({
      x: inst.x, y: inst.y, w, h,
      fill: isBoard ? '#1e5b8a' : def && !def.isBoard && def.category === 'Breadboards' ? '#d8dce0' : '#7a8894',
      rx: isBoard ? 6 : 2,
    });
    minX = Math.min(minX, inst.x); minY = Math.min(minY, inst.y);
    maxX = Math.max(maxX, inst.x + w); maxY = Math.max(maxY, inst.y + h);
  }
  const lines: string[] = [];
  for (const c of project.connections.slice(0, 60)) {
    const all = new Map(instances.map((i) => [i.id, i] as const));
    const a = all.get(c.sourceComponentId);
    const b = all.get(c.targetComponentId);
    if (!a || !b) continue;
    lines.push(
      `<line x1="${a.x + 20}" y1="${a.y + 20}" x2="${b.x + 20}" y2="${b.y + 20}" stroke="${c.color || '#2f9e44'}" stroke-width="3" stroke-linecap="round" opacity="0.85"/>`,
    );
  }
  const pad = 30;
  const vb = `${minX - pad} ${minY - pad} ${Math.max(maxX - minX + pad * 2, 100)} ${Math.max(maxY - minY + pad * 2, 80)}`;
  const rectSvg = rects
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${r.rx}" fill="${r.fill}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><rect x="${minX - pad}" y="${minY - pad}" width="100%" height="100%" fill="#141a20"/>${lines.join('')}${rectSvg}</svg>`;
}
