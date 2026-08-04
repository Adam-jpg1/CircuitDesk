// Shared SPI bus.
//
// Sits between the MCU's SPI controller (which reports the bytes firmware
// actually clocks out) and the device models attached to the canvas. The bus
// owns the parts of SPI that are the *wiring's* job rather than any one
// device's:
//
//   • chip-select routing — the bus reads the real CS pin level out of the
//     emulator, so a device whose CS is never driven low never sees a byte;
//   • bit order — DORD=1 puts bit 0 on the wire first, so a normal MSB-first
//     target genuinely receives the bit-reversed byte (and its reply comes
//     back reversed too);
//   • clock polarity/phase — a device sampling on the wrong edge does not
//     quietly work, it is reported as a mode mismatch and reads back as an
//     undriven bus;
//   • contention — two devices selected at once are both driving MISO, which
//     on real hardware is indeterminate and is recorded here rather than
//     silently resolved.
//
// Devices therefore only describe their own command set. Nothing in this file
// invents a response: an unselected bus reads back 0xFF, which is what a
// pulled-up MISO line actually looks like.

import type { SpiDevice, SpiMode } from './types';

/** Subset of the MCU's SPI peripheral the bus needs; keeps this engine-neutral. */
export interface SpiController {
  /** Datasheet mode: (CPOL << 1) | CPHA. */
  readonly mode: SpiMode;
  readonly bitOrder: 'msbFirst' | 'lsbFirst';
}

export interface SpiBusEvent {
  mosi: number;
  miso: number;
  /** Instance ids that were selected for this byte. */
  selected: string[];
  mode: SpiMode;
  /** Set when a selected device does not support the current SPI mode. */
  modeMismatch?: boolean;
  /** Set when no device was selected — the byte went nowhere. */
  unselected?: boolean;
}

export interface SpiAttachment {
  device: SpiDevice;
  /**
   * Board pin number the device's CS is wired to, or null for a part with no
   * chip select. A device that needs a CS but has none resolved is not
   * attached at all, so it cannot answer.
   */
  csPin: number | null;
}

/** Reads a board pin level out of the emulator. Undefined = no such pin. */
export type PinLevelReader = (pin: number) => 'high' | 'low' | 'input' | 'input-pullup' | undefined;

const MAX_LOG = 200;
/** Idle level of a pulled-up MISO line — what firmware reads when nothing answers. */
export const SPI_IDLE_BYTE = 0xff;

/** Reverses the bit order of a byte (DORD=1 traffic on an MSB-first target). */
export function reverseBits(value: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) out |= ((value >> i) & 1) << (7 - i);
  return out & 0xff;
}

export class SpiBus {
  private attached: SpiAttachment[] = [];
  private byInstance = new Map<string, SpiDevice>();
  private log: SpiBusEvent[] = [];

  /** Bytes clocked out while no device was selected — surfaced, not hidden. */
  unselectedByteCount = 0;
  /** Bytes a selected device could not accept because the SPI mode was wrong. */
  modeMismatchCount = 0;
  /** Bytes where more than one device drove MISO at the same time. */
  contentionCount = 0;

  /**
   * Attaches exactly the given instances, creating any that are new and
   * dropping any that were unwired. Existing devices keep their state, because
   * re-binding the circuit (a wiring edit) is not a power cycle.
   */
  sync(wanted: { instanceId: string; csPin: number | null; create: () => SpiDevice }[]): SpiDevice[] {
    const keep = new Set(wanted.map((w) => w.instanceId));
    for (const id of [...this.byInstance.keys()]) {
      if (!keep.has(id)) this.byInstance.delete(id);
    }
    this.attached = wanted.map((w) => {
      let device = this.byInstance.get(w.instanceId);
      if (!device) {
        device = w.create();
        this.byInstance.set(w.instanceId, device);
      }
      return { device, csPin: w.csPin };
    });
    return this.attached.map((a) => a.device);
  }

  detachAll(): void {
    this.attached = [];
    this.byInstance.clear();
  }

  deviceFor(instanceId: string): SpiDevice | undefined {
    return this.byInstance.get(instanceId);
  }

  get attachedCount(): number {
    return this.attached.length;
  }

  recentEvents(limit = 20): SpiBusEvent[] {
    return this.log.slice(-limit);
  }

  private record(event: SpiBusEvent): void {
    this.log.push(event);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /**
   * True when this attachment's chip select is actually asserted. CS is active
   * low, so a pin left as an input (never driven by firmware) is floating and
   * does NOT select the device — which is exactly how a forgotten pinMode
   * behaves on a breadboard.
   */
  private isSelected(a: SpiAttachment, readPin: PinLevelReader): boolean {
    if (a.csPin === null) return true; // CS-less parts always shift
    return readPin(a.csPin) === 'low';
  }

  /**
   * Re-applies chip-select state to every device.
   *
   * Selection changes between transactions, not during them: firmware raises CS
   * and clocks nothing until the next command. Without this, a device would
   * never learn it had been deselected and would treat the next transaction's
   * first byte as a continuation of the last one. Call this from a pin-edge
   * subscription on the chip-select lines.
   */
  refreshSelection(readPin: PinLevelReader): void {
    for (const a of this.attached) a.device.select(this.isSelected(a, readPin));
  }

  /** Board pins currently used as chip selects, for edge subscriptions. */
  get chipSelectPins(): number[] {
    return [...new Set(this.attached.map((a) => a.csPin).filter((p): p is number => p !== null))];
  }

  /**
   * Clocks one byte through every selected device and returns the byte the MCU
   * shifts in. Call this from the SPI peripheral's byte callback.
   */
  transferByte(mosi: number, ctrl: SpiController, readPin: PinLevelReader): number {
    const lsbFirst = ctrl.bitOrder === 'lsbFirst';
    // What the wire carries: an MSB-first target sees a reversed byte when the
    // controller is shifting LSB first.
    const onWire = lsbFirst ? reverseBits(mosi) : mosi;

    const selected: string[] = [];
    let driven: number | null = null;
    let drivers = 0;
    let mismatch = false;

    for (const a of this.attached) {
      const active = this.isSelected(a, readPin);
      a.device.select(active);
      if (!active) continue;
      selected.push(a.device.instanceId);
      if (!a.device.supportedModes.includes(ctrl.mode)) {
        // Sampling on the wrong edge does not produce usable data. We report
        // the mismatch rather than guessing what garbage the part would latch.
        mismatch = true;
        continue;
      }
      const out = a.device.transfer(onWire);
      if (out === null) continue; // part does not drive MISO (e.g. 74HC595)
      drivers++;
      driven = driven === null ? out & 0xff : driven & out & 0xff;
    }

    if (selected.length === 0) this.unselectedByteCount++;
    if (mismatch) this.modeMismatchCount++;
    if (drivers > 1) this.contentionCount++;

    const miso = driven === null ? SPI_IDLE_BYTE : driven;
    this.record({
      mosi,
      miso,
      selected,
      mode: ctrl.mode,
      ...(mismatch ? { modeMismatch: true } : {}),
      ...(selected.length === 0 ? { unselected: true } : {}),
    });
    // Reply travels back over the same wire, so it is reversed for the
    // controller in exactly the same way the outgoing byte was.
    return lsbFirst ? reverseBits(miso) : miso;
  }
}
