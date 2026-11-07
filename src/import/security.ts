// Import hardening: SVG sanitization, safe XML parsing, ZIP limits.

import { ImportError, MAX_IMPORT_BYTES, MAX_ZIP_ENTRIES } from './types';
import type JSZip from 'jszip';

const FORBIDDEN_SVG_TAGS = ['script', 'foreignObject', 'iframe', 'embed', 'object', 'audio', 'video', 'animate', 'set'];

/** Removes scripts, event handlers and external references from SVG text. */
export function sanitizeSvg(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) {
    throw new ImportError('The SVG file could not be parsed.');
  }
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (FORBIDDEN_SVG_TAGS.includes(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      walk(child);
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#') && !value.startsWith('data:image/')) {
        el.removeAttribute(attr.name);
      } else if (value.includes('javascript:') || value.includes('url(http')) {
        el.removeAttribute(attr.name);
      }
    }
  };
  const root = doc.documentElement;
  walk(root);
  return new XMLSerializer().serializeToString(root);
}

/** DOMParser in browsers never resolves external entities; still verify well-formedness. */
export function parseXmlSafe(text: string, what: string): Document {
  if (/<!ENTITY/i.test(text)) {
    throw new ImportError(`${what}: XML with custom entities is rejected for safety.`);
  }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new ImportError(`${what}: the XML is malformed.`);
  }
  return doc;
}

export function checkFileSize(file: File): void {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ImportError(`File exceeds the ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB import limit.`);
  }
}

/** Guards against zip-slip, oversized archives and executables. */
export function safeZipEntries(zip: JSZip): { path: string; entry: JSZip.JSZipObject }[] {
  const out: { path: string; entry: JSZip.JSZipObject }[] = [];
  let count = 0;
  zip.forEach((path, entry) => {
    count++;
    if (count > MAX_ZIP_ENTRIES) throw new ImportError(`Archive has too many entries (limit ${MAX_ZIP_ENTRIES}).`);
    if (entry.dir) return;
    const normalized = path.replace(/\\/g, '/');
    if (normalized.includes('..') || normalized.startsWith('/')) return; // zip-slip attempt — skip
    if (/\.(exe|dll|so|dylib|sh|bat|cmd|com|scr|js|mjs|jar|apk|bin)$/i.test(normalized)) return; // executables — skip
    out.push({ path: normalized, entry });
  });
  return out;
}
