// Real SAMD21 execution: Arduino SAMD firmware (Intel HEX from the compiler
// service, linked above the boards' 8 KB bootloader) runs on the chip model in
// ./samd21, instruction by instruction, on rp2040js's Cortex-M0+ core.
//
// The bootloader itself is not run — it is not CircuitDesk's to ship, and all
// it does on a normal reset is what this does: point VTOR at the application,
// load the stack pointer and jump to the reset handler the image publishes.
//
// Pins are the chip's pads, numbered group * 32 + bit, so PA17 is 17 and PB08
// is 40. A board's labels (D13, A1, SDA) reach them through its pad map, as on
// the XIAO RP2040.
//
// This module imports rp2040js, so it must only ever be reached through the
// adapter's dynamic import.

import { Samd21, SAMD21_CPU_HZ, SAMD21_FLASH_BYTES } from './samd21';
import { parseIntelHex, intelHexHighestAddress } from '../intelHex';
import { samdPadIndex, type PinLevel, type PinSnapshot } from '../boardRunner';
import { processorProfile } from '../../boards/processorProfiles';

/** Where the Adafruit and Seeed SAMD21 boards' applications start, above the bootloader. */
export const SAMD21_APP_BASE = 0x2000;
export const SAMD21_PIN_COUNT = 64;
const MAX_INSTRUCTIONS_PER_CALL = 20_000_000;
const NS_PER_CYCLE = 1e9 / SAMD21_CPU_HZ;
const ADC_VREF = 3.3;

/** ADC input (AIN) behind each pad that has one: the processor profile's mux table, by pad index. */
const AIN_BY_PAD: Record<number, number> = Object.fromEntries(
  Object.entries(processorProfile('proc.samd21')?.adcChannels ?? {}).map(([pad, ain]) => [samdPadIndex(pad), ain]),
);

interface DutyTracker {
  lastHigh: boolean;
  lastChangeNs: number;
  highNs: number;
  windowStartNs: number;
  pulseRiseNs: number;
  pulseWidthUs: number;
  toggles: number;
}

export class FirmwareRejectedError extends Error {}

export class Samd21Runner {
  readonly engine = 'samd21' as const;

  private chip!: Samd21;
  private readonly image: Uint8Array;
  private trackers: DutyTracker[] = [];
  private readonly pinListeners = new Set<(pin: number, high: boolean) => void>();
  private readonly external = new Map<number, boolean>();
  private disposed = false;

  /** SERCOM0's USART: Serial1 on the boards here. */
  onSerialByte: ((byte: number) => void) | null = null;
  /** The native USB port: Serial on every SAMD21 board here. */
  onUsbSerialByte: ((byte: number) => void) | null = null;
  onPinChange: ((pin: number, high: boolean) => void) | null = null;

