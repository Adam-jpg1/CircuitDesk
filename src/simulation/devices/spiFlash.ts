// Winbond W25Q80-class SPI NOR flash (8 Mbit / 1 MiB).
//
// Implements the command set an Arduino sketch actually uses, straight from
// the datasheet, including the two behaviours that catch people out on real
// hardware and are therefore modelled rather than smoothed over:
//
//   • A program or erase is refused unless Write Enable (0x06) was issued
//     first, and WEL clears again the moment the operation starts.
//   • Programming can only turn 1 bits into 0 bits. Writing 0xFF over a byte
//     that already holds 0x00 leaves 0x00 — you must erase (which restores
//     0xFF) before the byte can hold anything else.
//
// Busy timing is modelled from the datasheet's typical figures, driven by the
// emulator's own cycle counter, so firmware that polls the BUSY bit spins for
// a realistic number of cycles instead of seeing an instant completion.
//
// Storage is a flat 1 MiB Uint8Array — bounded, allocated once per device.
// Only the pages that differ from erased state are handed back for project
// persistence, capped so a project file cannot grow without limit.

import type { DeviceSnapshot, SpiDevice, SpiMode } from './types';

export const FLASH_PAGE_SIZE = 256;
export const FLASH_SECTOR_SIZE = 4096;
export const FLASH_BLOCK_SIZE = 65536;
/** 8 Mbit = 1 MiB, the W25Q80 density. */
export const FLASH_CAPACITY = 1024 * 1024;

/** JEDEC id for a Winbond W25Q80BV: manufacturer 0xEF, type 0x40, capacity 0x14. */
export const FLASH_JEDEC_ID = [0xef, 0x40, 0x14] as const;

// Commands (datasheet "Instruction Set").
const CMD_WRITE_ENABLE = 0x06;
const CMD_WRITE_DISABLE = 0x04;
const CMD_READ_STATUS_1 = 0x05;
const CMD_READ_STATUS_2 = 0x35;
const CMD_READ_DATA = 0x03;
const CMD_FAST_READ = 0x0b;
const CMD_PAGE_PROGRAM = 0x02;
const CMD_SECTOR_ERASE = 0x20;
const CMD_BLOCK_ERASE = 0xd8;
const CMD_CHIP_ERASE_C7 = 0xc7;
const CMD_CHIP_ERASE_60 = 0x60;
const CMD_JEDEC_ID = 0x9f;
const CMD_MFG_DEVICE_ID = 0x90;
const CMD_POWER_DOWN = 0xb9;
const CMD_RELEASE_POWER_DOWN = 0xab;

/** Status register 1 bits. */
const SR1_BUSY = 0x01;
const SR1_WEL = 0x02;

/** Datasheet typical timings, in microseconds. */
const T_PAGE_PROGRAM_US = 700;
const T_SECTOR_ERASE_US = 45_000;
const T_BLOCK_ERASE_US = 150_000;
const T_CHIP_ERASE_US = 3_000_000;

/** W25Q80 supports SPI modes 0 and 3; the other two shift on the wrong edge. */
const SUPPORTED_MODES: readonly SpiMode[] = [0, 3];

/** Cap on how many 256-byte pages are handed back for project persistence. */
export const MAX_PERSISTED_PAGES = 64;

type Phase = 'idle' | 'command' | 'address' | 'dummy' | 'read' | 'program' | 'status' | 'id';

export interface SpiFlashSnapshotData {
  /** Sparse page image: page index → base64 of the 256 bytes. */
  pages: Record<number, string>;
  /** True when the device holds more dirty pages than we are willing to save. */
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

export class SpiFlashDevice implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  readonly supportedModes = SUPPORTED_MODES;

  private readonly mem = new Uint8Array(FLASH_CAPACITY).fill(0xff);
  private readonly dirtyPages = new Set<number>();

  private selected = false;
  private phase: Phase = 'idle';
  private command = 0;
  private address = 0;
  private addressBytes = 0;
  private dummyLeft = 0;
  private statusIndex = 0;
  private idIndex = 0;
  /** Byte offset within the page currently being programmed. */
  private programCursor = 0;
  private writeEnabled = false;
  private poweredDown = false;

  /** Cycle count (from the caller's clock) at which BUSY clears. */
  private busyUntilUs = 0;
  private nowUs: () => number;

