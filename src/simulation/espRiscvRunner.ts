// The production board runner for Espressif's RISC-V parts.
//
// Everything above this file — the simulation controller, the circuit binding,
// the Pin States panel — talks to a `BoardRunner` and has no idea which
// architecture is underneath. This is that contract's implementation for the
// ESP32-C3 and the ESP32-C6, and it is the only place where either chip's
// machine meets CircuitDesk's simulation layer. There is no parallel
// ESP-specific simulation path, and no fallback to another architecture:
// firmware that will not run on a chip is refused rather than handed to a
// different engine.
//
// What is chip-specific is the machine, the GPIO block and how many pads the
// part has — all of which arrive through `EspRunnerConfig`. Everything else,
// which is most of it, is genuinely the same on both: the slice budget, the
// duty and pulse measurement, the pin reporting, the event scheduling and the
// lifecycle.
//
// This module imports the emulators, so it must only ever be reached through
// an adapter's dynamic import. Nothing in the startup bundle may import it.

import { EspUart } from './espRiscv/uart';
import { EspSarAdc, espAdcIndexForGpio } from './espRiscv/sarAdc';
import { Esp32C3Machine } from './esp32c3/esp32c3Machine';
import { parseEspApplicationImage, type EspApplicationImage } from './esp32c3/espImage';
import { createStartupPeripherals } from './esp32c3/peripherals';
import { createFlashFromBuild, SerialNorFlash, ESP32C3_FLASH_LAYOUT } from './esp32c3/spiFlash';
import { Esp32C3Gpio } from './esp32c3/gpio';
import type { EspRiscvMachine } from './espRiscv/machine';
import type { BoardRunner, PinLevel, PinSnapshot } from './boardRunner';
import type { PinChange } from './gpioEvents';

/**
 * What differs between one Espressif RISC-V part and another, from a runner's
 * point of view.
 *
 * Deliberately small. If this grew a branch for every difference between the
 * chips it would be the parallel simulation path this file exists to avoid.
 */
export interface EspRunnerConfig {
  engine: 'esp32c3' | 'esp32c6';
  /** Every GPIO the chip has, whether or not a given board brings it out. */
  pinCount: number;
  /** Builds the machine and its peripherals, and returns its GPIO block. */
  build(flash: SerialNorFlash): { machine: EspRiscvMachine; gpio: Esp32C3Gpio; uart?: EspUart; adc?: EspSarAdc };
}

/**
 * Instructions a single `runFor` may retire.
 *
 * A slice of simulated time normally costs far fewer than this, because an
 * idle processor skips straight to its next event rather than clocking cycles.
 * The budget exists for the case that cannot: firmware spinning in a tight
 * loop, which would otherwise run until the browser gave up. Hitting it ends
 * the slice, not the run, so the interface stays responsive and the next slice
 * carries on.
 */
const MAX_INSTRUCTIONS_PER_SLICE = 8_000_000;

/** Window over which pad duty and pulse width are measured. */
const MEASURE_WINDOW_US = 50_000;

interface PadHistory {
  toggles: number;
  /** Level the pad has held since `lastChangeUs`. */
  level: 0 | 1 | undefined;
  lastChangeUs: number;
  /** Start of the window duty is measured over. */
  windowStartUs: number;
  /** High time already accumulated in the window, excluding the current run. */
  windowHighUs: number;
  lastHighPulseUs: number;
}

export class EspRiscvRunner implements BoardRunner {
  readonly engine: 'esp32c3' | 'esp32c6';

  private readonly machine: EspRiscvMachine;
  private readonly gpio: Esp32C3Gpio;
  /** UART0, which is Serial. */
  private readonly uart: EspUart | undefined;
  private readonly adc: EspSarAdc | undefined;
  private readonly pinCount: number;
  private readonly flash: SerialNorFlash;
  private readonly image: EspApplicationImage;

  private readonly pinListeners = new Set<(pin: number, high: boolean) => void>();
  onPinChange: ((pin: number, high: boolean) => void) | null = null;
  onSerialByte: ((byte: number) => void) | null = null;

  private readonly history: PadHistory[] = [];
  private disposed = false;

  /**
   * Built from the compiler's artifacts rather than from the executed image
   * alone: the chip reads its partition table out of flash before it will run
   * anything, so the parts that are not executed still have to be present.
   */
  constructor(image: EspApplicationImage, regions: { offset: number; data: Uint8Array }[], config: EspRunnerConfig) {
    this.image = image;
    this.engine = config.engine;
    this.pinCount = config.pinCount;
    const named = (offset: number): Uint8Array | undefined => regions.find((r) => r.offset === offset)?.data;
    // Both parts put the bootloader, the partition table and the OTA selector
    // at the same flash offsets, so this layout is genuinely shared.
    this.flash = createFlashFromBuild({
      bootloader: named(ESP32C3_FLASH_LAYOUT.bootloader),
      partitionTable: named(ESP32C3_FLASH_LAYOUT.partitionTable),
      otaSelect: named(ESP32C3_FLASH_LAYOUT.otaSelect),
      application: image.raw,
    });

    const built = config.build(this.flash);
    this.machine = built.machine;
    this.gpio = built.gpio;
    this.uart = built.uart;
    this.adc = built.adc;
    if (this.uart) this.uart.onByte = (byte: number) => this.onSerialByte?.(byte);

    for (let i = 0; i < this.pinCount; i++) this.history.push(this.freshHistory());
    this.gpio.onPinChange((change) => this.recordChange(change));
    this.machine.loadImage(image);
  }

