// Binds the circuit graph to the AVR emulator: reads real pin states out of
// the executed firmware and feeds user inputs (buttons, potentiometers,
// sensor sliders) back in as electrical signals. This is a digital-level
// circuit model (documented as such) — full analog SPICE simulation is a
// separate future adapter.

import type { BoardDefinition, CircuitProject, ComponentInstance } from '../types';
import { buildCircuitGraph, splitNode, type CircuitGraph } from '../circuit/nets';
import type { AVRRunner } from './avrRunner';
import { arduinoPinNumber, avrProfileFor } from '../boards/pinMaps';
import { Ssd1306Device, SSD1306_ADDRESSES } from './devices/ssd1306';
import { Bmp280Device, BMP280_ADDRESSES } from './devices/bmp280';
import { Mpu6050Device, MPU6050_ADDRESSES } from './devices/mpu6050';
import type { I2cDevice, SpiDevice } from './devices/types';
import { Sn74hc595Device, HC595_OUTPUT_PINS } from './devices/sn74hc595';
import { SdCardDevice, type SdCardSnapshotData } from './devices/sdCard';
import { SpiFlashDevice, type SpiFlashSnapshotData } from './devices/spiFlash';
import { spiPinsFor } from './avr/spiPins';

export interface NetLevel {
  volts: number | null;
  /** Arduino pin that drives this net, when driven by the MCU. */
  sourcePin: number | null;
  seriesOhms: number;
  conflict: boolean;
}

export interface DisplayVisual {
  /** SSD1306 GDDRAM (1 bit per pixel, page-major), or null when dark. */
  pixels: Uint8Array | null;
  on: boolean;
  revision: number;
}

export interface ComponentVisualState {
  /** Populated for display devices driven by real bus traffic. */
  display?: DisplayVisual;
  /** Live text lines read out of a simulated device model, drawn on the part. */
  readout?: string[];
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

/** Pin types that count as a supply feeding a module's VCC (or an address strap). */
const POWER_PIN_TYPES = ['power-5v', 'power-3v3', 'power-vin'];

interface I2cDeviceModel {
  /** 7-bit address used when the instance has no explicit override. */
  defaultAddress: number;
  create: (instanceId: string, address: number) => I2cDevice;
  /** Pin that selects the alternate address when strapped to a supply (AD0, …). */
  addressSelect?: { pinId: string; alternateAddress: number };
}

/**
 * Components with a genuine device model behind them. A part missing here is
 * not simulated at the protocol level — it is simply not attached to the bus,
 * so firmware addressing it gets a NACK rather than a fabricated reply.
 */
const I2C_DEVICE_MODELS: Record<string, I2cDeviceModel> = {
  'comp.oled': {
    defaultAddress: SSD1306_ADDRESSES[0],
    create: (id, address) => new Ssd1306Device(id, address),
  },
  'comp.bmp280': {
    defaultAddress: BMP280_ADDRESSES[0],
    create: (id, address) => new Bmp280Device(id, address),
  },
  'comp.mpu6050': {
    defaultAddress: MPU6050_ADDRESSES[0],
    create: (id, address) => new Mpu6050Device(id, address),
    addressSelect: { pinId: 'ad0', alternateAddress: MPU6050_ADDRESSES[1] },
  },
};

/**
 * Components with a genuine SPI device model.
 *
 * `busPins` names the component pins that must reach the board's own SPI
 * lines; `miso: null` marks a part that never drives MISO (a 74HC595), so its
 * absence is not treated as a wiring fault. `cs` names the chip-select pin, or
 * null for parts that have none.
 */
interface SpiDeviceModel {
  busPins: { sck: string; mosi: string; miso: string | null; cs: string | null };
  create: (ctx: SpiCreateContext) => SpiDevice;
}

interface SpiCreateContext {
  instanceId: string;
  csPinId: string | null;
  logicVolts: number;
  /** Emulated microseconds since reset — device busy timers run off this. */
  nowUs: () => number;
  /** Per-instance saved state, so a card keeps its contents across reloads. */
  saved: Record<string, unknown>;
}

const SPI_DEVICE_MODELS: Record<string, SpiDeviceModel> = {
  'comp.hc595': {
    busPins: { sck: 'srclk', mosi: 'ser', miso: null, cs: null },
    create: (ctx) => new Sn74hc595Device(ctx.instanceId, ctx.logicVolts),
  },
  'comp.sd-card': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: 'miso', cs: 'cs' },
    create: (ctx) => {
      const device = new SdCardDevice(ctx.instanceId, ctx.csPinId ?? 'cs');
      device.loadState(ctx.saved.sdCard as SdCardSnapshotData | undefined);
      return device;
    },
  },
  'comp.spi-flash': {
    busPins: { sck: 'sck', mosi: 'mosi', miso: 'miso', cs: 'cs' },
    create: (ctx) => {
      const device = new SpiFlashDevice(ctx.instanceId, ctx.csPinId ?? 'cs', ctx.nowUs);
      device.loadState(ctx.saved.spiFlash as SpiFlashSnapshotData | undefined);
      return device;
    },
  },
};

