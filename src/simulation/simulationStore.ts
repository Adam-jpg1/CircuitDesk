import { create } from 'zustand';
import type { ComponentVisualState } from './circuitSim';
import type { PinSnapshot } from './avrRunner';

export type SimStatus = 'stopped' | 'running' | 'paused' | 'error';

interface SimulationState {
  status: SimStatus;
  error: string | null;
  simTimeMs: number;
  /** Actual emulation speed as a fraction of real time (1 = realtime). */
  speedFactor: number;
  serialText: string;
  serialLineCount: number;
  pinSnapshot: PinSnapshot | null;
  visuals: Record<string, ComponentVisualState>;
  /** Bumped on every published frame so canvas layers can subscribe cheaply. */
  frame: number;

  // user inputs
  pressedButtons: string[];
  toggleStates: Record<string, boolean>;
  potPositions: Record<string, number>;
  sensorValues: Record<string, number>;

  setStatus(status: SimStatus, error?: string | null): void;
  publishFrame(data: {
    simTimeMs: number;
    speedFactor: number;
    pinSnapshot: PinSnapshot;
    visuals: Record<string, ComponentVisualState>;
  }): void;
  appendSerial(text: string): void;
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
  pinSnapshot: null,
  visuals: {},
  frame: 0,
  pressedButtons: [],
  toggleStates: {},
  potPositions: {},
  sensorValues: {},

  setStatus: (status, error = null) => set({ status, error }),

  publishFrame: (data) =>
    set((s) => ({
      simTimeMs: data.simTimeMs,
      speedFactor: data.speedFactor,
      pinSnapshot: data.pinSnapshot,
      visuals: data.visuals,
      frame: s.frame + 1,
    })),

  appendSerial(text) {
    const current = get().serialText;
    let next = current + text;
    if (next.length > SERIAL_CAP) next = next.slice(next.length - SERIAL_CAP);
    set({ serialText: next, serialLineCount: get().serialLineCount + (text.match(/\n/g)?.length ?? 0) });
  },

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