  private freshHistory(): PadHistory {
    const nowUs = this.machine ? this.machine.micros : 0;
    return { toggles: 0, level: undefined, lastChangeUs: nowUs, windowStartUs: nowUs, windowHighUs: 0, lastHighPulseUs: 0 };
  }

  /**
   * Fraction of the recent past a pad has spent high.
   *
   * Computed when asked rather than accumulated on edges, because a pad that
   * is simply held high has no edges — and a duty derived only from edges
   * reads zero for it, which would leave a steadily lit LED dark.
   */
  private dutyOf(pin: number): number {
    const history = this.history[pin];
    const nowUs = this.machine.micros;
    const elapsed = nowUs - history.windowStartUs;
    const inCurrentRun = history.level === 1 ? nowUs - history.lastChangeUs : 0;
    if (elapsed <= 0) return history.level === 1 ? 1 : 0;
    return Math.min(1, Math.max(0, (history.windowHighUs + inCurrentRun) / elapsed));
  }

  /**
   * Drops history older than the measurement window.
   *
   * Without this the duty of a pin that changed behaviour long ago would stay
   * anchored to what it used to do.
   */
  private rollWindow(history: PadHistory, nowUs: number): void {
    if (nowUs - history.windowStartUs <= MEASURE_WINDOW_US) return;
    history.windowStartUs = nowUs;
    history.windowHighUs = 0;
    history.lastChangeUs = Math.min(history.lastChangeUs, nowUs);
  }

  // ------------------------------------------------------------- execution

  get timeMs(): number {
    return this.machine.micros / 1000;
  }

  /**
   * Advances by a slice of simulated time.
   *
   * The machine is told the slice's end so that fast-forwarding an idle
   * processor cannot overshoot it: an input arriving from the canvas between
   * slices must not find that the clock has already moved past the moment it
   * should have been seen.
   */
  runFor(simMs: number): void {
    if (this.disposed || simMs <= 0) return;
    const until = this.machine.nanos + simMs * 1_000_000;
    this.machine.timeLimitNanos = until;
    let instructions = 0;
    while (this.machine.nanos < until && instructions < MAX_INSTRUCTIONS_PER_SLICE) {
      this.machine.step();
      instructions++;
      // Nothing left can wake the machine. Spinning to the end of the slice
      // would burn the whole budget to reach the same state.
      if (this.machine.stalled) {
        this.machine.timeLimitNanos = undefined;
        this.uart?.sync();
        return;
      }
    }
    this.machine.timeLimitNanos = undefined;
    this.uart?.sync();
  }

  /**
   * How long until the machine's next scheduled event.
   *
   * Derived from the same sources the idle fast-forward uses, so the world and
   * the machine agree on when something will happen rather than each keeping
   * its own guess.
   */
  nextEventMs(): number | undefined {
    if (this.disposed) return undefined;
    const at = this.machine.nextEventNanos();
    if (at === undefined) return undefined;
    return Math.max(0, (at - this.machine.nanos) / 1_000_000);
  }

  // ------------------------------------------------------------------ pins

  digitalPinLevel(pin: number): PinLevel | undefined {
    if (pin < 0 || pin >= this.pinCount) return undefined;
    const state = this.gpio.pinState(pin);
    if (state.direction === 'output') return state.level === 1 ? 'high' : 'low';
    // An input's reported level belongs to whatever is driving it, so the
    // binding is told the direction and pull instead of a driven level.
    return state.pull === 'up' ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    if (pin < 0 || pin >= this.pinCount) return false;
    return this.gpio.pinState(pin).direction === 'output';
  }

  setDigitalInput(pin: number, value: boolean | null): void {
    if (this.disposed) return;
    this.gpio.drivePin(pin, value === null ? undefined : value ? 1 : 0);
  }

  addPinListener(listener: (pin: number, high: boolean) => void): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  private recordChange(change: PinChange): void {
    const pin = change.current.pin;
    const history = this.history[pin];
    if (history) {
      const nowUs = this.machine.micros;
      this.rollWindow(history, nowUs);
      if (history.level === 1) {
        const width = nowUs - history.lastChangeUs;
        history.lastHighPulseUs = width;
        history.windowHighUs += width;
      }
      if (history.level !== change.current.level) history.toggles++;
      history.lastChangeUs = nowUs;
      history.level = change.current.level;
    }

    // Only a driven pad is reported as a level change; an input's level
    // belongs to the circuit, and echoing it back would fight the binding.
    if (change.current.direction !== 'output') return;
    const high = change.current.level === 1;
    if (change.previous.direction === 'output' && change.previous.level === change.current.level) return;
    this.onPinChange?.(change.current.pin, high);
    for (const listener of this.pinListeners) listener(change.current.pin, high);
  }

