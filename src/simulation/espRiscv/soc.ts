// What distinguishes one Espressif RISC-V part from another.
//
// Every number in this file was read out of Espressif's own headers, listed
// against each entry. None of it is remembered, and none of it is inferred from
// the other chip — which matters, because the tempting assumption is that the
// C6 is a C3 with a different number, and it is not:
//
//   * the C6 unifies IRAM with DRAM, and IROM with DROM; the C3 splits both
//   * the C6's flash MMU has twice the entries, the opposite valid-bit
//     polarity, and no memory-mapped table at all
//   * SPI0 and SPI1 swap places
//   * the C3's interrupt matrix is one block; the C6's is two, at addresses
//     nowhere near each other
//   * not one interrupt source number carries over
//
// A machine built by copying the C3's and editing constants would get the first
// of those and silently miss the rest.

/** Chips this runtime has a machine for. */
export type EspRiscvChip = 'esp32c3' | 'esp32c6';

export interface AddressRange {
  readonly start: number;
  readonly end: number;
}

export interface EspMemoryMap {
  /** The mask ROM window. */
  readonly rom: AddressRange;
  /** Instruction RAM. On the C6 this is the same window as `dram`. */
  readonly iram: AddressRange;
  /** Data RAM. On the C6 this is the same window as `iram`. */
  readonly dram: AddressRange;
  /** Flash-mapped constants. On the C6 this is the same window as `irom`. */
  readonly drom: AddressRange;
  /** Flash-mapped code. On the C6 this is the same window as `drom`. */
  readonly irom: AddressRange;
  /** Low-power / RTC memory. */
  readonly rtcFast: AddressRange;
  /** The whole memory-mapped peripheral space. */
  readonly peripheral: AddressRange;
}

/**
 * Where the CPU interrupt controller's registers live.
 *
 * On the C3 these offsets are inside the interrupt matrix itself. On the C6
 * they are in a separate INTPRI block, and every one of them has moved — which
 * is why they are configuration rather than constants.
 */
export interface CpuInterruptLayout {
  /** Base of the block holding the registers below. */
  readonly base: number;
  readonly size: number;
  readonly enable: number;
  readonly type: number;
  readonly clear: number;
  readonly eipStatus: number;
  /** Offset of the priority word for line 0; line n is this plus n*4. */
  readonly priorityBase: number;
  readonly threshold: number;
}

/**
 * Where the four software interrupts a CPU raises on itself live.
 *
 * FreeRTOS switches tasks through one of these: `vPortYield` writes 1 and then
 * spins until the handler writes 0 back, so this has to be a real interrupt
 * source rather than storage. The C3 puts them in the SYSTEM block, far from
 * its interrupt controller; the C6 puts them inside INTPRI. They are located
 * absolutely here because the two chips do not agree on which block owns them.
 */
export interface SoftwareInterruptLayout {
  readonly base: number;
  /** Offset of FROM_CPU_0 within that block; n is this plus n*4. */
  readonly fromCpu0: number;
}

/** Peripheral interrupt source numbers this runtime can raise. */
export interface InterruptSources {
  readonly gpio: number;
  readonly uart0: number;
  readonly uart1: number;
  readonly systimerTarget0: number;
  readonly fromCpu0: number;
}

export interface FlashMmuConfig {
  /** How many 64 KB pages the table can map. */
  readonly entryCount: number;
  /** Bits of an entry holding the flash page number. */
  readonly pageMask: number;
  /**
   * How an entry says it maps something.
   *
   * The two parts disagree about the polarity: the C3 sets a bit to mean
   * *invalid*, the C6 sets one to mean *valid*. Reading a C6 table with the
   * C3's rule turns every mapped page into an unmapped one.
   */
  readonly validity:
    | { readonly kind: 'invalidBit'; readonly bit: number }
    | { readonly kind: 'validBit'; readonly bit: number };
  /** Bits of a cache address that select a page within the table. */
  readonly vaddrMask: number;
}

/**
 * Constants the mask ROM publishes as data, which the application reads
 * directly rather than through a call.
 *
 * `ets_rom_layout_p` is the one that decides whether the chip boots at all:
 * ESP-IDF's heap initialisation dereferences it to learn which DRAM the ROM has
 * reserved, and with a null pointer computes a reservation covering all of
 * memory and panics. The two parts put it in completely different places — the
 * C3 in a legacy data window, the C6 in the last word of the mask ROM itself —
 * so it cannot be a constant.
 */
