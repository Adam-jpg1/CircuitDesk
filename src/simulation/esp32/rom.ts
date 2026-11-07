// The ESP32 mask ROM routines ESP-IDF and Arduino-ESP32 call, provided natively.
//
// The ROM itself is not published, so none of it is executed. Each entry here
// implements the documented contract of a routine the firmware links against
// (addresses from ESP-IDF's esp32.rom.ld and esp32.rom.libgcc.ld): the libgcc
// soft-float and 64-bit integer helpers, the console printf, delays, the
// interrupt matrix, the flash cache MMU set-up, the analog "I2C" register bus,
// GPIO matrix helpers and the checksums.
//
// ABI: the windowed calling convention. A ROM routine is reached by CALL8 or
// CALLX8, so its arguments are the caller's a10.. — `arg(i)` — and its result
// goes back into a10 (a10:a11 for 64-bit values). A 64-bit argument occupies
// an aligned register pair, low word first.

import type { GuestRoutine } from '../firmwareCalls';

export interface Esp32RomHost {
  /** Argument register i of the routine being called. */
  arg(i: number): number;
  /** The caller's stack pointer, for variadic arguments past the sixth. */
  sp(): number;
  read8(a: number): number;
  read32(a: number): number;
  write8(a: number, v: number): void;
  write32(a: number, v: number): void;
  /** The CPU making the call: 0 for PRO, 1 for APP. */
  readonly cpu: number;
  console(byte: number): void;
  consoleRead(): number | undefined;
  delayUs(us: number): void;
  readonly state: Esp32RomState;
  setInterruptMap(cpu: number, source: number, line: number): void;
  setAppCpuBootAddress(address: number): void;
  mmuSet(cpu: number, vaddr: number, paddr: number, pages: number): number;
  mmuInit(cpu: number): void;
  gpioMatrixIn(gpio: number, signal: number, invert: boolean): void;
  gpioMatrixOut(gpio: number, signal: number, invert: boolean, oenInvert: boolean): void;
  padSelectGpio(gpio: number): void;
  padPull(gpio: number, up: boolean, down: boolean): void;
  padDrive(gpio: number, strength: number): void;
  softwareReset(cpuOnly: boolean): void;
  /** PS, for the routines that raise the interrupt level. */
  ps: number;
  /** The calling core, for the routines that read or set its special registers. */
  readonly core: import('../xtensa/xtensa').Xtensa;
  /** Address of the word holding this CPU's syscall_stub_table pointer. */
  readonly syscallTablePointer: number;
  /** Where this chip's machine code for `withReent` lives (REENT_TRAMPOLINE_CODE). */
  readonly reentTrampoline: number;
}

export interface Esp32RomState {
  cpuTicksPerUs: number;
  resetReason: number;
  regi2c: Map<string, number>;
  /** Bytes fed to each MD5 context so far, by the context's address. */
  md5: Map<number, number[]>;
}

export function createRomState(): Esp32RomState {
  return { cpuTicksPerUs: 40, resetReason: 1, regi2c: new Map(), md5: new Map() };
}

/** MD5 (RFC 1321). */
export function md5(bytes: ArrayLike<number>): Uint8Array {
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) * 64;
  const msg = new Uint8Array(total);
  for (let i = 0; i < len; i++) msg[i] = bytes[i];
  msg[len] = 0x80;
  const bits = len * 8;
  for (let i = 0; i < 8; i++) msg[total - 8 + i] = Math.floor(bits / 2 ** (8 * i)) & 0xff;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = msg[off + i * 4] | (msg[off + i * 4 + 1] << 8) | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((w, k) => { for (let i = 0; i < 4; i++) out[k * 4 + i] = (w >>> (8 * i)) & 0xff; });
  return out;
}

/** Continue in firmware code instead of returning: see `syscall` below. */
export interface RomJump {
  jump: number;
  /** Values for the callee's a6 and a7 (the caller's a14 and a15) before it runs. */
  a6?: number;
  a7?: number;
}
/**
 * A ROM routine's answer: a value (or a 64-bit pair), a jump into firmware, or
 * a GuestRoutine where it must call firmware first (strdup's malloc).
 */