  constructor(hex: string) {
    let highest: number;
    try {
      highest = intelHexHighestAddress(hex);
    } catch (err) {
      throw new FirmwareRejectedError(`Firmware could not be parsed as Intel HEX: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (highest < SAMD21_APP_BASE) {
      throw new FirmwareRejectedError(
        'This image starts below 0x2000, where the SAMD21 boards keep their bootloader. It was not built for one of these boards.',
      );
    }
    if (highest >= SAMD21_FLASH_BYTES) {
      throw new FirmwareRejectedError(`Firmware reaches flash byte 0x${highest.toString(16)}, beyond the SAMD21's 256 KB.`);
    }
    this.image = new Uint8Array(SAMD21_FLASH_BYTES).fill(0xff);
    parseIntelHex(hex, this.image);
    this.build();
  }

  private build(): void {
    const chip = new Samd21();
    chip.flashMemory.set(this.image);
    this.chip = chip;
    this.trackers = Array.from({ length: SAMD21_PIN_COUNT }, () => ({
      lastHigh: false, lastChangeNs: 0, highNs: 0, windowStartNs: 0, pulseRiseNs: 0, pulseWidthUs: 0, toggles: 0,
    }));
    chip.onPinChange = (pin, high) => this.padChanged(pin, high);
    chip.onUartByte = (byte) => this.onSerialByte?.(byte);
    chip.usb.onSerialData = (byte) => this.onUsbSerialByte?.(byte);
    for (const [pin, level] of this.external) chip.setExternal(pin, level);

    // What the bootloader does on a normal reset.
    const core = this.core;
    core.VTOR = SAMD21_APP_BASE;
    core.SP = chip.readUint32(SAMD21_APP_BASE);
    core.PC = chip.readUint32(SAMD21_APP_BASE + 4) & ~1;
  }

  private get core(): { VTOR: number; SP: number; PC: number; waiting: boolean; executeInstruction(): number } {
    return (this.chip as unknown as { core: { VTOR: number; SP: number; PC: number; waiting: boolean; executeInstruction(): number } }).core;
  }

  private get clock(): { nanos: number; tick(ns: number): void; nanosToNextAlarm: number; createAlarm(cb: () => void): { schedule(ns: number): void; cancel(): void } } {
    return (this.chip as unknown as { clock: never }).clock;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('This SAMD21 simulation has been stopped.');
  }

  runFor(simMs: number): void {
    this.assertLive();
    const clock = this.clock;
    const core = this.core;
    const target = clock.nanos + simMs * 1e6;
    let executed = 0;
    while (clock.nanos < target) {
      if (core.waiting) {
        clock.tick(Math.min(clock.nanosToNextAlarm || NS_PER_CYCLE, target - clock.nanos) || NS_PER_CYCLE);
      } else {
        clock.tick((core.executeInstruction() || 1) * NS_PER_CYCLE);
      }
      if (++executed > MAX_INSTRUCTIONS_PER_CALL) {
        throw new Error('Simulation stopped: the firmware executed an excessive number of instructions without advancing time.');
      }
    }
  }

  get timeMs(): number {
    return this.clock.nanos / 1e6;
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

  // ------------------------------------------------------------------ pins

  private padChanged(pin: number, high: boolean): void {
    const tracker = this.trackers[pin];
    if (!tracker || high === tracker.lastHigh) return;
    const now = this.clock.nanos;
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

  addPinListener(listener: (pin: number, high: boolean) => void): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  digitalPinLevel(pin: number): PinLevel | undefined {
    if (pin < 0 || pin >= SAMD21_PIN_COUNT) return undefined;
    const g = pin >> 5;
    const bit = pin & 31;
    const group = this.chip.groups[g];
    if (group.dir & (1 << bit)) return group.out & (1 << bit) ? 'high' : 'low';
    const pulled = (group.pincfg[bit] & 0x04) !== 0 && (group.out & (1 << bit)) !== 0;
    return pulled ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    return this.chip.isOutput(pin);
  }

  setDigitalInput(pin: number, value: boolean | null): void {
    if (pin < 0 || pin >= SAMD21_PIN_COUNT) return;
    if (value === null) this.external.delete(pin);
    else this.external.set(pin, value);
    this.chip.setExternal(pin, value === null ? undefined : value);
  }

  // ------------------------------------------------------------------- ADC

  adcChannelForPin(pin: number): number | undefined {
    return AIN_BY_PAD[pin];
  }

  /** The SAMD21 is a 3.3 V part: nothing above the reference reads higher. */
  setAnalogVolts(channel: number, volts: number): void {
    if (channel < 0 || channel >= this.chip.adcVolts.length) return;
    this.chip.adcVolts[channel] = Math.max(0, Math.min(ADC_VREF, volts));
  }

  // ---------------------------------------------------------------- serial

  queueSerialInput(text: string): void {
    // Typed into the monitor: the USB port is what is on the other end of it.
    this.chip.usb.sendSerial(new TextEncoder().encode(text));
  }

  /** Bytes on Serial1's RX pad. Lost, as on the board, while no USART is listening. */
  queueUartInput(text: string): void {
    for (const byte of new TextEncoder().encode(text)) this.chip.receiveUart(byte);
  }

  get uartBaudRate(): number | undefined {
    return this.chip.uartBaudRate();
  }

  addMicrosecondEvent(us: number, callback: () => void): () => void {
    const alarm = this.clock.createAlarm(callback);
    alarm.schedule(us * 1000);
    return () => alarm.cancel();
  }

  snapshot(): PinSnapshot {
    const states: PinSnapshot['states'] = [];
    const duty: number[] = [];
    const pulseWidthUs: number[] = [];
    const toggles: number[] = [];
    const now = this.clock.nanos;
    for (let pin = 0; pin < SAMD21_PIN_COUNT; pin++) {
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
