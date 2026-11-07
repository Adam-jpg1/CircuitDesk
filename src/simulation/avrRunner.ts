// Real AVR execution using avr8js. Compiled firmware (Intel HEX from the
// compiler backend) runs instruction-by-instruction; GPIO, timers (incl.
// PWM), UART and ADC are the emulator's own peripherals. Nothing in here
// scans source code — all behavior comes from executing the program.
//
// Everything MCU-specific comes from the board's AvrBoardProfile
// (boards/pinMaps.ts) plus its peripheral configuration
// (simulation/avr/mcuConfig.ts): ports, SRAM size, flash size, pin numbering,
// timers, USART and ADC. Only boards with a registered profile can run here —
// there is no implicit Uno fallback for any other board.

import { CPU, avrInstruction, AVRIOPort, AVRTimer, AVRUSART, AVRADC, AVRTWI, AVRSPI, AVREEPROM, EEPROMMemoryBackend, PinState } from 'avr8js';
import { parseIntelHex, intelHexHighestAddress } from './intelHex';
import { AVR_BOARD_PROFILES, type AvrBoardProfile, type AvrPortName } from '../boards/pinMaps';
import { Atmega32u4Usb } from './avr/usb32u4';
import { Timer4 } from './avr/timer4';
import { MCU_CONFIGS } from './avr/mcuConfig';
import { I2cBus } from './devices/i2cBus';
import { SpiBus, type SpiController } from './devices/spiBus';
import type { SpiMode } from './devices/types';
import type { UartPort } from './boardRunner';

export const F_CPU = 16_000_000;

/** Default profile (ATmega328P / Uno pinout) for direct test usage. */
export const DEFAULT_AVR_PROFILE: AvrBoardProfile = AVR_BOARD_PROFILES['board.arduino-uno'];

/** Hard ceiling on instructions per runToCycles() call — runaway-sketch guard. */
const MAX_INSTRUCTIONS_PER_CALL = 200_000_000;

/** SPCR control bits used to derive the datasheet SPI mode and bit order. */
const SPCR_DORD = 0x20;
const SPCR_CPOL = 0x08;
const SPCR_CPHA = 0x04;

export class FirmwareRejectedError extends Error {}

/** @deprecated board-aware resolution lives in boards/pinMaps.ts (arduinoPinNumber). */
export function boardPinToArduino(pinId: string): number | undefined {
  if (/^D\d+$/.test(pinId)) return Number(pinId.slice(1));
  if (/^A[0-7]$/.test(pinId)) return 14 + Number(pinId.slice(1));
  if (pinId === 'SDA') return 18;
  if (pinId === 'SCL') return 19;
  return undefined;
}

export interface PinSnapshot {
  /** state per Arduino pin, indexed 0..profile.pinCount-1 */
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
  readonly engine = 'avr8js' as const;
  // The chip and its peripherals. Rebuilt from the same firmware by reset(),
  // which is why they are assigned in build() rather than declared readonly.
  cpu!: CPU;
  usart!: AVRUSART;
  adc!: AVRADC;
  /** Hardware I2C controller. Device models attach through the bus below. */
  twi!: AVRTWI;
  /** I2C devices on the canvas attach here; survives circuit re-binds. */
  readonly i2cBus = new I2cBus();
  /** Hardware SPI controller. Device models attach through the bus below. */
  spi!: AVRSPI;
  /** SPI devices on the canvas attach here; survives circuit re-binds. */
  readonly spiBus = new SpiBus();
  timers!: AVRTimer[];
  readonly profile: AvrBoardProfile;
  /** The flash image, kept so reset() can power the chip up again on it. */
  private readonly program: Uint8Array;
  /**
   * The data EEPROM. Non-volatile, so it belongs to the runner rather than the
   * chip: what a sketch saved is still there after the reset button, as on a
   * real board. Erased (0xFF) at power-up.
   */
  readonly eeprom: EEPROMMemoryBackend;

  private ports = new Map<AvrPortName, AVRIOPort>();
  /** Reverse index: port name → [arduinoPin, bitIndex][] (avoids per-change scans). */
  private portPins = new Map<AvrPortName, [number, number][]>();

