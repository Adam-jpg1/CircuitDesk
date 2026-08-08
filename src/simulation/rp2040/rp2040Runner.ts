// Real RP2040 execution using rp2040js (MIT). Compiled Arduino-Pico firmware
// (a UF2 from the compiler backend) is written into flash unmodified and
// executed instruction by instruction: the image's own second stage runs, the
// SDK's startup code runs, and control reaches the sketch's setup() and loop()
// on its own. GPIO, PWM, ADC and UART behaviour all come from the emulator's
// peripherals.
//
// Nothing here inspects source code, patches the image, skips startup
// functions by address, forces the program counter into user code or
// intercepts Arduino functions. Every observation is taken at a pad or a
// peripheral register.
//
// This module statically imports rp2040js, so bundlers place both in the same
// lazily-fetched chunk. Only `adapters.ts` imports it, and only with a dynamic
// import when a Pico simulation actually starts.

import { RP2040 } from 'rp2040js';
import { buildBootStub } from './bootStub';
import { PadPullResolver } from './gpioPulls';
import { Rp2040ClockTree } from './clockTree';
import { installSioFifo } from './sioFifo';
import { FLASH_BASE, parseRp2040Uf2, type Uf2Image } from './uf2';
import {
  readI2cPins,
  readSpiPins,
  ARDUINO_PICO_DEFAULT_I2C,
  ARDUINO_PICO_DEFAULT_SPI,
  type I2cPinAssignment,
  type SpiPinAssignment,
} from './busPins';
import { I2cBus } from '../devices/i2cBus';
import { SpiBus, type SpiController } from '../devices/spiBus';
import type { SpiMode } from '../devices/types';
import type { PinSnapshot } from '../boardRunner';

/** GP0..GP29 exist on the die; a Pico brings out GP0..GP28. */
export const RP2040_PIN_COUNT = 30;

/** SRAM ends here on the RP2040; the ROM stages boot2 just below it. */
const SRAM_TOP = 0x20042000;
const BOOT2_RAM = SRAM_TOP - 0x100;

/**
 * Return address handed to boot2. It points into the ROM header block, which
 * holds no code, so reaching it can only mean the second stage returned.
 */
const BOOT2_SENTINEL = 0x00000f00;

/**
 * System clock before the firmware configures its own.
 *
 * This is only the starting point. Once startup programs the PLLs and clock
 * MUXes, the clock tree re-derives the real frequency from those registers and
 * execution follows it — which matters, because the Arduino-Pico core runs a
 * Pico well above the RP2040's nominal 125 MHz by default.
 */
const DEFAULT_CLOCK_HZ = 125e6;

/** Instructions boot2 is allowed before we call it stuck. */
const BOOT2_BUDGET = 2_000_000;

/**
 * Below this address there is no code, only the boot ROM's header block.
 *
 * A lookup for a ROM routine CircuitDesk does not provide returns the
 * documented 0, and the caller then branches straight to it. Catching that
 * here turns what would otherwise be an endless slide through zeroed memory
 * into a message that names the cause.
 */
const ROM_HEADER_END = 0x10;

/**
 * Hard ceiling on instructions retired in one runFor() call. A sketch that
 * never yields cannot hold the browser's main thread beyond this.
 */
const MAX_INSTRUCTIONS_PER_CALL = 20_000_000;

/** ADC channels 0..3 are GP26..GP29; channel 4 is the temperature sensor. */
const ADC_FIRST_GPIO = 26;
export const RP2040_ADC_CHANNELS = 4;

/**
 * PL022 SSPCR0 bits used to derive the datasheet SPI mode.
 *
 * rp2040js exposes a `spiMode` getter, but it returns 3 for CPOL=1/CPHA=0 and
 * 2 for CPOL=1/CPHA=1 — modes 2 and 3 swapped relative to the datasheet. The
 * control register is read directly instead, the same way the AVR runner works
 * around the equivalent defect in avr8js (which swaps modes 1 and 2).
 */
const SSPCR0_OFFSET = 0x00;
const SSPCR0_SPO = 1 << 6; // CPOL
const SSPCR0_SPH = 1 << 7; // CPHA

/** The RP2040's ADC is 3.3 V full scale and 12 bits. */
export const RP2040_ADC_VREF = 3.3;
export const RP2040_ADC_MAX_CODE = 4095;