export type RomResult = number | [number, number] | RomJump | GuestRoutine | void;
type Handler = (h: Esp32RomHost) => RomResult;

const scratch = new DataView(new ArrayBuffer(8));
const dbl = (lo: number, hi: number): number => {
  scratch.setUint32(0, lo >>> 0, true);
  scratch.setUint32(4, hi >>> 0, true);
  return scratch.getFloat64(0, true);
};
const flt = (w: number): number => {
  scratch.setUint32(0, w >>> 0, true);
  return scratch.getFloat32(0, true);
};
const fromDbl = (v: number): [number, number] => {
  scratch.setFloat64(0, v, true);
  return [scratch.getUint32(0, true), scratch.getUint32(4, true)];
};
const fromFlt = (v: number): number => {
  scratch.setFloat32(0, v, true);
  return scratch.getUint32(0, true);
};
const i64 = (lo: number, hi: number): bigint => BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0));
const u64 = (lo: number, hi: number): bigint => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
const pair = (v: bigint): [number, number] => {
  const x = BigInt.asUintN(64, v);
  return [Number(x & 0xffffffffn), Number(x >> 32n)];
};
/** Truncation toward zero, saturating as GCC's soft-float conversions do on overflow. */
const toInt = (v: number, min: number, max: number): number => (Number.isNaN(v) ? 0 : Math.max(min, Math.min(max, Math.trunc(v))));
const toBig = (v: number, min: bigint, max: bigint): bigint => {
  if (Number.isNaN(v)) return 0n;
  const t = Math.trunc(v);
  if (t <= Number(min)) return min;
  if (t >= Number(max)) return max;
  return BigInt(t);
};
/** A 64-bit integer to binary32, rounded once (via the exact BigInt, not a double). */
const bigToFloat = (v: bigint): number => {
  const neg = v < 0n;
  let m = neg ? -v : v;
  if (m === 0n) return 0;
  let bits = m.toString(2).length;
  if (bits > 24) {
    const shift = BigInt(bits - 24);
    const rem = m & ((1n << shift) - 1n);
    const half = 1n << (shift - 1n);
    m >>= shift;
    if (rem > half || (rem === half && (m & 1n) === 1n)) m += 1n;
    const r = Number(m) * 2 ** Number(shift);
    return Math.fround(neg ? -r : r);
  }
  return Math.fround(neg ? -Number(m) : Number(m));
};

const d0 = (h: Esp32RomHost) => dbl(h.arg(0), h.arg(1));
const d1 = (h: Esp32RomHost) => dbl(h.arg(2), h.arg(3));
const f0 = (h: Esp32RomHost) => flt(h.arg(0));
const f1 = (h: Esp32RomHost) => flt(h.arg(1));

/** IEEE comparison results with libgcc's conventions for unordered operands. */
function cmp(a: number, b: number, unordered: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return unordered;
  return a < b ? -1 : a > b ? 1 : 0;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** The CRC-8 eFuse uses to check the factory MAC (polynomial 0x8C, reflected). */
export function esp32MacCrc8(bytes: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x8c : crc >>> 1;
  }
  return crc & 0xff;
}

