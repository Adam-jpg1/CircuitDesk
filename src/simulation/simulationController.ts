// Owns the live emulator instance. The CPU runs outside React state — only
// throttled snapshots are published to the simulation store.
//
// Board gating: firmware only ever executes through the simulator adapter
// registered for the project's board (adapters.ts). Boards without an
// adapter produce a clear status message — they are never run on another
// board's engine or pin profile. Engines are loaded lazily on first start.

import type { BoardRunner } from './boardRunner';
import { CircuitBinding, emptyControls, type SimControls } from './circuitSim';
import { getSimulatorAdapter, assertFirmwareMatchesBoard, type FirmwareArtifact } from './adapters';
import { resolveDefinition } from '../project/partsRegistry';
import { useSimulationStore } from './simulationStore';
import type { BoardDefinition, CircuitProject } from '../types';

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

function findSimulatedBoard(project: CircuitProject): BoardDefinition | null {
  for (const inst of project.boardInstances) {
    const def = resolveDefinition(inst.definitionId, project);
    if (def?.isBoard && getSimulatorAdapter(def)) return def;
  }
  return null;
}

class SimulationController {
  private runner: BoardRunner | null = null;
  private binding: CircuitBinding | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickWall = 0;
  private lastPublishWall = 0;
  private serialDecoder = new TextDecoder();
  private firmware: FirmwareArtifact | null = null;
  private compiledForBoardId: string | null = null;
  private project: CircuitProject | null = null;
  private simMsRecently = 0;
  private wallRecently = 0;
  private starting = false;

  loadFirmware(firmware: FirmwareArtifact, project: CircuitProject, compiledForBoardId: string): void {
    this.stop();
    this.firmware = firmware;
    this.compiledForBoardId = compiledForBoardId;
    this.project = project;
  }

  get hasFirmware(): boolean {
    return this.firmware !== null;
  }

  /**
   * Re-bind the circuit (e.g. after wiring changes) without recompiling.
   *
   * If the board itself changed, the running firmware no longer belongs to
   * this project: the simulation is stopped instead of continuing to publish
   * the old board's pin states under the new board's name.
   */
  refreshCircuit(project: CircuitProject): void {
    this.project = project;
    if (!this.runner) return;
    const board = findSimulatedBoard(project);
    if (!board) {
      this.stop();
      useSimulationStore
        .getState()
        .setStatus('error', 'The simulated board was removed from the canvas, so the simulation was stopped.');
      return;
    }
    if (this.compiledForBoardId && board.id !== this.compiledForBoardId) {
      this.stop();
      useSimulationStore
        .getState()
        .setStatus(
          'error',
          `The board on the canvas changed to ${board.name}, but the loaded firmware was compiled for "${this.compiledForBoardId}". ` +
            'The simulation was stopped — recompile for this board.',
        );
      return;
    }
    this.binding = new CircuitBinding(project, this.runner);
  }

  start(): void {
    const store = useSimulationStore.getState();
    if (!this.firmware || !this.project) {
      store.setStatus('error', 'No compiled firmware loaded. Compile the sketch first.');
      return;
    }
    if (store.status === 'paused' && this.runner) {
      this.resumeLoop();
      store.setStatus('running');
      return;
    }
    if (this.starting) return;
    this.starting = true;
    const previous = this.runner;
    void this.createRunner()
      .then((runner) => {
        if (!runner) return;
        this.attachRunner(previous, runner);
        useSimulationStore.getState().clearSerial();
        useSimulationStore.getState().setStatus('running');
        this.resumeLoop();
      })
      .finally(() => {
        this.starting = false;
      });
  }

  /** Creates a runner through the board's registered adapter — or reports why not. */
  private async createRunner(): Promise<BoardRunner | null> {
    const store = useSimulationStore.getState();
    const project = this.project!;
    const boardDef = findSimulatedBoard(project);
    if (!boardDef) {
      const firstBoard = project.boardInstances[0]
        ? resolveDefinition(project.boardInstances[0].definitionId, project)
        : undefined;
      store.setStatus(
        'error',
        firstBoard
          ? `Simulation is not supported for ${firstBoard.name} (${firstBoard.supportLevel} support). It will not be run on another board's simulator.`
          : 'Place a simulated board (e.g. Arduino Uno or Nano) on the canvas to run firmware.',
      );
      return null;
    }
    const adapter = getSimulatorAdapter(boardDef)!;
    try {
      assertFirmwareMatchesBoard(this.compiledForBoardId ?? '', boardDef);
      return await adapter.createRunner(this.firmware!, boardDef);
    } catch (err) {
      console.error('[CircuitDesk] simulator init failed:', err);
      store.setStatus('error', err instanceof Error ? err.message : 'Failed to load firmware into the simulator.');
      return null;
    }
  }

