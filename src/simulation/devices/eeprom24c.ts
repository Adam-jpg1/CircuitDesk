// AT24C256-class I2C serial EEPROM (32 KiB, 64-byte pages).
//
// The behaviour worth having here is the write cycle. After a write the part
// goes internally busy for ~5 ms and NACKs its own address until it finishes —
// which is why every EEPROM library polls by repeatedly addressing the device
// ("ACK polling"). Firmware that writes and immediately reads back genuinely
// fails here, exactly as it does on a breadboard.
//
// The other real constraint modelled is page wrap: a page write that runs past
// a 64-byte boundary wraps to the start of the same page instead of spilling
// into the next one, so a careless 100-byte write corrupts its own beginning.
//
// Addressing is two bytes (big-endian), as on every 24C32 and larger part.

import type { DeviceSnapshot, I2cDevice } from './types';

/** A0-A2 strapping gives 0x50..0x57. */
export const EEPROM_ADDRESSES = [0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57] as const;

export const EEPROM_CAPACITY = 32 * 1024;
export const EEPROM_PAGE_SIZE = 64;
/** Datasheet maximum self-timed write cycle. */
export const EEPROM_WRITE_CYCLE_US = 5000;
/** Cap on pages handed back for project persistence, keeping project files small. */
export const EEPROM_MAX_PERSISTED_PAGES = 64;

export interface Eeprom24cSnapshotData {
  pages: Record<number, string>;
  truncated: boolean;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
}

function fromBase64(text: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}

export class Eeprom24cDevice implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;

  /** Erased EEPROM reads as 0xFF. */
  private readonly mem = new Uint8Array(EEPROM_CAPACITY).fill(0xff);
  private readonly dirtyPages = new Set<number>();

  private pointer = 0;
  private addressBytes = 0;
  private pendingAddress = 0;
  private reading = false;
  /** Bytes buffered for the current page write, applied on STOP. */
  private pageBuffer: number[] = [];
  private pageStart = 0;

  private busyUntilUs = 0;
  private nowUs: () => number;
  private nacksWhileBusy = 0;
  private writes = 0;
  private log: string[] = [];

  constructor(instanceId: string, address: number = EEPROM_ADDRESSES[0], nowUs: () => number = () => 0) {
    this.instanceId = instanceId;
    this.address = address;
    this.nowUs = nowUs;
  }

  /** True while the internal write cycle is still running. */
  get busy(): boolean {
    return this.nowUs() < this.busyUntilUs;
  }

  get nackCount(): number {
    return this.nacksWhileBusy;
  }

  get writeCounter(): number {
    return this.writes;
  }

  readByteAt(address: number): number {
    return this.mem[address % EEPROM_CAPACITY];
  }

  readRange(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.mem[(address + i) % EEPROM_CAPACITY];
    return out;
  }

  /**
   * A busy part does not answer its own address at all. This is what makes ACK
   * polling work, and what makes a read-immediately-after-write fail.
   */
  matchesAddress(address: number): boolean {
    if (address !== this.address) return false;
    if (this.busy) {
      this.nacksWhileBusy++;
      return false;
    }
    return true;
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    if (write) {
      // A write transaction always restates the word address first.
      this.addressBytes = 0;
      this.pendingAddress = 0;
      this.pageBuffer = [];
    }
  }

  stop(): void {
    if (this.pageBuffer.length > 0) this.commitPage();
    this.addressBytes = 0;
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    if (this.addressBytes < 2) {
      this.pendingAddress = ((this.pendingAddress << 8) | (value & 0xff)) & 0xffff;
      if (++this.addressBytes === 2) {
        this.pointer = this.pendingAddress % EEPROM_CAPACITY;
        this.pageStart = Math.floor(this.pointer / EEPROM_PAGE_SIZE) * EEPROM_PAGE_SIZE;
      }
      return true;
    }
    this.pageBuffer.push(value & 0xff);
    return true;
  }

  readByte(): number {
    const value = this.mem[this.pointer % EEPROM_CAPACITY];
    this.pointer = (this.pointer + 1) % EEPROM_CAPACITY;
    return value;
  }

  /**
   * The buffered page is written in one shot on STOP, wrapping inside its own
   * 64-byte page — a datasheet behaviour that silently corrupts oversized
   * writes on real parts.
   */
  private commitPage(): void {
    const offsetInPage = this.pointer - this.pageStart;
    this.pageBuffer.forEach((byte, i) => {
      const target = this.pageStart + ((offsetInPage + i) % EEPROM_PAGE_SIZE);
      this.mem[target] = byte;
      this.dirtyPages.add(Math.floor(target / EEPROM_PAGE_SIZE));
    });
    this.pointer = (this.pointer + this.pageBuffer.length) % EEPROM_CAPACITY;
    this.note(`page write of ${this.pageBuffer.length} byte(s) at 0x${this.pageStart.toString(16)}`);
    this.pageBuffer = [];
    this.writes++;
    this.busyUntilUs = this.nowUs() + EEPROM_WRITE_CYCLE_US;
  }

  saveState(): Eeprom24cSnapshotData {
    const pages: Record<number, string> = {};
    let count = 0;
    let truncated = false;
    for (const page of [...this.dirtyPages].sort((a, b) => a - b)) {
      if (count >= EEPROM_MAX_PERSISTED_PAGES) {
        truncated = true;
        break;
      }
      pages[page] = toBase64(this.mem.subarray(page * EEPROM_PAGE_SIZE, (page + 1) * EEPROM_PAGE_SIZE));
      count++;
    }
    return { pages, truncated };
  }

  loadState(data: Eeprom24cSnapshotData | undefined): void {
    if (!data?.pages) return;
    for (const [key, b64] of Object.entries(data.pages)) {
      const page = Number(key);
      if (!Number.isInteger(page) || page < 0 || page >= EEPROM_CAPACITY / EEPROM_PAGE_SIZE) continue;
      const bytes = fromBase64(b64);
      if (bytes.length !== EEPROM_PAGE_SIZE) continue;
      this.mem.set(bytes, page * EEPROM_PAGE_SIZE);
      this.dirtyPages.add(page);
    }
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.mem.fill(0xff);
    this.dirtyPages.clear();
    this.pointer = 0;
    this.addressBytes = 0;
    this.pageBuffer = [];
    this.busyUntilUs = 0;
    this.nacksWhileBusy = 0;
    this.writes = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `24C256 EEPROM @0x${this.address.toString(16)} (32 KiB): ` +
        `${this.busy ? 'write cycle in progress' : 'ready'}, ${this.dirtyPages.size} page(s) written`,
      log: [...this.log],
    };
  }
}