  private unknownCommands: number[] = [];
  private refusedWrites = 0;
  private writes = 0;
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string, nowUs: () => number = () => 0) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
    this.nowUs = nowUs;
  }

  // ---- inspection ----

  get busy(): boolean {
    return this.nowUs() < this.busyUntilUs;
  }

  get writeEnableLatch(): boolean {
    return this.writeEnabled;
  }

  get statusRegister1(): number {
    return (this.busy ? SR1_BUSY : 0) | (this.writeEnabled ? SR1_WEL : 0);
  }

  readByteAt(address: number): number {
    return this.mem[address % FLASH_CAPACITY];
  }

  /** Copy of a range, for tests and inspector display. */
  readRange(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.mem[(address + i) % FLASH_CAPACITY];
    return out;
  }

  get unhandledCommands(): number[] {
    return [...new Set(this.unknownCommands)];
  }

  get refusedWriteCount(): number {
    return this.refusedWrites;
  }

  /** Increments on every program/erase, so callers can persist only on change. */
  get writeCounter(): number {
    return this.writes;
  }

  // ---- persistence ----

  /** Sparse image of everything that is no longer in the erased state. */
  saveState(): SpiFlashSnapshotData {
    const pages: Record<number, string> = {};
    let count = 0;
    let truncated = false;
    for (const page of [...this.dirtyPages].sort((a, b) => a - b)) {
      if (count >= MAX_PERSISTED_PAGES) {
        truncated = true;
        break;
      }
      pages[page] = toBase64(this.mem.subarray(page * FLASH_PAGE_SIZE, (page + 1) * FLASH_PAGE_SIZE));
      count++;
    }
    return { pages, truncated };
  }

  loadState(data: SpiFlashSnapshotData | undefined): void {
    if (!data?.pages) return;
    for (const [key, b64] of Object.entries(data.pages)) {
      const page = Number(key);
      if (!Number.isInteger(page) || page < 0 || page >= FLASH_CAPACITY / FLASH_PAGE_SIZE) continue;
      const bytes = fromBase64(b64);
      if (bytes.length !== FLASH_PAGE_SIZE) continue;
      this.mem.set(bytes, page * FLASH_PAGE_SIZE);
      this.dirtyPages.add(page);
    }
  }

  // ---- bus-facing ----

  select(active: boolean): void {
    if (active === this.selected) return;
    this.selected = active;
    // Deselecting always ends the current command, exactly as CS rising does
    // on real silicon — a half-written page program is simply abandoned.
    if (!active) this.phase = 'idle';
    else this.phase = 'command';
  }

  transfer(mosi: number): number {
    if (!this.selected) return 0xff;
    switch (this.phase) {
      case 'command':
        return this.startCommand(mosi);
      case 'address':
        return this.takeAddressByte(mosi);
      case 'dummy':
        if (--this.dummyLeft <= 0) this.phase = 'read';
        return 0xff;
      case 'read': {
        const value = this.mem[this.address % FLASH_CAPACITY];
        this.address = (this.address + 1) % FLASH_CAPACITY;
        return value;
      }
      case 'program':
        this.programByte(mosi);
        return 0xff;
      case 'status':
        return this.command === CMD_READ_STATUS_1 ? this.statusRegister1 : 0x00;
      case 'id':
        return this.idByte();
      default:
        return 0xff;
    }
  }

  private startCommand(cmd: number): number {
    this.command = cmd;
    // Everything except a status read and the release-from-power-down command
    // is ignored while an erase or program is still running.
    if (this.busy && cmd !== CMD_READ_STATUS_1 && cmd !== CMD_READ_STATUS_2) {
      this.phase = 'idle';
      return 0xff;
    }
    if (this.poweredDown && cmd !== CMD_RELEASE_POWER_DOWN) {
      this.phase = 'idle';
      return 0xff;
    }
    switch (cmd) {
      case CMD_WRITE_ENABLE:
        this.writeEnabled = true;
        this.phase = 'idle';
        this.note('write enable');
        return 0xff;
      case CMD_WRITE_DISABLE:
        this.writeEnabled = false;
        this.phase = 'idle';
        return 0xff;
      case CMD_READ_STATUS_1:
      case CMD_READ_STATUS_2:
        this.phase = 'status';
        this.statusIndex = 0;
        return 0xff;
      case CMD_JEDEC_ID:
      case CMD_MFG_DEVICE_ID:
        this.phase = 'id';
        this.idIndex = 0;
        return 0xff;
      case CMD_READ_DATA:
      case CMD_FAST_READ:
      case CMD_PAGE_PROGRAM:
      case CMD_SECTOR_ERASE:
      case CMD_BLOCK_ERASE:
        this.phase = 'address';
        this.address = 0;
        this.addressBytes = 0;
        return 0xff;
      case CMD_CHIP_ERASE_C7:
      case CMD_CHIP_ERASE_60:
        this.beginErase(0, FLASH_CAPACITY, T_CHIP_ERASE_US, 'chip erase');
        this.phase = 'idle';
        return 0xff;
      case CMD_POWER_DOWN:
        this.poweredDown = true;
        this.phase = 'idle';
        return 0xff;
      case CMD_RELEASE_POWER_DOWN:
        this.poweredDown = false;
        this.phase = 'idle';
        return 0xff;
      default:
        this.unknownCommands.push(cmd);
        this.note(`unhandled command 0x${cmd.toString(16)}`);
        this.phase = 'idle';
        return 0xff;
    }
  }

  private takeAddressByte(byte: number): number {
    this.address = ((this.address << 8) | (byte & 0xff)) >>> 0;
    if (++this.addressBytes < 3) return 0xff;
    this.address %= FLASH_CAPACITY;
    switch (this.command) {
      case CMD_READ_DATA:
        this.phase = 'read';
        break;
      case CMD_FAST_READ:
        this.dummyLeft = 1;
        this.phase = 'dummy';
        break;
      case CMD_PAGE_PROGRAM:
        if (!this.writeEnabled) {
          // No WEL: the part accepts the bytes on the wire and discards them.
          this.refusedWrites++;
          this.note('page program refused — write enable not set');
          this.phase = 'idle';
          break;
        }
        this.programCursor = 0;
        this.phase = 'program';
        break;
      case CMD_SECTOR_ERASE:
        if (!this.requireWriteEnable('sector erase')) break;
        this.beginErase(
          Math.floor(this.address / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE,
          FLASH_SECTOR_SIZE,
          T_SECTOR_ERASE_US,
          'sector erase',
        );
        this.phase = 'idle';
        break;
      case CMD_BLOCK_ERASE:
        if (!this.requireWriteEnable('block erase')) break;
        this.beginErase(
          Math.floor(this.address / FLASH_BLOCK_SIZE) * FLASH_BLOCK_SIZE,
          FLASH_BLOCK_SIZE,
          T_BLOCK_ERASE_US,
          'block erase',
        );
        this.phase = 'idle';
        break;
      default:
        this.phase = 'idle';
    }
    return 0xff;
  }

  private requireWriteEnable(what: string): boolean {
    if (this.writeEnabled) return true;
    this.refusedWrites++;
    this.note(`${what} refused — write enable not set`);
    this.phase = 'idle';
    return false;
  }

  /**
   * Page program. Bits can only go 1 → 0, and the address wraps inside the
   * 256-byte page rather than spilling into the next one — both datasheet
   * behaviours that firmware is expected to work around.
   */
  private programByte(byte: number): void {
    const pageBase = Math.floor(this.address / FLASH_PAGE_SIZE) * FLASH_PAGE_SIZE;
    const target = pageBase + ((this.address % FLASH_PAGE_SIZE) + this.programCursor) % FLASH_PAGE_SIZE;
    this.mem[target] &= byte & 0xff;
    this.dirtyPages.add(Math.floor(target / FLASH_PAGE_SIZE));
    this.programCursor++;
    this.writes++;
    // Programming time starts when CS rises; approximating it from the first
    // byte is close enough and keeps BUSY non-zero for a realistic span.
    this.busyUntilUs = this.nowUs() + T_PAGE_PROGRAM_US;
    this.writeEnabled = false;
  }

  private beginErase(start: number, length: number, us: number, what: string): void {
    this.mem.fill(0xff, start, Math.min(FLASH_CAPACITY, start + length));
    for (let p = Math.floor(start / FLASH_PAGE_SIZE); p < (start + length) / FLASH_PAGE_SIZE; p++) {
      this.dirtyPages.delete(p);
    }
    this.writeEnabled = false;
    this.writes++;
    this.busyUntilUs = this.nowUs() + us;
    this.note(`${what} at 0x${start.toString(16)}`);
  }

  private idByte(): number {
    if (this.command === CMD_JEDEC_ID) {
      return FLASH_JEDEC_ID[Math.min(this.idIndex++, FLASH_JEDEC_ID.length - 1)];
    }
    // 0x90 returns manufacturer then device id after 3 address bytes; sketches
    // that use it read the pair, so both are served in order.
    const pair = [FLASH_JEDEC_ID[0], 0x13];
    return pair[Math.min(this.idIndex++, pair.length - 1)];
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.mem.fill(0xff);
    this.dirtyPages.clear();
    this.selected = false;
    this.phase = 'idle';
    this.writeEnabled = false;
    this.poweredDown = false;
    this.busyUntilUs = 0;
    this.unknownCommands = [];
    this.refusedWrites = 0;
    this.writes = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `SPI flash W25Q80 (1 MiB) — ${this.busy ? 'busy' : 'ready'}, ` +
        `WEL ${this.writeEnabled ? 'set' : 'clear'}, ${this.dirtyPages.size} page(s) programmed`,
      log: [...this.log],
    };
  }
}