  private attachRunner(previous: BoardRunner | null, runner: BoardRunner): void {
    // Release the outgoing machine before the new one starts, so a stopped
    // project cannot keep listeners alive or leak peripheral state into the
    // next run.
    previous?.dispose?.();
    this.runner = runner;
    runner.onSerialByte = (byte) => {
      const text = this.serialDecoder.decode(new Uint8Array([byte]), { stream: true });
      if (text) useSimulationStore.getState().appendSerial(text);
    };
    this.binding = new CircuitBinding(this.project!, runner);
  }

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
    const runner = this.runner;
    const binding = this.binding;
    if (!runner || !binding) return;
    const now = performance.now();
    const elapsedMs = Math.min(100, now - this.lastTickWall);
    this.lastTickWall = now;

    const targetSimMs = Math.min(elapsedMs, MAX_SIM_MS_PER_TICK);
    const before = runner.timeMs;
    try {
      // Interleave execution with circuit updates so inputs land promptly.
      const slice = targetSimMs / 4;
      const controls = this.controls();
      for (let done = 0; done < targetSimMs; done += slice) {
        runner.runFor(Math.min(slice, targetSimMs - done));
        binding.update(controls);
      }
    } catch (err) {
      this.stopLoop();
      useSimulationStore.getState().setStatus('error', err instanceof Error ? err.message : 'Simulation crashed.');
      return;
    }
    this.simMsRecently += runner.timeMs - before;
    this.wallRecently += elapsedMs;

    if (now - this.lastPublishWall >= PUBLISH_EVERY_MS) {
      this.publish();
      this.lastPublishWall = now;
    }
  }

  private publish(): void {
    const runner = this.runner;
    const binding = this.binding;
    if (!runner || !binding) return;
    const { visuals } = binding.update(this.controls());
    const speedFactor = this.wallRecently > 0 ? this.simMsRecently / this.wallRecently : 1;
    this.simMsRecently = 0;
    this.wallRecently = 0;
    useSimulationStore.getState().publishFrame({
      simTimeMs: runner.timeMs,
      speedFactor,
      pinSnapshot: runner.snapshot(),
      visuals: Object.fromEntries(visuals),
    });
  }

  pause(): void {
    if (useSimulationStore.getState().status !== 'running') return;
    this.stopLoop();
    this.publish();
    useSimulationStore.getState().setStatus('paused');
  }

  /** Advances a fixed slice of simulated time while paused (single-step). */
  step(simMs = 1): void {
    const store = useSimulationStore.getState();
    if (!this.runner || !this.binding) return;
    if (store.status === 'running') this.pause();
    try {
      this.runner.runFor(simMs);
      this.binding.update(this.controls());
      this.publish();
      store.setStatus('paused');
    } catch (err) {
      store.setStatus('error', err instanceof Error ? err.message : 'Step failed.');
    }
  }

  reset(): void {
    const store = useSimulationStore.getState();
    const wasRunning = store.status === 'running';
    this.stopLoop();
    if (!this.firmware || !this.project) return;
    const previous = this.runner;
    void this.createRunner().then((runner) => {
      if (!runner) return;
      this.attachRunner(previous, runner);
      useSimulationStore.getState().clearSerial();
      if (wasRunning) {
        this.resumeLoop();
        useSimulationStore.getState().setStatus('running');
      } else {
        this.publish();
        useSimulationStore.getState().setStatus('paused');
      }
    });
  }

  stop(): void {
    this.stopLoop();
    this.runner?.dispose?.();
    this.runner = null;
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

  sendSerial(text: string): void {
    this.runner?.queueSerialInput(text);
  }
}

export const simulationController = new SimulationController();
