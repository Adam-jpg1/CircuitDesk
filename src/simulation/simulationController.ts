// Owns the live simulation. The CPUs run outside React state — only throttled
// snapshots are published to the simulation store.
//
// This used to own `this.runner`: one board, one CPU, one binding. That model
// was wrong in a way that only showed up once a project had two boards in it —
// a workspace with two Picos ran one Pico and reported it twice. Board *type*
// is not board *instance*, and two boards with the same id are two machines.
//
// So the controller now owns a `SimulationWorld` and the world owns the boards:
//
//     workspace
//        └── SimulationController
//              └── SimulationWorld
//                    ├── board instance A → runner A
//                    ├── board instance B → runner B
//                    └── shared nets, devices, one timeline
//
// Each instance has its own runner, CPU state, RAM, peripherals, lifecycle,
// firmware image and serial identity. The only thing two instances of the same
// board type share is the compiled artifact, which is a file on disk — loading
// the same file into two machines does not join them.
//
// Board gating is unchanged: firmware only ever executes through the adapter
// registered for that board (adapters.ts), and a board without an adapter is
// reported rather than run on another board's engine.

import type { BoardRunner } from './boardRunner';
import { CircuitBinding, emptyControls, type SimControls } from './circuitSim';
import { SimulationWorld, type SerialOutputEvent } from './simulationWorld';
import { SerialTranscript, buildSerialLabels, describeContention } from './serialLog';
import { getSimulatorAdapter, assertFirmwareMatchesBoard, type FirmwareArtifact } from './adapters';
import { resolveWorkspaceTargets, type WorkspaceTarget } from '../compiler/targets';
import { compileProjectCode } from '../compiler/compilerClient';
import { resolveDefinition } from '../project/partsRegistry';
import { useSimulationStore } from './simulationStore';
import type { BoardDefinition, CircuitProject, CompileResult } from '../types';

const TICK_MS = 12;
/**
 * Most simulated milliseconds a single tick may advance.
 *
 * This is the responsiveness budget: if the host cannot keep up with real
 * time, the simulation runs slower rather than blocking the UI thread. It is
 * expressed in simulated time so it means the same thing on every engine.
 */
const MAX_SIM_MS_PER_TICK = 40;
const PUBLISH_EVERY_MS = 33;

/** What became of one target's build, and which boards were waiting on it. */
export interface BoardBuild {
  fqbn: string;
  boardId: string;
  boardName: string;
  instanceIds: string[];
  status: 'built' | 'compile-failed' | 'not-simulated' | 'artifact-mismatch' | 'no-toolchain' | 'needs-build';
  /** One line a person can act on. Always names the board, never just "failed". */
  detail: string;
  durationMs?: number;
  result?: CompileResult;
}

export interface BuildReport {
  builds: BoardBuild[];
  /** True when at least one target produced firmware a runner can execute. */
  anyRunnable: boolean;
  /** True when nothing failed — some targets may still be unsimulated. */
  allSucceeded: boolean;
}

/** Injectable so tests and offline modes can supply their own compiler. */
export type CompileFn = (
  project: CircuitProject,
  target: { boardId: string; fqbn: string },
) => Promise<CompileResult>;

class SimulationController {
  private world: SimulationWorld | null = null;
  private binding: CircuitBinding | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickWall = 0;
  private lastPublishWall = 0;
  private project: CircuitProject | null = null;
  private simMsRecently = 0;
  private wallRecently = 0;
  private starting = false;

  /**
   * Firmware per compile target, keyed by FQBN and the source it was built from.
   *
   * Reused across board instances and across restarts while the sketch has not
   * changed — building the same source for the same target twice produces the
   * same bytes. Runtime state is never in here; this holds files.
   */
  private artifacts = new Map<string, FirmwareArtifact>();
  private builds: BoardBuild[] = [];

  private transcript = new SerialTranscript();
  private transcriptVersion = 0;
  private publishedTranscriptVersion = -1;

  /** Controls sampled once per tick and read by the world's settle callback. */
  private controlsNow: SimControls = emptyControls();

  private compileFn: CompileFn = (project, target) => compileProjectCode(project, target);

