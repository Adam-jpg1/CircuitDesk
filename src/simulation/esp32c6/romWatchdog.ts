// The ESP32-C6's ROM watchdog HAL.
//
// The C3 links its watchdog HAL into the application; the C6's mask ROM
// publishes it, and ESP-IDF calls the ROM copy. So this is a family of entry
// points the C3 runtime has no counterpart for at all — it cannot be shared,
// borrowed or renamed into place, and every one of them has to exist before a
// C6 gets through startup. `wdt_hal_write_protect_disable` at 0x400003a0 is
// where real C6 firmware stopped without them.
//
// These are independent implementations, written from the register definitions
// in `soc/esp32c6/register/soc/{timer_group,lp_wdt}_reg.h` and the field
// meanings in `hal/esp32c6/include/hal/{mwdt,lpwdt}_ll.h`. No ROM code was
// read, disassembled or copied; what is reproduced is the documented effect on
// documented registers.
//
// The point of doing it properly rather than returning success is that firmware
// reads these registers back. `wdt_hal_is_enabled` asks the hardware, not the
// HAL, and a startup that disables a watchdog and then confirms it must see the
// bit it just cleared.

import type { Bus } from '../riscv/rv32Core';
import type { RomFunction, RomHandler } from '../esp32c3/romFunctions';

/**
 * `wdt_hal_context_t`, as `hal/include/hal/wdt_hal.h` declares it:
 *
 *   struct { wdt_inst_t inst; union { timg_dev_t *mwdt_dev; rwdt_dev_t *rwdt_dev; }; }
 *
 * so the instance is the first word and the device pointer the second.
 */
const CONTEXT_INST = 0x00;
const CONTEXT_DEV = 0x04;

/** `wdt_inst_t`. */
const WDT_RWDT = 0;

/**
 * Register offsets within each kind of watchdog.
 *
 * The two are laid out differently — the MWDT sits partway into a timer group,
 * the RWDT owns its own block from offset zero — which is why the offsets are
 * per-instance rather than shared.
 */
const MWDT = {
  config0: 0x48,
  stage: [0x4c, 0x50, 0x54, 0x58] as const,
  feed: 0x60,
  writeProtect: 0x64,
  enable: 1 << 31,
  flashboot: 1 << 14,
  /** WDT_STG0..3 occupy two bits each, from bit 28 downwards. */
  stageShift: [28, 26, 24, 22] as const,
  stageMask: 0x3,
} as const;

const RWDT = {
  config0: 0x00,
  stage: [0x04, 0x08, 0x0c, 0x10] as const,
  feed: 0x14,
  writeProtect: 0x18,
  enable: 1 << 31,
  flashboot: 1 << 12,
  /** WDT_STG0..3 occupy three bits each, from bit 28 downwards. */
  stageShift: [28, 25, 22, 19] as const,
  stageMask: 0x7,
} as const;

/**
 * TIMG_WDT_WKEY_VALUE and LP_WDT_WKEY_VALUE, which are the same constant.
 * (`soc/include/soc/wdt_periph.h`, `hal/esp32c6/include/hal/lpwdt_ll.h`.)
 */
export const WDT_WRITE_PROTECT_KEY = 0x50d83aa1;

type WdtLayout = typeof MWDT | typeof RWDT;

interface WdtTarget {
  dev: number;
  layout: WdtLayout;
}

/** Reads the HAL context the caller passed and resolves which watchdog it names. */
function targetOf(bus: Bus, context: number): WdtTarget {
  const inst = bus.readUint32((context + CONTEXT_INST) >>> 0);
  const dev = bus.readUint32((context + CONTEXT_DEV) >>> 0) >>> 0;
  return { dev, layout: inst === WDT_RWDT ? RWDT : MWDT };
}

const read = (bus: Bus, t: WdtTarget, offset: number): number => bus.readUint32((t.dev + offset) >>> 0) >>> 0;
const write = (bus: Bus, t: WdtTarget, offset: number, value: number): void =>
  bus.writeUint32((t.dev + offset) >>> 0, value >>> 0);

/** Sets or clears bits in CONFIG0, which is where every enable lives. */
function updateConfig0(bus: Bus, t: WdtTarget, set: number, clear: number): void {
  const value = (read(bus, t, t.layout.config0) & ~clear) | set;
  write(bus, t, t.layout.config0, value);
}

const writeProtectDisable: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  write(bus, t, t.layout.writeProtect, WDT_WRITE_PROTECT_KEY);
};

const writeProtectEnable: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  // Anything other than the key re-arms the protection; zero is what the HAL
  // writes.
  write(bus, t, t.layout.writeProtect, 0);
};

const enable: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  updateConfig0(bus, t, t.layout.enable, 0);
};

const disable: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  updateConfig0(bus, t, 0, t.layout.enable);
};

const isEnabled: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  return (read(bus, t, t.layout.config0) & t.layout.enable) !== 0 ? 1 : 0;
};

const setFlashbootEnable: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  const on = (args[1] & 1) !== 0;
  updateConfig0(bus, t, on ? t.layout.flashboot : 0, on ? 0 : t.layout.flashboot);
};

const feed: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  // The feed register is write-triggered; any write reloads the counter.
  write(bus, t, t.layout.feed, 1);
};