interface DutyTracker {
  lastHigh: boolean;
  lastChangeNs: number;
  highNs: number;
  windowStartNs: number;
  pulseRiseNs: number;
  pulseWidthUs: number;
  toggles: number;
}

export class Rp2040Runner {
  readonly engine = 'rp2040js' as const;

  private rp!: RP2040;
  private pads!: PadPullResolver;
  private clocks!: Rp2040ClockTree;
  private readonly image: Uf2Image;
  private readonly startupCycleNs: number;
  private trackers: DutyTracker[] = [];
  private pinListeners = new Set<(pin: number, high: boolean) => void>();
  private unsubscribers: (() => void)[] = [];
  private externalDrive = new Map<number, boolean>();
  private disposed = false;

  /**
   * I2C and SPI devices on the canvas attach to these, exactly as they do on
   * the AVR runner. The device models are shared, not duplicated: an SSD1306
   * driven by Pico firmware is the same object an Uno would drive.
   *
   * They live on the runner rather than on the machine so their contents
   * survive a circuit re-bind — a wiring edit is not a power cycle.
   */
  readonly i2cBus = new I2cBus();
  readonly spiBus = new SpiBus();
  private readonly spiCtrl: SpiController;

  /** Bytes the firmware transmits on UART0, which is Serial1 on a Pico. */
  onSerialByte: ((byte: number) => void) | null = null;
  onPinChange: ((pin: number, high: boolean) => void) | null = null;

  /**
   * @param firmware Raw UF2 bytes. Already-validated images may be passed as a
   *                 parsed Uf2Image to avoid parsing twice.
   */
  constructor(firmware: Uint8Array | Uf2Image, options: { clockHz?: number } = {}) {
    this.image = firmware instanceof Uint8Array ? parseRp2040Uf2(firmware) : firmware;
    this.startupCycleNs = 1e9 / (options.clockHz ?? DEFAULT_CLOCK_HZ);
    // Read lazily through the runner, so the mode reflects whatever the
    // firmware has SSPCR0 set to at the moment of each transfer.
    const runner = this;
    this.spiCtrl = {
      get mode(): SpiMode {
        return runner.currentSpiMode;
      },
      // The PL022 in Motorola SPI format transmits most-significant bit first
      // and offers no alternative, so unlike an AVR there is no DORD to read.
      get bitOrder(): 'msbFirst' | 'lsbFirst' {
        return 'msbFirst';
      },
    };
    this.build();
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Constructs a machine in its power-on state and boots the image.
   *
   * A fresh machine is built rather than mutating the old one because
   * rp2040js's own reset() clears only the core and the PWM block: SRAM, the
   * GPIO pads and every other peripheral would keep whatever the previous run
   * left behind, and a sketch would appear to restart while running on stale
   * state.
   */
  private build(): void {
    const rp = new RP2040();
    rp.logger = { debug() {}, info() {}, warn() {}, error() {} };
    rp.loadBootrom(buildBootStub().rom);
    this.rp = rp;
    this.clocks = new Rp2040ClockTree(rp as never);
    installSioFifo(rp as never);
    this.pads = new PadPullResolver(rp.gpio);

    for (const [addr, data] of this.image.blocks) rp.flash.set(data, addr - FLASH_BASE);

    this.trackers = Array.from({ length: RP2040_PIN_COUNT }, () => ({
      lastHigh: false,
      lastChangeNs: 0,
      highNs: 0,
      windowStartNs: 0,
      pulseRiseNs: 0,
      pulseWidthUs: 0,
      toggles: 0,
    }));

    for (let pin = 0; pin < RP2040_PIN_COUNT; pin++) {
      const index = pin;
      rp.gpio[index].addListener(() => this.padChanged(index));
    }
    rp.uart[0].onByte = (byte: number) => this.onSerialByte?.(byte);
    this.attachBuses(rp);

    for (const [pin, level] of this.externalDrive) this.pads.drive(pin, level);
    this.bootFromFlash();
  }

  /**
   * Runs the image's own second stage the way the boot ROM does, then enters
   * the application through the vector table the image publishes.
   */
  private bootFromFlash(): void {
    const rp = this.rp;
    for (let i = 0; i < 256; i++) rp.writeUint8(BOOT2_RAM + i, rp.readUint8(FLASH_BASE + i));
    rp.core.SP = SRAM_TOP;
    rp.core.registers[14] = BOOT2_SENTINEL | 1;
    rp.core.PC = BOOT2_RAM;

    let returned = false;
    for (let i = 0; i < BOOT2_BUDGET; i++) {
      if ((rp.core.PC & ~1) === BOOT2_SENTINEL) {
        returned = true;
        break;
      }
      this.step();
    }
    if (!returned) {
      throw new Error(
        "The firmware's second-stage bootloader did not finish. The UF2 may be corrupt or built for a different flash layout.",
      );
    }
    rp.core.SP = rp.readUint32(FLASH_BASE + 0x100);
    rp.core.PC = rp.readUint32(FLASH_BASE + 0x104) & ~1;
  }

  /** Rebuilds the machine in its power-on state and boots the same image. */
  reset(): void {
    this.assertLive();
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.build();
  }

  /** Releases the machine. Further calls throw rather than run on a dead one. */
  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.pinListeners.clear();
    this.onSerialByte = null;
    this.onPinChange = null;
    this.disposed = true;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('This RP2040 simulation has been stopped.');
  }

