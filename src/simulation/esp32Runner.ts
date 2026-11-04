// The production board runner for the Xtensa ESP32.
//
// Everything above this file talks to a `BoardRunner`; this is that contract
// for the ESP32 machine in ./esp32. Pins are the chip's own GPIO numbers
// (0..39); a board's labels reach them through its pad map.
//
// This module imports the emulator, so it must only ever be reached through
// an adapter's dynamic import.

import { Esp32Machine } from './esp32/esp32';
import { ESP32_PAD_COUNT } from './esp32/gpio';
import { ESP32_SPI_SIGNALS } from './esp32/spi';
import { esp32AdcGpio } from './esp32/adc';
import { parseEspApplicationImage, type EspApplicationImage } from './esp32c3/espImage';
import { createFlashFromBuild } from './esp32c3/spiFlash';
import type { BoardRunner, PinLevel, PinSnapshot, UartPort } from './boardRunner';
import type { PinChange } from './gpioEvents';
import { I2cBus } from './devices/i2cBus';
import { SpiBus } from './devices/spiBus';

/** Instructions one slice may retire, so a spinning sketch cannot freeze the page. */
const MAX_INSTRUCTIONS_PER_SLICE = 8_000_000;
/** Window over which pad duty and pulse width are measured. */
const MEASURE_WINDOW_US = 50_000;

/** Where an ESP32 application image may place its segments (soc.h, memory.ld). */
export const ESP32_REGIONS = [
  { start: 0x3f400000, end: 0x3f800000, name: 'DROM (flash-mapped constants)' },
  { start: 0x3ff80000, end: 0x3ff82000, name: 'RTC fast memory' },
  { start: 0x3ffae000, end: 0x40000000, name: 'DRAM' },
  { start: 0x40070000, end: 0x400c2000, name: 'IRAM' },
  { start: 0x400d0000, end: 0x40400000, name: 'IROM (flash-mapped code)' },
  { start: 0x50000000, end: 0x50002000, name: 'RTC slow memory' },
];

interface PadHistory {
  toggles: number;
  level: 0 | 1 | undefined;
  lastChangeUs: number;
  windowStartUs: number;
  windowHighUs: number;
  lastHighPulseUs: number;
}

export class Esp32Runner implements BoardRunner {
  readonly engine = 'esp32' as const;
  readonly machine: Esp32Machine;
  readonly i2cBus = new I2cBus();
  readonly spiBus = new SpiBus();
  private readonly pinListeners = new Set<(pin: number, high: boolean) => void>();
  onPinChange: ((pin: number, high: boolean) => void) | null = null;
  onSerialByte: ((byte: number) => void) | null = null;
  private readonly history: PadHistory[] = [];
  private disposed = false;

  constructor(
    readonly image: EspApplicationImage,
    regions: { offset: number; data: Uint8Array }[],
  ) {
    const named = (offset: number) => regions.find((r) => r.offset === offset)?.data;
    const flash = createFlashFromBuild({ partitionTable: named(0x8000), application: image.raw }, 4 << 20);
    this.machine = new Esp32Machine(flash);
    this.extraUarts = [this.uartPort('Serial2', 2, 16, 17)];
    this.attachBuses();
    this.machine.onConsoleByte = (b) => this.onSerialByte?.(b);
    this.machine.uarts[0].onByte = (b) => this.onSerialByte?.(b);
    for (let i = 0; i < ESP32_PAD_COUNT; i++) this.history.push(this.freshHistory());
    this.machine.gpio.onPinChange((c) => this.recordChange(c));
    this.machine.loadImage(image);
  }

