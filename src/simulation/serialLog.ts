// Turning attributed serial bytes into a transcript a person can read.
//
// `SimulationWorld` emits one `SerialOutputEvent` per byte, tagged with the
// board instance that wrote it. That is the right thing for the runtime to
// produce and the wrong thing to show anyone, so this sits between: it decodes,
// splits into lines, and remembers which instance each line came from.
//
// Three things here are easy to get wrong and are the reason this exists rather
// than being three lines in the controller:
//
//   * Decoding must be per instance. A UTF-8 '°' is two bytes; if two boards
//     are printing at once, a single streaming decoder would splice one board's
//     lead byte onto the other's continuation byte and emit a replacement
//     character. One decoder per instance is the only correct arrangement.
//
//   * A line must be attributed to the instance that wrote it, not to whoever
//     happened to write the newline. Partial lines are therefore held per
//     instance until they are terminated.
//
//   * The label is not the identity. The instance id is stable and internal;
//     "Pico #1" is a display name that can change when the user renames a board
//     or adds another one. Lines are stored by id and labelled at render time,
//     so renaming a board relabels its history instead of orphaning it.

import type { SerialOutputEvent } from './simulationWorld';

/** One line of output, and the board instance that produced it. */
export interface SerialLine {
  instanceId: string;
  /** Simulated milliseconds at which the line's first byte was written. */
  timestamp: number;
  /** The line's text, without its terminating newline. */
  text: string;
  /** False while the firmware has written a partial line and no newline yet. */
  complete: boolean;
}

export interface SerialTranscriptOptions {
  /**
   * Most lines retained. Older ones are dropped, as a terminal scrolls.
   *
   * Firmware that prints in a tight loop will outrun any panel, and holding
   * every line would grow without bound for as long as the simulation runs.
   */
  maxLines?: number;
  /**
   * Label every line even when only one board has spoken.
   *
   * Off by default so a single-board project's monitor reads exactly as it
   * always has. The moment a second instance writes anything, prefixes appear —
   * including on the lines already there, which is why lines are stored by id
   * and rendered on demand.
   */
  alwaysLabel?: boolean;
}

const DEFAULT_MAX_LINES = 2000;

/** How a board instance is named in the transcript. */
export type SerialLabeller = (instanceId: string) => string;

export class SerialTranscript {
  private readonly decoders = new Map<string, TextDecoder>();
  private readonly openLines = new Map<string, SerialLine>();
  private readonly closed: SerialLine[] = [];
  private readonly maxLines: number;
  private readonly alwaysLabel: boolean;

  constructor(options: SerialTranscriptOptions = {}) {
    this.maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
    this.alwaysLabel = options.alwaysLabel ?? false;
  }

  /** Instances that have written at least one byte, in first-write order. */
  get speakers(): string[] {
    const seen: string[] = [];
    for (const line of this.lines()) if (!seen.includes(line.instanceId)) seen.push(line.instanceId);
    return seen;
  }

  push(event: SerialOutputEvent): void {
    let decoder = this.decoders.get(event.instanceId);
    if (!decoder) {
      decoder = new TextDecoder();
      this.decoders.set(event.instanceId, decoder);
    }
    // `stream: true` is what holds an incomplete multi-byte sequence back until
    // its continuation bytes arrive, rather than emitting U+FFFD for each half.
    const text = decoder.decode(new Uint8Array([event.byte]), { stream: true });
    if (text) this.appendText(event.instanceId, event.timestamp, text);
  }

  /** Adds already-decoded text, for callers that have it in that form. */
  appendText(instanceId: string, timestamp: number, text: string): void {
    let open = this.openLines.get(instanceId);
    for (const char of text) {
      if (char === '\r') continue; // CRLF: the newline is what ends a line.
      if (!open) {
        open = { instanceId, timestamp, text: '', complete: false };
        this.openLines.set(instanceId, open);
      }
      if (char === '\n') {
        open.complete = true;
        this.closed.push(open);
        this.openLines.delete(instanceId);
        open = undefined;
        if (this.closed.length > this.maxLines) this.closed.splice(0, this.closed.length - this.maxLines);
      } else {
        open.text += char;
      }
    }
  }

  /**
   * Every line, finished ones first and then whatever is still being written.
   *
   * The unfinished lines come last because they have no ordering among
   * themselves that is more truthful than that: two boards mid-line have both
   * written something, and neither has finished.
   */
  lines(): SerialLine[] {
    const open = [...this.openLines.values()].sort((a, b) => a.timestamp - b.timestamp);
    return [...this.closed, ...open];
  }

