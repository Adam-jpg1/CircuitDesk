// One board runner for every ARMv7-M chip: the Due's SAM3X, the STM32F4, the
// RA4M1, the nRF52 and the i.MX RT.
//
// What differs between them is the chip model; what the rest of CircuitDesk
// needs from a board — run for a slice of time, pin levels and PWM duty,
// serial in and out, the I2C and SPI device buses, analog inputs — is the
// same, so it lives here once. Pins are the chip's pads, numbered however its
// model numbers them; a board's labels reach them through its pad map.
//
// This module imports the core, so it must only be reached through the
// adapter's dynamic import.

import type { CortexM } from './cortexM';
import type { ArmChip } from './bus';
import type { EventQueue, Pads } from './peripherals';
import { NOT_DRIVEN } from './peripherals';
import { I2cBus } from '../devices/i2cBus';
import { SpiBus } from '../devices/spiBus';
import type { PinLevel, PinSnapshot, UartPort } from '../boardRunner';

export interface McuSerial {
  readonly name: string;
  readonly rxPad: number;
  readonly txPad: number;
  onTransmit: ((byte: number) => void) | null;
  receive(byte: number): void;
  baud(): number | undefined;
}

export interface McuUsbSerial {
  onSerialData: ((byte: number) => void) | null;
  sendSerial(bytes: Iterable<number>): void;
  /** Advances the host side; called as time passes. */
  readonly portOpen?: boolean;
}

export interface I2cMasterHooks {
  start(repeated: boolean): void;
  connect(address: number, write: boolean): boolean;
  writeByte(value: number): boolean;
  readByte(ack: boolean): number;
  stop(): void;
}

/** What a chip model gives the runner. */
export interface ArmMcu extends ArmChip {
  readonly core: CortexM;
  readonly events: EventQueue;
  readonly pads: Pads;
  /** CPU clock, which is the unit the core and event queue count in. */
  readonly hz: number;
  readonly adcVolts: Float64Array;
  /** Full-scale ADC voltage. */
  readonly adcReference: number;
  adcChannelForPad(pad: number): number | undefined;
  readonly serials: McuSerial[];
  /** The UART the Serial Monitor talks to, when Serial is a UART. */
  readonly console: McuSerial | null;
  /** The native USB port, when Serial is USB. */
  readonly usb?: McuUsbSerial;
  i2c: I2cMasterHooks | null;
  spiTransfer: ((mosi: number, mode: 0 | 1 | 2 | 3) => number) | null;
  /** Loads the stack pointer and entry point, as the chip's reset does. */
  reset(): void;
  activeI2cPads?(): { sda?: number; scl?: number } | undefined;
  activeSpiPads?(): { sck?: number; mosi?: number; miso?: number } | undefined;
}

export interface ArmBusDefaults {
  sda?: number;
  scl?: number;
  sck?: number;
  mosi?: number;
  miso?: number;
}

interface DutyTracker {
  lastHigh: boolean;
  lastChangeCycle: number;
  highCycles: number;
  windowStartCycle: number;
  pulseRiseCycle: number;
  pulseWidthUs: number;
  toggles: number;
}

const MAX_STEPS_PER_CALL = 400_000_000;

export class ArmRunner {
  readonly engine = 'armv7m' as const;
  private chip!: ArmMcu;
  private trackers: DutyTracker[] = [];
  private readonly pinListeners = new Set<(pin: number, high: boolean) => void>();
  private readonly external = new Map<number, boolean>();
  private disposed = false;
  readonly i2cBus = new I2cBus();
  readonly spiBus = new SpiBus();
  onSerialByte: ((byte: number) => void) | null = null;
  onUsbSerialByte: ((byte: number) => void) | null = null;
  onPinChange: ((pin: number, high: boolean) => void) | null = null;
  private ports: UartPort[] = [];

  constructor(
    private readonly makeChip: () => ArmMcu,
    private readonly busDefaults: ArmBusDefaults = {},
  ) {
    this.build();
  }

