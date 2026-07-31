// Real ATmega328P execution using avr8js. Compiled firmware (Intel HEX from
// the compiler backend) runs instruction-by-instruction; GPIO, timers (incl.
// PWM), UART and ADC are the emulator's own peripherals. Nothing in here
// scans source code — all behavior comes from executing the program.
//
// Pin numbering is driven by a per-board AvrBoardProfile (boards/pinMaps.ts):
// only boards with a registered profile can run here — there is no implicit
// Uno fallback for other boards.

import {
  CPU,
  avrInstruction,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  AVRADC,
  adcConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  PinState,
} from 'avr8js';
import { parseIntelHex } from './intelHex';
import { AVR_BOARD_PROFILES, type AvrBoardProfile } from '../boards/pinMaps';

export const F_CPU = 16_000_000;

/** Default profile (ATmega328P / Uno pinout) for direct test usage. */
export const DEFAULT_AVR_PROFILE: AvrBoardProfile = AVR_BOARD_PROFILES['board.arduino-uno'];

/** @deprecated board-aware resolution lives in boards/pinMaps.ts (arduinoPinNumber). */
export function boardPinToArduino(pinId: string): number | undefined {
  if (/^D\d+$/.test(pinId)) return Number(pinId.slice(1));
  if (/^A[0-7]$/.test(pinId)) return 14 + Number(pinId.slice(1));
  if (pinId === 'SDA') return 18;
  if (pinId === 'SCL') return 19;
  return undefined;
}

export interface PinSnapshot {
  /** state per Arduino pin 0..19 */
  states: ('low' | 'high' | 'input' | 'input-pullup')[];
  /** measured PWM duty per pin over the last sample window (0..1), only for output pins */
  duty: number[];
  /** last measured high-pulse width in microseconds per pin (for servo-style signals) */
  pulseWidthUs: number[];
  /** toggle counts per pin since start */
  toggles: number[];
}

interface DutyTracker {
  lastState: boolean;
  lastChangeCycles: number;
  highCycles: number;
  windowStartCycles: number;
  pulseRiseCycles: number;
  pulseWidthUs: number;
  toggles: number;
}

export class AVRRunner {
  readonly cpu: CPU;
  readonly portB: AVRIOPort;
  readonly portC: AVRIOPort;
  readonly portD: AVRIOPort;
  readonly usart: AVRUSART;
  readonly adc: AVRADC;
  readonly timer0: AVRTimer;
  readonly timer1: AVRTimer;
  readonly timer2: AVRTimer;

  onSerialByte: ((byte: number) => void) | null = null;
  /** Called on any digital pin change with (arduinoPin, isHigh). */
  onPinChange: ((pin: number, high: boolean) => void) | null = null;

  private program = new Uint8Array(0x8000);
  private trackers: DutyTracker[] = [];
  private serialRxQueue: number[] = [];

  readonly profile: AvrBoardProfile;

  constructor(hex: string, profile: AvrBoardProfile = DEFAULT_AVR_PROFILE) {
    this.profile = profile;
    parseIntelHex(hex, this.program);
    this.cpu = new CPU(new Uint16Array(this.program.buffer));
    this.timer0 = new AVRTimer(this.cpu, timer0Config);
    this.timer1 = new AVRTimer(this.cpu, timer1Config);
    this.timer2 = new AVRTimer(this.cpu, timer2Config);
    this.portB = new AVRIOPort(this.cpu, portBConfig);
    this.portC = new AVRIOPort(this.cpu, portCConfig);
    this.portD = new AVRIOPort(this.cpu, portDConfig);
    this.usart = new AVRUSART(this.cpu, usart0Config, F_CPU);
    this.adc = new AVRADC(this.cpu, adcConfig);

    for (let pin = 0; pin < 20; pin++) {
      this.trackers.push({
        lastState: false,
        lastChangeCycles: 0,
        highCycles: 0,
        windowStartCycles: 0,
        pulseRiseCycles: 0,
        pulseWidthUs: 0,
        toggles: 0,
      });
    }

    this.usart.onByteTransmit = (value: number) => {
      this.onSerialByte?.(value);
    };
    this.usart.onRxComplete = () => this.pumpSerialRx();

    this.portB.addListener(() => this.portChanged('B'));
    this.portC.addListener(() => this.portChanged('C'));
    this.portD.addListener(() => this.portChanged('D'));
  }

  private portOf(name: 'B' | 'C' | 'D'): AVRIOPort {
    return name === 'B' ? this.portB : name === 'C' ? this.portC : this.portD;
  }