/** Control pins a 74HC595 needs beyond the shift clock and data line. */
interface Hc595Wiring {
  device: Sn74hc595Device;
  /** Board pin the RCLK (latch) line reaches, or null when unwired. */
  latchPin: number | null;
  oeNet: string | undefined;
  clearNet: string | undefined;
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
  readonly boardDef: BoardDefinition | null;
  private edges: ConductiveEdge[] = [];
  private netBoardPins = new Map<string, number[]>();
  /** netId → emulated ADC channels reachable on that net (board-profile-aware). */
  private netAdcChannels = new Map<string, number[]>();
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
    // Bind ONLY to a board whose definition declares genuine simulation
    // support. Boards without a simulator never fall back to another
    // board's profile — with no simulated board, no MCU pins are bound.
    this.boardInstance =
      project.boardInstances.find((b) => {
        const def = this.graph.definitions.get(b.id);
        return def?.isBoard && def.simulation?.supported === true;
      }) ?? null;
    const bd = this.boardInstance ? this.graph.definitions.get(this.boardInstance.id) : undefined;
    this.boardDef = bd?.isBoard ? bd : null;

    this.indexNets();
    this.buildEdges();
    if (runner) this.setupUltrasonic(runner);
    if (runner) this.setupI2cDevices(runner);
    if (runner) this.setupSpiDevices(runner);
  }

  private hc595 = new Map<string, Hc595Wiring>();
  private spiDevices: SpiDevice[] = [];
  private unsubscribeLatches: (() => void)[] = [];
  private persistedWrites = new Map<string, number>();

  /**
   * Copies a storage device's contents into the project only when it actually
   * changed. Re-encoding a card image every frame would be wasted work.
   */
  private persistDevice(inst: ComponentInstance, writeCounter: number, save: () => void): void {
    if (this.persistedWrites.get(inst.id) === writeCounter) return;
    this.persistedWrites.set(inst.id, writeCounter);
    if (writeCounter > 0) save();
  }

  /** Drops edge subscriptions held for this binding (called on re-bind). */
  releaseListeners(): void {
    this.unsubscribeLatches.forEach((off) => off());
    this.unsubscribeLatches = [];
  }

  /**
   * Attaches SPI device models for parts genuinely wired to the board's SPI
   * bus. A device whose SCK, MOSI, MISO, power or ground is missing is not
   * attached at all, so firmware talking to it reads back an idle bus rather
   * than a fabricated reply.
   */
  private setupSpiDevices(runner: AVRRunner): void {
    const board = this.boardDef;
    if (!board) {
      runner.spiBus.sync([]);
      return;
    }
    const profile = avrProfileFor(board);
    const busPins = profile ? spiPinsFor(profile) : { sck: undefined, mosi: undefined, miso: undefined };
    const logicVolts = Number(board.metadata.logicVoltage ?? 5);

    const netHasPin = (netId: string | undefined, pin: number | undefined): boolean =>
      netId !== undefined && pin !== undefined && (this.netBoardPins.get(netId) ?? []).includes(pin);

    /** First board pin on a net — used to resolve chip-select and latch lines. */
    const boardPinOn = (netId: string | undefined): number | null =>
      netId === undefined ? null : (this.netBoardPins.get(netId) ?? [])[0] ?? null;

    const netFedBy = (netId: string | undefined, instanceId: string, types: string[]): boolean => {
      if (netId === undefined) return false;
      const net = this.graph.nets.find((n) => n.id === netId);
      if (!net) return false;
      for (const node of net.nodes) {
        const [otherId, pinId] = splitNode(node);
        if (otherId === instanceId) continue;
        const otherDef = this.graph.definitions.get(otherId);
        const pin = otherDef?.pins.find((p) => p.id === pinId);
        if (pin && types.includes(pin.type)) return true;
      }
      return false;
    };

    this.releaseListeners();
    this.hc595.clear();

    const wanted: { instanceId: string; csPin: number | null; create: () => SpiDevice }[] = [];
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const model = def ? SPI_DEVICE_MODELS[def.id] : undefined;
      if (!model) continue;

      const powered = netFedBy(this.netOfInstancePin(inst.id, 'vcc'), inst.id, POWER_PIN_TYPES);
      const grounded = netFedBy(this.netOfInstancePin(inst.id, 'gnd'), inst.id, ['ground']);
      const onSck = netHasPin(this.netOfInstancePin(inst.id, model.busPins.sck), busPins.sck);
      const onMosi = netHasPin(this.netOfInstancePin(inst.id, model.busPins.mosi), busPins.mosi);
      const onMiso =
        model.busPins.miso === null ||
        netHasPin(this.netOfInstancePin(inst.id, model.busPins.miso), busPins.miso);
      if (!powered || !grounded || !onSck || !onMosi || !onMiso) continue;

      // A part with a chip select must have it on a real board pin; without one
      // nothing can ever assert it, so the device stays off the bus.
      let csPin: number | null = null;
      if (model.busPins.cs !== null) {
        csPin = boardPinOn(this.netOfInstancePin(inst.id, model.busPins.cs));
        if (csPin === null) continue;
      }

      const csPinId = model.busPins.cs;
      wanted.push({
        instanceId: inst.id,
        csPin,
        create: () =>
          model.create({
            instanceId: inst.id,
            csPinId,
            logicVolts,
            nowUs: () => runner.timeMs * 1000,
            saved: inst.simulationState,
          }),
      });
    }

    this.spiDevices = runner.spiBus.sync(wanted);

    // Chip select changes between transactions, when no byte is being clocked,
    // so it has to be watched as a pin edge. Polling once per frame would let a
    // device miss its own deselect and treat the next command as a continuation.
    const csPins = new Set(runner.spiBus.chipSelectPins);
    if (csPins.size > 0) {
      this.unsubscribeLatches.push(
        runner.addPinListener((pin) => {
          if (csPins.has(pin)) runner.spiBus.refreshSelection((p) => runner.digitalPinLevel(p));
        }),
      );
    }

    // Shift registers latch on an RCLK edge, which is far too short to catch by
    // polling once per frame — subscribe to real pin edges instead.
    for (const device of this.spiDevices) {
      if (!(device instanceof Sn74hc595Device)) continue;
      const instId = device.instanceId;
      const latchPin = boardPinOn(this.netOfInstancePin(instId, 'rclk'));
      this.hc595.set(instId, {
        device,
        latchPin,
        oeNet: this.netOfInstancePin(instId, 'oe'),
        clearNet: this.netOfInstancePin(instId, 'srclr'),
      });
      if (latchPin === null) continue;
      this.unsubscribeLatches.push(
        runner.addPinListener((pin, high) => {
          if (pin === latchPin && high) device.latch();
        }),
      );
    }
  }

  private indexNets(): void {
    for (const net of this.graph.nets) {
      for (const node of net.nodes) {
        const [instId, pinId] = splitNode(node);
        const def = this.graph.definitions.get(instId);
        const pin = def?.pins.find((p) => p.id === pinId);
        if (!pin) continue;
        if (def?.isBoard && instId === this.boardInstance?.id && this.boardDef) {
          const arduinoPin = arduinoPinNumber(this.boardDef, pinId);
          if (arduinoPin !== undefined) {
            const arr = this.netBoardPins.get(net.id) ?? [];
            arr.push(arduinoPin);
            this.netBoardPins.set(net.id, arr);
          }
          const profile = avrProfileFor(this.boardDef);
          const channel =
            (arduinoPin !== undefined ? profile?.portMap[arduinoPin]?.adcChannel : undefined) ??
            profile?.adcOnlyChannels?.[pinId];
          if (channel !== undefined) {
            const chans = this.netAdcChannels.get(net.id) ?? [];
            chans.push(channel);
            this.netAdcChannels.set(net.id, chans);
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


  /**
   * Attaches I2C device models for parts that are genuinely wired to the
   * board's I2C bus. A display with SDA/SCL on the wrong pins, or with no
   * power, is not attached at all — so firmware addressing it gets a NACK,
   * exactly as it would on a breadboard.
   */
  private setupI2cDevices(runner: AVRRunner): void {
    const board = this.boardDef;
    if (!board) {
      runner.i2cBus.sync([]);
      return;
    }
    // Board-side SDA/SCL as emulator pin numbers (A4/A5 on Uno, D20/D21 on
    // Mega, D2/D3 on Leonardo — taken from the board's own metadata).
    const i2cPinIds = (board.metadata.i2cPins as string[] | undefined) ?? [];
    const busPins = new Set<number>();
    for (const pinId of i2cPinIds) {
      const n = arduinoPinNumber(board, pinId);
      if (n !== undefined) busPins.add(n);
    }
    const sdaId = i2cPinIds[0];
    const sclId = i2cPinIds[1];
    const sdaPin = sdaId ? arduinoPinNumber(board, sdaId) : undefined;
    const sclPin = sclId ? arduinoPinNumber(board, sclId) : undefined;

    const netHasPin = (netId: string | undefined, pin: number | undefined): boolean =>
      netId !== undefined && pin !== undefined && (this.netBoardPins.get(netId) ?? []).includes(pin);

    /**
     * True when some OTHER instance drives this net with a pin of one of the
     * given types. A module's own VCC/GND pins are typed as power/ground, so
     * membership in supplyNets alone would let an unconnected board claim it
     * is powered — the device must be fed from outside itself.
     */
    const netFedBy = (netId: string | undefined, instanceId: string, types: string[]): boolean => {
      if (netId === undefined) return false;
      const net = this.graph.nets.find((n) => n.id === netId);
      if (!net) return false;
      for (const node of net.nodes) {
        const [otherId, pinId] = splitNode(node);
        if (otherId === instanceId) continue;
        const otherDef = this.graph.definitions.get(otherId);
        const pin = otherDef?.pins.find((p) => p.id === pinId);
        if (pin && types.includes(pin.type)) return true;
      }
      return false;
    };

    const wanted: { instanceId: string; create: () => I2cDevice }[] = [];
    for (const inst of this.graph.instances) {
      const def = this.graph.definitions.get(inst.id);
      const model = def ? I2C_DEVICE_MODELS[def.id] : undefined;
      if (!model) continue;
      const sdaNet = this.netOfInstancePin(inst.id, 'sda');
      const sclNet = this.netOfInstancePin(inst.id, 'scl');
      const vccNet = this.netOfInstancePin(inst.id, 'vcc');
      const gndNet = this.netOfInstancePin(inst.id, 'gnd');
      const wiredToBus = netHasPin(sdaNet, sdaPin) && netHasPin(sclNet, sclPin);
      const powered = netFedBy(vccNet, inst.id, POWER_PIN_TYPES);
      const grounded = netFedBy(gndNet, inst.id, ['ground']);
      if (!wiredToBus || !powered || !grounded) continue;

      // Explicit property wins; otherwise an address-select pin tied to a
      // supply picks the alternate address, exactly like the AD0 strap.
      const raw = inst.properties.i2cAddress;
      const explicit = raw === undefined || raw === '' ? Number.NaN : Number(raw);
      let address: number;
      if (Number.isFinite(explicit)) {
        address = explicit;
      } else if (
        model.addressSelect &&
        netFedBy(this.netOfInstancePin(inst.id, model.addressSelect.pinId), inst.id, POWER_PIN_TYPES)
      ) {
        address = model.addressSelect.alternateAddress;
      } else {
        address = model.defaultAddress;
      }
      wanted.push({
        instanceId: inst.id,
        create: () => model.create(inst.id, address),
      });
    }
    runner.i2cBus.sync(wanted);
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
      const highVolts = Number(this.boardDef?.metadata.logicVoltage ?? 5);
      for (const [netId, pins] of this.netBoardPins) {
        for (const pin of pins) {
          const level = runner.digitalPinLevel(pin);
          if (level === 'high') setLevel(netId, highVolts, pin, 0);
          else if (level === 'low') setLevel(netId, 0, pin, 0);
        }
      }
    }

    // Propagate through conductive elements to a fixpoint (bounded iterations).
    const propagate = () => {
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
    };
    propagate();

    // Devices that drive their own output pins (a 74HC595's Q0-Q7) act as
    // sources on top of the MCU's pins, so their nets are seeded and the graph
    // is settled a second time. Control inputs are sampled from the first pass,
    // which is where a grounded OE or a firmware-driven line has landed.
    if (this.hc595.size > 0) {
      for (const [, wiring] of this.hc595) {
        const oe = levels.get(wiring.oeNet ?? '')?.volts;
        const clear = levels.get(wiring.clearNet ?? '')?.volts;
        // OE is active low. A floating OE is electrically undefined on real HC
        // logic, so the outputs are treated as disabled rather than guessed.
        wiring.device.setOutputEnable(oe != null && oe <= 0.8);
        if (clear != null && clear <= 0.8) wiring.device.clearShiftRegister();
      }
      for (const device of this.spiDevices) {
        if (!(device instanceof Sn74hc595Device)) continue;
        for (const pinId of HC595_OUTPUT_PINS) {
          const volts = device.analogOut(pinId);
          if (volts === null) continue; // high impedance drives nothing
          const netId = this.netOfInstancePin(device.instanceId, pinId);
          if (netId) setLevel(netId, volts, null, 0);
        }
      }
      propagate();
    }

    const levelOf = (netId: string | undefined): NetLevel | undefined =>
      netId ? levels.get(netId) : undefined;

    // Feed digital inputs into the emulator.
    if (runner) {
      for (const [netId, pins] of this.netBoardPins) {
        const level = levels.get(netId);
        for (const pin of pins) {
          const state = runner.digitalPinLevel(pin);
          if (state === 'input' || state === 'input-pullup') {
            if (level?.volts != null) {
              runner.setDigitalInput(pin, level.volts >= 2.5);
            } else if (state === 'input-pullup') {
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
            const channel = wiperNet ? this.netAdcChannels.get(wiperNet)?.[0] : undefined;
            if (channel !== undefined) {
              const v1 = levelOf(net('t1'))?.volts ?? 0;
              const v2 = levelOf(net('t2'))?.volts ?? 5;
              runner.setAnalogVolts(channel, v1 + pos * (v2 - v1));
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
            const channel = outNet ? this.netAdcChannels.get(outNet)?.[0] : undefined;
            if (channel !== undefined) runner.setAnalogVolts(channel, 0.5 + temp * 0.01);
          }
          break;
        }
        case 'sim.ldr': {
          const light = controls.sensorValues.get(inst.id) ?? 0.5;
          visuals.set(inst.id, { value: light });
          if (runner) {
            for (const pinId of ['p1', 'p2']) {
              const n = net(pinId);
              const channel = n ? this.netAdcChannels.get(n)?.[0] : undefined;
              if (channel !== undefined) {
                // Simplified divider model, documented in the part description.
                runner.setAnalogVolts(channel, 5 * light);
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
        case 'sim.ssd1306': {
          const device = runner?.i2cBus.deviceFor(inst.id);
          if (device instanceof Ssd1306Device) {
            visuals.set(inst.id, {
              display: { pixels: device.ram, on: device.isOn, revision: device.revision },
              value: device.litPixels,
            });
          } else {
            // Not wired to the bus (or no simulation running): stays dark.
            visuals.set(inst.id, { display: { pixels: null, on: false, revision: 0 } });
          }
          break;
        }
        case 'sim.bmp280': {
          const device = runner?.i2cBus.deviceFor(inst.id);
          if (device instanceof Bmp280Device) {
            visuals.set(inst.id, {
              readout: device.isMeasuring
                ? [`${device.temperatureC.toFixed(1)} C`, `${device.pressureHpa.toFixed(0)} hPa`]
                : ['sleep'],
            });
          } else {
            // Not wired to the bus (or no simulation running): no readout.
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.mpu6050': {
          const device = runner?.i2cBus.deviceFor(inst.id);
          if (device instanceof Mpu6050Device) {
            const { accelG, gyroDps } = device.motion;
            visuals.set(inst.id, {
              readout: device.isAwake
                ? [
                    `${accelG.x.toFixed(2)} ${accelG.y.toFixed(2)} ${accelG.z.toFixed(2)} g`,
                    `${gyroDps.x.toFixed(0)} ${gyroDps.y.toFixed(0)} ${gyroDps.z.toFixed(0)} d/s`,
                  ]
                : ['sleep'],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.hc595': {
          const device = runner?.spiBus.deviceFor(inst.id);
          if (device instanceof Sn74hc595Device) {
            const bits = device.outputs;
            visuals.set(inst.id, {
              readout:
                bits === null
                  ? ['outputs Hi-Z', 'check OE']
                  : [`Q7..Q0 ${bits.toString(2).padStart(8, '0')}`, `${device.latchCount} latch`],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.sd-card': {
          const device = runner?.spiBus.deviceFor(inst.id);
          if (device instanceof SdCardDevice) {
            this.persistDevice(inst, device.writeCounter, () => {
              inst.simulationState.sdCard = device.saveState();
            });
            visuals.set(inst.id, {
              readout: [device.isInitialised ? 'card ready' : 'not initialised', `${device.storedBlockCount} blk`],
            });
          } else {
            visuals.set(inst.id, {});
          }
          break;
        }
        case 'sim.spi-flash': {
          const device = runner?.spiBus.deviceFor(inst.id);
          if (device instanceof SpiFlashDevice) {
            this.persistDevice(inst, device.writeCounter, () => {
              inst.simulationState.spiFlash = device.saveState();
            });
            visuals.set(inst.id, {
              readout: [device.busy ? 'busy' : 'ready', device.writeEnableLatch ? 'WEL set' : 'WEL clear'],
            });
          } else {
            visuals.set(inst.id, {});
          }
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