  /** Only what one board instance said. */
  linesFor(instanceId: string): SerialLine[] {
    return this.lines().filter((line) => line.instanceId === instanceId);
  }

  /**
   * The transcript as text, prefixed with each line's board when it matters.
   *
   * `label` turns the stable instance id into whatever the project calls that
   * board. Passing one that throws away the distinction — a constant, say —
   * would make the output ambiguous again, which is the caller's decision to
   * get right and not something this can check.
   */
  render(label: SerialLabeller): string {
    const lines = this.lines();
    const multi = this.alwaysLabel || new Set(lines.map((l) => l.instanceId)).size > 1;
    const rendered = lines.map((line) => (multi ? `[${label(line.instanceId)}] ${line.text}` : line.text));
    // A line still being written has no newline yet, and must not gain one:
    // the next byte continues it.
    const trailing = this.openLines.size > 0 ? '' : '\n';
    return rendered.length === 0 ? '' : rendered.join('\n') + trailing;
  }

  clear(): void {
    this.decoders.clear();
    this.openLines.clear();
    this.closed.length = 0;
  }

  /** Forgets one board's output and its decoder, for a board being removed. */
  forget(instanceId: string): void {
    this.decoders.delete(instanceId);
    this.openLines.delete(instanceId);
    for (let i = this.closed.length - 1; i >= 0; i--) {
      if (this.closed[i].instanceId === instanceId) this.closed.splice(i, 1);
    }
  }
}

/**
 * Display names for board instances, numbered per board type.
 *
 * "Pico #1" and "Pico #2" rather than two identical "Pico"s, and no number at
 * all when a type appears once — a project with one Pico and one Uno reads
 * better as "[Pico]" and "[Uno]". The user's own label for an instance wins
 * over both, because they chose it to tell the boards apart.
 */
export function buildSerialLabels(
  instances: readonly { instanceId: string; boardName: string; label?: string }[],
): Map<string, string> {
  const labels = new Map<string, string>();
  const taken = new Set<string>();

  // Named boards first, so a board the user has already told apart never gets
  // a number, and never has one taken from under it by an automatic name.
  const unnamed: typeof instances = instances.filter((inst) => {
    const own = inst.label?.trim();
    if (!own) return true;
    labels.set(inst.instanceId, own);
    taken.add(own);
    return false;
  }) as typeof instances;

  // Numbering counts only the boards that still need a name: one Uno beside a
  // second Uno the user has called "Sensor node" is unambiguously "Arduino Uno".
  const counts = new Map<string, number>();
  for (const inst of unnamed) counts.set(inst.boardName, (counts.get(inst.boardName) ?? 0) + 1);

  const seen = new Map<string, number>();
  for (const inst of unnamed) {
    const n = (seen.get(inst.boardName) ?? 0) + 1;
    seen.set(inst.boardName, n);
    let name = (counts.get(inst.boardName) ?? 0) > 1 ? `${inst.boardName} #${n}` : inst.boardName;
    // A user label can collide with the name this would otherwise produce.
    // Two identical prefixes in a transcript would defeat the whole point.
    let bump = n;
    while (taken.has(name)) name = `${inst.boardName} #${++bump}`;
    taken.add(name);
    labels.set(inst.instanceId, name);
  }
  return labels;
}

// ------------------------------------------------------- contention reporting
//
// "Net contention detected" tells a user that something is wrong and nothing
// about where. The binding already knows exactly which board pins are fighting;
// this turns that into the sentence, using the same stable-id-to-label rule the
// serial monitor uses so a board is called the same thing everywhere.

/** One board pin driving a contended net, as the reporter needs it. */
export interface ContentionDriverInfo {
  instanceId: string;
  pinId: string;
  level: 'high' | 'low';
}

/**
 * Describes a contended net in terms of the boards driving it.
 *
 * `label` maps a stable instance id to whatever the project calls that board —
 * the user's own name when they gave one, otherwise a numbered product name.
 * Fewer than two drivers is not contention and returns null, so a caller cannot
 * accidentally produce a conflict message for a single driver.
 */
export function describeContention(
  drivers: readonly ContentionDriverInfo[],
  label: SerialLabeller,
): string | null {
  if (drivers.length < 2) return null;
  // Agreement is not a conflict. Three outputs all driving HIGH are wired
  // together, which is legal and common.
  if (new Set(drivers.map((d) => d.level)).size < 2) return null;

  const named = drivers.map((d) => `${label(d.instanceId)} ${d.pinId} (${d.level.toUpperCase()})`);
  const list =
    named.length === 2
      ? `${named[0]} and ${named[1]}`
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `Net contention: ${list} are driving conflicting levels.`;
}