  private portChanged(name: 'B' | 'C' | 'D'): void {
    const port = this.portOf(name);
    for (const [pinStr, ref] of Object.entries(this.profile.portMap)) {
      if (ref.port !== name) continue;
      const pin = Number(pinStr);
      const state = port.pinState(ref.index);
      const high = state === PinState.High;
      const tracker = this.trackers[pin];
      if (high !== tracker.lastState) {
        const now = this.cpu.cycles;
        if (tracker.lastState) {
          tracker.highCycles += now - tracker.lastChangeCycles;
          tracker.pulseWidthUs = ((now - tracker.pulseRiseCycles) / F_CPU) * 1e6;
        } else {
          tracker.pulseRiseCycles = now;
        }
        tracker.lastState = high;
        tracker.lastChangeCycles = now;
        tracker.toggles++;
        this.onPinChange?.(pin, high);
      }
    }
  }

  pinState(pin: number): PinState | undefined {
    const ref = this.profile.portMap[pin];
    if (!ref) return undefined;
    return this.portOf(ref.port as 'B' | 'C' | 'D').pinState(ref.index);
  }

  /** String pin level for engine-agnostic consumers (no avr8js enum leak). */
  digitalPinLevel(pin: number): 'high' | 'low' | 'input' | 'input-pullup' | undefined {
    const s = this.pinState(pin);
    if (s === undefined) return undefined;
    return s === PinState.High ? 'high' : s === PinState.Low ? 'low' : s === PinState.InputPullUp ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    const s = this.pinState(pin);
    return s === PinState.High || s === PinState.Low;
  }

  setDigitalInput(pin: number, value: boolean): void {
    const ref = this.profile.portMap[pin];
    if (!ref) return;
    this.portOf(ref.port as 'B' | 'C' | 'D').setPin(ref.index, value);
  }

  /** ADC channel for an Arduino pin number on this board's profile. */
  adcChannelForPin(pin: number): number | undefined {
    return this.profile.portMap[pin]?.adcChannel;
  }

  setAnalogVolts(channel: number, volts: number): void {
    if (channel >= 0 && channel < 8) {
      this.adc.channelValues[channel] = Math.max(0, Math.min(5, volts));
    }
  }

  queueSerialInput(text: string): void {
    for (const ch of new TextEncoder().encode(text)) this.serialRxQueue.push(ch);
    this.pumpSerialRx();
  }

  private pumpSerialRx(): void {
    while (this.serialRxQueue.length > 0 && !this.usart.rxBusy) {
      const byte = this.serialRxQueue.shift()!;
      if (!this.usart.writeByte(byte)) break;
    }
  }

  addMicrosecondEvent(us: number, callback: () => void): () => void {
    const cycles = Math.max(1, Math.round((us / 1e6) * F_CPU));
    const cb = this.cpu.addClockEvent(callback, cycles);
    return () => this.cpu.clearClockEvent(cb);
  }

  /** Executes AVR instructions until the CPU reaches the target cycle count. */
  runToCycles(targetCycles: number): void {
    const { cpu } = this;
    while (cpu.cycles < targetCycles) {
      avrInstruction(cpu);
      cpu.tick();
    }
  }

  get timeMs(): number {
    return (this.cpu.cycles / F_CPU) * 1000;
  }

  /** Samples PWM duty per pin and resets the measurement window. */
  snapshot(): PinSnapshot {
    const states: PinSnapshot['states'] = [];
    const duty: number[] = [];
    const pulseWidthUs: number[] = [];
    const toggles: number[] = [];
    const now = this.cpu.cycles;
    for (let pin = 0; pin < 20; pin++) {
      const s = this.pinState(pin);
      states.push(
        s === PinState.High ? 'high' : s === PinState.Low ? 'low' : s === PinState.InputPullUp ? 'input-pullup' : 'input',
      );
      const t = this.trackers[pin];
      let high = t.highCycles;
      if (t.lastState) high += now - t.lastChangeCycles;
      const window = now - t.windowStartCycles;
      duty.push(window > 0 ? Math.min(1, high / window) : t.lastState ? 1 : 0);
      pulseWidthUs.push(t.pulseWidthUs);
      toggles.push(t.toggles);
      t.highCycles = 0;
      t.windowStartCycles = now;
      t.lastChangeCycles = t.lastState ? Math.max(t.lastChangeCycles, t.windowStartCycles) : t.lastChangeCycles;
      if (t.lastState) t.lastChangeCycles = now;
    }
    return { states, duty, pulseWidthUs, toggles };
  }
}
