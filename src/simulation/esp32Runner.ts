// The production board runner for the Xtensa Espressif parts: the ESP32 and
// the ESP32-S3.
//
// Everything above this file talks to a `BoardRunner`; this is that contract
// for the machines in ./esp32 and ./esp32s3. Pins are the chip's own GPIO
// numbers (0..39 on the ESP32, 0..48 on the S3); a board's labels reach them
// through its pad map. What differs between the chips — the machine, its
// image regions, and the matrix signals and default pads of the buses — is
// an `XtensaChip`.
//
// This module imports the emulator, so it must only ever be reached through
// an adapter's dynamic import.

import { Esp32Machine } from './esp32/esp32';
import { Esp32S3Machine, ESP32S3_SPI_SIGNALS } from './esp32s3/esp32s3';
import type { Esp32Gpio } from './esp32/gpio';
import type { Esp32Sens } from './esp32/adc';
import type { EspUart } from './espRiscv/uart';
import type { EspXtensaMachine } from './xtensa/espXtensaMachine';
import { ESP32_SPI_SIGNALS } from './esp32/spi';
import { parseEspApplicationImage, type EspApplicationImage, type EspChipName } from './esp32c3/espImage';
import { SerialNorFlash } from './esp32c3/spiFlash';
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

/**
 * The flash a build expects, from its own image header: the size field (the
 * top nibble of byte 3: 1, 2, 4, 8 or 16 MB) decides the part, a GigaDevice
 * GD25Q of that size, whose JEDEC ID ESP-IDF checks against the header. The
 * partition table sits at 0x8000 and the application at 0x10000.
 */
export function flashForImage(image: EspApplicationImage, partitionTable: Uint8Array | undefined): SerialNorFlash {
  const megabytes = [1, 2, 4, 8, 16][(image.raw[3] >>> 4) & 0xf] ?? 4;
  const capacity = 20 + Math.log2(megabytes);
  const regions = [{ offset: 0x10000, data: image.raw }];
  if (partitionTable?.length) regions.push({ offset: 0x8000, data: partitionTable });
  return new SerialNorFlash({ sizeBytes: megabytes << 20, id: { manufacturer: 0xc8, memoryType: 0x40, capacity }, regions });
}

/** Where an ESP32-S3 application image may place its segments. */
export const ESP32S3_REGIONS = [
  { start: 0x3c000000, end: 0x3e000000, name: 'DROM (flash-mapped constants)' },
  { start: 0x3fc88000, end: 0x3fd00000, name: 'DRAM' },
  { start: 0x40370000, end: 0x403e0000, name: 'IRAM' },
  { start: 0x42000000, end: 0x44000000, name: 'IROM (flash-mapped code)' },
  { start: 0x50000000, end: 0x50002000, name: 'RTC slow memory' },
  { start: 0x600fe000, end: 0x60100000, name: 'RTC fast memory' },
];

type XtensaMachine = EspXtensaMachine & { gpio: Esp32Gpio; uarts: EspUart[]; sens: Esp32Sens };

/** What distinguishes one Xtensa Espressif part from another, from a runner's point of view. */
export interface XtensaChip {
  engine: 'esp32' | 'esp32s3';
  chip: EspChipName;
  regions: { start: number; end: number; name: string }[];
  build(flash: SerialNorFlash): XtensaMachine;
  /** Matrix input signals of each I2C controller's SDA and SCL, and the variant's default pads. */
  i2c: { sda: number[]; scl: number[]; defaults: { sda: number; scl: number } };
  /** Matrix signals of each SPI master, the one SPI uses by default first, and the variant's default pads. */
  spi: { clk: number[]; mosi: number[]; miso: number[]; defaults: { sck: number; mosi: number; miso: number } };
  /** UARTs a part may be wired to besides Serial: Arduino's name, the UART, and the variant's RX/TX pads. */
  extraUarts: { name: string; uart: number; rx: number; tx: number }[];
}

export const ESP32_CHIP: XtensaChip = {
  engine: 'esp32',
  chip: 'esp32',
  regions: ESP32_REGIONS,
  build: (flash) => new Esp32Machine(flash),
  i2c: { sda: [30, 96], scl: [29, 95], defaults: { sda: 21, scl: 22 } },
  spi: {
    clk: [ESP32_SPI_SIGNALS.vspi.clk, ESP32_SPI_SIGNALS.hspi.clk],
    mosi: [ESP32_SPI_SIGNALS.vspi.mosi, ESP32_SPI_SIGNALS.hspi.mosi],
    miso: [ESP32_SPI_SIGNALS.vspi.miso, ESP32_SPI_SIGNALS.hspi.miso],
    defaults: { sck: 18, mosi: 23, miso: 19 },
  },
  // Serial1's default pins are the module's flash lines, so it has no pads to offer a part.
  extraUarts: [{ name: 'Serial2', uart: 2, rx: 16, tx: 17 }],
};

