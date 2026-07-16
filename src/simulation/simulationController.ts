// Owns the live emulator instance. The AVR CPU runs outside React state —
// only throttled snapshots are published to the simulation store.

import { AVRRunner, F_CPU } from './avrRunner';
import { CircuitBinding, emptyControls, type SimControls } from './circuitSim';
import { useSimulationStore } from './simulationStore';
import type { CircuitProject } from '../types';

const TICK_MS = 12;
/** Max cycles executed per tick — keeps the UI responsive if the machine can't keep up. */
const MAX_CYCLES_PER_TICK = (F_CPU / 1000) * 40;
const PUBLISH_EVERY_MS = 33;

class SimulationController {
  private runner: AVRRunner | null = null;
  private binding: CircuitBinding | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickWall = 0;
  private lastPublishWall = 0;
  private serialDecoder = new TextDecoder();
  private hex: string | null = null;
  private project: CircuitProject | null = null;
  private executedRecently = 0;
  private wallRecently = 0;

  loadFirmware(hex: string, project: CircuitProject): void {
    this.stop();
    this.hex = hex;
    this.project = project;
  }

  get hasFirmware(): boolean {
    return this.hex !== null;
  }

  /** Re-bind the circuit (e.g. after wiring changes) without recompiling. */
  refreshCircuit(project: CircuitProject): void {
    this.project = project;
    if (this.runner) {
      this.binding = new CircuitBinding(project, this.runner);
    }
  }

  start(): void {
    const store = useSimulationStore.getState();
    if (!this.hex || !this.project) {
      store.setStatus('error', 'No compiled firmware loaded. Compile the sketch first.');
      return;
    }
    if (store.status === 'paused' && this.runner) {
      this.resumeLoop();
      store.setStatus('running');
      return;
    }
    try {
      this.runner = new AVRRunner(this.hex);
    } catch (err) {
      store.setStatus('error', err instanceof Error ? err.message : 'Failed to load firmware.');
      return;
    }
    this.runner.onSerialByte = (byte) => {
      const text = this.serialDecoder.decode(new Uint8Array([byte]), { stream: true });
      if (text) useSimulationStore.getState().appendSerial(text);
    };
    this.binding = new CircuitBinding(this.project, this.runner);
    store.clearSerial();
    store.setStatus('running');
    this.resumeLoop();
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
    this.executedRecently = 0;
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

    const targetCycles = Math.min(Math.round((elapsedMs / 1000) * F_CPU), MAX_CYCLES_PER_TICK);
    const before = runner.cpu.cycles;
    try {
      // Interleave execution with circuit updates so inputs land promptly.
      const slice = Math.max(1000, Math.floor(targetCycles / 4));
      const controls = this.controls();
      for (let executed = 0; executed < targetCycles; executed += slice) {
        runner.runToCycles(before + Math.min(targetCycles, executed + slice));
        binding.update(controls);
      }
    } catch (err) {
      this.stopLoop();
      useSimulationStore.getState().setStatus('error', err instanceof Error ? err.message : 'Simulation crashed.');
      return;
    }
    this.executedRecently += runner.cpu.cycles - before;
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
    const speedFactor =
      this.wallRecently > 0 ? this.executedRecently / ((this.wallRecently / 1000) * F_CPU) : 1;
    this.executedRecently = 0;
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

  /** Executes a fixed number of cycles while paused (single-step). */
  step(cycles = 16_000): void {
    const store = useSimulationStore.getState();
    if (!this.runner || !this.binding) return;
    if (store.status === 'running') this.pause();
    try {
      this.runner.runToCycles(this.runner.cpu.cycles + cycles);
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
    if (this.hex && this.project) {
      this.runner = new AVRRunner(this.hex);
      this.runner.onSerialByte = (byte) => {
        const text = this.serialDecoder.decode(new Uint8Array([byte]), { stream: true });
        if (text) useSimulationStore.getState().appendSerial(text);
      };
      this.binding = new CircuitBinding(this.project, this.runner);
      store.clearSerial();
      if (wasRunning) {
        this.resumeLoop();
        store.setStatus('running');
      } else {
        this.publish();
        store.setStatus('paused');
      }
    }
  }

  stop(): void {
    this.stopLoop();
    this.runner = null;
    this.binding = null;
    const store = useSimulationStore.getState();
    store.setStatus('stopped');
    store.publishFrame({
      simTimeMs: 0,
      speedFactor: 1,
      pinSnapshot: { states: Array(20).fill('input'), duty: Array(20).fill(0), pulseWidthUs: Array(20).fill(0), toggles: Array(20).fill(0) },
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