  private build(): void {
    const chip = this.makeChip();
    this.chip = chip;
    this.trackers = Array.from({ length: chip.pads.count }, () => ({
      lastHigh: false, lastChangeCycle: 0, highCycles: 0, windowStartCycle: 0, pulseRiseCycle: 0, pulseWidthUs: 0, toggles: 0,
    }));
    const previous = chip.pads.onChange;
    chip.pads.onChange = (pin, high) => {
      previous?.(pin, high);
      this.padChanged(pin, high);
    };
    if (chip.console) chip.console.onTransmit = (byte) => this.onSerialByte?.(byte);
    if (chip.usb) chip.usb.onSerialData = (byte) => this.onUsbSerialByte?.(byte);
    this.ports = chip.serials
      .filter((s) => s !== chip.console && s.rxPad >= 0)
      .map((s) => {
        const port: UartPort = {
          name: s.name,
          rxPin: s.rxPad,
          txPin: s.txPad,
          receive: (text: string) => {
            for (const b of new TextEncoder().encode(text)) s.receive(b);
          },
          onTransmit: null,
          get baudRate() {
            return s.baud() ?? 9600;
          },
        };
        s.onTransmit = (byte) => port.onTransmit?.(byte);
        return port;
      });
    this.attachBuses(chip);
    for (const [pin, level] of this.external) chip.pads.setExternal(pin, level);
    chip.reset();
  }

  private attachBuses(chip: ArmMcu): void {
    let acked = false;
    let read = 0xff;
    const handler = this.i2cBus.handler({
      completeStart: () => {},
      completeStop: () => {},
      completeConnect: (ack) => (acked = ack),
      completeWrite: (ack) => (acked = ack),
      completeRead: (value) => (read = value),
    });
    chip.i2c = {
      start: (repeated) => handler.start(repeated),
      connect: (address, write) => {
        handler.connectToSlave(address, write);
        return acked;
      },
      writeByte: (value) => {
        handler.writeByte(value);
        return acked;
      },
      readByte: (ack) => {
        handler.readByte(ack);
        return read;
      },
      stop: () => handler.stop(),
    };
    chip.spiTransfer = (mosi, mode) =>
      this.spiBus.transferByte(mosi, { mode, bitOrder: 'msbFirst' }, (pin) => this.digitalPinLevel(pin));
  }

  /** The UARTs beyond the console, each on its own pins. */
  get extraUarts(): readonly UartPort[] {
    return this.ports;
  }

  activeI2cPins(): { sda?: number; scl?: number } {
    return this.chip.activeI2cPads?.() ?? { sda: this.busDefaults.sda, scl: this.busDefaults.scl };
  }

  activeSpiPins(): { sck?: number; mosi?: number; miso?: number } {
    return this.chip.activeSpiPads?.() ?? { sck: this.busDefaults.sck, mosi: this.busDefaults.mosi, miso: this.busDefaults.miso };
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('This simulation has been stopped.');
  }

  runFor(simMs: number): void {
    this.assertLive();
    const chip = this.chip;
    const core = chip.core;
    const events = chip.events;
    const target = core.cycles + (simMs * chip.hz) / 1000;
    let steps = 0;
    while (core.cycles < target) {
      const nextEvent = events.nextAt;
      if (core.cycles >= nextEvent) {
        events.runDue(core.cycles);
        continue;
      }
      if (core.sleeping) {
        // Nothing executes until an interrupt: move time to whatever comes first.
        const wake = Math.min(target, nextEvent, core.cycles + core.cyclesToNextEvent());
        core.cycles = Math.max(core.cycles + 1, Math.ceil(wake));
        core.step();
        continue;
      }
      while (core.cycles < target && core.cycles < events.earliest && !core.sleeping) {
        core.step();
        if (++steps > MAX_STEPS_PER_CALL) {
          throw new Error('Simulation stopped: the firmware executed an excessive number of instructions without advancing time.');
        }
      }
    }
  }

  get timeMs(): number {
    return (this.chip.core.cycles / this.chip.hz) * 1000;
  }

  nextEventMs(): number | undefined {
    const next = this.chip.events.nextAt;
    if (next === Infinity) return undefined;
    return Math.max(0, ((next - this.chip.core.cycles) / this.chip.hz) * 1000);
  }

