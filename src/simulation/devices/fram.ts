// FM24CL64 — I2C FRAM, which is an EEPROM without the wait.
//
// The pin compatibility with a 24C-series EEPROM is the trap. It answers the
// same addresses, takes the same two-byte address, and reads back the same way —
// so a sketch written for one runs against the other and nothing complains. The
// difference is entirely in the writes:
//
//   • an EEPROM writes a page at a time and is BUSY for milliseconds
//     afterwards, NACKing everything until it finishes;
//   • FRAM writes a byte at bus speed, has no page boundary, and is never busy.
//
// That is why FRAM exists, and it is the one thing a model has to get right.
// Reproducing an EEPROM's write delay here would erase the reason to choose the
// part; leaving the delay out of the EEPROM would erase the reason to be
// careful with it. The two models therefore differ exactly where the silicon
// does — and this file's test asserts the difference rather than each part in
// isolation.
//
// Contents survive a board reset, because a board reset is not a power cycle for
// a device on the bus, and they would survive one of those too.
//
// NOT modelled: the write-protect pin, endurance (FRAM's is effectively
// unlimited at these scales anyway), and the device-ID sequence.

import type { DeviceSnapshot, I2cDevice } from './types';

/** The eight addresses the three strap pins select. */
export const FRAM_ADDRESSES = [0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57] as const;

export interface FramSnapshotData {
  bytes: number[];
}

export class FramDevice implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;
  readonly sizeBytes: number;

  private memory: Uint8Array;
  private pointer = 0;
  private addressBytes: number[] = [];
  private reading = false;

  private writes = 0;
  private reads = 0;
  private log: string[] = [];

  constructor(instanceId: string, address: number = FRAM_ADDRESSES[0], sizeBytes = 8192) {
    this.instanceId = instanceId;
    this.address = address;
    this.sizeBytes = sizeBytes;
    this.memory = new Uint8Array(sizeBytes);
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    if (write) this.addressBytes = [];
  }

  stop(): void {
    this.addressBytes = [];
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    if (this.addressBytes.length < 2) {
      this.addressBytes.push(value & 0xff);
      if (this.addressBytes.length === 2) {
        this.pointer = ((this.addressBytes[0] << 8) | this.addressBytes[1]) % this.sizeBytes;
      }
      return true;
    }
    // No page boundary and no wait. An EEPROM would wrap within its page here
    // and then go busy; this simply stores the byte and moves on, which is the
    // entire reason the part exists.
    this.memory[this.pointer] = value & 0xff;
    this.pointer = (this.pointer + 1) % this.sizeBytes;
    this.writes++;
    return true;
  }

  readByte(): number {
    const value = this.memory[this.pointer];
    this.pointer = (this.pointer + 1) % this.sizeBytes;
    this.reads++;
    return value;
  }

  /** FRAM is never busy, so it never NACKs a write for timing reasons. */
  get isBusy(): boolean {
    return false;
  }

  // ---- persistence ----

  /**
   * Contents for the project file.
   *
   * Only the non-zero span is stored, so a mostly-empty 8 KB part does not add
   * 8 KB to every save.
   */
  saveState(): FramSnapshotData {
    let end = this.memory.length;
    while (end > 0 && this.memory[end - 1] === 0) end--;
    return { bytes: Array.from(this.memory.slice(0, end)) };
  }

  loadState(data: FramSnapshotData | undefined): void {
    if (!data || !Array.isArray(data.bytes)) return;
    this.memory.fill(0);
    this.memory.set(data.bytes.slice(0, this.sizeBytes));
  }

  // ---- inspection ----

  byteAt(index: number): number {
    return this.memory[index % this.sizeBytes];
  }
  get writeCount(): number {
    return this.writes;
  }
  get readCount(): number {
    return this.reads;
  }
  get usedBytes(): number {
    let n = 0;
    for (let i = 0; i < this.memory.length; i++) if (this.memory[i] !== 0) n++;
    return n;
  }

  reset(): void {
    // Deliberately does NOT clear memory: a reset is not a power cycle, and even
    // a power cycle would leave a nonvolatile part's contents alone.
    this.pointer = 0;
    this.addressBytes = [];
    this.reading = false;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `FRAM @0x${this.address.toString(16)} — ${this.sizeBytes} bytes, ` +
        `${this.usedBytes} non-zero, ${this.writes} write(s), ${this.reads} read(s)`,
      log: [...this.log],
    };
  }
}
