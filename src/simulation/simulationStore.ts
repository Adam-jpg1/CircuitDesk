import { create } from 'zustand';
import type { ComponentVisualState } from './circuitSim';
import type { PinSnapshot } from './avrRunner';

export type SimStatus = 'stopped' | 'running' | 'paused' | 'error';

/**
 * One target's build outcome, as the UI needs it.
 *
 * Structurally per target rather than one global boolean, because "build
 * failed" is not true of a workspace where the Pico built and the C6 did not.
 */
export interface BoardBuildSummary {
  boardName: string;
  fqbn: string;
  /** The sketch this build compiled, so a failure names the file to open. */
  sketchName: string;
  /**
   * Display names of the boards this one build serves.
   *
   * One build result, however many boards share it: three Picos on one failing
   * sketch is one error and a list of who is affected, not the same message
   * three times.
   */
  usedBy: string[];
  status: 'built' | 'compile-failed' | 'not-simulated' | 'artifact-mismatch' | 'no-toolchain' | 'needs-build';
  detail: string;
}

interface SimulationState {
  status: SimStatus;
  error: string | null;
  simTimeMs: number;
  /** Actual emulation speed as a fraction of real time (1 = realtime). */
  speedFactor: number;
  /**
   * The serial monitor's text, already attributed.
   *
   * Rendered by the controller from a per-instance transcript rather than
   * accumulated here: with two boards printing, "which board said that" is
   * part of the content, and a plain string cannot carry it. One board still
   * renders exactly as it always did, with no prefixes.
   */
  serialText: string;
  serialLineCount: number;
  /** Board instances that can produce or accept serial, with display labels. */
  serialBoards: { instanceId: string; label: string }[];
  /** Which board typed serial input goes to. Never broadcast. */
  serialTarget: string | null;
  /** Per-target build outcomes, so a failure names the board that failed. */
  builds: BoardBuildSummary[];
  pinSnapshot: PinSnapshot | null;
  visuals: Record<string, ComponentVisualState>;
  /** Bumped on every published frame so canvas layers can subscribe cheaply. */
  frame: number;
  /**
   * True while the circuit is being solved without a run: batteries and the
   * parts they power behave as they would on a bench, and switches and knobs
   * in the inspector work, before any board is started.
   */
  circuitLive: boolean;

  // user inputs
  pressedButtons: string[];
  toggleStates: Record<string, boolean>;
  potPositions: Record<string, number>;
  sensorValues: Record<string, number>;

  setStatus(status: SimStatus, error?: string | null): void;
  setCircuitLive(live: boolean): void;
  publishFrame(data: {
    simTimeMs: number;
    speedFactor: number;
    pinSnapshot: PinSnapshot;
    visuals: Record<string, ComponentVisualState>;
  }): void;
  publishSerial(text: string, lineCount: number): void;
  setSerialBoards(boards: { instanceId: string; label: string }[]): void;
  setSerialTarget(instanceId: string | null): void;
  setBuilds(builds: BoardBuildSummary[]): void;
  clearSerial(): void;
  pressButton(id: string, pressed: boolean): void;
  setToggle(id: string, on: boolean): void;
  setPot(id: string, position: number): void;
  setSensor(id: string, value: number): void;
  resetInputs(): void;
}

const SERIAL_CAP = 200_000;

export const useSimulationStore = create<SimulationState>((set, get) => ({
  status: 'stopped',
  error: null,
  simTimeMs: 0,
  speedFactor: 1,
  serialText: '',
  serialLineCount: 0,
  serialBoards: [],
  serialTarget: null,
  builds: [],
  pinSnapshot: null,
  visuals: {},
  frame: 0,
  circuitLive: false,
  pressedButtons: [],
  toggleStates: {},
  potPositions: {},
  sensorValues: {},

  setStatus: (status, error = null) => set({ status, error }),
  setCircuitLive: (live) => set({ circuitLive: live }),

  publishFrame: (data) =>
    set((s) => ({
      simTimeMs: data.simTimeMs,
      speedFactor: data.speedFactor,
      pinSnapshot: data.pinSnapshot,
      visuals: data.visuals,
      frame: s.frame + 1,
    })),

  publishSerial(text, lineCount) {
    // Trimmed from the front, as a terminal scrolls. The transcript itself is
    // already bounded; this bounds what React has to render.
    const next = text.length > SERIAL_CAP ? text.slice(text.length - SERIAL_CAP) : text;
    set({ serialText: next, serialLineCount: lineCount });
  },

  setSerialBoards(boards) {
    const current = get().serialBoards;
    const same =
      current.length === boards.length &&
      current.every((b, i) => b.instanceId === boards[i].instanceId && b.label === boards[i].label);
    if (!same) set({ serialBoards: boards });
  },

  setSerialTarget: (instanceId) => set({ serialTarget: instanceId }),

  setBuilds: (builds) => set({ builds }),

  clearSerial: () => set({ serialText: '', serialLineCount: 0 }),

  pressButton(id, pressed) {
    const setNow = new Set(get().pressedButtons);
    if (pressed) setNow.add(id);
    else setNow.delete(id);
    set({ pressedButtons: [...setNow] });
  },
  setToggle: (id, on) => set((s) => ({ toggleStates: { ...s.toggleStates, [id]: on } })),
  setPot: (id, position) => set((s) => ({ potPositions: { ...s.potPositions, [id]: position } })),
  setSensor: (id, value) => set((s) => ({ sensorValues: { ...s.sensorValues, [id]: value } })),
  resetInputs: () => set({ pressedButtons: [], toggleStates: {}, potPositions: {}, sensorValues: {} }),
}));
