// Board artwork arrives from strangers, and SVG is a scripting language.
//
// An imported .cdboard.json can carry the picture of the board's face, which is
// most of what makes a custom board feel like a real one. It is also the single
// most dangerous field in the file: SVG can carry <script>, event handlers on
// any element, <foreignObject> with arbitrary HTML in it, external references
// that phone home, and `javascript:` URLs. Rendering one as-is would let a board
// file run code in the page of whoever opened the project.
//
// So the artwork is not sanitised by removing the bad parts — a denylist loses,
// because there is always another way to spell an event handler. It is rebuilt
// from an allowlist: a fixed set of shape elements, a fixed set of presentation
// attributes, and nothing else survives. Anything not on the list is dropped,
// and what comes out the far side is a picture or nothing.
//
// This runs in the browser against the real parser, because a regex over SVG
// text is exactly the sort of "sanitiser" that gets bypassed. In a non-DOM
// context (tests, server) it falls back to refusing the artwork outright rather
// than passing through something it could not parse.

/** Elements that may appear in board artwork. Everything else is dropped. */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
]);

/**
 * Attributes that may survive.
 *
 * Presentation and geometry only. Notably absent: anything beginning `on`,
 * `href`/`xlink:href` (which can be `javascript:` or fetch a remote resource),
 * `style` (which can carry `url()` and `expression()`), and `filter` (which can
 * reference an external document).
 */
const ALLOWED_ATTRIBUTES = new Set([
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'points', 'transform', 'viewBox', 'preserveAspectRatio',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'clip-path', 'clip-rule', 'mask',
  'font-size', 'font-family', 'font-weight', 'text-anchor', 'letter-spacing',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
  'patternUnits', 'patternContentUnits', 'maskUnits', 'clipPathUnits',
  'id', 'class',
]);

/** Attribute values that may reference something. Only same-document ids pass. */
const REFERENCE_ATTRIBUTES = new Set(['clip-path', 'mask', 'fill', 'stroke']);

export interface SanitizedArtwork {
  svg: string | null;
  /** What was taken out, so the studio can say so rather than silently changing it. */
  removed: string[];
}

/** True when a reference is a plain same-document `url(#id)` or a literal value. */
function safeReference(value: string): boolean {
  const url = /url\(([^)]*)\)/i.exec(value);
  if (!url) return !/[:(]/.test(value) || /^(none|currentColor|#[0-9a-fA-F]{3,8}|rgb|rgba|hsl|hsla)/i.test(value);
  const target = url[1].trim().replace(/^['"]|['"]$/g, '');
  return target.startsWith('#') && /^#[A-Za-z0-9_.:-]+$/.test(target);
}

/**
 * Rebuilds board artwork from an allowlist.
 *
 * Returns null when there is nothing safe left, or when there is no DOM to parse
 * with — a board without artwork gets the generated outline, which is a good
 * board, whereas a board with artwork nobody could check is a risk.
 */
export function sanitizeBoardSvg(input: string): SanitizedArtwork {
  const removed: string[] = [];
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
    return { svg: null, removed: ['artwork cannot be checked outside a browser, so it was not kept'] };
  }
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(input, 'image/svg+xml');
  } catch {
    return { svg: null, removed: ['the artwork is not parseable SVG'] };
  }
  if (doc.querySelector('parsererror')) {
    return { svg: null, removed: ['the artwork is not parseable SVG'] };
  }
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    return { svg: null, removed: ['the artwork has no <svg> root'] };
  }

  const out = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

  /** Copies one element's allowed attributes onto a fresh node of the same name. */
  const rebuild = (source: Element): Element | null => {
    const tag = source.nodeName;
    // Compared case-sensitively for the camelCase SVG names and
    // case-insensitively for the rest, which is how SVG itself treats them.
    const name = ALLOWED_ELEMENTS.has(tag) ? tag : [...ALLOWED_ELEMENTS].find((e) => e.toLowerCase() === tag.toLowerCase());
    if (!name) {
      removed.push(`<${tag}>`);
      return null;
    }
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const attr of Array.from(source.attributes)) {
      const attrName = attr.name;
      if (!ALLOWED_ATTRIBUTES.has(attrName)) {
        // Named individually because these are the ones a person needs to know
        // were there; the rest are usually harmless editor cruft.
        if (/^on/i.test(attrName) || /href/i.test(attrName) || attrName === 'style') {
          removed.push(`${attrName} on <${tag}>`);
        }
        continue;
      }
      if (REFERENCE_ATTRIBUTES.has(attrName) && !safeReference(attr.value)) {
        removed.push(`${attrName}="${attr.value.slice(0, 40)}"`);
        continue;
      }
      if (attr.value.length > 20_000) {
        removed.push(`${attrName} on <${tag}> (too long)`);
        continue;
      }
      node.setAttribute(attrName, attr.value);
    }
    return node;
  };

  const walk = (source: Element, target: Element): void => {
    for (const child of Array.from(source.childNodes)) {
      if (child.nodeType === 3) {
        // Text, kept only inside the elements that draw it.
        const parentName = target.nodeName.toLowerCase();
        if (parentName === 'text' || parentName === 'tspan' || parentName === 'title' || parentName === 'desc') {
          target.appendChild(document.createTextNode((child.textContent ?? '').slice(0, 500)));
        }
        continue;
      }
      if (child.nodeType !== 1) continue; // comments, CDATA, processing instructions
      const element = child as Element;
      const rebuilt = rebuild(element);
      if (!rebuilt) continue;
      target.appendChild(rebuilt);
      walk(element, rebuilt);
    }
  };

  for (const attr of ['viewBox', 'preserveAspectRatio', 'width', 'height']) {
    const value = root.getAttribute(attr);
    if (value !== null && value.length < 200) out.setAttribute(attr, value);
  }
  walk(root, out);

  if (out.childNodes.length === 0) return { svg: null, removed: [...removed, 'nothing drawable was left'] };
  return { svg: new XMLSerializer().serializeToString(out), removed: [...new Set(removed)] };
}

/**
 * Cheap structural refusal, usable without a DOM.
 *
 * Not a sanitiser and never used as one — it is what an importer calls to
 * reject an obviously hostile file early, so a user gets "this file contains a
 * script" rather than "artwork removed" after a long import.
 */
export function looksHostile(svg: string): string | null {
  if (/<\s*script/i.test(svg)) return 'the artwork contains a <script> element';
  if (/<\s*foreignObject/i.test(svg)) return 'the artwork contains a <foreignObject>, which can hold arbitrary HTML';
  if (/\son[a-z]+\s*=/i.test(svg)) return 'the artwork contains an event handler attribute';
  if (/javascript:/i.test(svg)) return 'the artwork contains a javascript: URL';
  if (/<!ENTITY/i.test(svg)) return 'the artwork declares XML entities';
  return null;
}
