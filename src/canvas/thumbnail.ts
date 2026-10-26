import type { CircuitProject } from '../types';
import { resolveDefinition } from '../project/partsRegistry';
import { MM } from '../boards/pinHelpers';

/**
 * Everything interpolated into the markup below comes from a project, and a
 * project can come from a file or from someone else entirely. So nothing goes
 * in as text: positions and sizes are coerced to finite numbers, and a wire's
 * colour must be a hex colour or it is replaced. A colour of
 * `"/><script>…` would otherwise have closed the attribute.
 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
const HEX_COLOUR = /^#[0-9a-f]{3,8}$/i;
export function safeColour(value: unknown, fallback = '#2f9e44'): string {
  return typeof value === 'string' && HEX_COLOUR.test(value) ? value : fallback;
}

/** An SVG string as an image URL, so it is drawn as a picture and never parsed as page markup. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

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
      x: num(inst.x), y: num(inst.y), w: num(w), h: num(h),
      fill: isBoard ? '#1e5b8a' : def && !def.isBoard && def.category === 'Breadboards' ? '#d8dce0' : '#7a8894',
      rx: isBoard ? 6 : 2,
    });
    minX = Math.min(minX, num(inst.x)); minY = Math.min(minY, num(inst.y));
    maxX = Math.max(maxX, num(inst.x) + num(w)); maxY = Math.max(maxY, num(inst.y) + num(h));
  }
  const lines: string[] = [];
  for (const c of project.connections.slice(0, 60)) {
    const all = new Map(instances.map((i) => [i.id, i] as const));
    const a = all.get(c.sourceComponentId);
    const b = all.get(c.targetComponentId);
    if (!a || !b) continue;
    lines.push(
      `<line x1="${num(a.x) + 20}" y1="${num(a.y) + 20}" x2="${num(b.x) + 20}" y2="${num(b.y) + 20}" stroke="${safeColour(c.color)}" stroke-width="3" stroke-linecap="round" opacity="0.85"/>`,
    );
  }
  const pad = 30;
  const vb = `${minX - pad} ${minY - pad} ${Math.max(maxX - minX + pad * 2, 100)} ${Math.max(maxY - minY + pad * 2, 80)}`;
  const rectSvg = rects
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${r.rx}" fill="${r.fill}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><rect x="${minX - pad}" y="${minY - pad}" width="100%" height="100%" fill="#141a20"/>${lines.join('')}${rectSvg}</svg>`;
}
