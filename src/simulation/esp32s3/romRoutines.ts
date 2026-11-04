// The ESP32-S3's mask ROM routines, provided natively.
//
// The S3's ROM publishes most of what the ESP32's does (libgcc, the console,
// delays, the interrupt matrix, the analog register bus, GPIO matrix helpers,
// MD5) at other addresses, and much the ESP32's does not: the C library's
// string and memory functions, the cache control interface, the watchdog HAL
// and the eFuse queries. Firmware built for the S3 links against all of it
// (esp32s3.rom*.ld). Shared routines come from ../esp32/rom by name; the
// S3's own are here, each implementing the documented contract of its C
// prototype. Addresses are in ./romAddresses.

import { ROM_HANDLERS, type Esp32RomHost, type RomHandler, type RomResult } from '../esp32/rom';

type H = (h: Esp32RomHost) => RomResult;

const MAX_SCAN = 1 << 20;

function cstr(h: Esp32RomHost, a: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < MAX_SCAN; i++) {
    const b = h.read8(a + i);
    if (!b) break;
    out.push(b);
  }
  return out;
}

function strlen(h: Esp32RomHost, a: number): number {
  let n = 0;
  while (n < MAX_SCAN && h.read8(a + n)) n++;
  return n;
}

function copy(h: Esp32RomHost, d: number, s: number, n: number): void {
  if (d === s || n === 0) return;
  // memmove semantics, so overlapping copies come out right in either direction.
  if (d < s || d >= s + n) for (let i = 0; i < n; i++) h.write8(d + i, h.read8(s + i));
  else for (let i = n - 1; i >= 0; i--) h.write8(d + i, h.read8(s + i));
}

const lower = (c: number) => (c >= 65 && c <= 90 ? c + 32 : c);
const upper = (c: number) => (c >= 97 && c <= 122 ? c - 32 : c);
const sign = (v: number) => (v < 0 ? -1 : v > 0 ? 1 : 0);

function compare(h: Esp32RomHost, a: number, b: number, n: number, fold: boolean, stopAtNul: boolean): number {
  for (let i = 0; i < n; i++) {
    let x = h.read8(a + i);
    let y = h.read8(b + i);
    if (fold) {
      x = lower(x);
      y = lower(y);
    }
    if (x !== y) return x - y;
    if (stopAtNul && x === 0) return 0;
  }
  return 0;
}

function find(h: Esp32RomHost, hay: number, needle: number, fold: boolean): number {
  const nd = cstr(h, needle);
  if (nd.length === 0) return hay;
  const n = strlen(h, hay);
  for (let i = 0; i + nd.length <= n; i++) {
    let ok = true;
    for (let k = 0; k < nd.length && ok; k++) {
      const c = h.read8(hay + i + k);
      ok = fold ? lower(c) === lower(nd[k]) : c === nd[k];
    }
    if (ok) return hay + i;
  }
  return 0;
}

const SPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

/** strtol/strtoul: whitespace, sign, 0x or 0 prefixes for base 0 or 16, digits in the base. */
function parseInteger(h: Esp32RomHost, s: number, endp: number, base: number, unsigned: boolean): number {
  let p = s;
  while (SPACE.has(h.read8(p))) p++;
  let neg = false;
  if (h.read8(p) === 0x2d || h.read8(p) === 0x2b) {
    neg = h.read8(p) === 0x2d;
    p++;
  }
  if ((base === 0 || base === 16) && h.read8(p) === 0x30 && (h.read8(p + 1) | 0x20) === 0x78) {
    p += 2;
    base = 16;
  } else if (base === 0) base = h.read8(p) === 0x30 ? 8 : 10;
  let v = 0;
  let any = false;
  for (;;) {
    const c = h.read8(p);
    const d = c >= 48 && c <= 57 ? c - 48 : (c | 0x20) >= 97 && (c | 0x20) <= 122 ? (c | 0x20) - 87 : 99;
    if (d >= base) break;
    v = v * base + d;
    any = true;
    p++;
  }
  if (endp) h.write32(endp, any ? p : s);
  if (unsigned) {
    if (v > 0xffffffff) return 0xffffffff;
    return (neg ? -v : v) >>> 0;
  }
  if (!neg && v > 0x7fffffff) return 0x7fffffff;
  if (neg && v > 0x80000000) return 0x80000000 | 0;
  return (neg ? -v : v) | 0;
}