  onSerialByte: ((byte: number) => void) | null = null;
  /**
   * What the firmware sends over the chip's own USB, on boards that have it
   * (the Leonardo's `Serial`). For the monitor only: no wire carries it.
   */
  onUsbSerialByte: ((byte: number) => void) | null = null;
  private usb: Atmega32u4Usb | null = null;
  /**
   * The Mega's Serial1-3. The port objects outlive a reset; the USART behind
   * each is rebuilt with the chip.
   */
  readonly extraUarts: AvrUartPort[] = [];
  /** Called on any digital pin change with (arduinoPin, isHigh). */
  onPinChange: ((pin: number, high: boolean) => void) | null = null;

  private trackers: DutyTracker[] = [];
  private serialRxQueue: number[] = [];
  private spiCtrl!: SpiController;
  /** Edge subscribers. Additive alongside onPinChange, which stays as-is. */
  private pinListeners = new Set<(pin: number, high: boolean) => void>();

  constructor(hex: string, profile: AvrBoardProfile = DEFAULT_AVR_PROFILE) {
    this.profile = profile;
    const mcu = MCU_CONFIGS[profile.mcu];
    if (!mcu) {
      throw new FirmwareRejectedError(`No emulator configuration is registered for MCU "${profile.mcu}".`);
    }

    // Flash image sized for this MCU. Firmware that reaches beyond this chip's
    // flash is rejected outright rather than silently truncated into a
    // different chip's address space.
    let highest: number;
    try {
      highest = intelHexHighestAddress(hex);
    } catch (err) {
      throw new FirmwareRejectedError(
        `Firmware could not be parsed as Intel HEX for ${profile.mcu}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (highest < 0) {
      throw new FirmwareRejectedError(`Firmware image for ${profile.mcu} is empty.`);
    }
    if (highest >= profile.flashBytes) {
      throw new FirmwareRejectedError(
        `Firmware addresses flash byte 0x${highest.toString(16)} but ${profile.mcu} has only ${profile.flashBytes} bytes of flash: refusing to run firmware built for a different MCU.`,
      );
    }
    const program = new Uint8Array(profile.flashBytes);
    try {
      parseIntelHex(hex, program);
    } catch (err) {
      throw new FirmwareRejectedError(
        `Firmware could not be loaded for ${profile.mcu}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.program = program;
    this.eeprom = new EEPROMMemoryBackend(mcu.eeprom.bytes);
    this.build();
  }

  /**
   * Powers the chip up on the firmware: a fresh CPU, RAM and peripherals, as
   * after a reset. What belongs to the runner rather than the chip — the
   * device buses, edge listeners and serial callbacks — carries over.
   */
  private build(): void {
    const profile = this.profile;
    const mcu = MCU_CONFIGS[profile.mcu]!;
    const program = this.program;
    this.ports = new Map();
    this.portPins = new Map();
    this.trackers = [];
    this.serialRxQueue = [];
    this.usb = null;

    // avr8js allocates 0x100 of register space plus sramBytes, so the SRAM
    // allocation must span through RAMEND. The ATmega2560's extended I/O
    // pushes SRAM to 0x200, which the 328P's layout would silently truncate.
    this.cpu = new CPU(new Uint16Array(program.buffer), profile.ramEnd + 1 - 0x100);

    // Narrow per-MCU hardware avr8js has no class for (e.g. the 32U4's USB PLL
    // lock bit, without which the Arduino core never reaches setup()).
    mcu.installExtras?.(this.cpu);
    // The 32U4's own USB port, which is `Serial` on a Leonardo.
    if (profile.mcu === 'atmega32u4') {
      this.usb = new Atmega32u4Usb(this.cpu, F_CPU);
      this.usb.onSerialData = (byte: number) => this.onUsbSerialByte?.(byte);
    }

    this.timers = mcu.timers.map((cfg) => new AVRTimer(this.cpu, cfg));
    this.usart = new AVRUSART(this.cpu, mcu.usart, F_CPU);
    this.adc = new AVRADC(this.cpu, mcu.adc);
    // Without it EEPROM.write() left EEPE set and the next EEPROM access spun
    // on it forever.
    new AVREEPROM(this.cpu, this.eeprom, mcu.eeprom.config);
    // The TWI controller reports what the firmware's Wire calls actually do.
    // Until a device model attaches, avr8js's default handler NACKs everything,
    // which is the honest answer for a bus with nothing on it.
    this.twi = new AVRTWI(this.cpu, mcu.twi, F_CPU);
    // With no device attached the bus NACKs every address, which is the honest
    // answer for a bus with nothing on it (Wire.endTransmission() returns 2).
    this.twi.eventHandler = this.i2cBus.handler(this.twi);

    // Hardware SPI. avr8js hands us the MOSI byte and expects the MISO byte
    // back; the bus decides who (if anyone) is selected. The reply is delivered
    // after the real number of SCK cycles for the configured divider, so a
    // sketch that clocks slowly genuinely takes longer.
    this.spi = new AVRSPI(this.cpu, mcu.spi, F_CPU);
    const cpu = this.cpu;
    const SPCR = mcu.spi.SPCR;
    this.spiCtrl = {
      // avr8js's own spiMode getter reports (CPHA<<1)|CPOL, which swaps modes 1
      // and 2 relative to the datasheet. Read the control bits directly.
      get mode(): SpiMode {
        const v = cpu.data[SPCR];
        return (((v & SPCR_CPOL ? 1 : 0) << 1) | (v & SPCR_CPHA ? 1 : 0)) as SpiMode;
      },
      get bitOrder(): 'msbFirst' | 'lsbFirst' {
        return cpu.data[SPCR] & SPCR_DORD ? 'lsbFirst' : 'msbFirst';
      },
    };
    this.spi.onByte = (mosi: number) => {
      const miso = this.spiBus.transferByte(mosi, this.spiCtrl, (pin) => this.digitalPinLevel(pin));
      this.cpu.addClockEvent(() => this.spi.completeTransfer(miso), this.spi.transferCycles);
    };

    for (const name of profile.ports) {
      const cfg = mcu.ports[name];
      if (!cfg) continue;
      this.ports.set(name, new AVRIOPort(this.cpu, cfg));
      this.portPins.set(name, []);
    }
    for (const [pinStr, ref] of Object.entries(profile.portMap)) {
      this.portPins.get(ref.port)?.push([Number(pinStr), ref.index]);
    }
    // The 32U4's Timer4, which avr8js does not have: PWM on D13 and D6.
    const portC = this.ports.get('C');
    const portD = this.ports.get('D');
    if (profile.mcu === 'atmega32u4' && portC && portD) new Timer4(this.cpu, portC, portD);

    for (let pin = 0; pin < profile.pinCount; pin++) {
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
    (mcu.extraUsarts ?? []).forEach((spec, i) => {
      const usart = new AVRUSART(this.cpu, spec.config, F_CPU);
      const port = (this.extraUarts[i] ??= new AvrUartPort(spec.name, spec.rxPin, spec.txPin));
      port.attach(usart);
    });
    this.usart.onRxComplete = () => this.pumpSerialRx();

    for (const [name, port] of this.ports) {
      port.addListener(() => this.portChanged(name));
    }
  }

  private portChanged(name: AvrPortName): void {
    const port = this.ports.get(name);
    const pins = this.portPins.get(name);
    if (!port || !pins) return;
    for (const [pin, index] of pins) {
      const high = port.pinState(index) === PinState.High;
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
        for (const listener of this.pinListeners) listener(pin, high);
      }
    }
  }

  /**
   * The RESET pin: the firmware starts again from the top, on a chip whose RAM
   * and peripherals are back at their power-on state. Before this existed the
   * workbench's reset button did nothing at all on the AVR boards.
   */
  reset(): void {
    this.build();
    // The pins come back as inputs: tell anything watching an output that it
    // has let go.
    for (const name of this.ports.keys()) this.portChanged(name);
  }

  /**
   * Subscribes to digital pin edges and returns an unsubscribe function.
   * Devices that latch on an edge (a 74HC595's RCLK) cannot poll for it — the
   * pulse is over long before the next UI frame.
   */
  addPinListener(listener: (pin: number, high: boolean) => void): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  pinState(pin: number): PinState | undefined {
    const ref = this.profile.portMap[pin];
    if (!ref) return undefined;
    return this.ports.get(ref.port)?.pinState(ref.index);
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

  /**
   * Drives an input pin from the circuit.
   *
   * `null` means nothing outside the chip is holding the pin, so the pad falls
   * back to its own configuration: an input with the internal pull-up enabled
   * reads high, and a plain input is left as it was, because a floating AVR
   * input genuinely has no defined level.
   */
  setDigitalInput(pin: number, value: boolean | null): void {
    const ref = this.profile.portMap[pin];
    if (!ref) return;
    if (value === null) {
      if (this.pinState(pin) === PinState.InputPullUp) this.ports.get(ref.port)?.setPin(ref.index, true);
      return;
    }
    this.ports.get(ref.port)?.setPin(ref.index, value);
  }

  /** ADC channel for an Arduino pin number on this board's profile. */
  adcChannelForPin(pin: number): number | undefined {
    return this.profile.portMap[pin]?.adcChannel;
  }

  setAnalogVolts(channel: number, volts: number): void {
    if (channel >= 0 && channel < this.adc.channelValues.length) {
      this.adc.channelValues[channel] = Math.max(0, Math.min(5, volts));
    }
  }

  queueSerialInput(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const ch of bytes) this.serialRxQueue.push(ch);
    this.pumpSerialRx();
    // And to the USB port, where there is one: the monitor is what is on the
    // other end of it.
    this.usb?.sendSerial(bytes);
  }

  queueUartInput(text: string): void {
    for (const ch of new TextEncoder().encode(text)) this.serialRxQueue.push(ch);
    this.pumpSerialRx();
  }

  /**
   * The baud the firmware programmed into UBRR.
   *
   * Read from the peripheral rather than remembered, so a sketch that calls
   * Serial.begin twice reports the rate it is actually running at — which is
   * what decides whether a device on the other end of the wire understands it.
   */
  get uartBaudRate(): number {
    return this.usart.baudRate;
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

  /**
   * Executes AVR instructions until the CPU reaches the target cycle count.
   * The instruction budget is a safety net: if firmware ever stops advancing
   * the cycle counter, this throws instead of spinning the thread forever.
   */
  runToCycles(targetCycles: number): void {
    const { cpu } = this;
    let executed = 0;
    while (cpu.cycles < targetCycles) {
      avrInstruction(cpu);
      cpu.tick();
      if (++executed > MAX_INSTRUCTIONS_PER_CALL) {
        throw new Error('Simulation stopped: the firmware executed an excessive number of instructions without advancing time.');
      }
    }
  }

  /**
   * Advances the simulation by a slice of simulated time.
   *
   * The engine-neutral entry point the simulation controller drives, so it
   * never has to know that this architecture measures progress in clock
   * cycles while another measures it in nanoseconds.
   */
  runFor(simMs: number): void {
    this.runToCycles(this.cpu.cycles + Math.round((simMs / 1000) * F_CPU));
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
    for (let pin = 0; pin < this.profile.pinCount; pin++) {
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

/** One of the further USARTs, as a port the circuit can wire a part to. */
class AvrUartPort implements UartPort {
  onTransmit: ((byte: number) => void) | null = null;
  private usart: AVRUSART | null = null;
  private queue: number[] = [];

  constructor(readonly name: string, readonly rxPin: number, readonly txPin: number) {}

  /** Binds the port to the USART of a freshly built chip. */
  attach(usart: AVRUSART): void {
    this.usart = usart;
    this.queue = [];
    usart.onByteTransmit = (value: number) => this.onTransmit?.(value);
    usart.onRxComplete = () => this.pump();
  }

  receive(text: string): void {
    for (const ch of new TextEncoder().encode(text)) this.queue.push(ch);
    this.pump();
  }

  get baudRate(): number {
    return this.usart?.baudRate ?? 9600;
  }

  private pump(): void {
    const usart = this.usart;
    if (!usart) return;
    while (this.queue.length > 0 && !usart.rxBusy) {
      if (!usart.writeByte(this.queue[0])) break;
      this.queue.shift();
    }
  }
}