/** The S3: pins_arduino.h's SDA 8, SCL 9, SCK 12, MOSI 11, MISO 13; Serial1 on RX 18 / TX 17 (HardwareSerial.h). */
export const ESP32S3_CHIP: XtensaChip = {
  engine: 'esp32s3',
  chip: 'esp32s3',
  regions: ESP32S3_REGIONS,
  build: (flash) => new Esp32S3Machine(flash),
  i2c: { sda: [90, 92], scl: [89, 91], defaults: { sda: 8, scl: 9 } },
  spi: {
    clk: [ESP32S3_SPI_SIGNALS.fspi.clk, ESP32S3_SPI_SIGNALS.spi3.clk],
    mosi: [ESP32S3_SPI_SIGNALS.fspi.mosi, ESP32S3_SPI_SIGNALS.spi3.mosi],
    miso: [ESP32S3_SPI_SIGNALS.fspi.miso, ESP32S3_SPI_SIGNALS.spi3.miso],
    defaults: { sck: 12, mosi: 11, miso: 13 },
  },
  extraUarts: [{ name: 'Serial1', uart: 1, rx: 18, tx: 17 }],
};

interface PadHistory {
  toggles: number;
  level: 0 | 1 | undefined;
  lastChangeUs: number;
  windowStartUs: number;
  windowHighUs: number;
  lastHighPulseUs: number;
}

export class Esp32Runner implements BoardRunner {
  readonly engine: 'esp32' | 'esp32s3';
  readonly machine: XtensaMachine;
  private readonly padCount: number;
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
    private readonly chip: XtensaChip = ESP32_CHIP,
  ) {
    const named = (offset: number) => regions.find((r) => r.offset === offset)?.data;
    const flash = flashForImage(image, named(0x8000));
    this.engine = chip.engine;
    this.machine = chip.build(flash);
    this.padCount = this.machine.gpio.padCount;
    this.extraUarts = chip.extraUarts.map((u) => this.uartPort(u.name, u.uart, u.rx, u.tx));
    this.attachBuses();
    this.machine.onConsoleByte = (b) => this.onSerialByte?.(b);
    this.machine.uarts[0].onByte = (b) => this.onSerialByte?.(b);
    for (let i = 0; i < this.padCount; i++) this.history.push(this.freshHistory());
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
   * The pads Wire.begin() routed I2C to, or the variant's defaults until it
   * has, so a part on those pins is attached in time.
   */
  activeI2cPins(): { sda?: number; scl?: number } {
    const g = this.machine.gpio;
    const { i2c } = this.chip;
    const first = (signals: number[]) => signals.map((s) => g.inputSignalPin(s)).find((p) => p !== undefined);
    return { sda: first(i2c.sda) ?? i2c.defaults.sda, scl: first(i2c.scl) ?? i2c.defaults.scl };
  }

  /** The pads SPI.begin() routed the default SPI master to, or the variant's defaults. */
  activeSpiPins(): { sck?: number; mosi?: number; miso?: number } {
    const g = this.machine.gpio;
    const { spi } = this.chip;
    const out = (signals: number[]) => signals.map((s) => g.outputSignalPin(s)).find((p) => p !== undefined);
    const inp = (signals: number[]) => signals.map((s) => g.inputSignalPin(s)).find((p) => p !== undefined);
    return { sck: out(spi.clk) ?? spi.defaults.sck, mosi: out(spi.mosi) ?? spi.defaults.mosi, miso: inp(spi.miso) ?? spi.defaults.miso };
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
    if (pin < 0 || pin >= this.padCount) return undefined;
    const s = this.machine.gpio.pinState(pin);
    if (s.direction === 'output' && !(s.openDrain && s.level === 1)) return s.level === 1 ? 'high' : 'low';
    return s.pull === 'up' ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    return pin >= 0 && pin < this.padCount && this.machine.gpio.pinState(pin).direction === 'output';
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
    for (let pin = 0; pin < this.padCount; pin++) {
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
    return this.machine.sens.isAdcGpio(pin) ? pin : undefined;
  }

  setAnalogVolts(channel: number, volts: number): void {
    if (channel >= 0 && channel < this.padCount) this.machine.sens.volts[channel] = Math.max(0, Math.min(3.3, volts));
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
    for (let i = 0; i < this.padCount; i++) this.history[i] = this.freshHistory();
  }

  dispose(): void {
    this.disposed = true;
    this.pinListeners.clear();
    this.onPinChange = null;
    this.onSerialByte = null;
  }
}

export function createEsp32Runner(
  applicationImage: Uint8Array,
  regions: { offset: number; data: Uint8Array }[],
  chip: XtensaChip = ESP32_CHIP,
): Esp32Runner {
  const image = parseEspApplicationImage(applicationImage, { expectChip: chip.chip, regions: chip.regions });
  return new Esp32Runner(image, regions, chip);
}
