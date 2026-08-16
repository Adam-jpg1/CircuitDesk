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
import { SerialTranscript, buildSerialLabels } from './serialLog';
import { getSimulatorAdapter, assertFirmwareMatchesBoard, type FirmwareArtifact } from './adapters';
import { resolveWorkspaceTargets, type WorkspaceTarget } from '../compiler/targets';
import { compileProjectCode } from '../compiler/compilerClient';
import { resolveDefinition } from '../project/partsRegistry';
import { filesForBoard, sketchIdFor } from '../project/sketches';
import { useSimulationStore } from './simulationStore';
import type { CompileStage } from '../app/editorStore';
import type { BoardDefinition, CircuitProject, CompileResult, SimulationNote } from '../types';

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
  /** The sketch this build compiled, by stable id. */
  sketchId: string;
  /** And by the name a person gave it. */
  sketchName: string;
  instanceIds: string[];
  status: 'built' | 'compile-failed' | 'not-simulated' | 'artifact-mismatch' | 'no-toolchain' | 'needs-build';
  /** One line a person can act on. Always names the board, never just "failed". */
  detail: string;
  /**
   * Includes that compile for this target and then do nothing.
   *
   * Carried on the build rather than only inside `result`, because it survives
   * the artifact cache: the second build of an unchanged sketch reports "up to
   * date" without asking the compiler, and the warning has to still be there.
   */
  notes?: SimulationNote[];
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
  target: {
    /** The target the compiler service is asked for — always on its allowlist. */
    boardId: string;
    /** The board the artifact belongs to, when it differs from the target. */
    stampBoardId?: string;
    fqbn: string;
    files?: { name: string; content: string }[];
  },
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
  /**
   * Include warnings, keyed the same way the artifacts are.
   *
   * They belong to the same thing an artifact does — a target plus exact
   * source text — so a cache hit that skips the compiler still knows that this
   * sketch's Servo.h does nothing on this board.
   */
  private artifactNotes = new Map<string, SimulationNote[]>();
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
   * Compiles each sketch once per target that runs it.
   *
   * The build unit is target + sketch, not board: two boards on one sketch and
   * one FQBN produce one artifact loaded into two machines, and two boards on
   * different sketches produce two even though they are the same kind of board.
   * A failure is reported as that sketch's failure on that board family, with
   * the boards affected named — not as "Build failed".
   */
  async build(project: CircuitProject): Promise<BuildReport> {
    this.project = project;
    const { targets, unbuildable } = resolveWorkspaceTargets(project);
    const builds: BoardBuild[] = [];

    const labels = this.boardLabels();
    for (const [index, target] of targets.entries()) {
      // One status per BUILD, not per board: three Picos on one sketch are one
      // compile, and saying so three times would misreport what is happening.
      this.onStage?.({
        step: 'preparing',
        sketchName: target.sketchName,
        fqbn: target.fqbn,
        boards: target.instanceIds.map((id) => labels.get(id) ?? this.boardLabel(id)),
        index: index + 1,
        total: targets.length,
      });
      builds.push(await this.buildTarget(project, target, index + 1, targets.length, labels));
    }
    this.onStage?.(null);
    for (const board of unbuildable) {
      builds.push({
        fqbn: '',
        boardId: '',
        boardName: board.boardName,
        sketchId: '',
        sketchName: '',
        instanceIds: [board.instanceId],
        status: 'no-toolchain',
        detail: board.reason,
      });
    }

    this.builds = builds;
    this.publishBuilds();
    return {
      builds,
      anyRunnable: builds.some((b) => b.status === 'built'),
      allSucceeded: builds.every((b) => b.status === 'built'),
    };
  }

  /**
   * Sends the build report to the UI with the boards each build serves.
   *
   * Board names come from the same labelling the serial monitor uses, so one
   * board is called one thing everywhere in the app.
   */
  private publishBuilds(): void {
    // Project-wide labelling, not the running world's: a build report exists
    // precisely when boards are not running yet, and three identical Picos
    // sharing one broken sketch have to be named apart in "affected boards".
    const labels = this.boardLabels();
    useSimulationStore.getState().setBuilds(
      this.builds.map((b) => ({
        boardName: b.boardName,
        fqbn: b.fqbn,
        sketchName: b.sketchName,
        usedBy: b.instanceIds.map((id) => labels.get(id) ?? this.boardLabel(id)),
        status: b.status,
        detail: b.detail,
      })),
    );
  }

  /**
   * Display names for every board instance in the project, told apart.
   *
   * Built from the project rather than the running world so a board is called
   * the same thing whether it is running, waiting or failed to build — and so
   * a board that did not compile cannot renumber the ones that did.
   */
  private boardLabels(): Map<string, string> {
    const project = this.project;
    if (!project) return new Map();
    return buildSerialLabels(
      project.boardInstances.map((inst) => ({
        instanceId: inst.id,
        boardName: resolveDefinition(inst.definitionId, project)?.name ?? 'Board',
        label: inst.label,
      })),
    );
  }

  /** A readable name for a board instance that is not running yet. */
  private boardLabel(instanceId: string): string {
    const project = this.project;
    const inst = project?.boardInstances.find((b) => b.id === instanceId);
    if (!inst) return instanceId;
    if (inst.label) return inst.label;
    const def = project ? resolveDefinition(inst.definitionId, project) : undefined;
    return def?.name ?? instanceId;
  }

  /**
   * Where build stages are reported, wired up by the app.
   *
   * A callback rather than a store write from here, because the controller is
   * used headless in tests where there is no UI to tell.
   */
  onStage?: (stage: CompileStage | null) => void;

  private async buildTarget(
    project: CircuitProject,
    target: WorkspaceTarget,
    index: number,
    total: number,
    labels: Map<string, string>,
  ): Promise<BoardBuild> {
    const files = filesForBoard(project, target.instanceIds[0]);
    const base = {
      fqbn: target.fqbn,
      boardId: target.boardId,
      boardName: target.board.name,
      sketchId: target.sketchId,
      sketchName: target.sketchName,
      instanceIds: [...target.instanceIds],
    };
    const adapter = getSimulatorAdapter(target.board);
    // Keyed by what actually determines the bytes: the target and the exact
    // text going into it. Not the board instance — an artifact is a file, and
    // two machines can load the same one.
    const cacheKey = buildKey(target.fqbn, files);

    const boards = target.instanceIds.map((id) => labels.get(id) ?? this.boardLabel(id));
    const stage = (step: CompileStage['step']) =>
      this.onStage?.({ step, sketchName: target.sketchName, fqbn: target.fqbn, boards, index, total });

    const cached = this.artifacts.get(cacheKey);
    if (cached) {
      stage('cached');
      const notes = this.artifactNotes.get(cacheKey);
      return {
        ...base,
        status: 'built',
        detail: `${describe(target)} — up to date${noteSuffix(notes)}`,
        notes,
      };
    }

    stage('compiling');
    const result = await this.compileFn(project, {
      // The service is asked for the TARGET, and the artifact is stamped with
      // the BOARD. A custom board names the RP2040 target to get RP2040
      // firmware, and the firmware still belongs to that board.
      boardId: target.serverBoardId,
      stampBoardId: target.boardId,
      fqbn: target.fqbn,
      files: files.map((f) => ({ name: f.name, content: f.content })),
    });
    if (!result.success || !result.firmware) {
      return {
        ...base,
        status: 'compile-failed',
        detail: `${describe(target)} — build failed${result.error ? `: ${firstLine(result.error)}` : ''}`,
        notes: result.simulationNotes,
        durationMs: result.durationMs,
        result,
      };
    }
    if (!adapter) {
      return {
        ...base,
        status: 'not-simulated',
        detail: `${describe(target)} — built for the real hardware, but CircuitDesk cannot execute this board yet`,
        durationMs: result.durationMs,
        result,
      };
    }
    if (result.firmware.format !== adapter.firmwareFormat) {
      return {
        ...base,
        status: 'artifact-mismatch',
        detail:
          `${describe(target)} — built as ${result.firmware.format}, but its engine expects ${adapter.firmwareFormat}`,
        durationMs: result.durationMs,
        result,
      };
    }
    this.artifacts.set(cacheKey, result.firmware);
    const notes = result.simulationNotes;
    if (notes && notes.length > 0) this.artifactNotes.set(cacheKey, notes);
    else this.artifactNotes.delete(cacheKey);
    return {
      ...base,
      status: 'built',
      detail: `${describe(target)} — build succeeded${noteSuffix(notes)}`,
      notes,
      durationMs: result.durationMs,
      result,
    };
  }

  /** Firmware for a board instance, if the build for its sketch succeeded. */
  private artifactForInstance(instanceId: string): FirmwareArtifact | undefined {
    if (!this.project) return undefined;
    const build = this.builds.find((b) => b.status === 'built' && b.instanceIds.includes(instanceId));
    if (!build) return undefined;
    return this.artifacts.get(buildKey(build.fqbn, filesForBoard(this.project, instanceId)));
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
        sketchId: sketchIdFor(this.project!, instanceId) ?? '',
        sketchName: this.project?.codeFiles.find((f) => f.id === sketchIdFor(this.project!, instanceId))?.name ?? '',
        instanceIds: [instanceId],
        status: 'needs-build',
        detail: `${def.name} — on the canvas but not built yet. Recompile to include it.`,
      },
    ];
    this.publishBuilds();
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
    const labels = this.boardLabels();
    return world.boards.map((m) => ({ instanceId: m.instanceId, label: labels.get(m.instanceId) ?? m.instanceId }));
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

  /**
   * Tears the controller down for a different project entirely.
   *
   * `stop()` ends a run but deliberately keeps the build report on screen, so
   * a compile error is still readable after pressing Stop. Leaving a project
   * is different: everything on screen belonged to a project the user is no
   * longer in, and a fresh blank project showing the last one's serial output
   * or "3 boards built" is showing them somebody else's work.
   *
   * Distinct from `reset()`, which power-cycles the boards inside the project
   * the user is still working on.
   */
  closeProject(): void {
    this.stop();
    this.project = null;
    this.builds = [];
    this.artifacts.clear();
    this.transcript.clear();
    this.transcriptVersion = 0;
    this.publishedTranscriptVersion = -1;
    this.controlsNow = emptyControls();
    const store = useSimulationStore.getState();
    store.setStatus('stopped', null);
    store.clearSerial();
    store.setSerialBoards([]);
    store.setSerialTarget(null);
    store.setBuilds([]);
    store.resetInputs();
  }

  private stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * What decides whether two builds are the same build.
 *
 * The target and the exact text of every file going into it. Same key means
 * the same bytes come out, so the artifact is reused; different text or a
 * different FQBN means a real compilation. The board instance is deliberately
 * absent — sharing a file is not sharing a CPU.
 */
function buildKey(fqbn: string, files: readonly { name: string; content: string }[]): string {
  return `${fqbn}\u0002${files.map((f) => `${f.name}\u0000${f.content}`).join('\u0001')}`;
}

/** "receiver.ino — Raspberry Pi Pico", which is what a build report needs. */
function describe(target: WorkspaceTarget): string {
  return `${target.sketchName} — ${target.board.name}`;
}

/**
 * The tail of a build line when an include compiles and then does nothing.
 *
 * Kept to one clause, because it sits on a line that already says which sketch
 * and which board; the full reason and the workaround are on the note itself
 * for whatever wants to show them.
 */
function noteSuffix(notes: SimulationNote[] | undefined): string {
  const dead = (notes ?? []).filter((n) => n.kind === 'no-effect');
  if (dead.length === 0) return '';
  const names = dead.map((n) => n.header).join(', ');
  return ` — but ${names} ${dead.length === 1 ? 'does' : 'do'} nothing on this board here`;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export const simulationController = new SimulationController();
export type { BoardDefinition };