export interface EspRomDataLayout {
  /** Address of `ets_rom_layout_p`, taken from each chip's own linker script. */
  readonly layoutPointer: number;
  /** Where this runtime places the structure that pointer refers to. */
  readonly layoutAddress: number;
  readonly dramLow: number;
  readonly dramHigh: number;
  readonly romStackStart: number;
  readonly romStackSize: number;
  /** Where the coexistence version string is placed. */
  readonly coexVersionAddress: number;
}

export interface EspSocConfig {
  readonly chip: EspRiscvChip;
  /** Espressif's own name for the part, for messages a user may see. */
  readonly displayName: string;
  readonly memory: EspMemoryMap;
  /**
   * The stack the mask ROM is running on when it enters the application.
   *
   * ESP-IDF names this SOC_ROM_STACK_START. Because this runtime enters the
   * application directly rather than executing the ROM's boot flow, it has to
   * establish the same starting condition — without it the very first function
   * prologue pushes its return address to whatever a zero stack pointer
   * produces. Startup register state, not a patch.
   */
  readonly romStackTop: number;
  /** Reset CPU frequency in MHz, as the ROM leaves it. */
  readonly cpuMhz: number;
  /** Flash offset of the application partition. */
  readonly applicationFlashOffset: number;
  readonly mmu: FlashMmuConfig;
  /**
   * Base of the block holding the per-source routing words.
   *
   * On the C3 this is the same block as `cpuInterrupts`; on the C6 the two are
   * nowhere near each other.
   */
  readonly interruptMatrixBase: number;
  /** How many sources that block has a routing word for. */
  readonly interruptSourceCount: number;
  readonly cpuInterrupts: CpuInterruptLayout;
  readonly softwareInterrupts: SoftwareInterruptLayout;
  readonly interruptSources: InterruptSources;
  readonly romData: EspRomDataLayout;
}

/** 64 KB, the page size both parts use (`SOC_MMU_PAGE_SIZE`). */
export const MMU_PAGE_SIZE = 0x10000;

/**
 * ESP32-C3.
 *
 * Sources: `soc/esp32c3/include/soc/soc.h`, `.../ext_mem_defs.h`,
 * `.../reg_base.h`, `.../interrupts.h`, `hal/esp32c3/include/hal/mmu_ll.h`.
 */
export const ESP32C3_SOC: EspSocConfig = {
  chip: 'esp32c3',
  displayName: 'ESP32-C3',
  memory: {
    rom: { start: 0x40000000, end: 0x40060000 },
    iram: { start: 0x40380000, end: 0x403e0000 },
    dram: { start: 0x3fc80000, end: 0x3fce0000 },
    drom: { start: 0x3c000000, end: 0x3c800000 },
    irom: { start: 0x42000000, end: 0x42800000 },
    rtcFast: { start: 0x50000000, end: 0x50002000 },
    peripheral: { start: 0x60000000, end: 0x60100000 },
  },
  romStackTop: 0x3fcde710,
  cpuMhz: 160,
  applicationFlashOffset: 0x10000,
  mmu: {
    // SOC_MMU_ENTRY_NUM 128, SOC_MMU_VALID_VAL_MASK 0xff,
    // SOC_MMU_INVALID BIT(8), SOC_MMU_VADDR_MASK 0x7FFFFF.
    entryCount: 128,
    pageMask: 0xff,
    validity: { kind: 'invalidBit', bit: 1 << 8 },
    vaddrMask: 0x7fffff,
  },
  // DR_REG_INTERRUPT_BASE, which also holds the CPU controller on this part.
  interruptMatrixBase: 0x600c2000,
  interruptSourceCount: 62,
  cpuInterrupts: {
    // All inside the interrupt matrix block, DR_REG_INTERRUPT_BASE.
    base: 0x600c2000,
    size: 0x1000,
    enable: 0x104,
    type: 0x108,
    clear: 0x10c,
    eipStatus: 0x110,
    priorityBase: 0x114,
    threshold: 0x194,
  },
  // SYSTEM_CPU_INTR_FROM_CPU_0_REG, in a block two pages below the matrix.
  softwareInterrupts: { base: 0x600c0000, fromCpu0: 0x28 },
  interruptSources: {
    gpio: 16,
    uart0: 21,
    uart1: 22,
    systimerTarget0: 37,
    fromCpu0: 50,
  },
  romData: {
    // `ets_rom_layout_p = 0x3ff1fffc` in esp32c3.rom.ld.
    layoutPointer: 0x3ff1fffc,
    layoutAddress: 0x3ff1ff00,
    dramLow: 0x3fc80000,
    dramHigh: 0x3fce0000,
    romStackStart: 0x3fcde710,
    romStackSize: 0x2000,
    // Inside the ROM window, past every implemented entry point. The window is
    // only dispatched as code when the program counter enters it, so a data
    // read here reads memory.
    coexVersionAddress: 0x4005ff00,
  },
};