  // ------------------------------------------------------------- execution

  /**
   * Nanoseconds per CPU cycle, from the clock tree the firmware programmed.
   *
   * Read on each step rather than cached, so a sketch that changes the system
   * clock at runtime changes how fast it executes, as it would on the chip.
   */
  private get cycleNs(): number {
    const hz = this.rp.clkSys;
    return hz > 0 && Number.isFinite(hz) ? 1e9 / hz : this.startupCycleNs;
  }

  /** One instruction, or a clock advance while the core is halted on a WFI. */
  private step(): void {
    const core = this.rp.core;
    if ((core.PC & ~1) < ROM_HEADER_END) this.reportUnresolvedRomCall();
    const cycleNs = this.cycleNs;
    if (core.waiting) {
      const clock = this.rp.clock as unknown as { tick(ns: number): void; nanosToNextAlarm: number };
      clock.tick(clock.nanosToNextAlarm || cycleNs);
    } else {
      const cycles = core.executeInstruction();
      (this.rp.clock as unknown as { tick(ns: number): void }).tick((cycles || 1) * cycleNs);
    }
  }

  /**
   * Advances the simulation by a slice of simulated time.
   *
   * The instruction ceiling is the runaway guard: a sketch that spins without
   * letting the clock advance is stopped with a clear message instead of
   * freezing the tab.
   */
  runFor(simMs: number): void {
    this.assertLive();
    const clock = this.rp.clock as unknown as { nanos: number };
    const target = clock.nanos + simMs * 1e6;
    let executed = 0;
    while (clock.nanos < target) {
      this.step();
      if (++executed > MAX_INSTRUCTIONS_PER_CALL) {
        throw new Error(
          'Simulation stopped: the firmware executed an excessive number of instructions without advancing time.',
        );
      }
    }
  }

  get timeMs(): number {
    return Number((this.rp.clock as unknown as { nanos: number }).nanos) / 1e6;
  }

  /**
   * Explains a branch into the boot ROM header block.
   *
   * The only way to get there is through a ROM table lookup that returned 0,
   * and the only routines deliberately withheld are the soft-float tables —
   * the mufplib code CircuitDesk cannot redistribute. The Arduino-Pico core is
   * built against the SDK's ROM float implementation, so any sketch doing
   * floating-point arithmetic lands here. That includes `analogWrite()`, which
   * computes its PWM divisor in floating point.
   *
   * Saying so is the point: the alternative is a sketch that appears to run
   * while producing silently wrong numbers.
   */
  private reportUnresolvedRomCall(): never {
    throw new Error(
      'This sketch uses floating-point arithmetic, which the Arduino-Pico core performs through routines built ' +
        "into the Raspberry Pi boot ROM. Those routines are third-party code CircuitDesk is not licensed to " +
        'redistribute, so they are not available in simulation and the sketch cannot run here. This also affects ' +
        'analogWrite(), which computes its PWM divisor in floating point. Integer arithmetic, digital I/O, ' +
        'analogRead() and Serial1 are unaffected.',
    );
  }

  // ------------------------------------------------------------------ GPIO

