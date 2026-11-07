// Sound from the parts that make it: speakers and active buzzers.
//
// A speaker plays the frequency its pin is really toggling at — measured from
// the running firmware, so tone(440) is an A and a sketch that gets its
// timer wrong plays the wrong note. An active buzzer has its own oscillator
// and sounds at its fixed pitch whenever it is powered. Nothing plays while
// the simulation is paused or stopped.
//
// The browser only lets a page make sound after the user has interacted with
// it; pressing Run is that interaction. The setting is per browser.

import { create } from 'zustand';
import { useSimulationStore } from './simulationStore';
import { useEditorStore } from '../app/editorStore';

const STORAGE_KEY = 'circuitdesk.sound';
/** An active buzzer's own oscillator: most hobby modules sit around 2.3 kHz. */
const BUZZER_HZ = 2300;
/** Quiet: a square wave is loud, and several can play at once. */
const VOLUME = 0.04;

function savedOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export const useSoundSetting = create<{ on: boolean; toggle: () => void }>((set, get) => ({
  on: savedOn(),
  toggle: () => {
    const on = !get().on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // the setting just does not persist
    }
    set({ on });
  },
}));

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
}

/** Starts following the simulation; returns the function that stops it. */
export function startSimAudio(): () => void {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return () => {};
  let ctx: AudioContext | null = null;
  const voices = new Map<string, Voice>();

  const silence = (id: string) => {
    const v = voices.get(id);
    if (!v || !ctx) return;
    v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    v.osc.stop(ctx.currentTime + 0.1);
    voices.delete(id);
  };

  const update = () => {
    const sim = useSimulationStore.getState();
    const project = useEditorStore.getState().project;
    const wanted = new Map<string, number>();
    if (useSoundSetting.getState().on && sim.status === 'running' && project) {
      for (const inst of project.componentInstances) {
        const visual = sim.visuals[inst.id];
        if (!visual?.buzzerOn) continue;
        if (inst.definitionId === 'comp.speaker' && visual.value) wanted.set(inst.id, visual.value);
        else if (inst.definitionId === 'comp.buzzer') wanted.set(inst.id, BUZZER_HZ);
      }
    }
    for (const id of [...voices.keys()]) if (!wanted.has(id)) silence(id);
    if (wanted.size === 0) return;
    if (!ctx) {
      try {
        ctx = new AudioContext();
      } catch {
        return;
      }
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    for (const [id, hz] of wanted) {
      let v = voices.get(id);
      if (!v) {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        gain.gain.setTargetAtTime(VOLUME, ctx.currentTime, 0.005);
        v = { osc, gain };
        voices.set(id, v);
      }
      v.osc.frequency.setTargetAtTime(hz, ctx.currentTime, 0.005);
    }
  };

  const unsubSim = useSimulationStore.subscribe(update);
  const unsubSetting = useSoundSetting.subscribe(update);
  return () => {
    unsubSim();
    unsubSetting();
    for (const id of [...voices.keys()]) silence(id);
    void ctx?.close().catch(() => {});
  };
}
