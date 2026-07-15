// Binds the circuit graph to the AVR emulator: reads real pin states out of
// the executed firmware and feeds user inputs (buttons, potentiometers,
// sensor sliders) back in as electrical signals. This is a digital-level
// circuit model (documented as such) — full analog SPICE simulation is a
// separate future adapter.

import type { CircuitProject, ComponentInstance } from '../types';
import { buildCircuitGraph, splitNode, type CircuitGraph } from '../circuit/nets';
import { AVRRunner, boardPinToArduino } from './avrRunner';
import { PinState } from 'avr8js';

export interface NetLevel {
  volts: number | null;
  /** Arduino pin that drives this net, when driven by the MCU. */
  sourcePin: number | null;
  seriesOhms: number;
  conflict: boolean;
}

export interface ComponentVisualState {
  ledOn?: boolean;
  brightness?: number;
  rgb?: [number, number, number];
  buzzerOn?: boolean;
  servoAngle?: number;
  segments?: Record<string, boolean>;
  pressed?: boolean;
  toggledOn?: boolean;
  potPosition?: number;
  value?: number;
  coilOn?: boolean;
}

export interface SimControls {
  pressedButtons: Set<string>;
  toggleStates: Map<string, boolean>;
  potPositions: Map<string, number>; // 0..1
  sensorValues: Map<string, number>; // ultrasonic cm, tmp36 °C, ldr 0..1
}

export function emptyControls(): SimControls {
  return {
    pressedButtons: new Set(),
    toggleStates: new Map(),
    potPositions: new Map(),
    sensorValues: new Map(),
  };
}

interface ConductiveEdge {
  a: string;
  b: string;
  ohms: number;
  kind: 'resistor' | 'switch' | 'pot' | 'diode' | 'channel';
  enabled: (controls: SimControls) => boolean;
}

interface UltrasonicState {
  trigPin: number | null;
  echoPin: number | null;
  trigHighAtUs: number;
  cancelEcho: (() => void)[];
}

export class CircuitBinding {
  readonly graph: CircuitGraph;
  readonly boardInstance: ComponentInstance | null;
  private edges: ConductiveEdge[] = [];
  private netBoardPins = new Map<string, number[]>();
  private groundNets = new Set<string>();
  private supplyNets = new Map<string, number>();
  private ultrasonic = new Map<string, UltrasonicState>();
  private netOfInstancePin = (instanceId: string, pinId: string): string | undefined =>
    this.graph.netOf.get(`${instanceId}:${pinId}`);

  constructor(
    readonly project: CircuitProject,
    readonly runner: AVRRunner | null,
  ) {
    this.graph = buildCircuitGraph(project);
    this.boardInstance =
      project.boardInstances.find((b) => {
        const def = this.graph.definitions.get(b.id);
        return def?.isBoard && def.simulationAdapterId?.startsWith('avr8js');
      }) ?? project.boardInstances[0] ?? null;

    this.indexNets();
    this.buildEdges();
    if (runner) this.setupUltrasonic(runner);
  }

  private indexNets(): void {
    for (const net of this.graph.nets) {
      for (const node of net.nodes) {
        const [instId, pinId] = splitNode(node);
        const def = this.graph.definitions.get(instId);
        const pin = def?.pins.find((p) => p.id === pinId);
        if (!pin) continue;
        if (def?.isBoard && instId === this.boardInstance?.id) {
          const arduinoPin = boardPinToArduino(pinId);
          if (arduinoPin !== undefined) {
            const arr = this.netBoardPins.get(net.id) ?? [];
            arr.push(arduinoPin);
            this.netBoardPins.set(net.id, arr);
          }
        }
        if (pin.type === 'ground') this.groundNets.add(net.id);
        if (pin.type === 'power-5v') this.supplyNets.set(net.id, 5);
        if (pin.type === 'power-3v3' && !this.supplyNets.has(net.id)) this.supplyNets.set(net.id, 3.3);
        if (pin.type === 'power-vin' && !this.supplyNets.has(net.id)) {
          const inst = this.graph.instances.find((i) => i.id === instId);
          const v = typeof inst?.properties.voltage === 'number' ? (inst.properties.voltage as number) : 9;
          if (def && !def.isBoard && def.simulationAdapterId === 'sim.supply') this.supplyNets.set(net.id, v);
        }
      }
    }
  }

