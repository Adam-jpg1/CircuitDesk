// The pinned library manifest, typed, and the per-target header resolver.
//
// Same arrangement as cores.ts: one file of data, read by the image bootstrap,
// by the capability endpoint, and by the tests, so that "this service can build
// a Servo sketch for an Uno" is one claim in one place rather than three that
// can disagree.
//
// The resolver answers a question the compiler cannot answer usefully on its
// own. When a sketch includes a header that will not build for the selected
// board, arduino-cli either reports a missing include or — worse — resolves a
// library that is wrong for the architecture and fails deep inside it with an
// error about a macro the user has never heard of. Both cases are answerable
// before compiling, from data that was measured rather than guessed.

import manifest from './libraries.json' with { type: 'json' };

export interface PinnedLibrary {
  /** The name in the Arduino library index, as `arduino-cli lib install` takes it. */
  id: string;
  /** The exact version this service is validated against. */
  version: string;
  /** Headers a sketch can include once it is installed. */
  provides: string[];
  maintainer?: string;
  license?: string;
  /** True when the deployment is not considered healthy without it. */
  required: boolean;
  note?: string;
}

/**
 * What a header does once the firmware runs.
 *
 * `compiles-only` is the honest name for a library that builds and then has no
 * effect on any pin, because it drives the hardware through a peripheral the
 * emulator does not model. Reporting that as available would be a lie told in
 * the most expensive place: the user wires a servo, the build succeeds, and
 * nothing moves with no explanation anywhere.
 */
export type HeaderEffect = 'works' | 'compiles-only';

/** One way a header becomes available: an installed library, or a core that bundles it. */
export interface HeaderSource {
  /** `library:<id>` or `core:<package>:<architecture>`. */
  source: string;
  /** The FQBNs this was observed to compile for. */
  targets: string[];
  /** Measured behaviour when the firmware runs. Absent means `works`. */
  effect?: HeaderEffect;
  /** Why it has no effect, when it has none. */
  effectReason?: string;
  /** What to do instead, when there is something. */
  workaround?: string;
  note?: string;
}

/** A target where the header does not build, and why. */
export interface HeaderGap {
  targets: string[];
  reason: string;
  /** The header to use instead, when there is one. */
  alternative?: string;
}

export interface HeaderClaim {
  header: string;
  /** A minimal sketch that exercises the header, compiled by `--probe`. */
  probe: string;
  via: HeaderSource[];
  unavailable: HeaderGap[];
  note?: string;
}

export const PINNED_LIBRARIES: PinnedLibrary[] = (manifest.libraries as PinnedLibrary[]).map((l) => ({
  ...l,
  required: l.required !== false,
}));

export const HEADER_CLAIMS: HeaderClaim[] = (manifest.headers as HeaderClaim[]).map((h) => ({
  ...h,
  unavailable: h.unavailable ?? [],
}));

export function pinnedLibrary(id: string): PinnedLibrary | undefined {
  return PINNED_LIBRARIES.find((l) => l.id === id);
}

export type HeaderResolution =
  | {
      header: string;
      available: true;
      source: string;
      effect: HeaderEffect;
      effectReason?: string;
      workaround?: string;
      note?: string;
    }
  | { header: string; available: false; reason: string; alternative?: string }
  | { header: string; available: false; reason: string; alternative?: string; unknown: true };

/**
 * Whether `header` builds for `fqbn`, and where it comes from.
 *
 * A header nobody has recorded returns `unknown: true` rather than `false`. The
 * manifest lists what has been measured, not everything that exists — plenty of
 * headers resolve for reasons this file knows nothing about (a core's own
 * extras, a header shipped alongside the sketch), and reporting those as
 * unavailable would be a confident wrong answer. Callers are expected to treat
 * unknown as "let the compiler decide".
 */
export function resolveHeader(header: string, fqbn: string): HeaderResolution {
  const claim = HEADER_CLAIMS.find((h) => h.header === header);
  if (!claim) {
    return {
      header,
      available: false,
      unknown: true,
      reason: `${header} is not in the pinned library manifest; whether it builds is up to the compiler.`,
    };
  }
  const via = claim.via.find((v) => v.targets.includes(fqbn));
  if (via) {
    return {
      header,
      available: true,
      source: via.source,
      effect: via.effect ?? 'works',
      effectReason: via.effectReason,
      workaround: via.workaround,
      note: via.note,
    };
  }
  const gap = claim.unavailable.find((u) => u.targets.includes(fqbn));
  if (gap) return { header, available: false, reason: gap.reason, alternative: gap.alternative };
  return {
    header,
    available: false,
    unknown: true,
    reason: `${header} has not been checked against ${fqbn}.`,
  };
}

/** Every header recorded as building for a target, for the capability report. */
export function headersForTarget(
  fqbn: string,
): { header: string; source: string; effect: HeaderEffect }[] {
  const out: { header: string; source: string; effect: HeaderEffect }[] = [];
  for (const claim of HEADER_CLAIMS) {
    const via = claim.via.find((v) => v.targets.includes(fqbn));
    if (via) out.push({ header: claim.header, source: via.source, effect: via.effect ?? 'works' });
  }
  return out;
}

/** `#include <X.h>` / `#include "X.h"` occurrences, outside comments and strings. */
export function includedHeaders(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const found: string[] = [];
  const re = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * The headers a sketch includes that are known not to build for the target.
 *
 * Only headers the manifest has a measured answer for are reported. An unknown
 * header is left to the compiler, so this never blocks a build that would have
 * worked.
 */
export function unsupportedIncludes(
  source: string,
  fqbn: string,
): { header: string; reason: string; alternative?: string }[] {
  const out: { header: string; reason: string; alternative?: string }[] = [];
  for (const header of includedHeaders(source)) {
    const res = resolveHeader(header, fqbn);
    if (!res.available && !('unknown' in res)) {
      out.push({ header: res.header, reason: res.reason, alternative: res.alternative });
    }
  }
  return out;
}

export interface IncludeWarning {
  header: string;
  /**
   * `unsupported` — it will not compile.
   * `no-effect`   — it will compile and do nothing on any pin.
   */
  kind: 'unsupported' | 'no-effect';
  reason: string;
  /** A header to use instead, for `unsupported`. */
  alternative?: string;
  /** A different way to get the same result, for `no-effect`. */
  workaround?: string;
}

/**
 * Everything worth telling a user about their includes before they wonder why
 * the circuit is dead.
 *
 * The `no-effect` half is the one that matters. A build that succeeds and a
 * circuit that does nothing is the hardest thing to debug in a simulator,
 * because every visible signal says the setup is correct. Saying it plainly at
 * build time costs one line and saves an afternoon.
 */
export function includeWarnings(source: string, fqbn: string): IncludeWarning[] {
  const out: IncludeWarning[] = [];
  for (const header of includedHeaders(source)) {
    const res = resolveHeader(header, fqbn);
    if (!res.available) {
      if ('unknown' in res) continue;
      out.push({ header: res.header, kind: 'unsupported', reason: res.reason, alternative: res.alternative });
    } else if (res.effect === 'compiles-only') {
      out.push({
        header: res.header,
        kind: 'no-effect',
        reason:
          res.effectReason ??
          `${res.header} compiles for ${fqbn}, but CircuitDesk does not model the peripheral it drives, so it has no effect.`,
        workaround: res.workaround,
      });
    }
  }
  return out;
}
