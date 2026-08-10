// Third-party notices, read from the file that is already the source of truth.
//
// THIRD_PARTY_NOTICES.md is what the repository maintains and what a reader
// checks. Retyping any of it into a table here would create a second list that
// drifts, and the drift would be invisible until it mattered — so nothing is
// retyped. The file is imported whole at build time and parsed into sections,
// and every section's text is preserved verbatim for display.
//
// The consequence worth stating: adding a section to the markdown makes it
// appear on the page with no code change at all, and a section this parser
// cannot classify still appears, under a general heading. Nothing can be
// dropped by failing to recognise it.

/** Where an entry belongs on the page. */
export type NoticeCategory = 'runtime' | 'toolchain' | 'other';

export interface NoticeEntry {
  /** The section heading, which is the project or subject name. */
  title: string;
  /** The whole section body, exactly as written. */
  body: string;
  category: NoticeCategory;
  /** Licence named in the section, when it names one. */
  license?: string;
  /** Copyright line, when the section carries one. */
  copyright?: string;
  /** Project URL, when the section links one. */
  url?: string;
  /**
   * True for sections that exist to record that something is deliberately
   * *not* shipped. These matter as much as the inclusions and are shown as
   * such rather than looking like a dependency.
   */
  exclusion: boolean;
}

export interface ParsedNotices {
  /** The text before the first section: the file's own preamble. */
  preamble: string;
  entries: NoticeEntry[];
}

/** Section headings that describe something CircuitDesk does not distribute. */
const EXCLUSION_PATTERN = /not distributed|original work/i;

/**
 * Classifies a section from its own text.
 *
 * Keyword matching rather than a hand-kept mapping, so a section added to the
 * markdown lands somewhere sensible without anyone remembering to edit code.
 * Anything unrecognised falls through to `other`, which is a visible heading —
 * an entry can be mis-grouped, but it can never vanish.
 */
function classify(title: string, body: string): NoticeCategory {
  const text = `${title}\n${body}`.toLowerCase();
  if (/arduino-cli|board support package|toolchain|compiler backend|core\b/.test(text)) return 'toolchain';
  if (/execute|executes|emulator|interpreter|runtime dependency|firmware in the browser/.test(text)) return 'runtime';
  return 'other';
}

/** Pulls a licence name out of a section, when it states one. */
function findLicense(body: string): string | undefined {
  const explicit = /\b((?:MIT|BSD(?:[- ]\d[- ]Clause)?|Apache(?:[- ]2\.0)?|GPLv2|GPLv3|AGPLv3|ISC|MPL[- ]2\.0)[^.\n]*?)\s*(?:License|Licence)?\b/i.exec(
    body,
  );
  const named = /\b(MIT|BSD-style|BSD|Apache-2\.0|Apache|GPLv2|GPLv3|AGPLv3|ISC|MPL-2\.0)\b/.exec(body);
  return named?.[1] ?? explicit?.[1];
}

function findCopyright(body: string): string | undefined {
  const match = /((?:Copyright|©)\s*(?:\(c\)\s*)?[^\n.]*)/i.exec(body);
  return match?.[1]?.trim();
}

function findUrl(body: string): string | undefined {
  const match = /<(https?:\/\/[^>\s]+)>/.exec(body);
  return match?.[1];
}

/**
 * Splits the notices file into its sections.
 *
 * Only `##` headings start a section, so the document's own structure decides
 * what an entry is.
 */
export function parseNotices(markdown: string): ParsedNotices {
  const lines = markdown.split('\n');
  const entries: NoticeEntry[] = [];
  const preambleLines: string[] = [];

  let current: { title: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    entries.push({
      title: current.title,
      body,
      category: classify(current.title, body),
      license: findLicense(body),
      copyright: findCopyright(body),
      url: findUrl(body),
      exclusion: EXCLUSION_PATTERN.test(current.title),
    });
    current = null;
  };

  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[1].trim(), lines: [] };
      continue;
    }
    // The document's own H1 is the page's title, not part of the preamble.
    if (/^#\s+/.test(line)) continue;
    if (current) current.lines.push(line);
    else preambleLines.push(line);
  }
  flush();

  return { preamble: preambleLines.join('\n').trim(), entries };
}

/** Human labels for the groups, in the order the page shows them. */
export const CATEGORY_LABELS: { key: NoticeCategory; label: string; blurb: string }[] = [
  {
    key: 'runtime',
    label: 'Runtime and simulation libraries',
    blurb: 'Code that runs in your browser to execute firmware.',
  },
  {
    key: 'toolchain',
    label: 'Compiler and toolchain components',
    blurb: 'Software that compiles your sketch on the server. None of it reaches the browser.',
  },
  {
    key: 'other',
    label: 'Other notices',
    blurb: 'Everything else that warrants attribution, including material CircuitDesk deliberately does not ship.',
  },
];

/**
 * The independence statement shown above the notices.
 *
 * Kept factual. CircuitDesk names the hardware it simulates because that is
 * what the hardware is called, and a reader is entitled to know that naming it
 * is not a claim of any relationship with its maker.
 */
export const INDEPENDENCE_NOTICE = [
  'CircuitDesk is an independent simulation platform. It is not affiliated with, sponsored by, or endorsed by any hardware manufacturer named in this application.',
  'Third-party product names, model numbers and trademarks are used only to identify the hardware being simulated, and remain the property of their respective owners. Their appearance here does not imply sponsorship, affiliation or endorsement unless stated explicitly.',
];