  private buildEdges(): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (!def || def.isBoard) continue;
      const net = (pinId: string) => this.netOfInstancePin(inst.id, pinId);
      switch (def.id) {
        case 'comp.resistor': {
          const [a, b] = [net('p1'), net('p2')];
          const ohms = Number(inst.properties.resistance ?? 220);
          if (a && b) this.edges.push({ a, b, ohms, kind: 'resistor', enabled: () => true });
          break;
        }
        case 'comp.ldr': {
          const [a, b] = [net('p1'), net('p2')];
          if (a && b) this.edges.push({ a, b, ohms: 10_000, kind: 'resistor', enabled: () => true });
          break;
        }
        case 'comp.push-button': {
          const [a, b] = [net('1a'), net('2a')];
          if (a && b)
            this.edges.push({
              a, b, ohms: 0, kind: 'switch',
              enabled: (c) => c.pressedButtons.has(inst.id),
            });
          break;
        }
        case 'comp.toggle-switch': {
          const [com, no, nc] = [net('com'), net('no'), net('nc')];
          if (com && no)
            this.edges.push({ a: com, b: no, ohms: 0, kind: 'switch', enabled: (c) => c.toggleStates.get(inst.id) === true });
          if (com && nc)
            this.edges.push({ a: com, b: nc, ohms: 0, kind: 'switch', enabled: (c) => c.toggleStates.get(inst.id) !== true });
          break;
        }
        case 'comp.diode': {
          const [a, b] = [net('anode'), net('cathode')];
          if (a && b) this.edges.push({ a, b, ohms: 1, kind: 'diode', enabled: () => true });
          break;
        }
        case 'comp.level-converter': {
          for (const [h, l] of [['hv1', 'lv1'], ['hv2', 'lv2']] as const) {
            const [a, b] = [net(h), net(l)];
            if (a && b) this.edges.push({ a, b, ohms: 0, kind: 'channel', enabled: () => true });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private setupUltrasonic(runner: AVRRunner): void {
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (def?.id !== 'comp.ultrasonic') continue;
      const trigNet = this.netOfInstancePin(inst.id, 'trig');
      const echoNet = this.netOfInstancePin(inst.id, 'echo');
      const trigPin = trigNet ? this.netBoardPins.get(trigNet)?.[0] ?? null : null;
      const echoPin = echoNet ? this.netBoardPins.get(echoNet)?.[0] ?? null : null;
      this.ultrasonic.set(inst.id, { trigPin, echoPin, trigHighAtUs: -1, cancelEcho: [] });
    }
    if (this.ultrasonic.size === 0) return;

    const previous = runner.onPinChange;
    runner.onPinChange = (pin, high) => {
      previous?.(pin, high);
      for (const [instId, state] of this.ultrasonic) {
        if (pin !== state.trigPin || state.echoPin === null) continue;
        const nowUs = runner.timeMs * 1000;
        if (high) {
          state.trigHighAtUs = nowUs;
        } else if (state.trigHighAtUs >= 0 && nowUs - state.trigHighAtUs >= 9) {
          // Valid >=10us trigger pulse: reply with an echo pulse whose width
          // encodes the user-set distance (58 us per cm).
          state.cancelEcho.forEach((c) => c());
          state.cancelEcho = [];
          const inst = this.graph.instances.find((i) => i.id === instId);
          const distanceCm = Number(
            (inst?.simulationState.distanceCm as number | undefined) ?? this.controlsRef?.sensorValues.get(instId) ?? 100,
          );
          const widthUs = Math.max(58, distanceCm * 58);
          const echoPin = state.echoPin;
          state.cancelEcho.push(
            runner.addMicrosecondEvent(200, () => runner.setDigitalInput(echoPin, true)),
            runner.addMicrosecondEvent(200 + widthUs, () => runner.setDigitalInput(echoPin, false)),
          );
          state.trigHighAtUs = -1;
        }
      }
    };
  }

  private controlsRef: SimControls | null = null;

  /** Solves net levels, feeds inputs to the emulator, returns per-component visuals. */
  update(controls: SimControls): {
    visuals: Map<string, ComponentVisualState>;
    netLevels: Map<string, NetLevel>;
  } {
    this.controlsRef = controls;
    const runner = this.runner;
    const levels = new Map<string, NetLevel>();
    const setLevel = (netId: string, volts: number, sourcePin: number | null, seriesOhms: number) => {
      const existing = levels.get(netId);
      if (!existing || existing.volts === null) {
        levels.set(netId, { volts, sourcePin, seriesOhms, conflict: false });
      } else if (existing.volts !== volts && existing.seriesOhms === 0 && seriesOhms === 0) {
        existing.conflict = true;
        if (volts < existing.volts) existing.volts = volts; // ground wins, like real shorts (roughly)
      }
    };

    for (const netId of this.groundNets) setLevel(netId, 0, null, 0);
    for (const [netId, v] of this.supplyNets) if (!this.groundNets.has(netId)) setLevel(netId, v, null, 0);

    // MCU-driven nets from real emulator pin states.
    if (runner) {
      for (const [netId, pins] of this.netBoardPins) {
        for (const pin of pins) {
          const state = runner.pinState(pin);
          if (state === PinState.High) setLevel(netId, 5, pin, 0);
          else if (state === PinState.Low) setLevel(netId, 0, pin, 0);
        }
      }
    }

    // Propagate through conductive elements to a fixpoint (bounded iterations).
    for (let iter = 0; iter < 12; iter++) {
      let changed = false;
      for (const edge of this.edges) {
        if (!edge.enabled(controls)) continue;
        const la = levels.get(edge.a);
        const lb = levels.get(edge.b);
        if (la?.volts != null && (lb?.volts == null)) {
          levels.set(edge.b, { volts: la.volts, sourcePin: la.sourcePin, seriesOhms: la.seriesOhms + edge.ohms, conflict: false });
          changed = true;
        } else if (lb?.volts != null && (la?.volts == null)) {
          levels.set(edge.a, { volts: lb.volts, sourcePin: lb.sourcePin, seriesOhms: lb.seriesOhms + edge.ohms, conflict: false });
          changed = true;
        }
      }
      if (!changed) break;
    }

    const levelOf = (netId: string | undefined): NetLevel | undefined =>
      netId ? levels.get(netId) : undefined;

    // Feed digital inputs into the emulator.
    if (runner) {
      for (const [netId, pins] of this.netBoardPins) {
        const level = levels.get(netId);
        for (const pin of pins) {
          const state = runner.pinState(pin);
          if (state === PinState.Input || state === PinState.InputPullUp) {
            if (level?.volts != null) {
              runner.setDigitalInput(pin, level.volts >= 2.5);
            } else if (state === PinState.InputPullUp) {
              runner.setDigitalInput(pin, true); // floating + internal pull-up reads high
            }
          }
        }
      }
    }

    // Per-component behavior + visuals.
    const visuals = new Map<string, ComponentVisualState>();
    const duty = runner ? runner.snapshot() : null;

    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      if (!def || def.isBoard) continue;
      const net = (pinId: string) => this.netOfInstancePin(inst.id, pinId);

      switch (def.simulationAdapterId) {
        case 'sim.led': {
          const anode = levelOf(net('anode'));
          const cathode = levelOf(net('cathode'));
          const fV = Number(inst.properties.forwardVoltage ?? 2);
          const on =
            anode?.volts != null && cathode?.volts != null && anode.volts - cathode.volts >= fV - 0.4;
          let brightness = on ? 1 : 0;
          if (on && duty && anode?.sourcePin != null && runner?.isOutput(anode.sourcePin)) {
            brightness = duty.duty[anode.sourcePin];
          }
          visuals.set(inst.id, { ledOn: on && brightness > 0.02, brightness });
          break;
        }
        case 'sim.rgb-led': {
          const cathode = levelOf(net('cathode'));
          const channels: [string, number][] = [['red', 0], ['green', 1], ['blue', 2]];
          const rgb: [number, number, number] = [0, 0, 0];
          for (const [pinId, idx] of channels) {
            const level = levelOf(net(pinId));
            if (level?.volts != null && cathode?.volts != null && level.volts - cathode.volts >= 1.6) {
              rgb[idx] =
                duty && level.sourcePin != null && runner?.isOutput(level.sourcePin)
                  ? duty.duty[level.sourcePin]
                  : 1;
            }
          }
          visuals.set(inst.id, { rgb, ledOn: rgb.some((c) => c > 0.02) });
          break;
        }
        case 'sim.push-button':
          visuals.set(inst.id, { pressed: controls.pressedButtons.has(inst.id) });
          break;
        case 'sim.toggle-switch':
          visuals.set(inst.id, { toggledOn: controls.toggleStates.get(inst.id) === true });
          break;
        case 'sim.potentiometer': {
          const pos = controls.potPositions.get(inst.id) ?? 0.5;
          visuals.set(inst.id, { potPosition: pos });
          if (runner) {
            const wiperNet = net('wiper');
            const pins = wiperNet ? this.netBoardPins.get(wiperNet) ?? [] : [];
            const analogPin = pins.find((p) => p >= 14 && p <= 19);
            if (analogPin !== undefined) {
              const v1 = levelOf(net('t1'))?.volts ?? 0;
              const v2 = levelOf(net('t2'))?.volts ?? 5;
              runner.setAnalogVolts(analogPin - 14, v1 + pos * (v2 - v1));
            }
          }
          break;
        }
        case 'sim.buzzer': {
          const plus = levelOf(net('plus'));
          const minus = levelOf(net('minus'));
          const on = plus?.volts != null && minus?.volts != null && plus.volts - minus.volts >= 2.5;
          let level = on ? 1 : 0;
          if (on && duty && plus?.sourcePin != null && runner?.isOutput(plus.sourcePin)) {
            level = duty.duty[plus.sourcePin];
          }
          visuals.set(inst.id, { buzzerOn: on && level > 0.02 });
          break;
        }
        case 'sim.servo': {
          const sig = levelOf(net('sig'));
          let angle = (inst.simulationState.angle as number | undefined) ?? 90;
          if (duty && sig?.sourcePin != null) {
            const width = duty.pulseWidthUs[sig.sourcePin];
            if (width >= 400 && width <= 2800) {
              angle = Math.max(0, Math.min(180, ((width - 1000) / 1000) * 180));
              inst.simulationState.angle = angle;
            }
          }
          visuals.set(inst.id, { servoAngle: angle });
          break;
        }
        case 'sim.seven-segment': {
          const com1 = levelOf(net('com1'));
          const grounded = com1?.volts != null && com1.volts < 0.5;
          const segments: Record<string, boolean> = {};
          for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp']) {
            const level = levelOf(net(seg));
            segments[seg] = Boolean(grounded && level?.volts != null && level.volts >= 1.6);
          }
          visuals.set(inst.id, { segments });
          break;
        }
        case 'sim.tmp36': {
          const temp = controls.sensorValues.get(inst.id) ?? 25;
          visuals.set(inst.id, { value: temp });
          if (runner) {
            const outNet = net('vout');
            const pins = outNet ? this.netBoardPins.get(outNet) ?? [] : [];
            const analogPin = pins.find((p) => p >= 14 && p <= 19);
            if (analogPin !== undefined) runner.setAnalogVolts(analogPin - 14, 0.5 + temp * 0.01);
          }
          break;
        }
        case 'sim.ldr': {
          const light = controls.sensorValues.get(inst.id) ?? 0.5;
          visuals.set(inst.id, { value: light });
          if (runner) {
            for (const pinId of ['p1', 'p2']) {
              const n = net(pinId);
              const pins = n ? this.netBoardPins.get(n) ?? [] : [];
              const analogPin = pins.find((p) => p >= 14 && p <= 19);
              if (analogPin !== undefined) {
                // Simplified divider model, documented in the part description.
                runner.setAnalogVolts(analogPin - 14, 5 * light);
              }
            }
          }
          break;
        }
        case 'sim.ultrasonic': {
          const cm = controls.sensorValues.get(inst.id) ?? 100;
          inst.simulationState.distanceCm = cm;
          visuals.set(inst.id, { value: cm });
          break;
        }
        default: {
          if (def.id === 'comp.relay') {
            const inLevel = levelOf(net('in'));
            visuals.set(inst.id, { coilOn: inLevel?.volts != null && inLevel.volts >= 2.5 });
          }
          break;
        }
      }
    }

    return { visuals, netLevels: levels };
  }
}
