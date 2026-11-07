// Building while the user is still reading their code.
//
// A compile is 0.6 s on an Uno and 4 s on an ESP32, all of it inside the
// toolchain, and it used to start only when Run was pressed — so every edit
// paid it in full, at exactly the moment the user was waiting. But the code is
// usually finished well before the click: people stop typing, look it over,
// and then press Run. This uses that pause. When the sketch has been still for
// a moment, it compiles in the background into the same artifact cache Run
// reads, and Run then starts immediately.
//
// It must not cost anyone anything, which is what most of this file is about:
//
//   * it only fires after the code has been still for IDLE_MS, so typing never
//     triggers a build per keystroke;
//   * one at a time, and never more often than MIN_SPACING_MS, so it can use at
//     most a fraction of the per-client compile budget the server enforces —
//     that limit is a protection for the shared service and is not touched;
//   * when the service says "not now" (busy, rate-limited, unreachable) it
//     backs off for BACKOFF_MS rather than asking again;
//   * a source that failed to compile is not retried until it changes, so a
//     half-written sketch costs one request, not one per pause;
//   * it never runs while a real compile is in progress, and does nothing
//     visible: no toast, no panel change, no build report.

import { useEditorStore } from './editorStore';
import { simulationController } from '../simulation/simulationController';
import { resolveWorkspaceTargets } from '../compiler/targets';
import { fingerprintForBoard } from '../compiler/fingerprint';
import { filesForBoard } from '../project/sketches';
import { getSimulatorAdapter } from '../simulation/adapters';
import type { CircuitProject } from '../types';

export const IDLE_MS = 1200;
export const MIN_SPACING_MS = 15_000;
export const BACKOFF_MS = 60_000;

/** Everything that decides what would be compiled, as one string. */
export function buildSignature(project: CircuitProject): string {
  const { targets } = resolveWorkspaceTargets(project);
  return targets
    .filter((t) => getSimulatorAdapter(t.board))
    .map((t) => fingerprintForBoard(t.board, filesForBoard(project, t.instanceIds[0])))
    .sort()
    .join('|');
}

interface SchedulerDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  prebuild: (project: CircuitProject) => ReturnType<typeof simulationController.prebuild>;
  isCompiling: () => boolean;
}

/**
 * The scheduling rules, separated from the stores so they can be tested with a
 * fake clock. `changed()` is called whenever the project may have changed.
 */
export class BackgroundBuilder {
  private timer: unknown = null;
  private inFlight = false;
  private lastStartedAt = -Infinity;
  private backoffUntil = -Infinity;
  private lastSignature = '';
  /** Signatures that failed to compile; not retried until the source changes. */
  private failed = new Set<string>();
  /** Requests actually sent, for tests and diagnostics. */
  requests = 0;

  constructor(
    private readonly current: () => CircuitProject | null,
    private readonly deps: SchedulerDeps,
  ) {}

  changed(): void {
    const project = this.current();
    if (!project) return;
    const signature = buildSignature(project);
    if (signature === '' || signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.schedule(IDLE_MS);
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.fire();
    }, ms);
  }

  private async fire(): Promise<void> {
    const project = this.current();
    if (!project || this.inFlight) return;
    const signature = buildSignature(project);
    if (signature === '' || this.failed.has(signature)) return;
    if (simulationController.isPrebuilt(project)) return;
    if (this.deps.isCompiling()) {
      this.schedule(IDLE_MS);
      return;
    }
    const now = this.deps.now();
    const wait = Math.max(this.backoffUntil - now, this.lastStartedAt + MIN_SPACING_MS - now);
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    this.inFlight = true;
    this.lastStartedAt = now;
    this.requests++;
    try {
      const outcome = await this.deps.prebuild(project);
      if (outcome.refused) this.backoffUntil = this.deps.now() + BACKOFF_MS;
      else if (outcome.failed > 0) this.failed.add(signature);
    } catch {
      this.backoffUntil = this.deps.now() + BACKOFF_MS;
    } finally {
      this.inFlight = false;
    }
    // The code may have moved on while that was compiling.
    const latest = this.current();
    if (latest && buildSignature(latest) !== signature) this.schedule(IDLE_MS);
  }

  stop(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}

/** Starts background builds for the editor; returns a function that stops them. */
export function startBackgroundBuilds(): () => void {
  const builder = new BackgroundBuilder(() => useEditorStore.getState().project, {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    prebuild: (project) => simulationController.prebuild(project),
    isCompiling: () => useEditorStore.getState().compiling,
  });
  let lastProject = useEditorStore.getState().project;
  const unsubscribe = useEditorStore.subscribe((state) => {
    if (state.project === lastProject) return;
    lastProject = state.project;
    builder.changed();
  });
  builder.changed();
  return () => {
    unsubscribe();
    builder.stop();
  };
}
