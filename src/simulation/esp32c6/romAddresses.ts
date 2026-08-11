// ESP32-C6 mask-ROM entry point addresses.
//
// The C6 publishes its ROM symbol addresses in ESP-IDF's linker scripts, the
// same way the C3 does, and this table is taken from those. It contains
// addresses only: no ROM code, no ROM binary, and nothing derived from one. The
// behaviour behind each address is implemented independently, exactly as it is
// for the C3.
//
// The reason this file exists at all is that almost none of these addresses
// match the C3's. memset sits at 0x40000354 on a C3 and 0x400004A8 here; qsort
// moves from 0x40000434 to 0x40000588. Binding the C3 table to a C6 would send
// every call to the wrong function, and the failures would look like emulator
// bugs rather than like what they are.
//
// The C6 also publishes the classic ets_/uart_ names where the C3 publishes
// newer esp_rom_ aliases. Those appear under the name the runtime already
// implements them as, so an implementation can be shared without renaming it.

/** C6 ROM entry points, keyed by the name the runtime implements them under. */
export const ESP32C6_ROM_ADDRESSES: Record<string, number> = {
  Cache_Enable_ICache: 0x40000694,
  Cache_Freeze_ICache_Disable: 0x400006a4,
  Cache_Freeze_ICache_Enable: 0x400006a0,
  Cache_Invalidate_Addr: 0x40000648,
  Cache_Invalidate_ICache_All: 0x4000064c,
  Cache_Resume_ICache: 0x4000069c,
  Cache_Set_IDROM_MMU_Size: 0x400006a8,
  Cache_Suspend_ICache: 0x40000698,
  MD5Final: 0x40000754,
  MD5Init: 0x4000074c,
  MD5Update: 0x40000750,
  __ashldi3: 0x4000089c,
  __ashrdi3: 0x400008a0,
  __bswapsi2: 0x400008a8,
  __clzsi2: 0x400008bc,
  __cmpdi2: 0x400008c0,
  __ctzsi2: 0x400008c8,
  __divdi3: 0x400008d4,
  __ffsdi2: 0x400008f0,
  __ffssi2: 0x400008f4,
  __lshrdi3: 0x40000950,
  __moddi3: 0x4000095c,
  __muldi3: 0x4000096c,
  __negdi2: 0x4000098c,
  __popcountsi2: 0x400009a8,
  __ucmpdi2: 0x400009c8,
  __udivdi3: 0x400009cc,
  __umoddi3: 0x400009dc,
  abs: 0x40000578,
  atoi: 0x400005a0,
  bzero: 0x400004d0,
  crc16_be: 0x40000768,
  crc16_le: 0x4000075c,
  crc32_be: 0x40000764,
  crc32_le: 0x40000758,
  div: 0x4000057c,
  esp_coex_rom_version_get: 0x40000afc,
  esp_rom_newlib_init_common_mutexes: 0x400004a4,
  ets_get_cpu_frequency: 0x40000044,
  ets_install_putc1: 0x4000002c,
  isalnum: 0x400004dc,
  isascii: 0x400004e4,
  isblank: 0x400004e8,
  iscntrl: 0x400004ec,
  isgraph: 0x400004f8,
  isprint: 0x400004fc,
  ispunct: 0x40000500,
  isspace: 0x40000504,
  itoa: 0x4000059c,
  labs: 0x40000580,
  ldiv: 0x40000584,
  memccpy: 0x40000518,
  memchr: 0x4000051c,
  memrchr: 0x40000520,
  memset: 0x400004a8,
  qsort: 0x40000588,
  rand: 0x40000590,
  srand: 0x40000594,
  strcasestr: 0x40000528,
  strcat: 0x4000052c,
  strchr: 0x40000534,
  strcspn: 0x40000538,
  strlcat: 0x40000540,
  strlcpy: 0x40000544,
  strlen: 0x400004c8,
  strncat: 0x40000550,
  strnlen: 0x40000558,
  strrchr: 0x4000055c,
  strsep: 0x40000560,
  strspn: 0x40000564,
  strstr: 0x400004cc,
  strtok_r: 0x40000568,
  strtol: 0x400005a8,
  toascii: 0x40000514,
  tolower: 0x40000510,
  toupper: 0x4000050c,
  uart_div_modify: 0x4000007c,
  utoa: 0x40000598,
  // Published as ets_delay_us on this part.
  esp_rom_delay_us: 0x40000040,
  // Published as ets_printf on this part.
  esp_rom_printf: 0x40000028,
  // Published as uart_tx_one_char on this part.
  esp_rom_output_tx_one_char: 0x40000058,
  // Published as uart_tx_wait_idle on this part.
  esp_rom_output_tx_wait_idle: 0x40000078,
  // Published as uart_rx_one_char on this part.
  esp_rom_output_rx_one_char: 0x40000060,
  // Published as intr_matrix_set on this part.
  esp_rom_route_intr_matrix: 0x40000730,
  // Published as rtc_get_reset_reason on this part.
  esp_rom_get_reset_reason: 0x40000018,
};

/**
 * Implemented for the C3 but not published by the C6's linker scripts.
 *
 * Recorded rather than silently dropped. Each is either genuinely absent on
 * this part — the C6 has a different interrupt controller and different analog
 * register access than the C3 — or published under a name not yet identified.
 * Either way a caller reaching one must fail loudly rather than land on a
 * neighbouring address.
 */
export const NOT_PUBLISHED_ON_C6: string[] = [
  'esp_rom_efuse_get_flash_gpio_info',
  'esp_rom_efuse_get_flash_wp_gpio',
  'esp_rom_output_flush_tx',
  'esp_rom_regi2c_read',
  'esp_rom_regi2c_read_mask',
  'esp_rom_regi2c_write',
  'esp_rom_regi2c_write_mask',
  'esp_rom_set_cpu_ticks_per_us',
  'esprv_int_disable',
  'esprv_int_enable',
  'esprv_int_set_priority',
  'esprv_int_set_threshold',
  'esprv_int_set_type',
  'ets_apb_backup_init_lock_func',
];