/**
 * ESP32-C6.
 *
 * Sources: `soc/esp32c6/include/soc/soc.h` (`SOC_IRAM_LOW` 0x40800000 =
 * `SOC_DRAM_LOW`, `SOC_IROM_LOW` 0x42000000 = `SOC_DROM_LOW`,
 * `SOC_ROM_STACK_START` 0x4087e610), `.../ext_mem_defs.h`
 * (`SOC_MMU_ENTRY_NUM` 256, `SOC_MMU_VALID` BIT(9), `SOC_MMU_VALID_VAL_MASK`
 * 0x1ff), `.../reg_base.h`, `.../intpri_reg.h`, `.../interrupts.h`.
 */
export const ESP32C6_SOC: EspSocConfig = {
  chip: 'esp32c6',
  displayName: 'ESP32-C6',
  memory: {
    // SOC_IROM_MASK_LOW/HIGH: the C6's mask ROM window is 0x50000 long, not
    // the C3's 0x60000.
    rom: { start: 0x40000000, end: 0x40050000 },
    // One window serves both instruction and data. Writing these as separate
    // entries with identical bounds keeps the shared machine's checks
    // unchanged while stating the fact plainly.
    iram: { start: 0x40800000, end: 0x40880000 },
    dram: { start: 0x40800000, end: 0x40880000 },
    // Likewise for the cache: 256 entries of 64 KB, both buses.
    drom: { start: 0x42000000, end: 0x43000000 },
    irom: { start: 0x42000000, end: 0x43000000 },
    rtcFast: { start: 0x50000000, end: 0x50004000 },
    peripheral: { start: 0x60000000, end: 0x60100000 },
  },
  romStackTop: 0x4087e610,
  cpuMhz: 160,
  applicationFlashOffset: 0x10000,
  mmu: {
    entryCount: 256,
    pageMask: 0x1ff,
    // The opposite of the C3's rule, and the reason the two cannot share one
    // implementation without saying which they are.
    validity: { kind: 'validBit', bit: 1 << 9 },
    // 256 pages of 64 KB.
    vaddrMask: 0xffffff,
  },
  // DR_REG_INTERRUPT_MATRIX_BASE, which on this part holds only the routing
  // words. INTMTX_CORE0_ECC_INTR_MAP_REG, the last of them, is at 0x130.
  interruptMatrixBase: 0x60010000,
  interruptSourceCount: 77,
  cpuInterrupts: {
    // A block of its own, DR_REG_INTPRI_BASE — which on the C3 is where the
    // flash MMU table sits.
    base: 0x600c5000,
    size: 0x1000,
    enable: 0x00,
    type: 0x04,
    clear: 0xa8,
    eipStatus: 0x08,
    priorityBase: 0x0c,
    threshold: 0x8c,
  },
  // INTPRI_CPU_INTR_FROM_CPU_0_REG, inside the same block as the controller.
  softwareInterrupts: { base: 0x600c5000, fromCpu0: 0x90 },
  interruptSources: {
    gpio: 30,
    uart0: 43,
    uart1: 44,
    systimerTarget0: 57,
    fromCpu0: 22,
  },
  romData: {
    // `ets_rom_layout_p = 0x4004fffc` in esp32c6.rom.ld — the last word of the
    // mask ROM window, nowhere near where the C3 keeps it.
    layoutPointer: 0x4004fffc,
    // The structure goes just below that pointer, still inside the window and
    // far past every published entry point.
    layoutAddress: 0x4004ff00,
    dramLow: 0x40800000,
    dramHigh: 0x40880000,
    romStackStart: 0x4087e610,
    romStackSize: 0x2000,
    coexVersionAddress: 0x4004fe00,
  },
};

export const ESP_SOCS: Record<EspRiscvChip, EspSocConfig> = {
  esp32c3: ESP32C3_SOC,
  esp32c6: ESP32C6_SOC,
};
