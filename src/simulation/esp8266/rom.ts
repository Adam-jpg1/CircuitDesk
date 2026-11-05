// The ESP8266 mask-ROM routines an Arduino build calls, provided natively.
//
// Addresses are the SDK's eagle.rom.addr.v6.ld. The general routines — the
// libgcc soft-float and 64-bit helpers, memcpy and friends, ets_printf, MD5 —
// are the ones the ESP32 runtime already provides (../esp32/rom), whose
// handlers read their arguments and return through the core's CALL0 ABI just
// as well. What is the ESP8266's own is here: the ROM's task scheduler
// (ets_task / ets_post / ets_run), its interrupt table (ets_isr_attach) and
// level-1 dispatcher, the flash routines, and the cache window.
//
// Two pieces of the ROM are machine code rather than native routines, since
// they call back into firmware: the level-1 interrupt dispatcher the user
// exception vector jumps to, and ets_run's loop. Both are a few dozen
// instructions (ROM_GLUE below), and each asks a native hook what to call
// next, so the scheduling decisions stay here.

import type { Esp32RomEntry, Esp32RomHost, RomResult } from '../esp32/rom';
import { ROM_HANDLERS } from '../esp32/rom';
import { s3Handler } from '../esp32s3/romRoutines';

/** Where ROM_GLUE sits, and its entry points. */
export const GLUE_AT = 0x4000f000;
export const L1INT_AT = 0x4000f008;
export const ETS_RUN_LOOP_AT = 0x4000f0a0;
/** Native hooks ROM_GLUE calls. */
export const HOOK_NEXT_INTERRUPT = 0x4000f800;
export const HOOK_NEXT_TASK = 0x4000f804;
/** Where an exception nothing handles goes. */
export const HOOK_UNHANDLED = 0x4000f808;
/**
 * The table phy_get_romfuncs returns, and the stubs it points at. It must be
 * RAM: the SDK's register_chipv6_phy replaces many entries with its own
 * routines. The ROM keeps it among its own data below the flash descriptor.
 */
export const PHY_TABLE_AT = 0x3fffc300;
/** In ROM space no routine of ESP8266_ROM_ADDRESSES occupies (0x4000e400-0x4000e800). */
export const PHY_STUBS_AT = 0x4000e400;
export const PHY_TABLE_ENTRIES = 256;

/**
 * The glue, assembled from:
 *
 *   lit_int:  .word HOOK_NEXT_INTERRUPT
 *   lit_task: .word HOOK_NEXT_TASK
 *   l1int:    save a0, a5..a15 at a1+0, 32..72; SAR at 12, EPC1 at 4, PS at 8
 *             (the vector saved a2..a4 at 20..28 and moved a1 down 256)
 *             wsr ps = 0x21 (level 1 masked, exceptions allowed); rsync
 *        1:   l32r a3, lit_int; callx0 a3      -> a2 arg, a3 frame, a4 handler
 *             beqz a4, 2f; callx0 a4; j 1b
 *        2:   restore PS, EPC1, SAR, a0, a2..a15; addmi a1, a1, 256; rfe
 *   etsrun:
 *        3:   l32r a3, lit_task; callx0 a3     -> a2 arg, a4 function or 0
 *             beqz a4, 4f; callx0 a4; j 3b
 *        4:   waiti 0; j 3b
 */
export const ROM_GLUE = new Uint8Array([
  0x00, 0xf8, 0x00, 0x40, 0x04, 0xf8, 0x00, 0x40, 0x02, 0x61, 0x00, 0x52, 0x61, 0x08, 0x62, 0x61, 0x09, 0x72, 0x61, 0x0a,
  0x82, 0x61, 0x0b, 0x92, 0x61, 0x0c, 0xa2, 0x61, 0x0d, 0xb2, 0x61, 0x0e, 0xc2, 0x61, 0x0f, 0xd2, 0x61, 0x10, 0xe2, 0x61,
  0x11, 0xf2, 0x61, 0x12, 0x20, 0x03, 0x03, 0x22, 0x61, 0x03, 0x20, 0xb1, 0x03, 0x22, 0x61, 0x01, 0x20, 0xe6, 0x03, 0x22,
  0x61, 0x02, 0x22, 0xa0, 0x21, 0x20, 0xe6, 0x13, 0x10, 0x20, 0x00, 0x31, 0xee, 0xff, 0xc0, 0x03, 0x00, 0x16, 0x54, 0x00,
  0xc0, 0x04, 0x00, 0x06, 0xfc, 0xff, 0x22, 0x21, 0x02, 0x20, 0xe6, 0x13, 0x10, 0x20, 0x00, 0x22, 0x21, 0x01, 0x20, 0xb1,
  0x13, 0x22, 0x21, 0x03, 0x20, 0x03, 0x13, 0x02, 0x21, 0x00, 0x22, 0x21, 0x05, 0x32, 0x21, 0x06, 0x42, 0x21, 0x07, 0x52,
  0x21, 0x08, 0x62, 0x21, 0x09, 0x72, 0x21, 0x0a, 0x82, 0x21, 0x0b, 0x92, 0x21, 0x0c, 0xa2, 0x21, 0x0d, 0xb2, 0x21, 0x0e,
  0xc2, 0x21, 0x0f, 0xd2, 0x21, 0x10, 0xe2, 0x21, 0x11, 0xf2, 0x21, 0x12, 0x12, 0xd1, 0x01, 0x00, 0x30, 0x00, 0x00, 0x00,
  0x31, 0xd9, 0xff, 0xc0, 0x03, 0x00, 0x16, 0x54, 0x00, 0xc0, 0x04, 0x00, 0x06, 0xfc, 0xff, 0x00, 0x70, 0x00, 0x86, 0xfa,
  0xff,
]);