  /** I2C and SPI parts on the canvas sit on these, as on every other board. */
  private attachBuses(): void {
    let acked = false;
    let read = 0xff;
    const handler = this.i2cBus.handler({
      completeStart: () => {},
      completeStop: () => {},
      completeConnect: (ack) => (acked = ack),
      completeWrite: (ack) => (acked = ack),
      completeRead: (value) => (read = value),
    });
    this.machine.ports.i2c = {
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
    this.machine.ports.spi = {
      transfer: (mosi, mode, lsbFirst) =>
        this.spiBus.transferByte(mosi, { mode, bitOrder: lsbFirst ? 'lsbFirst' : 'msbFirst' }, (pin) => this.digitalPinLevel(pin)),
    };
  }

  /**
   * The pads Wire.begin() routed I2C0 to, or the variant's defaults (SDA 21,
   * SCL 22) until it has, so a part on those pins is attached in time.
   */
  activeI2cPins(): { sda?: number; scl?: number } {
    const g = this.machine.gpio;
    return { sda: g.inputSignalPin(30) ?? g.inputSignalPin(96) ?? 21, scl: g.inputSignalPin(29) ?? g.inputSignalPin(95) ?? 22 };
  }

  /** VSPI's pads (SPI's default controller), or the variant's 18/23/19. */
  activeSpiPins(): { sck?: number; mosi?: number; miso?: number } {
    const g = this.machine.gpio;
    const v = ESP32_SPI_SIGNALS.vspi;
    const h = ESP32_SPI_SIGNALS.hspi;
    return {
      sck: g.outputSignalPin(v.clk) ?? g.outputSignalPin(h.clk) ?? 18,
      mosi: g.outputSignalPin(v.mosi) ?? g.outputSignalPin(h.mosi) ?? 23,
      miso: g.inputSignalPin(v.miso) ?? g.inputSignalPin(h.miso) ?? 19,
    };
  }

  private freshHistory(): PadHistory {
    const now = this.machine ? this.machine.micros : 0;
    return { toggles: 0, level: undefined, lastChangeUs: now, windowStartUs: now, windowHighUs: 0, lastHighPulseUs: 0 };
  }

  get timeMs(): number {
    return this.machine.micros / 1000;
  }

  runFor(simMs: number): void {
    if (this.disposed || simMs <= 0 || this.machine.fault) return;
    const until = this.machine.nanos + simMs * 1e6;
    this.machine.timeLimitNanos = until;
    this.machine.run(until, MAX_INSTRUCTIONS_PER_SLICE);
    this.machine.timeLimitNanos = undefined;
    for (const u of this.machine.uarts) u.sync();
  }

  nextEventMs(): number | undefined {
    if (this.disposed) return undefined;
    const at = this.machine.nextEventNanos();
    return at === undefined ? undefined : Math.max(0, (at - this.machine.nanos) / 1e6);
  }

  // ------------------------------------------------------------- pins

  digitalPinLevel(pin: number): PinLevel | undefined {
    if (pin < 0 || pin >= ESP32_PAD_COUNT) return undefined;
    const s = this.machine.gpio.pinState(pin);
    if (s.direction === 'output' && !(s.openDrain && s.level === 1)) return s.level === 1 ? 'high' : 'low';
    return s.pull === 'up' ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    return pin >= 0 && pin < ESP32_PAD_COUNT && this.machine.gpio.pinState(pin).direction === 'output';
  }

  setDigitalInput(pin: number, value: boolean | null): void {
    if (this.disposed) return;
    this.machine.gpio.drivePin(pin, value === null ? undefined : value ? 1 : 0);
    this.machine.interruptSourceChanged();
  }

  addPinListener(listener: (pin: number, high: boolean) => void): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  private dutyOf(pin: number): number {
    const h = this.history[pin];
    const now = this.machine.micros;
    const elapsed = now - h.windowStartUs;
    const run = h.level === 1 ? now - h.lastChangeUs : 0;
    if (elapsed <= 0) return h.level === 1 ? 1 : 0;
    return Math.min(1, Math.max(0, (h.windowHighUs + run) / elapsed));
  }

  private rollWindow(h: PadHistory, now: number): void {
    if (now - h.windowStartUs <= MEASURE_WINDOW_US) return;
    h.windowStartUs = now;
    h.windowHighUs = 0;
    h.lastChangeUs = Math.min(h.lastChangeUs, now);
  }

  private recordChange(change: PinChange): void {
    const pin = change.current.pin;
    const h = this.history[pin];
    if (h) {
      const now = this.machine.micros;
      this.rollWindow(h, now);
      if (h.level === 1) {
        const width = now - h.lastChangeUs;
        h.lastHighPulseUs = width;
        h.windowHighUs += width;
      }
      if (h.level !== change.current.level) h.toggles++;
      h.lastChangeUs = now;
      h.level = change.current.level;
    }
    if (change.current.direction !== 'output') return;
    const high = change.current.level === 1;
    if (change.previous.direction === 'output' && change.previous.level === change.current.level) return;
    this.onPinChange?.(pin, high);
    for (const l of this.pinListeners) l(pin, high);
  }

  snapshot(): PinSnapshot {
    const states: PinLevel[] = [];
    const duty: number[] = [];
    const pulseWidthUs: number[] = [];
    const toggles: number[] = [];
    for (let pin = 0; pin < ESP32_PAD_COUNT; pin++) {
      states.push(this.digitalPinLevel(pin) ?? 'input');
      this.rollWindow(this.history[pin], this.machine.micros);
      duty.push(this.dutyOf(pin));
      pulseWidthUs.push(this.history[pin].lastHighPulseUs);
      toggles.push(this.history[pin].toggles);
    }
    return { states, duty, pulseWidthUs, toggles };
  }

  // ------------------------------------------------------------- analog, serial

  /** The ADC "channel" of a pad is its GPIO number, when the pad has an ADC input. */
  adcChannelForPin(pin: number): number | undefined {
    return esp32AdcGpio(pin) ? pin : undefined;
  }

  setAnalogVolts(channel: number, volts: number): void {
    if (channel >= 0 && channel < 40) this.machine.sens.volts[channel] = Math.max(0, Math.min(3.3, volts));
  }

  queueSerialInput(text: string): void {
    this.machine.uarts[0].receive(new TextEncoder().encode(text));
    this.machine.interruptSourceChanged();
  }

  get uartBaudRate(): number | undefined {
    return this.machine.uarts[0].baudRate;
  }

  addMicrosecondEvent(us: number, callback: () => void): () => void {
    const at = this.machine.nanos + us * 1000;
    let done = false;
    this.machine.addEventSource({
      nextEventNanos: () => {
        if (done) return undefined;
        if (this.machine.nanos >= at) {
          done = true;
          callback();
          return undefined;
        }
        return at;
      },
    });
    return () => {
      done = true;
    };
  }

  /**
   * Serial2: UART2 on the variant's RX2/TX2 (GPIO16/GPIO17). Serial1's default
   * pins are the module's flash lines, so it has no pads to offer a part.
   */
  readonly extraUarts: readonly UartPort[];

  private uartPort(name: string, index: number, rxPin: number, txPin: number): UartPort {
    const uart = this.machine.uarts[index];
    const machine = this.machine;
    const port: UartPort = {
      name,
      rxPin,
      txPin,
      receive: (text) => {
        uart.receive(new TextEncoder().encode(text));
        machine.interruptSourceChanged();
      },
      onTransmit: null,
      get baudRate() {
        return uart.baudRate;
      },
    };
    uart.onByte = (b) => port.onTransmit?.(b);
    return port;
  }

  /** The firmware stopped and cannot continue, with the reason. */
  get fault(): string | null {
    return this.machine.fault;
  }

  reset(): void {
    if (this.disposed) return;
    this.machine.reset();
    for (let i = 0; i < ESP32_PAD_COUNT; i++) this.history[i] = this.freshHistory();
  }

  dispose(): void {
    this.disposed = true;
    this.pinListeners.clear();
    this.onPinChange = null;
    this.onSerialByte = null;
  }
}

export function createEsp32Runner(applicationImage: Uint8Array, regions: { offset: number; data: Uint8Array }[]): Esp32Runner {
  const image = parseEspApplicationImage(applicationImage, { expectChip: 'esp32', regions: ESP32_REGIONS });
  return new Esp32Runner(image, regions);
}