  snapshot(): PinSnapshot {
    const states: PinLevel[] = [];
    const duty: number[] = [];
    const pulseWidthUs: number[] = [];
    const toggles: number[] = [];
    for (let pin = 0; pin < this.pinCount; pin++) {
      states.push(this.digitalPinLevel(pin) ?? 'input');
      this.rollWindow(this.history[pin], this.machine.micros);
      duty.push(this.dutyOf(pin));
      pulseWidthUs.push(this.history[pin].lastHighPulseUs);
      toggles.push(this.history[pin].toggles);
    }
    return { states, duty, pulseWidthUs, toggles };
  }

  // ------------------------------------------------- not yet modelled here

  /**
   * Neither part's ADC is modelled yet, so no pin claims a channel.
   *
   * Returning a channel and then reporting a made-up conversion would be worse
   * than saying plainly that it is unsupported: a sketch reading a sensor would
   * appear to work while telling the student nothing true.
   */
  adcChannelForPin(pin: number): number | undefined {
    return this.adc ? espAdcIndexForGpio(this.engine, pin) : undefined;
  }

  /** Volts on an ADC channel; a 3.3 V part reads nothing above its supply. */
  setAnalogVolts(channel: number, volts: number): void {
    if (!this.adc || channel < 0 || channel >= this.adc.volts.length) return;
    this.adc.volts[channel] = Math.max(0, Math.min(3.3, volts));
  }

  /** The hardware UART is not modelled yet, so no byte can be queued into it. */
  queueSerialInput(text: string): void {
    if (!this.uart) return;
    this.uart.receive(new TextEncoder().encode(text));
    this.machine.interruptSourceChanged();
  }

  /** The rate Serial.begin() programmed into UART0. */
  get uartBaudRate(): number | undefined {
    return this.uart?.baudRate;
  }

  /**
   * Runs a callback after a delay in simulated microseconds.
   *
   * Registered with the machine's event scheduler rather than a host timer, so
   * it keeps its place in simulated time and, just as importantly, will wake a
   * processor that is parked waiting for it.
   */
  addMicrosecondEvent(us: number, callback: () => void): () => void {
    const at = this.machine.nanos + us * 1000;
    let cancelled = false;
    let fired = false;
    this.machine.addEventSource({
      nextEventNanos: () => {
        if (cancelled || fired) return undefined;
        if (this.machine.nanos >= at) {
          fired = true;
          callback();
          return undefined;
        }
        return at;
      },
    });
    return () => {
      cancelled = true;
    };
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Returns the chip to power-on and boots the same image again.
   *
   * The flash keeps its contents, as a real board's does: reset is not a
   * reprogram, and anything the sketch wrote to a data partition survives it.
   */
  reset(): void {
    if (this.disposed) return;
    this.machine.reset();
    for (let i = 0; i < this.pinCount; i++) this.history[i] = this.freshHistory();
  }

  dispose(): void {
    this.disposed = true;
    this.pinListeners.clear();
    this.onPinChange = null;
    this.onSerialByte = null;
  }

  /** The image this runner is executing, for diagnostics. */
  get applicationImage(): EspApplicationImage {
    return this.image;
  }
}

/** Decodes one base64 flash region from the compiler service. */
export function decodeRegion(data: string): Uint8Array {
  const binary = atob(data.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The ESP32-C3: 22 GPIOs, and its own machine. */
export const ESP32C3_RUNNER: EspRunnerConfig = {
  engine: 'esp32c3',
  pinCount: 22,
  build(flash) {
    const machine = new Esp32C3Machine();
    const peripherals = createStartupPeripherals(machine, flash);
    for (const peripheral of peripherals) machine.addPeripheral(peripheral);
    const gpio = peripherals.find((p): p is Esp32C3Gpio => p instanceof Esp32C3Gpio);
    if (!gpio) throw new Error('The ESP32-C3 machine was built without a GPIO block.');
    const uart = peripherals.find((p): p is EspUart => p instanceof EspUart && p.name === 'uart0');
    const adc = peripherals.find((p): p is EspSarAdc => p instanceof EspSarAdc);
    return { machine, gpio, uart, adc };
  },
};

export class Esp32C3Runner extends EspRiscvRunner {
  constructor(image: EspApplicationImage, regions: { offset: number; data: Uint8Array }[]) {
    super(image, regions, ESP32C3_RUNNER);
  }
}

/** Builds a C3 runner from the compiler service's artifacts. */
export function createEsp32C3Runner(
  applicationImage: Uint8Array,
  regions: { offset: number; data: string }[] = [],
): Esp32C3Runner {
  const image = parseEspApplicationImage(applicationImage);
  return new Esp32C3Runner(
    image,
    regions.map((r) => ({ offset: r.offset, data: decodeRegion(r.data) })),
  );
}