  private padChanged(pin: number): void {
    const gpio = this.rp.gpio[pin];
    const high = gpio.outputEnable ? gpio.outputValue : gpio.inputValue;
    const tracker = this.trackers[pin];
    if (!tracker || high === tracker.lastHigh) return;
    const now = this.nowNs();
    if (tracker.lastHigh) {
      tracker.highNs += now - tracker.lastChangeNs;
      tracker.pulseWidthUs = (now - tracker.pulseRiseNs) / 1000;
    } else {
      tracker.pulseRiseNs = now;
    }
    tracker.lastHigh = high;
    tracker.lastChangeNs = now;
    tracker.toggles++;
    this.onPinChange?.(pin, high);
    for (const listener of this.pinListeners) listener(pin, high);
  }

  private nowNs(): number {
    return Number((this.rp.clock as unknown as { nanos: number }).nanos);
  }

  /** Subscribes to pad edges. Devices that latch on a pulse cannot poll. */
  addPinListener(listener: (pin: number, high: boolean) => void): () => void {
    this.pinListeners.add(listener);
    const off = () => this.pinListeners.delete(listener);
    this.unsubscribers.push(off);
    return off;
  }

  digitalPinLevel(pin: number): 'high' | 'low' | 'input' | 'input-pullup' | undefined {
    const gpio = this.rp.gpio[pin];
    if (!gpio) return undefined;
    if (gpio.outputEnable) return gpio.outputValue ? 'high' : 'low';
    return gpio.pullupEnabled ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    return this.rp.gpio[pin]?.outputEnable === true;
  }

  /**
   * Connects an external driver to a pad — a wire to a rail, another device's
   * output, a button to ground. `null` disconnects it, leaving the pad's own
   * pull resistor to decide, exactly as an open switch would.
   */
  setDigitalInput(pin: number, value: boolean | null): void {
    if (pin < 0 || pin >= RP2040_PIN_COUNT) return;
    if (value === null) this.externalDrive.delete(pin);
    else this.externalDrive.set(pin, value);
    this.pads.drive(pin, value);
  }

  // ------------------------------------------------------------ I2C and SPI

  /**
   * Connects both hardware I2C controllers and both SPI controllers to the
   * shared device buses.
   *
   * rp2040js reports what the firmware's `Wire` and `SPI` calls actually do on
   * the wire, and the bus decides who — if anyone — answers. With no device
   * attached, the bus NACKs every address, which is the honest result for a
   * bus with nothing on it: `Wire.endTransmission()` returns 2, exactly as on
   * hardware.
   *
   * Both controller instances are wired, because the Arduino-Pico core's
   * `Wire` and `Wire1` (and `SPI` and `SPI1`) map onto different silicon, and
   * which one a sketch uses is its own choice.
   */
  private attachBuses(rp: RP2040): void {
    for (const controller of rp.i2c) {
      const handler = this.i2cBus.handler(controller);
      controller.onStart = (repeatedStart: boolean) => handler.start(repeatedStart);
      // rp2040js reports the direction as an I2CMode enum where Read is 1; the
      // bus speaks in terms of "is this a write".
      controller.onConnect = (address: number, mode: number) => handler.connectToSlave(address, mode === 0);
      controller.onWriteByte = (value: number) => handler.writeByte(value);
      controller.onReadByte = (ack: boolean) => handler.readByte(ack);
      controller.onStop = () => handler.stop();
    }

    for (const controller of rp.spi) {
      controller.onTransmit = (mosi: number) => {
        const miso = this.spiBus.transferByte(mosi, this.spiCtrl, (pin) => this.digitalPinLevel(pin));
        controller.completeTransmit(miso);
      };
    }
  }

  /**
   * The datasheet SPI mode `(CPOL << 1) | CPHA`, read from SSPCR0.
   *
   * Uses whichever controller the firmware has muxed to pins; falls back to
   * SPI0 when nothing is muxed yet, which is only reached before `SPI.begin()`.
   */
  private get currentSpiMode(): SpiMode {
    const instance = this.activeSpiPins().instance ?? 0;
    const control0 = this.rp.spi[instance]?.readUint32(SSPCR0_OFFSET) ?? 0;
    return ((((control0 & SSPCR0_SPO) ? 1 : 0) << 1) | ((control0 & SSPCR0_SPH) ? 1 : 0)) as SpiMode;
  }