/** Formats a ROM printf call: %d %i %u %x %X %o %c %s %p %%, with flags, width and l. */
function romPrintf(h: Esp32RomHost, fmtAddr: number, firstArg: number): void {
  let argIndex = firstArg;
  const next = (): number => {
    const v = argIndex < 6 ? h.arg(argIndex) : h.read32(h.sp() + (argIndex - 6) * 4);
    argIndex++;
    return v >>> 0;
  };
  const out = (s: string) => {
    for (let i = 0; i < s.length; i++) h.console(s.charCodeAt(i) & 0xff);
  };
  for (let p = fmtAddr, n = 0; n < 4096; n++) {
    const c = h.read8(p++);
    if (c === 0) break;
    if (c !== 0x25) {
      h.console(c);
      continue;
    }
    let flags = '';
    let ch = String.fromCharCode(h.read8(p++));
    while ('-0+ #'.includes(ch) && ch !== '') {
      flags += ch;
      ch = String.fromCharCode(h.read8(p++));
    }
    let width = 0;
    while (ch >= '0' && ch <= '9') {
      width = width * 10 + Number(ch);
      ch = String.fromCharCode(h.read8(p++));
    }
    while (ch === 'l' || ch === 'h' || ch === 'z') ch = String.fromCharCode(h.read8(p++));
    let s: string;
    switch (ch) {
      case 'd': case 'i': s = String(next() | 0); break;
      case 'u': s = String(next()); break;
      case 'x': s = next().toString(16); break;
      case 'X': s = next().toString(16).toUpperCase(); break;
      case 'o': s = next().toString(8); break;
      case 'p': s = '0x' + next().toString(16).padStart(8, '0'); break;
      case 'c': s = String.fromCharCode(next() & 0xff); break;
      case 's': {
        let a = next();
        s = '';
        for (let k = 0; k < 1024; k++) {
          const b = h.read8(a++);
          if (!b) break;
          s += String.fromCharCode(b);
        }
        break;
      }
      case '%': s = '%'; break;
      default: s = '%' + ch;
    }
    if (s.length < width) s = flags.includes('-') ? s.padEnd(width) : flags.includes('0') ? s.padStart(width, '0') : s.padStart(width);
    out(s);
  }
}

/**
 * The ROM's newlib glue. On the chip, `open`, `malloc` and the rest live in ROM
 * and forward through a table of function pointers ESP-IDF installs at boot
 * (syscall_table_ptr_pro/app, struct syscall_stub_table in rom/libc_stubs.h):
 * the reentrant `_x_r` entry points straight to the table's entry, the plain
 * ones after fetching the caller's reentrancy structure with `__getreent`.
 * The forwarding is reproduced exactly; what runs is the firmware's own VFS,
 * heap and locks.
 */
/** The ESP32's syscall_table_ptr_pro and syscall_table_ptr_app. */
export const ESP32_SYSCALL_TABLE_PTR = [0x3ffae024, 0x3ffae020];
/**
 * A routine the ROM implements in firmware terms: entered with the original
 * call's arguments, it calls `__getreent()`, then `fn(reent, a2, a3, a4, a5)`,
 * and returns that result. Machine code (Xtensa, windowed):
 *   entry a1,32; callx8 a6; mov a11..a14, a2..a5; callx8 a7; mov a2,a10; mov a3,a11; retw
 */
export const REENT_TRAMPOLINE = 0x4006ff00;
export const REENT_TRAMPOLINE_CODE = [
  0x36, 0x41, 0x00, 0xe0, 0x06, 0x00, 0x20, 0xb2, 0x20, 0x30, 0xc3, 0x20, 0x40, 0xd4, 0x20, 0x50, 0xe5, 0x20,
  0xe0, 0x07, 0x00, 0xa0, 0x2a, 0x20, 0xb0, 0x3b, 0x20, 0x90, 0x00, 0x00,
];
const stub = (h: Esp32RomHost, index: number) => h.read32(h.read32(h.syscallTablePointer) + index * 4);
const direct = (index: number): Handler => (h) => ({ jump: stub(h, index) });
const withReent = (index: number): Handler => (h) => ({ jump: h.reentTrampoline, a6: stub(h, 0), a7: stub(h, index) });

