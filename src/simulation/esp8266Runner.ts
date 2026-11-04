// The production board runner for the ESP8266 (the NodeMCU).
//
// Pins are the chip's GPIO numbers, 0..16; the board's D0..D8, RX and TX
// labels reach them through its pad map. A0, the chip's one analog input, has
// no GPIO, so it is runner pin 17.
//
// Serial is UART0 on GPIO1/GPIO3 behind the board's USB bridge. Wire is the
// Arduino core's software I2C on GPIO4 (SDA) and GPIO5 (SCL), which reaches the
// canvas's I2C parts through a bit-level target (./esp8266/softI2c); SPI is the
// HSPI master on GPIO14/13/12.
//
// This module imports the emulator, so it must only ever be reached through
// an adapter's dynamic import.

import { Esp8266Machine } from './esp8266/esp8266';
import { parseEsp8266Image, esp8266FlashBytes } from './esp8266/image';
import { SoftI2cTarget } from './esp8266/softI2c';
import type { EspApplicationImage } from './esp32c3/espImage';
import { SerialNorFlash } from './esp32c3/spiFlash';
import type { BoardRunner, PinLevel, PinSnapshot } from './boardRunner';
import type { PinChange } from './gpioEvents';
import { I2cBus } from './devices/i2cBus';
import { SpiBus } from './devices/spiBus';

const MAX_INSTRUCTIONS_PER_SLICE = 8_000_000;
const MEASURE_WINDOW_US = 50_000;
/** The runner pin A0 is. */
export const ESP8266_A0_PIN = 17;
const PIN_COUNT = 18;
/** pins_arduino.h of the NodeMCU variant. */
const I2C_DEFAULT = { sda: 4, scl: 5 };
const SPI_DEFAULT = { sck: 14, mosi: 13, miso: 12 };

interface PadHistory {
  toggles: number;
  level: 0 | 1 | undefined;
  lastChangeUs: number;
  windowStartUs: number;
  windowHighUs: number;
  lastHighPulseUs: number;
}

export class Esp8266Runner implements BoardRunner {
  readonly engine = 'esp8266' as const;
  readonly machine: Esp8266Machine;
  readonly i2cBus = new I2cBus();
  readonly spiBus = new SpiBus();
  private readonly pinListeners = new Set<(pin: number, high: boolean) => void>();
  onPinChange: ((pin: number, high: boolean) => void) | null = null;
  onSerialByte: ((byte: number) => void) | null = null;
  private readonly history: PadHistory[] = [];
  private disposed = false;

  constructor(readonly image: EspApplicationImage) {
    // The whole build is the flash image: the core's bootloader at 0, the application at 0x1000.
    const flash = new SerialNorFlash({
      sizeBytes: esp8266FlashBytes(image.raw),
      // A Winbond W25Q32, as on most NodeMCU boards.
      id: { manufacturer: 0xef, memoryType: 0x40, capacity: 0x16 },
      regions: [{ offset: 0, data: image.raw }],
    });
    this.machine = new Esp8266Machine(flash);
    this.machine.uarts[0].onByte = (b) => this.onSerialByte?.(b);
    this.attachBuses();
    for (let i = 0; i < PIN_COUNT; i++) this.history.push(this.freshHistory());
    this.machine.gpio.onPinChange((c) => this.recordChange(c));
    this.machine.loadImage(image);
  }

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
    const gpio = this.machine.gpio;
    new SoftI2cTarget(
      {
        level: (pin) => gpio.pinState(pin).level,
        pull: (pin, level) => gpio.pullBus(pin, level),
        onChange: (listener) => gpio.onPinChange((c) => listener(c.current.pin)),
      },
      I2C_DEFAULT.sda,
      I2C_DEFAULT.scl,
      () => this.machine.ports.i2c,
    );
    this.machine.ports.spi = {
      transfer: (mosi, mode, lsbFirst) =>
        this.spiBus.transferByte(mosi, { mode, bitOrder: lsbFirst ? 'lsbFirst' : 'msbFirst' }, (pin) => this.digitalPinLevel(pin)),
    };
  }

  activeI2cPins(): { sda?: number; scl?: number } {
    return { ...I2C_DEFAULT };
  }

  activeSpiPins(): { sck?: number; mosi?: number; miso?: number } {
    return { ...SPI_DEFAULT };
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
    if (pin === ESP8266_A0_PIN) return 'input';
    if (pin < 0 || pin >= this.machine.gpio.padCount) return undefined;
    const s = this.machine.gpio.pinState(pin);
    if (s.direction === 'output' && !(s.openDrain && s.level === 1)) return s.level === 1 ? 'high' : 'low';
    return s.pull === 'up' ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    return pin >= 0 && pin < this.machine.gpio.padCount && this.machine.gpio.pinState(pin).direction === 'output';
  }

  setDigitalInput(pin: number, value: boolean | null): void {
    if (this.disposed || pin >= this.machine.gpio.padCount) return;
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
    for (let pin = 0; pin < PIN_COUNT; pin++) {
      states.push(this.digitalPinLevel(pin) ?? 'input');
      this.rollWindow(this.history[pin], this.machine.micros);
      duty.push(this.dutyOf(pin));
      pulseWidthUs.push(this.history[pin].lastHighPulseUs);
      toggles.push(this.history[pin].toggles);
    }
    return { states, duty, pulseWidthUs, toggles };
  }

  // ------------------------------------------------------------- analog, serial

  adcChannelForPin(pin: number): number | undefined {
    return pin === ESP8266_A0_PIN ? 0 : undefined;
  }

  setAnalogVolts(channel: number, volts: number): void {
    if (channel === 0) this.machine.sar.setVolts(volts);
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

  get fault(): string | null {
    return this.machine.fault;
  }

  reset(): void {
    if (this.disposed) return;
    this.machine.reset();
    for (let i = 0; i < PIN_COUNT; i++) this.history[i] = this.freshHistory();
  }

  dispose(): void {
    this.disposed = true;
    this.pinListeners.clear();
    this.onPinChange = null;
    this.onSerialByte = null;
  }
}

export function createEsp8266Runner(bin: Uint8Array): Esp8266Runner {
  return new Esp8266Runner(parseEsp8266Image(bin));
}