  /**
   * The GP pins carrying I2C.
   *
   * The live mux wins whenever the firmware has established one. Before that —
   * which is every moment up to `Wire.begin()` — the installed core's
   * documented default is used, so a device wired on the canvas can answer a
   * transaction issued in the same `setup()` that opened the bus.
   */
  activeI2cPins(): I2cPinAssignment {
    const live = readI2cPins(this.rp.gpio);
    return live.sda !== undefined && live.scl !== undefined ? live : ARDUINO_PICO_DEFAULT_I2C;
  }

  /** The GP pins carrying SPI, with the same live-then-default rule. */
  activeSpiPins(): SpiPinAssignment {
    const live = readSpiPins(this.rp.gpio);
    return live.sck !== undefined ? live : ARDUINO_PICO_DEFAULT_SPI;
  }

  // ------------------------------------------------------------------- ADC

  /** ADC channel reachable at a GP pin, or undefined if the pin has no ADC. */
  adcChannelForPin(pin: number): number | undefined {
    const channel = pin - ADC_FIRST_GPIO;
    return channel >= 0 && channel < RP2040_ADC_CHANNELS ? channel : undefined;
  }

  /**
   * Applies a net voltage to an ADC channel.
   *
   * rp2040js's `channelValues` are raw conversion results, not volts — the
   * value written here is what the firmware reads back out of the ADC's RESULT
   * register — so the net voltage is converted to a 12-bit code first.
   *
   * Clamped to the RP2040's own 0 - 3.3 V input range: the chip is not 5 V
   * tolerant, and reporting a reading above full scale would be fiction.
   */
  setAnalogVolts(channel: number, volts: number): void {
    if (channel < 0 || channel >= this.rp.adc.channelValues.length) return;
    const clamped = Math.max(0, Math.min(RP2040_ADC_VREF, volts));
    this.rp.adc.channelValues[channel] = Math.round((clamped / RP2040_ADC_VREF) * RP2040_ADC_MAX_CODE);
  }

  /** The voltage currently presented to an ADC channel, for diagnostics. */
  analogVolts(channel: number): number {
    const code = this.rp.adc.channelValues[channel] ?? 0;
    return (code / RP2040_ADC_MAX_CODE) * RP2040_ADC_VREF;
  }

  // ------------------------------------------------------------------ UART

  /** The rate UART0 is actually running at, derived from the real clock tree. */
  get uartBaudRate(): number {
    return this.rp.uart[0].baudRate;
  }

  get peripheralClockHz(): number {
    return this.rp.clkPeri;
  }

  get systemClockHz(): number {
    return this.rp.clkSys;
  }

  queueSerialInput(text: string): void {
    for (const byte of new TextEncoder().encode(text)) this.rp.uart[0].feedByte(byte);
  }

  // ----------------------------------------------------------------- timing

  /** Schedules a callback on the simulated clock, for edge-timed devices. */
  addMicrosecondEvent(us: number, callback: () => void): () => void {
    const alarm = (this.rp.clock as unknown as { createAlarm(cb: () => void): { schedule(ns: number): void; cancel(): void } }).createAlarm(
      callback,
    );
    alarm.schedule(us * 1000);
    return () => alarm.cancel();
  }

  // --------------------------------------------------------------- snapshot

  /**
   * Samples every pad and resets the duty measurement window.
   *
   * Duty is measured from real pad transitions, so a pin driven by the PWM
   * peripheral reports the duty the circuit actually sees — the same thing a
   * scope on the pin would show. Nothing reads back what analogWrite() was
   * asked for.
   */
  snapshot(): PinSnapshot {
    const states: PinSnapshot['states'] = [];
    const duty: number[] = [];
    const pulseWidthUs: number[] = [];
    const toggles: number[] = [];
    const now = this.nowNs();

    for (let pin = 0; pin < RP2040_PIN_COUNT; pin++) {
      states.push(this.digitalPinLevel(pin) ?? 'input');
      const t = this.trackers[pin];
      let high = t.highNs;
      if (t.lastHigh) high += now - t.lastChangeNs;
      const window = now - t.windowStartNs;
      duty.push(window > 0 ? Math.min(1, high / window) : t.lastHigh ? 1 : 0);
      pulseWidthUs.push(t.pulseWidthUs);
      toggles.push(t.toggles);
      t.highNs = 0;
      t.windowStartNs = now;
      if (t.lastHigh) t.lastChangeNs = now;
    }
    return { states, duty, pulseWidthUs, toggles };
  }
}