/**
 * `wdt_hal_config_stage(hal, stage, timeout_ticks, behavior)`.
 *
 * Each stage has a timeout register of its own and a behaviour field packed
 * into CONFIG0. Writing the timeout without the behaviour, or the other way
 * round, leaves the watchdog configured differently from what was asked for and
 * a firmware read-back would say so.
 */
const configStage: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  const stage = args[1] & 0x3;
  const timeout = args[2] >>> 0;
  const behaviour = args[3] & t.layout.stageMask;
  write(bus, t, t.layout.stage[stage], timeout);
  const shift = t.layout.stageShift[stage];
  updateConfig0(bus, t, behaviour << shift, t.layout.stageMask << shift);
};

/**
 * `wdt_hal_init(hal, wdt_inst, prescaler, enable_intr)`.
 *
 * Fills in the caller's context and leaves the watchdog disabled with its
 * write protection back on, which is the state the HAL documents on return.
 * The device address is chosen from the instance, exactly as the HAL does.
 */
const init: RomHandler = ({ args, bus }) => {
  const context = args[0] >>> 0;
  const inst = args[1] | 0;
  const dev = inst === WDT_RWDT ? LP_WDT_BASE : inst === 1 ? TIMG0_BASE : TIMG1_BASE;
  bus.writeUint32((context + CONTEXT_INST) >>> 0, inst >>> 0);
  bus.writeUint32((context + CONTEXT_DEV) >>> 0, dev >>> 0);
  const t = targetOf(bus, context);
  write(bus, t, t.layout.writeProtect, WDT_WRITE_PROTECT_KEY);
  updateConfig0(bus, t, 0, t.layout.enable | t.layout.flashboot);
  if (t.layout === MWDT) {
    // MWDT_LL_CONFIG1: the clock prescaler, which the RWDT has no counterpart
    // for because it runs from the slow clock directly.
    write(bus, t, 0x4c, (args[2] & 0xffff) << 16);
  }
  write(bus, t, t.layout.writeProtect, 0);
};

const deinit: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  write(bus, t, t.layout.writeProtect, WDT_WRITE_PROTECT_KEY);
  updateConfig0(bus, t, 0, t.layout.enable);
  write(bus, t, t.layout.writeProtect, 0);
};

/** Clearing the interrupt and reloading, which is all the HAL's handler does. */
const handleInterrupt: RomHandler = ({ args, bus }) => {
  const t = targetOf(bus, args[0] >>> 0);
  write(bus, t, t.layout.feed, 1);
};

/** Peripheral bases the HAL selects between, from `reg_base.h`. */
const TIMG0_BASE = 0x60008000;
const TIMG1_BASE = 0x60009000;
const LP_WDT_BASE = 0x600b1c00;

/**
 * The watchdog entry points the C6's ROM publishes.
 *
 * Addresses are from `esp32c6.rom.wdt.ld` in the same core the firmware was
 * built with, under the symbol that script gives each one. A first draft also
 * listed a `wdt_hal_init` at 0x40000390; the script publishes only
 * `rom_wdt_hal_init`, so the invented entry was removed.
 */
export const ESP32C6_ROM_WATCHDOG: RomFunction[] = [
  {
    address: 0x40000394,
    name: 'rom_wdt_hal_init',
    handler: init,
    rationale: 'Selects the instance\'s registers and leaves it disabled and write-protected, as the HAL documents.',
  },
  {
    address: 0x40000398,
    name: 'rom_wdt_hal_deinit',
    handler: deinit,
    rationale: 'Disables the watchdog and restores its write protection.',
  },
  {
    address: 0x4000039c,
    name: 'wdt_hal_config_stage',
    handler: configStage,
    rationale: 'Writes both the stage timeout and its behaviour field, which firmware reads back.',
  },
  {
    address: 0x400003a0,
    name: 'wdt_hal_write_protect_disable',
    handler: writeProtectDisable,
    rationale: 'Writes the documented unlock key to the write-protect register.',
  },
  {
    address: 0x400003a4,
    name: 'wdt_hal_write_protect_enable',
    handler: writeProtectEnable,
    rationale: 'Restores protection by writing a value other than the key.',
  },
  {
    address: 0x400003a8,
    name: 'wdt_hal_enable',
    handler: enable,
    rationale: 'Sets the enable bit in the instance\'s CONFIG0.',
  },
  {
    address: 0x400003ac,
    name: 'wdt_hal_disable',
    handler: disable,
    rationale: 'Clears it, which is what startup does to the boot watchdogs.',
  },
  {
    address: 0x400003b0,
    name: 'wdt_hal_handle_intr',
    handler: handleInterrupt,
    rationale: 'Reloads the counter, the only observable part for a runtime with no watchdog reset.',
  },
  {
    address: 0x400003b4,
    name: 'wdt_hal_feed',
    handler: feed,
    rationale: 'Writes the feed register, which is write-triggered.',
  },
  {
    address: 0x400003b8,
    name: 'wdt_hal_set_flashboot_en',
    handler: setFlashbootEnable,
    rationale: 'Sets or clears the flash-boot mode bit the second-stage bootloader leaves on.',
  },
  {
    address: 0x400003bc,
    name: 'wdt_hal_is_enabled',
    handler: isEnabled,
    rationale: 'Reads the enable bit back from the register rather than from remembered state.',
  },
];