function writeNumber(h: Esp32RomHost, value: number, dst: number, base: number, signed: boolean): number {
  let text = signed && base === 10 ? String(value | 0) : (value >>> 0).toString(base);
  if (!signed || base !== 10) text = text.toLowerCase();
  for (let i = 0; i < text.length; i++) h.write8(dst + i, text.charCodeAt(i));
  h.write8(dst + text.length, 0);
  return dst;
}

const ctype = (test: (c: number) => boolean): H => (h) => (test(h.arg(0) & 0xff) ? 1 : 0);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** newlib's rand(): a 64-bit LCG, the top 31 bits of which are returned. */
let randState = 1n;

/**
 * qsort, which has to call the firmware's comparator. It is run as Xtensa code
 * placed in ROM space rather than natively: an insertion sort that swaps
 * elements byte by byte and calls compar(a, b) with CALLX8, assembled from
 *   entry a1,48; for (i = 1; i < n; i++) for (j = i; j && compar(e[j-1], e[j]) > 0; j--) swap(e[j-1], e[j]); retw
 * (qsort's contract does not require stability, and this is stable anyway).
 */
export const S3_QSORT_AT = 0x4005fe00;
export const S3_QSORT_CODE = [
  0x36, 0x61, 0x00, 0x62, 0xa0, 0x01, 0x37, 0xb6, 0x4d, 0x60, 0x76, 0x20, 0x16, 0x17, 0x04, 0x40, 0x87, 0x82, 0x80,
  0x82, 0x80, 0x40, 0x98, 0xc0, 0x82, 0x61, 0x00, 0x92, 0x61, 0x01, 0x90, 0xa9, 0x20, 0x80, 0xb8, 0x20, 0xe0, 0x05,
  0x00, 0xa6, 0x1a, 0x26, 0x82, 0x21, 0x00, 0x92, 0x21, 0x01, 0x40, 0xa4, 0x20, 0xb2, 0x08, 0x00, 0xc2, 0x09, 0x00,
  0xc2, 0x48, 0x00, 0xb2, 0x49, 0x00, 0x82, 0xc8, 0x01, 0x92, 0xc9, 0x01, 0xa2, 0xca, 0xff, 0x56, 0x7a, 0xfe, 0x72,
  0xc7, 0xff, 0x86, 0xee, 0xff, 0x62, 0xc6, 0x01, 0x86, 0xeb, 0xff, 0x90, 0x00, 0x00,
];

/**
 * What esp_coex_rom_version_get() returns, and where it is placed. ESP-IDF
 * logs it when the Wi-Fi/Bluetooth coexistence arbiter starts, on every boot.
 * Quoting an Espressif ROM build would be a false claim, so it names what is
 * providing the ROM here, as the C3 runtime's does.
 */
export const S3_COEX_VERSION = 'circuitdesk';
export const S3_COEX_VERSION_AT = 0x3ff1fc00;