const ROUTINES: [number, string, Handler][] = [
  // ------------------------------------------------------------- newlib glue
  [0x4000178c, 'open', withReent(20)],
  [0x40001778, 'close', withReent(19)],
  [0x400017dc, 'read', withReent(23)],
  [0x4000181c, 'write', withReent(21)],
  [0x400017f4, 'sbrk', withReent(15)],
  [0x40001808, 'times', withReent(8)],
  [0x4000bea0, 'malloc', withReent(1)],
  [0x4000beb8, 'free', withReent(2)],
  [0x4000becc, 'realloc', withReent(3)],
  [0x4000bee4, 'calloc', withReent(4)],
  [0x4000be8c, '__getreent', direct(0)],
  [0x4000bbb4, '_malloc_r', direct(1)],
  [0x4000bbcc, '_free_r', direct(2)],
  [0x4000bbe0, '_realloc_r', direct(3)],
  [0x4000bc10, '_system_r', direct(6)],
  [0x4000bc28, '_rename_r', direct(7)],
  [0x4000bc40, '_times_r', direct(8)],
  [0x4000bc58, '_gettimeofday_r', direct(9)],
  [0x4000bc70, '_raise_r', direct(10)],
  [0x4000bc84, '_unlink_r', direct(11)],
  [0x4000bc9c, '_link_r', direct(12)],
  [0x4000bccc, '_fstat_r', direct(14)],
  [0x4000bce4, '_sbrk_r', direct(15)],
  [0x4000bcfc, '_getpid_r', direct(16)],
  [0x4000bd10, '_kill_r', direct(17)],
  [0x4000bd28, '_exit_r', direct(18)],
  [0x4000bd3c, '_close_r', direct(19)],
  [0x4000bd54, '_open_r', direct(20)],
  [0x4000bd70, '_write_r', direct(21)],
  [0x4000bd8c, '_lseek_r', direct(22)],
  [0x4000bda8, '_read_r', direct(23)],
  [0x4000bdc4, '_lock_init', direct(24)],
  [0x4000bdd8, '_lock_init_recursive', direct(25)],
  [0x4000bdec, '_lock_close', direct(26)],
  [0x4000be00, '_lock_close_recursive', direct(27)],
  [0x4000be14, '_lock_acquire', direct(28)],
  [0x4000be28, '_lock_acquire_recursive', direct(29)],
  [0x4000be3c, '_lock_try_acquire', direct(30)],
  [0x4000be50, '_lock_try_acquire_recursive', direct(31)],
  [0x4000be64, '_lock_release', direct(32)],
  [0x4000be78, '_lock_release_recursive', direct(33)],
  // ------------------------------------------------------------- console
  [0x40007d54, 'ets_printf', (h) => { romPrintf(h, h.arg(0), 1); return 0; }],
  [0x40007d18, 'ets_install_putc1', () => {}],
  [0x40007d38, 'ets_install_putc2', () => {}],
  [0x40007d28, 'ets_install_uart_printf', () => {}],
  [0x40009200, 'uart_tx_one_char', (h) => { h.console(h.arg(0) & 0xff); return 0; }],
  [0x40007cf8, 'ets_write_char_uart', (h) => { h.console(h.arg(0) & 0xff); }],
  [0x40009258, 'uart_tx_flush', () => {}],
  [0x40009028, 'uart_tx_switch', () => {}],
  [0x400092d0, 'uart_rx_one_char', (h) => {
    const b = h.consoleRead();
    if (b === undefined) return 1;
    h.write8(h.arg(0), b);
    return 0;
  }],
  // ------------------------------------------------------------- clocks and resets
  [0x40008534, 'ets_delay_us', (h) => { h.delayUs(h.arg(0)); }],
  [0x40008550, 'ets_update_cpu_frequency_rom', (h) => { h.state.cpuTicksPerUs = h.arg(0); }],
  [0x4000855c, 'ets_get_cpu_frequency', (h) => h.state.cpuTicksPerUs],
  [0x4000856c, 'ets_get_xtal_scale', () => 0x10000],
  [0x40008588, 'ets_get_detected_xtal_freq', () => 40_000_000],
  [0x400081d4, 'rtc_get_reset_reason', (h) => h.state.resetReason],
  [0x40008208, 'set_rtc_memory_crc', () => {}],
  [0x4000824c, 'software_reset', (h) => { h.softwareReset(false); }],
  [0x40008264, 'software_reset_cpu', (h) => { h.softwareReset(true); }],
  [0x40008658, 'ets_efuse_get_spiconfig', () => 0],
  // ------------------------------------------------------------- interrupts and CPUs
  [0x4000681c, 'intr_matrix_set', (h) => { h.setInterruptMap(h.arg(0), h.arg(1), h.arg(2)); }],
  [0x4000689c, 'ets_set_appcpu_boot_addr', (h) => { h.setAppCpuBootAddress(h.arg(0)); }],
  [0x4000bfdc, '_xtos_set_intlevel', (h) => {
    const old = h.ps;
    h.ps = (old & ~0xf) | (h.arg(0) & 0xf);
    return old;
  }],
  [0x400067b0, 'ets_intr_lock', (h) => { h.ps = (h.ps & ~0xf) | 3; }],
  [0x400067c4, 'ets_intr_unlock', (h) => { h.ps = h.ps & ~0xf; }],
  // ------------------------------------------------------------- analog register bus
  [0x40004148, 'rom_i2c_readReg', (h) => h.state.regi2c.get(`${h.arg(0)}:${h.arg(2)}`) ?? 0],
  [0x400041a4, 'rom_i2c_writeReg', (h) => { h.state.regi2c.set(`${h.arg(0)}:${h.arg(2)}`, h.arg(3) & 0xff); }],
  [0x400041c0, 'rom_i2c_readReg_Mask', (h) => {
    const v = h.state.regi2c.get(`${h.arg(0)}:${h.arg(2)}`) ?? 0;
    const msb = h.arg(3), lsb = h.arg(4);
    return (v >>> lsb) & ((1 << (msb - lsb + 1)) - 1);
  }],
  [0x400041fc, 'rom_i2c_writeReg_Mask', (h) => {
    const key = `${h.arg(0)}:${h.arg(2)}`;
    const msb = h.arg(3), lsb = h.arg(4);
    const mask = ((1 << (msb - lsb + 1)) - 1) << lsb;
    const v = h.state.regi2c.get(key) ?? 0;
    h.state.regi2c.set(key, ((v & ~mask) | ((h.arg(5) << lsb) & mask)) & 0xff);
  }],
  // ------------------------------------------------------------- GPIO matrix and pads
  [0x40009edc, 'gpio_matrix_in', (h) => { h.gpioMatrixIn(h.arg(0), h.arg(1), h.arg(2) !== 0); }],
  [0x40009f0c, 'gpio_matrix_out', (h) => { h.gpioMatrixOut(h.arg(0), h.arg(1), h.arg(2) !== 0, h.arg(3) !== 0); }],
  [0x40009fdc, 'gpio_pad_select_gpio', (h) => { h.padSelectGpio(h.arg(0)); }],
  [0x4000a22c, 'gpio_pad_pullup', (h) => { h.padPull(h.arg(0), true, false); }],
  [0x4000a348, 'gpio_pad_pulldown', (h) => { h.padPull(h.arg(0), false, true); }],
  [0x4000a11c, 'gpio_pad_set_drv', (h) => { h.padDrive(h.arg(0), h.arg(1)); }],
  [0x4000a484, 'gpio_pad_unhold', () => {}],
  [0x4000a734, 'gpio_pad_hold', () => {}],
  // ------------------------------------------------------------- flash cache
  [0x400095a4, 'mmu_init', (h) => { h.mmuInit(h.arg(0)); }],
  [0x400095e0, 'cache_flash_mmu_set_rom', (h) => {
    // (cpu, pid, vaddr, paddr, psize in KB, num)
    if (h.arg(4) !== 64) return 4;
    return h.mmuSet(h.arg(0), h.arg(2), h.arg(3), h.arg(5));
  }],
  [0x400097f4, 'cache_sram_mmu_set_rom', () => 0],
  [0x40009a14, 'Cache_Flush_rom', () => {}],
  [0x40009a84, 'Cache_Read_Enable_rom', () => {}],
  [0x40009ab8, 'Cache_Read_Disable_rom', () => {}],
  // ------------------------------------------------------------- flash (the ROM driver)
  [0x400622c0, 'esp_rom_spiflash_wait_idle', () => 0],
  [0x40062a6c, 'esp_rom_spiflash_attach', () => {}],
  [0x40063238, 'esp_rom_spiflash_config_param', () => 0],
  [0x40062bc8, 'esp_rom_spiflash_config_clk', () => 0],
  [0x40062b64, 'esp_rom_spiflash_config_readmode', () => 0],
  [0x40061ddc, 'esp_rom_spiflash_select_qio_pins', () => {}],
  // ------------------------------------------------------------- helpers
  [0x4000ab7c, 'roundup2', (h) => {
    const size = h.arg(1);
    return (h.arg(0) + size - 1) & -size;
  }],
  [0x4005cfec, 'crc32_le', (h) => {
    let crc = ~h.arg(0) >>> 0;
    const buf = h.arg(1);
    const len = h.arg(2);
    for (let i = 0; i < len; i++) crc = CRC32_TABLE[(crc ^ h.read8(buf + i)) & 0xff] ^ (crc >>> 8);
    return ~crc >>> 0;
  }],
  [0x4005d144, 'esp_crc8', (h) => {
    const bytes: number[] = [];
    for (let i = 0; i < h.arg(1); i++) bytes.push(h.read8(h.arg(0) + i));
    return esp32MacCrc8(bytes);
  }],
  [0x4005da7c, 'esp_rom_md5_init', (h) => { h.state.md5.set(h.arg(0), []); }],
  [0x4005da9c, 'esp_rom_md5_update', (h) => {
    const acc = h.state.md5.get(h.arg(0)) ?? [];
    for (let i = 0; i < h.arg(2); i++) acc.push(h.read8(h.arg(1) + i));
    h.state.md5.set(h.arg(0), acc);
  }],
  [0x4005db1c, 'esp_rom_md5_final', (h) => {
    const digest = md5(h.state.md5.get(h.arg(1)) ?? []);
    h.state.md5.delete(h.arg(1));
    digest.forEach((b, i) => h.write8(h.arg(0) + i, b));
  }],
  // ------------------------------------------------------------- libgcc: double
  [0x40002590, '__adddf3', (h) => fromDbl(d0(h) + d1(h))],
  [0x400026e4, '__subdf3', (h) => fromDbl(d0(h) - d1(h))],
  [0x4006358c, '__muldf3', (h) => fromDbl(d0(h) * d1(h))],
  [0x40002954, '__divdf3', (h) => fromDbl(d0(h) / d1(h))],
  [0x400634a0, '__negdf2', (h) => [h.arg(0), (h.arg(1) ^ 0x80000000) >>> 0]],
  [0x400636a8, '__eqdf2', (h) => cmp(d0(h), d1(h), 1)],
  [0x400636dc, '__gtdf2', (h) => cmp(d0(h), d1(h), -1)],
  [0x40063768, '__gedf2', (h) => cmp(d0(h), d1(h), -1)],
  [0x40063790, '__ltdf2', (h) => cmp(d0(h), d1(h), 1)],
  [0x40063704, '__ledf2', (h) => cmp(d0(h), d1(h), 1)],
  [0x400637f4, '__unorddf2', (h) => (Number.isNaN(d0(h)) || Number.isNaN(d1(h)) ? 1 : 0)],
  [0x40002a78, '__fixdfsi', (h) => toInt(d0(h), -0x80000000, 0x7fffffff)],
  [0x40002b30, '__fixunsdfsi', (h) => toInt(d0(h), 0, 0xffffffff)],
  [0x40002ac4, '__fixdfdi', (h) => pair(toBig(d0(h), -(2n ** 63n), 2n ** 63n - 1n))],
  [0x4000c944, '__floatsidf', (h) => fromDbl(h.arg(0) | 0)],
  [0x4000c938, '__floatunsidf', (h) => fromDbl(h.arg(0) >>> 0)],
  [0x4000c988, '__floatdidf', (h) => fromDbl(Number(i64(h.arg(0), h.arg(1))))],
  [0x4000c978, '__floatundidf', (h) => fromDbl(Number(u64(h.arg(0), h.arg(1))))],
  [0x40002b90, '__truncdfsf2', (h) => fromFlt(d0(h))],
  [0x40002c34, '__extendsfdf2', (h) => fromDbl(f0(h))],
  [0x400638e4, '__powidf2', (h) => fromDbl(Math.pow(dbl(h.arg(0), h.arg(1)), h.arg(2) | 0))],
  // ------------------------------------------------------------- libgcc: float
  [0x400020e8, '__addsf3', (h) => fromFlt(f0(h) + f1(h))],
  [0x400021d0, '__subsf3', (h) => fromFlt(f0(h) - f1(h))],
  [0x400632c8, '__mulsf3', (h) => fromFlt(f0(h) * f1(h))],
  [0x400020c0, '__negsf2', (h) => (h.arg(0) ^ 0x80000000) >>> 0],
  [0x40063374, '__eqsf2', (h) => cmp(f0(h), f1(h), 1)],
  [0x400633a0, '__gtsf2', (h) => cmp(f0(h), f1(h), -1)],
  [0x4006340c, '__gesf2', (h) => cmp(f0(h), f1(h), -1)],
  [0x4006342c, '__ltsf2', (h) => cmp(f0(h), f1(h), 1)],
  [0x400633c0, '__lesf2', (h) => cmp(f0(h), f1(h), 1)],
  [0x40063478, '__unordsf2', (h) => (Number.isNaN(f0(h)) || Number.isNaN(f1(h)) ? 1 : 0)],
  [0x4000240c, '__fixsfsi', (h) => toInt(f0(h), -0x80000000, 0x7fffffff)],
  [0x400024ac, '__fixunssfsi', (h) => toInt(f0(h), 0, 0xffffffff)],
  [0x4000244c, '__fixsfdi', (h) => pair(toBig(f0(h), -(2n ** 63n), 2n ** 63n - 1n))],
  [0x40002504, '__fixunssfdi', (h) => pair(toBig(f0(h), 0n, 2n ** 64n - 1n))],
  [0x4000c870, '__floatsisf', (h) => fromFlt(h.arg(0) | 0)],
  [0x4000c864, '__floatunsisf', (h) => fromFlt(h.arg(0) >>> 0)],
  [0x4000c8c0, '__floatdisf', (h) => fromFlt(bigToFloat(i64(h.arg(0), h.arg(1))))],
  [0x4000c8b0, '__floatundisf', (h) => fromFlt(bigToFloat(u64(h.arg(0), h.arg(1))))],
  // ------------------------------------------------------------- libgcc: integers
  [0x4000c7b0, '__mulsi3', (h) => Math.imul(h.arg(0), h.arg(1))],
  [0x4000c7b8, '__divsi3', (h) => (h.arg(1) | 0 ? ((h.arg(0) | 0) / (h.arg(1) | 0)) | 0 : 0)],
  [0x4000c7c0, '__modsi3', (h) => (h.arg(1) | 0 ? (h.arg(0) | 0) % (h.arg(1) | 0) : 0)],
  [0x4000c7c8, '__udivsi3', (h) => (h.arg(1) >>> 0 ? Math.floor((h.arg(0) >>> 0) / (h.arg(1) >>> 0)) : 0)],
  [0x4000c7d0, '__umodsi3', (h) => (h.arg(1) >>> 0 ? (h.arg(0) >>> 0) % (h.arg(1) >>> 0) : 0)],
  [0x4000c7d8, '__umulsidi3', (h) => pair(BigInt(h.arg(0) >>> 0) * BigInt(h.arg(1) >>> 0))],
  [0x4000c9fc, '__muldi3', (h) => pair(u64(h.arg(0), h.arg(1)) * u64(h.arg(2), h.arg(3)))],
  [0x4000ca84, '__divdi3', (h) => {
    const b = i64(h.arg(2), h.arg(3));
    return pair(b === 0n ? 0n : i64(h.arg(0), h.arg(1)) / b);
  }],
  [0x4000cd4c, '__moddi3', (h) => {
    const b = i64(h.arg(2), h.arg(3));
    return pair(b === 0n ? 0n : i64(h.arg(0), h.arg(1)) % b);
  }],
  [0x4000cff8, '__udivdi3', (h) => {
    const b = u64(h.arg(2), h.arg(3));
    return pair(b === 0n ? 0n : u64(h.arg(0), h.arg(1)) / b);
  }],
  [0x4000d280, '__umoddi3', (h) => {
    const b = u64(h.arg(2), h.arg(3));
    return pair(b === 0n ? 0n : u64(h.arg(0), h.arg(1)) % b);
  }],
  [0x4000ca14, '__negdi2', (h) => pair(-i64(h.arg(0), h.arg(1)))],
  [0x4000c818, '__ashldi3', (h) => pair(u64(h.arg(0), h.arg(1)) << BigInt(h.arg(2) & 63))],
  [0x4000c830, '__ashrdi3', (h) => pair(i64(h.arg(0), h.arg(1)) >> BigInt(h.arg(2) & 63))],
  [0x4000c84c, '__lshrdi3', (h) => pair(u64(h.arg(0), h.arg(1)) >> BigInt(h.arg(2) & 63))],
  [0x40063820, '__cmpdi2', (h) => {
    const a = i64(h.arg(0), h.arg(1)), b = i64(h.arg(2), h.arg(3));
    return a < b ? 0 : a > b ? 2 : 1;
  }],
  [0x40063840, '__ucmpdi2', (h) => {
    const a = u64(h.arg(0), h.arg(1)), b = u64(h.arg(2), h.arg(3));
    return a < b ? 0 : a > b ? 2 : 1;
  }],
  [0x4000c7e8, '__clzsi2', (h) => Math.clz32(h.arg(0))],
  [0x4000c7f0, '__ctzsi2', (h) => (h.arg(0) ? 31 - Math.clz32(h.arg(0) & -h.arg(0)) : 32)],
  [0x4000c804, '__ffssi2', (h) => (h.arg(0) ? 32 - Math.clz32(h.arg(0) & -h.arg(0)) : 0)],
  [0x4000ca50, '__clzdi2', (h) => (h.arg(1) ? Math.clz32(h.arg(1)) : 32 + Math.clz32(h.arg(0)))],
  [0x4000ca64, '__ctzdi2', (h) => (h.arg(0) ? 31 - Math.clz32(h.arg(0) & -h.arg(0)) : 63 - Math.clz32(h.arg(1) & -h.arg(1)))],
  [0x4000ca2c, '__ffsdi2', (h) => (h.arg(0) ? 32 - Math.clz32(h.arg(0) & -h.arg(0)) : h.arg(1) ? 64 - Math.clz32(h.arg(1) & -h.arg(1)) : 0)],
  [0x40002ed0, '__popcountsi2', (h) => popcount(h.arg(0))],
  [0x40002ef8, '__popcountdi2', (h) => popcount(h.arg(0)) + popcount(h.arg(1))],
  [0x40002f3c, '__paritysi2', (h) => popcount(h.arg(0)) & 1],
  [0x40064ae0, '__bswapsi2', (h) => {
    const v = h.arg(0);
    return ((v >>> 24) | ((v >>> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24)) >>> 0;
  }],
  [0x40002c98, '__addvsi3', (h) => (h.arg(0) + h.arg(1)) | 0],
  [0x40002cf8, '__subvsi3', (h) => (h.arg(0) - h.arg(1)) | 0],
  [0x40002d60, '__mulvsi3', (h) => Math.imul(h.arg(0), h.arg(1))],
  [0x40002e78, '__negvsi2', (h) => -h.arg(0) | 0],
  [0x40063868, '__absvsi2', (h) => Math.abs(h.arg(0) | 0) | 0],
  [0x40002cbc, '__addvdi3', (h) => pair(i64(h.arg(0), h.arg(1)) + i64(h.arg(2), h.arg(3)))],
  [0x40002d20, '__subvdi3', (h) => pair(i64(h.arg(0), h.arg(1)) - i64(h.arg(2), h.arg(3)))],
  [0x40002d78, '__mulvdi3', (h) => pair(i64(h.arg(0), h.arg(1)) * i64(h.arg(2), h.arg(3)))],
  [0x40002e98, '__negvdi2', (h) => pair(-i64(h.arg(0), h.arg(1)))],
];

function popcount(v: number): number {
  v >>>= 0;
  let n = 0;
  while (v) {
    v &= v - 1;
    n++;
  }
  return n;
}

export interface Esp32RomEntry {
  name: string;
  handler: Handler;
}

export const ESP32_ROM = new Map<number, Esp32RomEntry>(ROUTINES.map(([a, name, handler]) => [a, { name, handler }]));

/** Every routine above by name, for chips whose ROM publishes the same functions at other addresses. */
export const ROM_HANDLERS = new Map<string, Handler>(ROUTINES.map(([, name, handler]) => [name, handler]));
export type { Handler as RomHandler };

/** The name of a ROM address with no implementation, for an honest error message. */
export const ESP32_ROM_START = 0x40000000;
export const ESP32_ROM_END = 0x40070000;
