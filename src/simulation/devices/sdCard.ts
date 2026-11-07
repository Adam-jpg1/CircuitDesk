// SD card in SPI mode — a 4 MiB standard-capacity (SDSC) card.
//
// What this models, from the SD Physical Layer Simplified Specification:
//
//   • the 6-byte command frame (0x40|CMD, 32-bit argument, CRC) and the R1/R3/R7
//     response shapes, including the leading 0xFF bytes a real card sends while
//     it thinks about the answer;
//   • the initialisation handshake sketches actually perform — CMD0 → CMD8 →
//     CMD58 → CMD55/ACMD41 until the idle bit clears → CMD16 — with ACMD41
//     reporting "still initialising" for several polls, as real cards do;
//   • single and multiple block reads (CMD17/CMD18) with the 0xFE data token,
//     block writes (CMD24) with the 0x05 data-accepted response and a busy
//     period, plus CMD9/CMD10 for CSD/CID and CMD12 to stop a multiple read.
//
// What this deliberately does NOT do:
//
//   • FAT is not implemented here. The card is a block device that happens to
//     be preformatted with a valid FAT16 volume; the file system is the host
//     library's job, exactly as on real hardware.
//   • CRC7/CRC16 are accepted but never verified. Cards run with CRC checking
//     off in SPI mode, so no sketch depends on rejection.
//   • Multiple block WRITE (CMD25), erase (CMD32/33/38) and the SDHC/SDXC block
//     addressing mode are not implemented and are answered with the illegal
//     command bit rather than pretended.
//
// Storage is sparse: only blocks the firmware actually wrote are kept, capped
// so a runaway sketch cannot exhaust memory.

import type { DeviceSnapshot, SpiDevice, SpiMode } from './types';

export const SD_BLOCK_SIZE = 512;
/** 4 MiB logical capacity — small, but a real standard-capacity geometry. */
export const SD_TOTAL_BLOCKS = 8192;
/** Ceiling on stored (written) blocks: 2048 × 512 B = 1 MiB of real memory. */
export const SD_MAX_STORED_BLOCKS = 2048;
/** Blocks handed back for project persistence; keeps project files small. */
export const SD_MAX_PERSISTED_BLOCKS = 64;

// Commands we implement.
const CMD0_GO_IDLE = 0;
const CMD8_SEND_IF_COND = 8;
const CMD9_SEND_CSD = 9;
const CMD10_SEND_CID = 10;
const CMD12_STOP_TRANSMISSION = 12;
const CMD16_SET_BLOCKLEN = 16;
const CMD17_READ_SINGLE = 17;
const CMD18_READ_MULTIPLE = 18;
const CMD24_WRITE_BLOCK = 24;
const CMD55_APP_CMD = 55;
const CMD58_READ_OCR = 58;
const ACMD41_SEND_OP_COND = 41;

/** R1 flags. */
const R1_IDLE = 0x01;
const R1_ILLEGAL_COMMAND = 0x04;
const R1_READY = 0x00;

const DATA_TOKEN = 0xfe;
const DATA_ACCEPTED = 0x05;
/** Card returns this instead of a data token when the read address is bad. */
const DATA_ERROR_TOKEN = 0x09;

/** How many ACMD41 polls report "still busy" before the card reports ready. */
const ACMD41_BUSY_POLLS = 3;
/** Busy bytes a real card holds the line low for after a block write. */
const WRITE_BUSY_BYTES = 8;

/** SD cards in SPI mode use mode 0; mode 3 is electrically compatible. */
const SUPPORTED_MODES: readonly SpiMode[] = [0, 3];

type Phase =
  | 'command'
  | 'response'
  | 'read-block'
  | 'await-write-token'
  | 'write-block'
  | 'write-busy'
  | 'idle';