  /** Replaces the compiler, for tests and offline builds. */
  setCompiler(fn: CompileFn): void {
    this.compileFn = fn;
  }

  // ------------------------------------------------------------------ state

  /** The running world, for panels that need per-instance state. */
  get simulationWorld(): SimulationWorld | null {
    return this.world;
  }

  get boardInstanceIds(): string[] {
    return (this.world?.boards ?? []).map((m) => m.instanceId);
  }

  runnerFor(instanceId: string): BoardRunner | undefined {
    return this.world?.runnerFor(instanceId);
  }

  get buildReport(): BoardBuild[] {
    return this.builds;
  }

  /** True when at least one target has firmware ready to run. */
  get hasFirmware(): boolean {
    return this.builds.some((b) => b.status === 'built');
  }

  get isMultiBoard(): boolean {
    return (this.world?.boards.length ?? 0) > 1;
  }

  // ------------------------------------------------------------------ build

  /**
   * Compiles the workspace sketch once per distinct target.
   *
   * The editor holds one source. Every runnable board gets that source built
   * for *its* target, so a Pico and a C6 in one project produce two artifacts
   * from one sketch — and a failure on one is reported as that board's failure,
   * not as "Build failed".
   */
  async build(project: CircuitProject): Promise<BuildReport> {
    this.project = project;
    const { targets, unbuildable } = resolveWorkspaceTargets(project);
    const source = sourceKey(project);
    const builds: BoardBuild[] = [];

    for (const target of targets) {
      builds.push(await this.buildTarget(project, target, source));
    }
    for (const board of unbuildable) {
      builds.push({
        fqbn: '',
        boardId: '',
        boardName: board.boardName,
        instanceIds: [board.instanceId],
        status: 'no-toolchain',
        detail: board.reason,
      });
    }

    this.builds = builds;
    useSimulationStore.getState().setBuilds(builds);
    return {
      builds,
      anyRunnable: builds.some((b) => b.status === 'built'),
      allSucceeded: builds.every((b) => b.status === 'built'),
    };
  }

  private async buildTarget(
    project: CircuitProject,
    target: WorkspaceTarget,
    source: string,
  ): Promise<BoardBuild> {
    const base = {
      fqbn: target.fqbn,
      boardId: target.boardId,
      boardName: target.board.name,
      instanceIds: [...target.instanceIds],
    };
    const adapter = getSimulatorAdapter(target.board);
    const cacheKey = `${target.fqbn}|${source}`;

    const cached = this.artifacts.get(cacheKey);
    if (cached) {
      return { ...base, status: 'built', detail: `${target.board.name} — up to date (${target.fqbn})` };
    }

    const result = await this.compileFn(project, { boardId: target.boardId, fqbn: target.fqbn });
    if (!result.success || !result.firmware) {
      return {
        ...base,
        status: 'compile-failed',
        detail: `${target.board.name} — build failed${result.error ? `: ${firstLine(result.error)}` : ''}`,
        durationMs: result.durationMs,
        result,
      };
    }
    if (!adapter) {
      return {
        ...base,
        status: 'not-simulated',
        detail: `${target.board.name} — built for the real hardware, but CircuitDesk cannot execute this board yet`,
        durationMs: result.durationMs,
        result,
      };
    }
    if (result.firmware.format !== adapter.firmwareFormat) {
      return {
        ...base,
        status: 'artifact-mismatch',
        detail:
          `${target.board.name} — built as ${result.firmware.format}, but its engine expects ${adapter.firmwareFormat}`,
        durationMs: result.durationMs,
        result,
      };
    }
    this.artifacts.set(cacheKey, result.firmware);
    return {
      ...base,
      status: 'built',
      detail: `${target.board.name} — build succeeded (${target.fqbn})`,
      durationMs: result.durationMs,
      result,
    };
  }