export const S3_ONLY: Record<string, H> = {
  qsort: () => ({ jump: S3_QSORT_AT }),
  esp_coex_rom_version_get: () => S3_COEX_VERSION_AT,
  // In the S3's ROM though not the ESP32's: single-precision division, correctly rounded.
  __divsf3: (h) => {
    const sc = new DataView(new ArrayBuffer(4));
    const f = (w: number) => (sc.setUint32(0, w >>> 0, true), sc.getFloat32(0, true));
    sc.setFloat32(0, f(h.arg(0)) / f(h.arg(1)), true);
    return sc.getUint32(0, true);
  },
  // --------------------------------------------------------------- memory
  memcpy: (h) => { copy(h, h.arg(0), h.arg(1), h.arg(2)); return h.arg(0); },
  memmove: (h) => { copy(h, h.arg(0), h.arg(1), h.arg(2)); return h.arg(0); },
  xthal_memcpy: (h) => { copy(h, h.arg(0), h.arg(1), h.arg(2)); return h.arg(0); },
  xthal_bcopy: (h) => { copy(h, h.arg(1), h.arg(0), h.arg(2)); },
  memset: (h) => {
    const d = h.arg(0), c = h.arg(1) & 0xff, n = h.arg(2);
    for (let i = 0; i < n; i++) h.write8(d + i, c);
    return d;
  },
  bzero: (h) => {
    for (let i = 0; i < h.arg(1); i++) h.write8(h.arg(0) + i, 0);
  },
  memcmp: (h) => sign(compare(h, h.arg(0), h.arg(1), h.arg(2), false, false)),
  memchr: (h) => {
    const s = h.arg(0), c = h.arg(1) & 0xff, n = h.arg(2);
    for (let i = 0; i < n; i++) if (h.read8(s + i) === c) return s + i;
    return 0;
  },
  memrchr: (h) => {
    const s = h.arg(0), c = h.arg(1) & 0xff, n = h.arg(2);
    for (let i = n - 1; i >= 0; i--) if (h.read8(s + i) === c) return s + i;
    return 0;
  },
  memccpy: (h) => {
    const d = h.arg(0), s = h.arg(1), c = h.arg(2) & 0xff, n = h.arg(3);
    for (let i = 0; i < n; i++) {
      const b = h.read8(s + i);
      h.write8(d + i, b);
      if (b === c) return d + i + 1;
    }
    return 0;
  },
  // --------------------------------------------------------------- strings
  strlen: (h) => strlen(h, h.arg(0)),
  strnlen: (h) => {
    let n = 0;
    while (n < h.arg(1) && h.read8(h.arg(0) + n)) n++;
    return n;
  },
  strcpy: (h) => { copy(h, h.arg(0), h.arg(1), strlen(h, h.arg(1)) + 1); return h.arg(0); },
  strncpy: (h) => {
    const d = h.arg(0), s = h.arg(1), n = h.arg(2);
    let i = 0;
    for (; i < n; i++) {
      const b = h.read8(s + i);
      h.write8(d + i, b);
      if (!b) break;
    }
    for (; i < n; i++) h.write8(d + i, 0);
    return d;
  },
  strcat: (h) => { copy(h, h.arg(0) + strlen(h, h.arg(0)), h.arg(1), strlen(h, h.arg(1)) + 1); return h.arg(0); },
  strncat: (h) => {
    const d = h.arg(0) + strlen(h, h.arg(0)), s = h.arg(1), n = h.arg(2);
    let i = 0;
    for (; i < n; i++) {
      const b = h.read8(s + i);
      if (!b) break;
      h.write8(d + i, b);
    }
    h.write8(d + i, 0);
    return h.arg(0);
  },
  strlcpy: (h) => {
    const d = h.arg(0), s = h.arg(1), size = h.arg(2);
    const n = strlen(h, s);
    if (size) {
      const k = Math.min(n, size - 1);
      copy(h, d, s, k);
      h.write8(d + k, 0);
    }
    return n;
  },
  strlcat: (h) => {
    const d = h.arg(0), s = h.arg(1), size = h.arg(2);
    let dl = 0;
    while (dl < size && h.read8(d + dl)) dl++;
    const sl = strlen(h, s);
    if (dl === size) return size + sl;
    const k = Math.min(sl, size - dl - 1);
    copy(h, d + dl, s, k);
    h.write8(d + dl + k, 0);
    return dl + sl;
  },
  strcmp: (h) => sign(compare(h, h.arg(0), h.arg(1), MAX_SCAN, false, true)),
  strcoll: (h) => sign(compare(h, h.arg(0), h.arg(1), MAX_SCAN, false, true)),
  strncmp: (h) => sign(compare(h, h.arg(0), h.arg(1), h.arg(2), false, true)),
  strcasecmp: (h) => sign(compare(h, h.arg(0), h.arg(1), MAX_SCAN, true, true)),
  strncasecmp: (h) => sign(compare(h, h.arg(0), h.arg(1), h.arg(2), true, true)),
  strchr: (h) => {
    const s = h.arg(0), c = h.arg(1) & 0xff;
    for (let i = 0; i < MAX_SCAN; i++) {
      const b = h.read8(s + i);
      if (b === c) return s + i;
      if (!b) return 0;
    }
    return 0;
  },
  strrchr: (h) => {
    const s = h.arg(0), c = h.arg(1) & 0xff;
    let found = 0;
    for (let i = 0; i < MAX_SCAN; i++) {
      const b = h.read8(s + i);
      if (b === c) found = s + i;
      if (!b) break;
    }
    return found;
  },
  strstr: (h) => find(h, h.arg(0), h.arg(1), false),
  strcasestr: (h) => find(h, h.arg(0), h.arg(1), true),
  strspn: (h) => {
    const set = new Set(cstr(h, h.arg(1)));
    let n = 0;
    while (set.has(h.read8(h.arg(0) + n))) n++;
    return n;
  },
  strcspn: (h) => {
    const set = new Set(cstr(h, h.arg(1)));
    let n = 0;
    for (;;) {
      const b = h.read8(h.arg(0) + n);
      if (!b || set.has(b)) return n;
      n++;
    }
  },
  strsep: (h) => {
    const sp = h.arg(0);
    const s = h.read32(sp);
    if (!s) return 0;
    const set = new Set(cstr(h, h.arg(1)));
    for (let i = 0; ; i++) {
      const b = h.read8(s + i);
      if (b === 0) {
        h.write32(sp, 0);
        return s;
      }
      if (set.has(b)) {
        h.write8(s + i, 0);
        h.write32(sp, s + i + 1);
        return s;
      }
    }
  },
  strtok_r: (h) => {
    const set = new Set(cstr(h, h.arg(1)));
    const save = h.arg(2);
    let s = h.arg(0) || h.read32(save);
    if (!s) return 0;
    while (h.read8(s) && set.has(h.read8(s))) s++;
    if (!h.read8(s)) {
      h.write32(save, s);
      return 0;
    }
    let e = s;
    while (h.read8(e) && !set.has(h.read8(e))) e++;
    if (h.read8(e)) {
      h.write8(e, 0);
      e++;
    }
    h.write32(save, e);
    return s;
  },
  strlwr: (h) => {
    for (let i = 0, b = h.read8(h.arg(0)); b; b = h.read8(h.arg(0) + ++i)) h.write8(h.arg(0) + i, lower(b));
    return h.arg(0);
  },
  strupr: (h) => {
    for (let i = 0, b = h.read8(h.arg(0)); b; b = h.read8(h.arg(0) + ++i)) h.write8(h.arg(0) + i, upper(b));
    return h.arg(0);
  },
  // --------------------------------------------------------------- numbers
  atoi: (h) => parseInteger(h, h.arg(0), 0, 10, false),
  atol: (h) => parseInteger(h, h.arg(0), 0, 10, false),
  strtol: (h) => parseInteger(h, h.arg(0), h.arg(1), h.arg(2), false),
  strtoul: (h) => parseInteger(h, h.arg(0), h.arg(1), h.arg(2), true),
  itoa: (h) => writeNumber(h, h.arg(0), h.arg(1), h.arg(2) || 10, true),
  utoa: (h) => writeNumber(h, h.arg(0), h.arg(1), h.arg(2) || 10, false),
  abs: (h) => Math.abs(h.arg(0) | 0) | 0,
  labs: (h) => Math.abs(h.arg(0) | 0) | 0,
  div: (h) => {
    const n = h.arg(0) | 0, d = h.arg(1) | 0;
    return d ? [(n / d) | 0, n % d] : [0, 0];
  },
  ldiv: (h) => {
    const n = h.arg(0) | 0, d = h.arg(1) | 0;
    return d ? [(n / d) | 0, n % d] : [0, 0];
  },
  rand: () => {
    randState = BigInt.asUintN(64, randState * 6364136223846793005n + 1n);
    return Number((randState >> 32n) & 0x7fffffffn);
  },
  srand: (h) => { randState = BigInt(h.arg(0) >>> 0); },
  rand_r: (h) => {
    // newlib's rand_r: Park-Miller "minimal standard" on a 31-bit state.
    let x = h.read32(h.arg(0)) | 0;
    if (x === 0) x = 0x12345987;
    const k = Math.trunc(x / 127773);
    x = 16807 * (x - k * 127773) - 2836 * k;
    if (x < 0) x += 2147483647;
    h.write32(h.arg(0), x >>> 0);
    return x & 0x7fffffff;
  },
  toupper: (h) => upper(h.arg(0) & 0xff),
  tolower: (h) => lower(h.arg(0) & 0xff),
  toascii: (h) => h.arg(0) & 0x7f,
  isalnum: ctype((c) => isAlpha(c) || isDigit(c)),
  isalpha: ctype(isAlpha),
  isascii: ctype((c) => c < 128),
  isblank: ctype((c) => c === 0x20 || c === 0x09),
  iscntrl: ctype((c) => c < 0x20 || c === 0x7f),
  isdigit: ctype(isDigit),
  isgraph: ctype((c) => c > 0x20 && c < 0x7f),
  islower: ctype((c) => c >= 97 && c <= 122),
  isprint: ctype((c) => c >= 0x20 && c < 0x7f),
  ispunct: ctype((c) => c > 0x20 && c < 0x7f && !isAlpha(c) && !isDigit(c)),
  isspace: ctype((c) => SPACE.has(c)),
  isupper: ctype((c) => c >= 65 && c <= 90),
  // --------------------------------------------------------------- the core
  xthal_get_ccount: (h) => h.core.ccount,
  xthal_get_ccompare: (h) => h.core.ccompare[h.arg(0) % 3],
  xthal_set_ccompare: (h) => { h.core.wsr(240 + (h.arg(0) % 3), h.arg(1)); },
  xthal_get_interrupt: (h) => h.core.interrupt,
  xthal_set_intclear: (h) => { h.core.wsr(227, h.arg(0)); },
  _xtos_ints_on: (h) => {
    const old = h.core.intenable;
    h.core.intenable = (old | h.arg(0)) >>> 0;
    return old;
  },
  _xtos_ints_off: (h) => {
    const old = h.core.intenable;
    h.core.intenable = (old & ~h.arg(0)) >>> 0;
    return old;
  },
  _xtos_restore_intlevel: (h) => { h.ps = (h.ps & ~0xf) | (h.arg(0) & 0xf); },
  ets_isr_mask: (h) => { h.core.intenable = (h.core.intenable & ~h.arg(0)) >>> 0; },
  ets_isr_unmask: (h) => { h.core.intenable = (h.core.intenable | h.arg(0)) >>> 0; },
  // --------------------------------------------------------------- clocks
  ets_get_apb_freq: () => 80_000_000,
  ets_get_xtal_div: () => 1,
  esp_rom_set_cpu_ticks_per_us: (h) => { h.state.cpuTicksPerUs = h.arg(0); },
  uart_tx_wait_idle: () => {},
  uart_div_modify: () => {},
  rtc_get_wakeup_cause: () => 0,
  // --------------------------------------------------------------- cache (no model of its contents is needed)
  Cache_Suspend_ICache: () => 0,
  rom_Cache_Suspend_ICache: () => 0,
  Cache_Suspend_DCache: () => 0,
  rom_Cache_Suspend_DCache: () => 0,
  Cache_Resume_ICache: () => {},
  Cache_Resume_DCache: () => {},
  Cache_Suspend_DCache_Autoload: () => 0,
  Cache_Resume_DCache_Autoload: () => {},
  Cache_Invalidate_ICache_All: () => {},
  Cache_Invalidate_DCache_All: () => {},
  Cache_Invalidate_Addr: () => {},
  Cache_WriteBack_All: () => {},
  rom_Cache_WriteBack_Addr: () => {},
  Cache_Disable_ICache: () => 0,
  Cache_Disable_DCache: () => 0,
  Cache_Enable_ICache: () => {},
  Cache_Enable_DCache: () => {},
  rom_Cache_Freeze_ICache_Enable: () => {},
  rom_Cache_Freeze_DCache_Enable: () => {},
  Cache_Freeze_ICache_Disable: () => {},
  Cache_Freeze_DCache_Disable: () => {},
  Cache_Get_ICache_Line_Size: () => 32,
  Cache_Get_DCache_Line_Size: () => 32,
  Cache_Set_IDROM_MMU_Size: () => {},
  Cache_Set_IDROM_MMU_Info: () => {},
  Cache_Occupy_ICache_MEMORY: () => 0,
  Cache_Occupy_DCache_MEMORY: () => 0,
  Cache_Set_ICache_Mode: () => {},
  Cache_Set_DCache_Mode: () => {},
  Cache_Get_Mode: () => 0,
  rom_config_instruction_cache_mode: () => {},
  rom_config_data_cache_mode: () => {},
  // --------------------------------------------------------------- watchdogs: configured, never biting
  wdt_hal_init: (h) => {
    // wdt_hal_context_t { inst; dev }: MWDT0, MWDT1 or the RTC watchdog.
    const inst = h.arg(1);
    h.write32(h.arg(0), inst);
    h.write32(h.arg(0) + 4, inst === 0 ? 0x6001f000 : inst === 1 ? 0x60020000 : 0x60008000);
  },
  wdt_hal_deinit: () => {},
  wdt_hal_config_stage: () => {},
  wdt_hal_write_protect_disable: () => {},
  wdt_hal_write_protect_enable: () => {},
  wdt_hal_enable: () => {},
  wdt_hal_disable: () => {},
  wdt_hal_handle_intr: () => {},
  wdt_hal_feed: () => {},
  wdt_hal_set_flashboot_en: () => {},
  wdt_hal_is_enabled: () => 0,
  disable_default_watchdog: () => {},
  // --------------------------------------------------------------- eFuse: a plain part with nothing burnt
  ets_efuse_get_spiconfig: () => 0,
  ets_efuse_flash_octal_mode: () => 0,
  ets_efuse_get_flash_delay_us: () => 0,
  ets_efuse_get_wp_pad: () => 0xff,
  ets_efuse_secure_boot_enabled: () => 0,
  ets_efuse_cache_encryption_enabled: () => 0,
  ets_efuse_usb_serial_jtag_print_is_disabled: () => 0,
  ets_efuse_usb_print_is_disabled: () => 0,
  ets_efuse_download_modes_disabled: () => 0,
  esp_rom_efuse_get_flash_gpio_info: () => 0,
  esp_rom_efuse_get_flash_wp_gpio: () => 0xff,
  // --------------------------------------------------------------- flash driver set-up the IDF asks the ROM for
  esp_rom_spiflash_config_param: () => 0,
  esp_rom_spiflash_config_clk: () => 0,
  esp_rom_spiflash_config_readmode: () => 0,
  esp_rom_spiflash_wait_idle: () => 0,
  esp_rom_spiflash_select_qio_pins: () => {},
  esp_rom_spiflash_write_enable: () => 0,
  esp_rom_opiflash_pin_config: () => {},
  esp_rom_opiflash_legacy_driver_init: () => {},
  esp_rom_spi_set_op_mode: () => {},
  esp_rom_spi_set_dtr_swap_mode: () => {},
  // --------------------------------------------------------------- the rest of startup
  rtc_unhold_all_pads: () => {},
  rtc_select_apb_bridge: () => 0,
  ets_apb_backup_init_lock_func: () => {},
  esp_rom_newlib_init_common_mutexes: () => {},
  ets_install_lock: () => {},
  ets_get_printf_channel: () => 0,
  ets_is_print_boot: () => 0,
  analog_super_wdt_reset_happened: () => 0,
  jtag_cpu_reset_happened: () => 0,
  clear_super_wdt_reset_flag: () => {},
  esp_rom_get_rtc_wake_addr: () => 0,
  esp_rom_set_rtc_wake_addr: () => {},
};

/** Names the S3's ROM gives a routine the ESP32 table knows under another. */
export const S3_ALIASES: Record<string, string> = {
  ets_update_cpu_frequency: 'ets_update_cpu_frequency_rom',
  ets_get_xtal_freq: 'ets_get_detected_xtal_freq',
  MD5Init: 'esp_rom_md5_init',
  MD5Update: 'esp_rom_md5_update',
  MD5Final: 'esp_rom_md5_final',
};

/** The handler for an S3 ROM symbol, if one is provided. */
export function s3Handler(name: string): RomHandler | undefined {
  return (S3_ONLY[name] as RomHandler | undefined) ?? ROM_HANDLERS.get(S3_ALIASES[name] ?? name);
}