  reset(): void {
    this.assertLive();
    this.build();
  }

  dispose(): void {
    this.pinListeners.clear();
    this.onSerialByte = null;
    this.onUsbSerialByte = null;
    this.onPinChange = null;
    this.disposed = true;
  }

  /** The chip model, for tests and diagnostics. */
  get mcu(): ArmMcu {
    return this.chip;
  }

  // ------------------------------------------------------------------ pins

  private padChanged(pin: number, high: boolean): void {
    const t = this.trackers[pin];
    if (!t || high === t.lastHigh) return;
    const now = this.chip.core.cycles;
    if (t.lastHigh) {
      t.highCycles += now - t.lastChangeCycle;
      t.pulseWidthUs = ((now - t.pulseRiseCycle) / this.chip.hz) * 1e6;
    } else {
      t.pulseRiseCycle = now;
    }
    t.lastHigh = high;
    t.lastChangeCycle = now;
    t.toggles++;
    this.onPinChange?.(pin, high);
    for (const listener of this.pinListeners) listener(pin, high);
  }

  addPinListener(listener: (pin: number, high: boolean) => void): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  digitalPinLevel(pin: number): PinLevel | undefined {
    const pads = this.chip.pads;
    if (pin < 0 || pin >= pads.count) return undefined;
    const d = pads.drive[pin];
    if (d !== NOT_DRIVEN) return d ? 'high' : 'low';
    return pads.pull[pin] === 1 ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    const pads = this.chip.pads;
    return pin >= 0 && pin < pads.count && pads.drive[pin] !== NOT_DRIVEN;
  }

  setDigitalInput(pin: number, value: boolean | null): void {
    const pads = this.chip.pads;
    if (pin < 0 || pin >= pads.count) return;
    if (value === null) this.external.delete(pin);
    else this.external.set(pin, value);
    pads.setExternal(pin, value === null ? undefined : value);
  }

  // ------------------------------------------------------------------- ADC

  adcChannelForPin(pin: number): number | undefined {
    return this.chip.adcChannelForPad(pin);
  }

  setAnalogVolts(channel: number, volts: number): void {
    const v = this.chip.adcVolts;
    if (channel < 0 || channel >= v.length) return;
    v[channel] = Math.max(0, Math.min(this.chip.adcReference, volts));
  }

  // ---------------------------------------------------------------- serial

  queueSerialInput(text: string): void {
    const bytes = new TextEncoder().encode(text);
    if (this.chip.usb) this.chip.usb.sendSerial(bytes);
    else if (this.chip.console) for (const b of bytes) this.chip.console.receive(b);
  }

  /** Bytes on the board's first UART RX pad, when Serial is USB and the UART is Serial1. */
  queueUartInput(text: string): void {
    const uart = this.chip.console ?? this.chip.serials[0];
    if (!uart) return;
    for (const b of new TextEncoder().encode(text)) uart.receive(b);
  }

  get uartBaudRate(): number | undefined {
    return (this.chip.console ?? this.chip.serials[0])?.baud();
  }

  addMicrosecondEvent(us: number, callback: () => void): () => void {
    return this.chip.events.schedule((us * this.chip.hz) / 1e6, callback);
  }

  snapshot(): PinSnapshot {
    const states: PinSnapshot['states'] = [];
    const duty: number[] = [];
    const pulseWidthUs: number[] = [];
    const toggles: number[] = [];
    const now = this.chip.core.cycles;
    for (let pin = 0; pin < this.trackers.length; pin++) {
      states.push(this.digitalPinLevel(pin) ?? 'input');
      const t = this.trackers[pin];
      let high = t.highCycles;
      if (t.lastHigh) high += now - t.lastChangeCycle;
      const window = now - t.windowStartCycle;
      duty.push(window > 0 ? Math.min(1, high / window) : t.lastHigh ? 1 : 0);
      pulseWidthUs.push(t.pulseWidthUs);
      toggles.push(t.toggles);
      t.highCycles = 0;
      t.windowStartCycle = now;
      if (t.lastHigh) t.lastChangeCycle = now;
    }
    return { states, duty, pulseWidthUs, toggles };
  }
}