  /** Firmware for a board instance, if its target built. */
  private artifactForInstance(instanceId: string): FirmwareArtifact | undefined {
    if (!this.project) return undefined;
    const source = sourceKey(this.project);
    const build = this.builds.find((b) => b.status === 'built' && b.instanceIds.includes(instanceId));
    return build ? this.artifacts.get(`${build.fqbn}|${source}`) : undefined;
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * Re-binds the circuit after wiring or board changes, without recompiling.
   *
   * Boards that appeared get a runner of their own; boards that went away are
   * removed and stop driving their nets. Boards that were already running are
   * left alone — editing a wire is not a reset.
   */
  refreshCircuit(project: CircuitProject): void {
    this.project = project;
    const world = this.world;
    if (!world) return;

    const present = new Set(project.boardInstances.map((b) => b.id));
    for (const member of [...world.boards]) {
      if (!present.has(member.instanceId)) {
        world.remove(member.instanceId);
        this.transcript.forget(member.instanceId);
        this.transcriptVersion++;
      }
    }
    // A board added while running boots on its own, exactly as plugging one in
    // would. Nothing else in the world restarts. A board with no firmware for
    // its target is named rather than skipped — silently ignoring it looks
    // exactly like a board that ran and did nothing.
    const needBuild: string[] = [];
    for (const inst of project.boardInstances) {
      if (world.runnerFor(inst.id)) continue;
      const def = resolveDefinition(inst.definitionId, project);
      if (!def?.isBoard || !getSimulatorAdapter(def)) continue;
      if (!this.artifactForInstance(inst.id)) {
        needBuild.push(inst.label || def.name);
        this.noteNeedsBuild(inst.id, def);
        continue;
      }
      void this.addBoardInstance(inst.id);
    }

    if (world.boards.length === 0) {
      this.stop();
      useSimulationStore
        .getState()
        .setStatus(
          'error',
          needBuild.length > 0
            ? `${needBuild.join(' and ')} ${needBuild.length > 1 ? 'are' : 'is'} on the canvas, but the loaded firmware was not compiled for ` +
              `${needBuild.length > 1 ? 'those boards' : 'that board'}. The simulation was stopped — recompile for this canvas.`
            : 'The simulated board was removed from the canvas, so the simulation was stopped.',
        );
      return;
    }
    this.rebind();
  }

  /** Records that a board on the canvas has no firmware built for it yet. */
  private noteNeedsBuild(instanceId: string, def: BoardDefinition): void {
    if (this.builds.some((b) => b.status === 'needs-build' && b.instanceIds.includes(instanceId))) return;
    this.builds = [
      ...this.builds,
      {
        fqbn: def.compiler?.fqbn ?? '',
        boardId: def.id,
        boardName: def.name,
        instanceIds: [instanceId],
        status: 'needs-build',
        detail: `${def.name} — on the canvas but not built yet. Recompile to include it.`,
      },
    ];
    useSimulationStore.getState().setBuilds(this.builds);
  }

  /** Creates and installs a runner for one board instance. */
  private async addBoardInstance(instanceId: string): Promise<boolean> {
    const world = this.world;
    const project = this.project;
    if (!world || !project) return false;
    const inst = project.boardInstances.find((b) => b.id === instanceId);
    const def = inst ? resolveDefinition(inst.definitionId, project) : undefined;
    if (!def?.isBoard) return false;
    const adapter = getSimulatorAdapter(def);
    const firmware = this.artifactForInstance(instanceId);
    if (!adapter || !firmware) return false;
    try {
      assertFirmwareMatchesBoard(def.id, def);
      // A separate createRunner call per instance: separate CPU, RAM and
      // peripherals, from the same bytes.
      const runner = await adapter.createRunner(firmware, def);
      world.add(instanceId, runner);
      this.rebind();
      return true;
    } catch (err) {
      console.error('[CircuitDesk] simulator init failed:', err);
      useSimulationStore
        .getState()
        .setStatus('error', err instanceof Error ? err.message : `Failed to load firmware into ${def.name}.`);
      return false;
    }
  }

  /**
   * Starts (or resumes) the simulation.
   *
   * Returns a promise so a caller that needs the world to exist can wait for
   * it; the UI ignores it and the buttons stay synchronous. Building runners
   * is asynchronous because engines are loaded on first use, which is what
   * keeps an emulator out of the startup bundle.
   */
  start(): Promise<boolean> {
    const store = useSimulationStore.getState();
    if (!this.project) {
      store.setStatus('error', 'No project loaded.');
      return Promise.resolve(false);
    }
    if (!this.hasFirmware) {
      store.setStatus('error', 'No compiled firmware loaded. Compile the sketch first.');
      return Promise.resolve(false);
    }
    if (store.status === 'paused' && this.world) {
      this.resumeLoop();
      store.setStatus('running');
      return Promise.resolve(true);
    }
    if (this.starting) return Promise.resolve(false);
    this.starting = true;
    return this.createWorld()
      .then((ok) => {
        if (!ok) return false;
        this.clearSerial();
        useSimulationStore.getState().setStatus('running');
        this.resumeLoop();
        return true;
      })
      .finally(() => {
        this.starting = false;
      });
  }

  /** Builds a fresh world with one runner per runnable board instance. */
  private async createWorld(): Promise<boolean> {
    const store = useSimulationStore.getState();
    const project = this.project!;
    this.world?.dispose();
    this.world = null;
    this.binding = null;

    const world = new SimulationWorld({ onSerial: (event) => this.onSerial(event) });
    const failures: string[] = [];
    for (const inst of project.boardInstances) {
      const def = resolveDefinition(inst.definitionId, project);
      if (!def?.isBoard) continue;
      const adapter = getSimulatorAdapter(def);
      const firmware = this.artifactForInstance(inst.id);
      if (!adapter) {
        // Not an error: the board compiled, CircuitDesk just cannot run it. The
        // build report already says so, and the rest of the canvas still runs.
        continue;
      }
      if (!firmware) {
        failures.push(`${inst.label || def.name} has no firmware — its target did not build.`);
        continue;
      }
      try {
        assertFirmwareMatchesBoard(def.id, def);
        world.add(inst.id, await adapter.createRunner(firmware, def));
      } catch (err) {
        console.error('[CircuitDesk] simulator init failed:', err);
        failures.push(`${inst.label || def.name}: ${err instanceof Error ? err.message : 'firmware would not load'}`);
      }
    }

    if (world.boards.length === 0) {
      world.dispose();
      const firstBoard = project.boardInstances[0]
        ? resolveDefinition(project.boardInstances[0].definitionId, project)
        : undefined;
      store.setStatus(
        'error',
        failures.length > 0
          ? failures.join(' ')
          : firstBoard
            ? `Simulation is not supported for ${firstBoard.name} (${firstBoard.supportLevel} support). It will not be run on another board's simulator.`
            : 'Place a simulated board (e.g. Arduino Uno or Nano) on the canvas to run firmware.',
      );
      return false;
    }

    this.world = world;
    this.rebind();
    this.publishSerialTargets();
    if (failures.length > 0) console.warn('[CircuitDesk]', failures.join(' '));
    return true;
  }

  /**
   * Rebuilds the circuit binding over the world's current runners.
   *
   * The world settles nets through this, once per slice, at whatever moments
   * the timeline says — not on a fixed millisecond. `controlsNow` is read
   * rather than captured so a button pressed this tick is seen by every settle
   * inside it.
   */
  private rebind(): void {
    const world = this.world;
    if (!world || !this.project) return;
    const primary = world.boards[0]?.runner ?? null;
    this.binding = new CircuitBinding(this.project, primary, world.runnerMap());
    world.settle = () => this.binding?.update(this.controlsNow);
  }

  // ------------------------------------------------------------------ serial

  private onSerial(event: SerialOutputEvent): void {
    this.transcript.push(event);
    this.transcriptVersion++;
  }

  /** Board instances that can produce or accept serial, with display labels. */
  private serialBoards(): { instanceId: string; label: string }[] {
    const project = this.project;
    const world = this.world;
    if (!project || !world) return [];
    const members = world.boards.map((m) => {
      const inst = project.boardInstances.find((b) => b.id === m.instanceId);
      const def = inst ? resolveDefinition(inst.definitionId, project) : undefined;
      return { instanceId: m.instanceId, boardName: def?.name ?? 'Board', label: inst?.label };
    });
    const labels = buildSerialLabels(members);
    return members.map((m) => ({ instanceId: m.instanceId, label: labels.get(m.instanceId) ?? m.instanceId }));
  }

  private publishSerialTargets(): void {
    const boards = this.serialBoards();
    const store = useSimulationStore.getState();
    store.setSerialBoards(boards);
    // Default the input target to the first board, and move it if the board it
    // pointed at has gone.
    const current = store.serialTarget;
    if (!current || !boards.some((b) => b.instanceId === current)) {
      store.setSerialTarget(boards[0]?.instanceId ?? null);
    }
  }

  private publishSerial(): void {
    if (this.transcriptVersion === this.publishedTranscriptVersion) return;
    this.publishedTranscriptVersion = this.transcriptVersion;
    const labels = new Map(this.serialBoards().map((b) => [b.instanceId, b.label]));
    const text = this.transcript.render((id) => labels.get(id) ?? id);
    useSimulationStore.getState().publishSerial(text, this.transcript.lines().length);
  }

  private clearSerial(): void {
    this.transcript.clear();
    this.transcriptVersion++;
    this.publishedTranscriptVersion = -1;
    useSimulationStore.getState().clearSerial();
  }

  /**
   * Sends text to one board's serial input.
   *
   * Targeted, never broadcast: with two boards on the canvas, typing into the
   * monitor has to mean one of them. Omitting the target uses the one the UI
   * has selected.
   */
  sendSerial(text: string, instanceId?: string): boolean {
    const target = instanceId ?? useSimulationStore.getState().serialTarget;
    if (!target || !this.world) return false;
    return this.world.sendSerial(target, text);
  }

  // -------------------------------------------------------------- execution

  private controls(): SimControls {
    const s = useSimulationStore.getState();
    const c = emptyControls();
    for (const id of s.pressedButtons) c.pressedButtons.add(id);
    for (const [id, v] of Object.entries(s.toggleStates)) c.toggleStates.set(id, v);
    for (const [id, v] of Object.entries(s.potPositions)) c.potPositions.set(id, v);
    for (const [id, v] of Object.entries(s.sensorValues)) c.sensorValues.set(id, v);
    return c;
  }

  private resumeLoop(): void {
    this.stopLoop();
    this.lastTickWall = performance.now();
    this.lastPublishWall = 0;
    this.simMsRecently = 0;
    this.wallRecently = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    const now = performance.now();
    const elapsedMs = Math.min(100, now - this.lastTickWall);
    this.lastTickWall = now;
    if (!this.advance(Math.min(elapsedMs, MAX_SIM_MS_PER_TICK))) return;
    this.wallRecently += elapsedMs;

    if (now - this.lastPublishWall >= PUBLISH_EVERY_MS) {
      this.publishNow();
      this.lastPublishWall = now;
    }
  }

  /**
   * Advances the whole world by a span of simulated time.
   *
   * One call, not a fixed sub-loop: the world decides where to stop, and it
   * stops at whatever moment something is actually due — a nanosecond-scheduled
   * net event, a board's next internal event, or the coarse ceiling when
   * nothing finer is pending. Slicing here would make that ceiling the finest
   * resolution anything could communicate at.
   *
   * Public because it is the same path the timer drives, and a caller that
   * needs a deterministic amount of simulated time should get the production
   * one rather than a parallel implementation.
   */
  advance(simMs: number): boolean {
    const world = this.world;
    const binding = this.binding;
    if (!world || !binding) return false;
    const before = world.timeMs;
    try {
      this.controlsNow = this.controls();
      world.runFor(simMs);
    } catch (err) {
      this.stopLoop();
      useSimulationStore.getState().setStatus('error', err instanceof Error ? err.message : 'Simulation crashed.');
      return false;
    }
    this.simMsRecently += world.timeMs - before;
    return true;
  }

  /**
   * Publishes a frame to the store immediately.
   *
   * The running loop calls this on a wall-clock throttle; this is the same
   * work, on demand, for the moments that need a frame right now — pausing,
   * stepping, and anything driving the controller a fixed amount at a time.
   */
  publishNow(): void {
    const world = this.world;
    const binding = this.binding;
    if (!world || !binding) return;
    this.controlsNow = this.controls();
    const { visuals } = binding.update(this.controlsNow);
    const speedFactor = this.wallRecently > 0 ? this.simMsRecently / this.wallRecently : 1;
    this.simMsRecently = 0;
    this.wallRecently = 0;
    const primary = world.boards[0]?.runner;
    useSimulationStore.getState().publishFrame({
      simTimeMs: world.timeMs,
      speedFactor,
      pinSnapshot: primary ? primary.snapshot() : { states: [], duty: [], pulseWidthUs: [], toggles: [] },
      visuals: Object.fromEntries(visuals),
    });
    this.publishSerial();
    this.publishSerialTargets();
    this.publishContention();
  }

  /**
   * Turns the binding's contended nets into sentences that name the boards.
   *
   * The drivers come from the circuit binding, which knows them by stable
   * instance id; the names come from the same labelling the serial monitor
   * uses, so one board is called one thing across the whole app.
   */
  private publishContention(): void {
    const binding = this.binding;
    if (!binding) return;
    const labels = new Map(this.serialBoards().map((b) => [b.instanceId, b.label]));
    const messages: string[] = [];
    for (const drivers of binding.contentionDrivers.values()) {
      const line = describeContention(drivers, (id) => labels.get(id) ?? id);
      if (line) messages.push(line);
    }
    useSimulationStore.getState().setContention(messages);
  }

  pause(): void {
    if (useSimulationStore.getState().status !== 'running') return;
    this.stopLoop();
    this.publishNow();
    useSimulationStore.getState().setStatus('paused');
  }

  /** Advances a fixed slice of simulated time while paused (single-step). */
  step(simMs = 1): void {
    const store = useSimulationStore.getState();
    if (!this.world || !this.binding) return;
    if (store.status === 'running') this.pause();
    if (this.advance(simMs)) {
      this.publishNow();
      store.setStatus('paused');
    }
  }

  /**
   * Restarts every board, as a power cycle would.
   *
   * The shared clock goes back to zero with them, because nothing on the bench
   * is still running.
   */
  reset(): void {
    const store = useSimulationStore.getState();
    const wasRunning = store.status === 'running';
    this.stopLoop();
    if (!this.world) return;
    this.world.reset();
    this.clearSerial();
    if (wasRunning) {
      this.resumeLoop();
      store.setStatus('running');
    } else {
      this.publishNow();
      store.setStatus('paused');
    }
  }

  /**
   * Restarts one board and leaves the rest alone.
   *
   * A reset button on one MCU is not a reset button on the bench: the world's
   * clock keeps running because the rest of the circuit did not stop.
   */
  resetBoard(instanceId: string): void {
    this.world?.resetBoard(instanceId);
    this.transcript.forget(instanceId);
    this.transcriptVersion++;
  }

  /** Takes a board off the canvas. The others carry on. */
  removeBoard(instanceId: string): void {
    if (!this.world) return;
    this.world.remove(instanceId);
    this.transcript.forget(instanceId);
    this.transcriptVersion++;
    this.rebind();
    this.publishSerialTargets();
  }

  /** Puts a board on the canvas mid-run. Only that instance boots. */
  async addBoard(instanceId: string, project?: CircuitProject): Promise<boolean> {
    if (project) this.project = project;
    const ok = await this.addBoardInstance(instanceId);
    if (ok) this.publishSerialTargets();
    return ok;
  }

  stop(): void {
    this.stopLoop();
    this.world?.dispose();
    this.world = null;
    this.binding = null;
    const store = useSimulationStore.getState();
    store.setStatus('stopped');
    store.publishFrame({
      simTimeMs: 0,
      speedFactor: 1,
      pinSnapshot: { states: [], duty: [], pulseWidthUs: [], toggles: [] },
      visuals: {},
    });
  }

  private stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Identifies the sketch, so an artifact is reused only for the source it is. */
function sourceKey(project: CircuitProject): string {
  return project.codeFiles.map((f) => `${f.name}\u0000${f.content}`).join('\u0001');
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export const simulationController = new SimulationController();
export type { BoardDefinition };
