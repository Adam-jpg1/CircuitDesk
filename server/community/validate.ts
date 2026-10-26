// Everything a stranger can send to the community API, checked before it is kept.
//
// A published project is untrusted input that other people will open, so the
// rules here are about what may be stored and handed back, not about whether a
// circuit is any good:
//
//   * every string is bounded, trimmed, and stripped of control characters; the
//     app renders all of it as text, never as markup, and these limits keep a
//     post from being a megabyte of title;
//   * every collection is bounded — parts, wires, files, tags, preview shapes;
//   * the preview is numbers and hex colours only, which is the whole of what
//     the app draws from it, so it cannot carry anything else;
//   * code file names follow the compiler's own rule, because "open a copy" will
//     eventually send them there;
//   * a project's thumbnail markup is never kept: the app draws its own;
//   * an author name cannot claim to be the creator, the site or an admin — the
//     creator badge comes from a server-side token, never from a name.

export class CommunityInputError extends Error {}

export const LIMITS = {
  titleMin: 3,
  title: 80,
  description: 1000,
  authorName: 40,
  tags: 5,
  tag: 20,
  board: 60,
  boardId: 80,
  projectBytes: 300 * 1024,
  boards: 8,
  components: 300,
  connections: 1000,
  codeFiles: 20,
  codeFileBytes: 64 * 1024,
  customDefinitions: 10,
  previewRects: 400,
  previewLines: 300,
} as const;

/** The compiler's own file-name rule, so a shared project can always be built. */
const FILE_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.(ino|h|hpp|c|cpp)$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
const HEX_COLOUR = /^#[0-9a-f]{3,8}$/i;
const AUTHOR_RE = /^[\p{L}\p{N} _.'-]+$/u;
/** Names nobody may publish under: the badge is earned by token, not typed. */
const RESERVED_AUTHOR = /(creator|admin|moderator|official|circuitdesk|staff)/i;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

export function cleanText(value: unknown, max: number, field: string, opts: { multiline?: boolean } = {}): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new CommunityInputError(`${field} must be text.`);
  let text = value.replace(CONTROL, '');
  if (!opts.multiline) text = text.replace(/[\r\n\t]+/g, ' ');
  text = text.replace(/[ ]{2,}/g, ' ').trim();
  if (text.length > max) throw new CommunityInputError(`${field} is longer than ${max} characters.`);
  return text;
}

function finite(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e7) throw new CommunityInputError(`${field} must be a number.`);
  return Math.round(n * 10) / 10;
}

export interface PreviewRect {
  x: number;
  y: number;
  w: number;
  h: number;
  k: 'board' | 'part' | 'breadboard' | 'led';
  /** Hex colour, or absent. */
  c?: string;
}
export interface PreviewLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c: string;
}
export interface CommunityPreview {
  rects: PreviewRect[];
  lines: PreviewLine[];
}

export function cleanPreview(value: unknown): CommunityPreview {
  const v = (value ?? {}) as { rects?: unknown; lines?: unknown };
  const rects = Array.isArray(v.rects) ? v.rects : [];
  const lines = Array.isArray(v.lines) ? v.lines : [];
  if (rects.length > LIMITS.previewRects || lines.length > LIMITS.previewLines) {
    throw new CommunityInputError('The preview has too many shapes.');
  }
  return {
    rects: rects.map((r, i) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const k = o.k === 'board' || o.k === 'breadboard' || o.k === 'led' ? o.k : 'part';
      return {
        x: finite(o.x, `preview rect ${i}`),
        y: finite(o.y, `preview rect ${i}`),
        w: Math.max(0, finite(o.w, `preview rect ${i}`)),
        h: Math.max(0, finite(o.h, `preview rect ${i}`)),
        k,
        ...(typeof o.c === 'string' && HEX_COLOUR.test(o.c) ? { c: o.c } : {}),
      };
    }),
    lines: lines.map((l, i) => {
      const o = (l ?? {}) as Record<string, unknown>;
      return {
        x1: finite(o.x1, `preview line ${i}`),
        y1: finite(o.y1, `preview line ${i}`),
        x2: finite(o.x2, `preview line ${i}`),
        y2: finite(o.y2, `preview line ${i}`),
        c: typeof o.c === 'string' && HEX_COLOUR.test(o.c) ? o.c : '#2f9e44',
      };
    }),
  };
}

export function cleanTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CommunityInputError('Tags must be a list.');
  const tags = [...new Set(value.map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : '')).filter(Boolean))];
  if (tags.length > LIMITS.tags) throw new CommunityInputError(`At most ${LIMITS.tags} tags.`);
  for (const t of tags) {
    if (!TAG_RE.test(t)) throw new CommunityInputError(`Tag "${t.slice(0, 24)}" may use only lowercase letters, digits and dashes.`);
  }
  return tags;
}

export function cleanAuthor(value: unknown, isCreator: boolean, creatorName: string): string {
  if (isCreator) return creatorName;
  const name = cleanText(value, LIMITS.authorName, 'Display name');
  if (name === '') return 'Anonymous';
  if (!AUTHOR_RE.test(name)) throw new CommunityInputError('Display name may use letters, digits, spaces and _ . \' - only.');
  if (RESERVED_AUTHOR.test(name) || name.toLowerCase() === creatorName.toLowerCase()) {
    throw new CommunityInputError('That display name is reserved.');
  }
  return name;
}

/** A project, structurally bounded. Its meaning is checked again by the app that opens it. */
export function cleanProject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommunityInputError('A project is required.');
  const p = value as Record<string, unknown>;
  const bytes = Buffer.byteLength(JSON.stringify(p), 'utf8');
  if (bytes > LIMITS.projectBytes) throw new CommunityInputError(`The project is ${Math.round(bytes / 1024)} KB; the limit is ${LIMITS.projectBytes / 1024} KB.`);

  const list = (key: string, max: number): unknown[] => {
    const v = p[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new CommunityInputError(`${key} must be a list.`);
    if (v.length > max) throw new CommunityInputError(`At most ${max} ${key}.`);
    return v;
  };
  const boards = list('boardInstances', LIMITS.boards);
  if (boards.length === 0) throw new CommunityInputError('A shared project needs a board on the canvas.');
  list('componentInstances', LIMITS.components);
  list('connections', LIMITS.connections);
  list('customDefinitions', LIMITS.customDefinitions);
  const files = list('codeFiles', LIMITS.codeFiles);
  for (const f of files) {
    const file = (f ?? {}) as Record<string, unknown>;
    if (typeof file.name !== 'string' || !FILE_NAME_RE.test(file.name)) {
      throw new CommunityInputError(`Code file name "${String(file.name).slice(0, 40)}" is not allowed.`);
    }
    if (typeof file.content !== 'string' || Buffer.byteLength(file.content, 'utf8') > LIMITS.codeFileBytes) {
      throw new CommunityInputError(`Code file "${file.name}" is too large.`);
    }
  }
  const { thumbnailSvg: _dropped, ...rest } = p;
  return rest;
}

export function isPlausibleClientId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