export interface SdCardSnapshotData {
  /** Sparse block image: block index → base64 of the 512 bytes. */
  blocks: Record<number, string>;
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

// ---------------------------------------------------------------- FAT16 image
//
// A 4 MiB volume with 512-byte sectors: 1 reserved sector, two 32-sector FATs,
// a 512-entry root directory (32 sectors) and single-sector clusters. That
// gives 8095 clusters, comfortably inside FAT16's 4085..65524 range, so a host
// library mounts it as FAT16 rather than guessing FAT12.

export const FAT_RESERVED_SECTORS = 1;
export const FAT_NUM_FATS = 2;
export const FAT_SECTORS_PER_FAT = 32;
export const FAT_ROOT_ENTRIES = 512;
export const FAT_ROOT_SECTORS = (FAT_ROOT_ENTRIES * 32) / SD_BLOCK_SIZE;
const FAT1_START = FAT_RESERVED_SECTORS;
const FAT2_START = FAT1_START + FAT_SECTORS_PER_FAT;

function bootSector(): Uint8Array {
  const b = new Uint8Array(SD_BLOCK_SIZE);
  const put16 = (off: number, v: number) => {
    b[off] = v & 0xff;
    b[off + 1] = (v >> 8) & 0xff;
  };
  const put32 = (off: number, v: number) => {
    put16(off, v & 0xffff);
    put16(off + 2, (v >>> 16) & 0xffff);
  };
  const putStr = (off: number, s: string, len: number) => {
    for (let i = 0; i < len; i++) b[off + i] = i < s.length ? s.charCodeAt(i) : 0x20;
  };

  b[0] = 0xeb;
  b[1] = 0x3c;
  b[2] = 0x90; // JMP short + NOP
  putStr(3, 'MSDOS5.0', 8); // OEM name
  put16(11, SD_BLOCK_SIZE); // bytes per sector
  b[13] = 1; // sectors per cluster
  put16(14, FAT_RESERVED_SECTORS);
  b[16] = FAT_NUM_FATS;
  put16(17, FAT_ROOT_ENTRIES);
  put16(19, SD_TOTAL_BLOCKS); // total sectors (fits in 16 bits)
  b[21] = 0xf8; // media descriptor: fixed disk
  put16(22, FAT_SECTORS_PER_FAT);
  put16(24, 32); // sectors per track
  put16(26, 2); // heads
  put32(28, 0); // hidden sectors
  put32(32, 0); // total sectors 32 (unused, count fits above)
  b[36] = 0x80; // drive number
  b[38] = 0x29; // extended boot signature
  put32(39, 0x43444b31); // volume id
  putStr(43, 'CIRCUITDESK', 11);
  putStr(54, 'FAT16', 8);
  b[510] = 0x55;
  b[511] = 0xaa;
  return b;
}

function fatSector(indexWithinFat: number): Uint8Array {
  const b = new Uint8Array(SD_BLOCK_SIZE);
  if (indexWithinFat === 0) {
    // Entry 0 = media descriptor, entry 1 = end-of-chain. Everything else free.
    b[0] = 0xf8;
    b[1] = 0xff;
    b[2] = 0xff;
    b[3] = 0xff;
  }
  return b;
}

/** The pristine content of a block that firmware has never written. */
export function formattedBlock(index: number): Uint8Array {
  if (index === 0) return bootSector();
  if (index >= FAT1_START && index < FAT1_START + FAT_SECTORS_PER_FAT) return fatSector(index - FAT1_START);
  if (index >= FAT2_START && index < FAT2_START + FAT_SECTORS_PER_FAT) return fatSector(index - FAT2_START);
  // Root directory and data area start empty.
  return new Uint8Array(SD_BLOCK_SIZE);
}

// ------------------------------------------------------------------- the card

export class SdCardDevice implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  readonly supportedModes = SUPPORTED_MODES;

  private blocks = new Map<number, Uint8Array>();
  private selected = false;
  private phase: Phase = 'command';

  private frame: number[] = [];
  private response: number[] = [];
  private dataBuf = new Uint8Array(SD_BLOCK_SIZE);
  private dataIndex = 0;
  private busyLeft = 0;