/** ROM routine addresses (eagle.rom.addr.v6.ld) of everything an Arduino build links against. */
export const ESP8266_ROM_ADDRESSES: Record<string, number> = {
  _xtos_set_exception_handler: 0x40000454, __muldi3: 0x40000650, ets_set_idle_cb: 0x40000dc0, ets_task: 0x40000dd0,
  ets_run: 0x40000e04, ets_post_rom: 0x40000e24, ets_isr_attach: 0x40000f88, ets_isr_mask: 0x40000f98, ets_isr_unmask: 0x40000fa8,
  boot_from_flash: 0x40001308, ets_memset: 0x400018a4, ets_memcpy: 0x400018b4, ets_memmove: 0x400018c4, ets_memcmp: 0x400018d4,
  ets_write_char: 0x40001da0, ets_uart_putc1: 0x40001dcc, ets_vprintf: 0x40001f00, ets_install_putc1: 0x4000242c,
  ets_install_uart_printf: 0x40002438, ets_printf: 0x400024cc, rtc_get_reset_reason: 0x400025e0, ets_strcpy: 0x40002a88,
  ets_strncpy: 0x40002a98, ets_strncmp: 0x40002ab8, ets_strlen: 0x40002ac8, ets_bzero: 0x40002ae8, ets_putc: 0x40002be8,
  ets_delay_us: 0x40002ecc, ets_update_cpu_frequency: 0x40002f04, ets_get_cpu_frequency: 0x40002f0c, roundup2: 0x400031b4,
  UartDwnLdProc: 0x40003368, uartAttach: 0x4000383c, uart_buff_switch: 0x400038a4, uart_baudrate_detect: 0x40003924,
  rom_uart_div_modify: 0x400039d8, Uart_Init: 0x40003a14, SPI_read_status: 0x400043c8, SPI_write_status: 0x40004400,
  SPI_write_enable: 0x4000443c, Wait_SPI_Idle: 0x4000448c, Enable_QMode: 0x400044c0, Cache_Read_Enable: 0x40004678,
  Cache_Read_Disable: 0x400047f0, SPIEraseSector: 0x40004a00, SPIWrite: 0x40004a4c, SPIRead: 0x40004b1c,
  gpio_output_set: 0x40004cd0, gpio_input_get: 0x40004cf0, gpio_pin_wakeup_enable: 0x40004e90, gpio_pin_wakeup_disable: 0x40004ed4,
  lldesc_build_chain: 0x40004f40, lldesc_num2link: 0x40005050, rom_chip_v5_disable_cca: 0x400060d0, rom_chip_v5_enable_cca: 0x400060ec,
  phy_get_romfuncs: 0x40006b08, MD5Init: 0x40009818, MD5Update: 0x40009834, MD5Final: 0x40009900, strcmp: 0x4000bdc8,
  strlen: 0x4000bf4c, strncmp: 0x4000bfa8, __addsf3: 0x4000c180, __subsf3: 0x4000c268, __mulsf3: 0x4000c3dc,
  __fixunssfsi: 0x4000c4c4, __adddf3: 0x4000c538, __subdf3: 0x4000c688, __muldf3: 0x4000c8f0, __divdf3: 0x4000cb94,
  __fixdfsi: 0x4000ccb8, __fixunsdfsi: 0x4000cd00, __truncdfsf2: 0x4000cd5c, __extendsfdf2: 0x4000cdfc, __divdi3: 0x4000ce60,
  __udivdi3: 0x4000d310, __umoddi3: 0x4000d770, __divsi3: 0x4000dc88, __umulsidi3: 0x4000dcf0, memcmp: 0x4000dea8,
  memcpy: 0x4000df48, memmove: 0x4000e04c, memset: 0x4000e190, strstr: 0x4000e1e0, __udivsi3: 0x4000e21c,
  __umodsi3: 0x4000e268, __floatunsisf: 0x4000e2a4, __floatsisf: 0x4000e2ac, __floatunsidf: 0x4000e2e8, __floatsidf: 0x4000e2f0,
};

/** Data the ROM owns in DRAM, which firmware links against (eagle.rom.addr.v6.ld). */
export const ROM_DATA = {
  excHandlerTable: 0x3fffc000,
  cHandlerTable: 0x3fffc100,
  flashchip: 0x3fffc714,
  /**
   * The digit strings the ROM's data initialisation leaves here, lower case
   * then upper, which the SDK's own ets_vsnprintf formats numbers with: %x
   * reads the first, %X (its LARGE flag) the second. It reaches them by
   * address; nothing names them.
   */
  digitsLower: 0x3fffd848,
  digitsUpper: 0x3fffd85c,
} as const;

/** ROM routines that are their ESP32 namesakes. */
const SAME_AS: Record<string, string> = {
  ets_memset: 'memset', ets_memcpy: 'memcpy', ets_memmove: 'memmove', ets_memcmp: 'memcmp', ets_strcpy: 'strcpy',
  ets_strncpy: 'strncpy', ets_strncmp: 'strncmp', ets_strlen: 'strlen', ets_bzero: 'bzero', ets_post_rom: 'ets_post',
};

export type Esp8266Handler = (h: Esp32RomHost) => RomResult;

/** The shared handler for a routine name, if the ESP32 runtime has one. */
export function sharedHandler(name: string): Esp8266Handler | undefined {
  const n = SAME_AS[name] ?? name;
  return ROM_HANDLERS.get(n) ?? s3Handler(n);
}

export type { Esp32RomEntry };
