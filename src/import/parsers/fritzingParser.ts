// Real Fritzing importer: opens .fzz/.fzpz archives (or bare .fzp XML), reads
// part metadata, connector ids/names, and the breadboard SVG artwork; maps
// connectors to SVG elements by id where possible.

import JSZip from 'jszip';
import { parseXmlSafe, sanitizeSvg, safeZipEntries } from '../security';
import { ImportError, type ImportParseResult, type ImportedPin } from '../types';

export async function parseFritzing(file: File): Promise<ImportParseResult> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.fzp')) {
    return parseFzp(await file.text(), new Map(), file.name);
  }
  const zip = await JSZip.loadAsync(await file.arrayBuffer()).catch(() => {
    throw new ImportError('Could not open the Fritzing archive (corrupt ZIP?).');
  });
  const entries = safeZipEntries(zip);

  const svgFiles = new Map<string, string>();
  for (const { path, entry } of entries) {
    if (path.toLowerCase().endsWith('.svg')) {
      svgFiles.set(path.split('/').pop()!.toLowerCase(), await entry.async('text'));
    }
  }

  const fzpEntry = entries.find((e) => e.path.toLowerCase().endsWith('.fzp'));
  if (fzpEntry) {
    return parseFzp(await fzpEntry.entry.async('text'), svgFiles, file.name);
  }

  // .fzz project archive: contains an .fz project XML
  const fzEntry = entries.find((e) => e.path.toLowerCase().endsWith('.fz'));
  if (fzEntry) {
    const doc = parseXmlSafe(await fzEntry.entry.async('text'), 'Fritzing project');
    const instances = [...doc.querySelectorAll('instance')];
    const title = doc.querySelector('title')?.textContent ?? file.name.replace(/\.fzz$/i, '');
    const warnings = [
      'Fritzing project (.fzz): the part list was extracted. Individual parts inside the project can be imported from their .fzpz files for full pin data.',
    ];
    const components = instances.map((inst, i) => {
      const geom = inst.querySelector('views > breadboardView > geometry');
      return {
        name: inst.getAttribute('moduleIdRef')?.split(/[/\\]/).pop() ?? `part ${i + 1}`,
        xMm: geom ? Number(geom.getAttribute('x') ?? 0) / 10 : 0,
        yMm: geom ? Number(geom.getAttribute('y') ?? 0) / 10 : 0,
      };
    });
    const anySvg = [...svgFiles.values()][0];
    return {
      format: 'fritzing',
      name: title,
      warnings,
      components,
      svg: anySvg ? sanitizeSvg(anySvg) : undefined,
      objectCounts: { instances: instances.length, svgFiles: svgFiles.size },
    };
  }

  throw new ImportError('No .fzp part or .fz project was found inside the archive.');
}

function parseFzp(fzpText: string, svgFiles: Map<string, string>, fileName: string): ImportParseResult {
  const doc = parseXmlSafe(fzpText, 'Fritzing part');
  const moduleEl = doc.querySelector('module');
  if (!moduleEl) throw new ImportError('Not a Fritzing part file (missing <module>).');

  const title = doc.querySelector('module > title')?.textContent ?? fileName.replace(/\.(fzpz|fzp|zip)$/i, '');
  const warnings: string[] = [];

  // find the breadboard view SVG
  const bbLayers = doc.querySelector('views > breadboardView > layers');
  const svgName = bbLayers?.getAttribute('image')?.split('/').pop()?.toLowerCase();
  let svgText = svgName ? svgFiles.get(svgName) : undefined;
  if (!svgText && svgFiles.size > 0) {
    svgText = [...svgFiles.entries()].find(([k]) => k.includes('breadboard'))?.[1] ?? [...svgFiles.values()][0];
    if (svgName) warnings.push(`Referenced artwork "${svgName}" was missing; using another SVG from the archive.`);
  }

  // SVG dimensions
  let widthMm = 30, heightMm = 20;
  let svgDoc: Document | null = null;
  if (svgText) {
    svgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svgEl = svgDoc.querySelector('svg');
    const parseLen = (v: string | null | undefined): number | null => {
      if (!v) return null;
      const m = /^([\d.]+)\s*(mm|in|px)?$/.exec(v.trim());
      if (!m) return null;
      const n = Number(m[1]);
      return m[2] === 'mm' ? n : m[2] === 'in' ? n * 25.4 : n / 3.5433; // px @90dpi ≈ 0.282mm
    };
    widthMm = parseLen(svgEl?.getAttribute('width')) ?? widthMm;
    heightMm = parseLen(svgEl?.getAttribute('height')) ?? heightMm;
  } else {
    warnings.push('No SVG artwork found in the archive — the part will use a generic body.');
  }

  // connectors → pins, mapped to SVG element positions where possible
  const pins: ImportedPin[] = [];
  const connectors = [...doc.querySelectorAll('connectors > connector')];
  const svgEl = svgDoc?.querySelector('svg');
  const vb = svgEl?.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const scaleX = vb && vb[2] > 0 ? widthMm / vb[2] : 1;
  const scaleY = vb && vb[3] > 0 ? heightMm / vb[3] : 1;
  let mapped = 0;

  connectors.forEach((conn, i) => {
    const id = conn.getAttribute('id') ?? `connector${i}`;
    const name = conn.getAttribute('name') ?? id;
    const svgId = conn.querySelector('views > breadboardView > p')?.getAttribute('svgId') ?? `${id}pin`;
    let xMm: number | null = null;
    let yMm: number | null = null;
    if (svgDoc) {
      const el = svgDoc.getElementById(svgId) ?? svgDoc.getElementById(id);
      if (el) {
        const cx = el.getAttribute('cx') ?? el.getAttribute('x');
        const cy = el.getAttribute('cy') ?? el.getAttribute('y');
        if (cx !== null && cy !== null) {
          xMm = Number(cx) * scaleX;
          yMm = Number(cy) * scaleY;
          mapped++;
        }
      }
    }
    if (xMm === null || yMm === null || !Number.isFinite(xMm) || !Number.isFinite(yMm)) {
      // fallback: evenly spaced along the bottom edge
      xMm = ((i + 1) / (connectors.length + 1)) * widthMm;
      yMm = heightMm - 1;
    }
    pins.push({
      id,
      label: name,
      xMm,
      yMm,
      notes: conn.getAttribute('type') ?? undefined,
    });
  });

  if (connectors.length > 0 && mapped < connectors.length) {
    warnings.push(
      `${mapped}/${connectors.length} connectors were located in the SVG; the rest were placed along the edge — adjust them in the mapping step.`,
    );
  }
  if (connectors.length === 0) warnings.push('The part defines no connectors.');

  return {
    format: 'fritzing',
    name: title,
    warnings,
    pins,
    svg: svgText ? sanitizeSvg(svgText) : undefined,
    outline: { widthMm: Math.max(2, widthMm), heightMm: Math.max(2, heightMm) },
    objectCounts: { connectors: connectors.length, mappedToSvg: mapped, svgFiles: svgFiles.size },
  };
}