  private idle = true;
  private initialised = false;
  private acmdPending = false;
  private acmdPolls = 0;
  private sawCmd0 = false;
  private multipleReadBlock = -1;
  private writeTarget = -1;
  private pendingWrite = false;

  private illegalCommands: number[] = [];
  private storageFull = false;
  private writes = 0;
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
  }

  // ---- inspection ----

  get isInitialised(): boolean {
    return this.initialised;
  }

  get storedBlockCount(): number {
    return this.blocks.size;
  }

  get unhandledCommands(): number[] {
    return [...new Set(this.illegalCommands)];
  }

  get storageExhausted(): boolean {
    return this.storageFull;
  }

  /** Increments on every accepted block write, so persistence runs only on change. */
  get writeCounter(): number {
    return this.writes;
  }

  /** Block content as the card would return it (written data or fresh format). */
  readBlock(index: number): Uint8Array {
    const stored = this.blocks.get(index);
    return stored ? stored.slice() : formattedBlock(index);
  }

  // ---- persistence ----

  saveState(): SdCardSnapshotData {
    const out: Record<number, string> = {};
    let count = 0;
    let truncated = false;
    for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
      if (count >= SD_MAX_PERSISTED_BLOCKS) {
        truncated = true;
        break;
      }
      out[index] = toBase64(this.blocks.get(index)!);
      count++;
    }
    return { blocks: out, truncated };
  }

  loadState(data: SdCardSnapshotData | undefined): void {
    if (!data?.blocks) return;
    for (const [key, b64] of Object.entries(data.blocks)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= SD_TOTAL_BLOCKS) continue;
      const bytes = fromBase64(b64);
      if (bytes.length !== SD_BLOCK_SIZE) continue;
      if (this.blocks.size >= SD_MAX_STORED_BLOCKS) break;
      this.blocks.set(index, bytes);
    }
  }

  // ---- bus-facing ----

  select(active: boolean): void {
    if (active === this.selected) return;
    this.selected = active;
    if (!active) {
      // CS rising aborts whatever was in flight, as on real silicon.
      this.phase = 'command';
      this.frame = [];
      this.response = [];
    }
  }

  transfer(mosi: number): number {
    if (!this.selected) return 0xff;
    switch (this.phase) {
      case 'write-busy':
        if (--this.busyLeft > 0) return 0x00; // card holds the line low
        this.phase = 'command';
        return 0xff;
      case 'await-write-token':
        return this.awaitWriteToken(mosi);
      case 'write-block':
        return this.takeWriteByte(mosi);
      case 'response':
      case 'read-block': {
        const byte = this.response.length > 0 ? this.response.shift()! : 0xff;
        if (this.response.length === 0) this.afterResponseDrained();
        return byte;
      }
      default:
        return this.takeCommandByte(mosi);
    }
  }

  /**
   * Command frames start with a byte whose top two bits are 01. Anything else
   * is the host clocking 0xFF to give the card time, which is not data.
   */
  private takeCommandByte(byte: number): number {
    if (this.frame.length === 0 && (byte & 0xc0) !== 0x40) return 0xff;
    this.frame.push(byte & 0xff);
    if (this.frame.length < 6) return 0xff;
    const cmd = this.frame[0] & 0x3f;
    const arg = ((this.frame[1] << 24) | (this.frame[2] << 16) | (this.frame[3] << 8) | this.frame[4]) >>> 0;
    this.frame = [];
    this.execute(cmd, arg);
    return 0xff;
  }

  private respond(bytes: number[]): void {
    // Real cards send at least one 0xFF while they decode the command; sketches
    // poll for the first byte with bit 7 clear, so this is load-bearing.
    this.response = [0xff, ...bytes];
    this.phase = 'response';
  }

  private afterResponseDrained(): void {
    if (this.phase === 'read-block' && this.multipleReadBlock >= 0) {
      // CMD18 keeps streaming until CMD12 arrives.
      this.multipleReadBlock++;
      this.queueDataBlock(this.multipleReadBlock);
      return;
    }
    this.phase = this.pendingWrite ? 'await-write-token' : 'command';
    this.pendingWrite = false;
  }

  private execute(cmd: number, arg: number): void {
    const acmd = this.acmdPending;
    this.acmdPending = false;

    if (acmd && cmd === ACMD41_SEND_OP_COND) {
      // Report "still initialising" a few times, then come ready.
      if (this.acmdPolls++ < ACMD41_BUSY_POLLS) {
        this.respond([R1_IDLE]);
      } else {
        this.idle = false;
        this.initialised = true;
        this.note('initialised (ACMD41 complete)');
        this.respond([R1_READY]);
      }
      return;
    }

    switch (cmd) {
      case CMD0_GO_IDLE:
        this.idle = true;
        this.initialised = false;
        this.acmdPolls = 0;
        this.sawCmd0 = true;
        this.note('CMD0: entered SPI idle state');
        this.respond([R1_IDLE]);
        return;

      case CMD8_SEND_IF_COND: {
        if (!this.sawCmd0) {
          this.respond([R1_ILLEGAL_COMMAND]);
          return;
        }
        // R7: R1 then the echoed voltage range and check pattern.
        const pattern = arg & 0xff;
        this.respond([R1_IDLE, 0x00, 0x00, 0x01, pattern]);
        return;
      }

      case CMD55_APP_CMD:
        this.acmdPending = true;
        this.respond([this.idle ? R1_IDLE : R1_READY]);
        return;

      case CMD58_READ_OCR:
        // 3.2-3.4 V supported, CCS = 0 (standard capacity, byte addressing).
        this.respond([this.idle ? R1_IDLE : R1_READY, 0x00, 0xff, 0x80, 0x00]);
        return;

      case CMD16_SET_BLOCKLEN:
        // Only the 512-byte block length every SD library uses is accepted.
        this.respond([arg === SD_BLOCK_SIZE ? R1_READY : 0x40]);
        return;

      case CMD9_SEND_CSD:
        this.respond([R1_READY]);
        this.queueDataPayload(this.csd());
        return;

      case CMD10_SEND_CID:
        this.respond([R1_READY]);
        this.queueDataPayload(this.cid());
        return;

      case CMD17_READ_SINGLE: {
        if (!this.requireReady()) return;
        const block = Math.floor(arg / SD_BLOCK_SIZE); // SDSC: byte address
        if (block >= SD_TOTAL_BLOCKS) {
          this.respond([R1_READY]);
          this.response.push(DATA_ERROR_TOKEN);
          this.note(`read past end of card (block ${block})`);
          return;
        }
        this.respond([R1_READY]);
        this.queueDataPayload(this.readBlock(block));
        return;
      }

      case CMD18_READ_MULTIPLE: {
        if (!this.requireReady()) return;
        this.multipleReadBlock = Math.floor(arg / SD_BLOCK_SIZE);
        this.respond([R1_READY]);
        this.queueDataPayload(this.readBlock(this.multipleReadBlock));
        this.phase = 'read-block';
        return;
      }

      case CMD12_STOP_TRANSMISSION:
        this.multipleReadBlock = -1;
        this.respond([R1_READY, 0x00]);
        return;

      case CMD24_WRITE_BLOCK: {
        if (!this.requireReady()) return;
        const block = Math.floor(arg / SD_BLOCK_SIZE);
        if (block >= SD_TOTAL_BLOCKS) {
          this.respond([0x40]); // parameter error
          return;
        }
        this.writeTarget = block;
        this.pendingWrite = true;
        this.respond([R1_READY]);
        return;
      }

      default:
        this.illegalCommands.push(cmd);
        this.note(`CMD${cmd} is not implemented: answered illegal command`);
        this.respond([(this.idle ? R1_IDLE : R1_READY) | R1_ILLEGAL_COMMAND]);
    }
  }

  private requireReady(): boolean {
    if (this.initialised) return true;
    // A card that has not completed ACMD41 still reports the idle bit, which
    // is what makes "SD.begin() before init" fail on real hardware.
    this.respond([R1_IDLE]);
    this.note('data command refused: card is still in idle state');
    return false;
  }

  /** Queues R1-follow-on data: token, payload, two CRC bytes. */
  private queueDataPayload(payload: Uint8Array): void {
    this.response.push(DATA_TOKEN, ...payload, 0xff, 0xff);
  }

  private queueDataBlock(block: number): void {
    if (block >= SD_TOTAL_BLOCKS) {
      this.response = [DATA_ERROR_TOKEN];
      this.phase = 'response';
      this.multipleReadBlock = -1;
      return;
    }
    this.response = [DATA_TOKEN, ...this.readBlock(block), 0xff, 0xff];
    this.phase = 'read-block';
  }

  private awaitWriteToken(byte: number): number {
    if (byte === DATA_TOKEN) {
      this.dataIndex = 0;
      this.dataBuf = new Uint8Array(SD_BLOCK_SIZE);
      this.phase = 'write-block';
    }
    return 0xff;
  }

  private takeWriteByte(byte: number): number {
    if (this.dataIndex < SD_BLOCK_SIZE) {
      this.dataBuf[this.dataIndex++] = byte & 0xff;
      return 0xff;
    }
    // Two CRC bytes follow the payload; the second one is answered with the
    // data-response token.
    if (this.dataIndex++ < SD_BLOCK_SIZE + 1) return 0xff;
    const stored = this.blocks.has(this.writeTarget);
    if (!stored && this.blocks.size >= SD_MAX_STORED_BLOCKS) {
      this.storageFull = true;
      this.note('write rejected: virtual card storage limit reached');
      this.phase = 'command';
      return 0x0d; // data rejected (write error)
    }
    this.blocks.set(this.writeTarget, this.dataBuf);
    this.writes++;
    this.busyLeft = WRITE_BUSY_BYTES;
    this.phase = 'write-busy';
    return DATA_ACCEPTED;
  }

  /** CSD v1 describing a 4 MiB standard-capacity card. */
  private csd(): Uint8Array {
    return new Uint8Array([
      0x00, 0x26, 0x00, 0x32, 0x5b, 0x59, 0x80, 0x03, 0xf6, 0xdb, 0xff, 0x80, 0x0a, 0x40, 0x00, 0x01,
    ]);
  }

  private cid(): Uint8Array {
    const b = new Uint8Array(16);
    b[0] = 0x03; // manufacturer id
    b[1] = 0x53; // OEM 'SD'
    b[2] = 0x44;
    const name = 'CDSIM';
    for (let i = 0; i < 5; i++) b[3 + i] = name.charCodeAt(i);
    b[8] = 0x10; // revision 1.0
    b[9] = 0x00; // serial
    b[10] = 0x00;
    b[11] = 0x00;
    b[12] = 0x01;
    b[13] = 0x01; // manufacturing date
    b[14] = 0x60;
    b[15] = 0x01; // CRC7 + stop bit (not verified by hosts in SPI mode)
    return b;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.blocks.clear();
    this.selected = false;
    this.phase = 'command';
    this.frame = [];
    this.response = [];
    this.idle = true;
    this.initialised = false;
    this.acmdPending = false;
    this.acmdPolls = 0;
    this.sawCmd0 = false;
    this.multipleReadBlock = -1;
    this.pendingWrite = false;
    this.storageFull = false;
    this.writes = 0;
    this.illegalCommands = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `SD card (4 MiB SDSC, FAT16): ${this.initialised ? 'initialised' : 'idle / not initialised'}, ` +
        `${this.blocks.size} block(s) written`,
      log: [...this.log],
    };
  }
}
