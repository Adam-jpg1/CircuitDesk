// The ESP32-C6's flash MMU, which is not the C3's with a bigger table.
//
// Three things differ, and each of them would be silently wrong if the C3's
// implementation were reused:
//
//   * There is no memory-mapped table. The C3 exposes 128 words at 0x600C5000
//     and firmware writes them directly; on the C6 that address is the
//     interrupt priority block. Every C6 entry is reached by writing its index
//     to SPI_MEM_MMU_ITEM_INDEX_REG and then reading or writing
//     SPI_MEM_MMU_ITEM_CONTENT_REG — an indexed port, not an array.
//     (`hal/esp32c6/include/hal/mmu_ll.h`.)
//   * The valid bit is inverted. The C3 sets BIT(8) to mean *invalid*; the C6
//     sets BIT(9) to mean *valid*. Applying the C3's rule to a C6 table turns
//     every mapped page into an unmapped one, and the cache would read zeroes
//     where the code is.
//   * The table is 256 entries with a 9-bit page number, so the address mask
//     that selects a page is 0xFFFFFF rather than 0x7FFFFF.
//
// Because the port lives inside SPI0's register window, this block *is* SPI0:
// firmware configures the cache controller through the same 4 KB page. Every
// other offset behaves as storage, which is what the C3's SPI0 register file
// does too — the controller is configured but never runs transactions.

import { RegisterFile } from '../esp32c3/registerFile';
import type { FlashMapper } from '../espRiscv/peripheral';
import { ESP32C6_SOC, MMU_PAGE_SIZE } from '../espRiscv/soc';

/** SPI0 on the C6. On the C3 this address is SPI1. */
export const ESP32C6_SPI0_BASE = 0x60002000;

/** SPI1, the controller ESP-IDF drives to reach the flash. */
export const ESP32C6_SPI1_BASE = 0x60003000;

/** SPI_MEM_MMU_ITEM_CONTENT_REG(0): the entry the index register selects. */
const MMU_ITEM_CONTENT = 0x37c;
/** SPI_MEM_MMU_ITEM_INDEX_REG(0): which entry the port refers to. */
const MMU_ITEM_INDEX = 0x380;

const { entryCount, pageMask, vaddrMask } = ESP32C6_SOC.mmu;

/** SOC_MMU_VALID: an entry says it maps something by setting this bit. */
const MMU_VALID = ESP32C6_SOC.mmu.validity.bit;

/**
 * SPI0 and the flash MMU it carries.
 *
 * Entries are writable because firmware really does rewrite them: mapping a
 * partition at runtime is exactly this, and `spi_flash_cache2phys` reads them
 * back to invert the mapping — without which `esp_ota_get_running_partition`
 * cannot tell which partition it is executing from.
 */
export class Esp32C6FlashMmu extends RegisterFile implements FlashMapper {
  readonly isFlashMapper = true;

  private readonly entries = new Uint32Array(entryCount);

  constructor() {
    super('spi0_mmu', ESP32C6_SPI0_BASE, 0x1000);
    this.entries.fill(0);
  }

  override reset(): void {
    super.reset();
    // Zero is SOC_MMU_INVALID on this part: no valid bit, nothing mapped.
    this.entries.fill(0);
  }

  /** Which entry the port currently refers to. */
  private get selected(): number {
    return this.peek(MMU_ITEM_INDEX) % entryCount;
  }

  protected override onRead(offset: number): number | undefined {
    if (offset !== MMU_ITEM_CONTENT) return undefined;
    return this.entries[this.selected] >>> 0;
  }

  protected override onWrite(offset: number, value: number): void {
    if (offset !== MMU_ITEM_CONTENT) return;
    this.entries[this.selected] = value >>> 0;
  }

  /** The entry a cache address falls in. */
  entryOf(address: number): number {
    return ((address & vaddrMask) >>> 16) % entryCount;
  }

  /** Points a cache page at a flash page, marking the entry valid. */
  map(entry: number, flashPage: number): void {
    if (entry < 0 || entry >= entryCount) return;
    this.entries[entry] = ((flashPage & pageMask) | MMU_VALID) >>> 0;
  }

  /**
   * Converts a cache address to a flash offset, or undefined when the page it
   * lands in is not mapped — which is the answer `spi_flash_cache2phys` reports
   * as a failure rather than a guess.
   */
  translate(address: number): number | undefined {
    const entry = this.entries[this.entryOf(address)];
    if ((entry & MMU_VALID) === 0) return undefined;
    return (entry & pageMask) * MMU_PAGE_SIZE + (address & (MMU_PAGE_SIZE - 1));
  }

  /** Raw entry value, for tests and diagnostics. */
  entry(index: number): number {
    return this.entries[index % entryCount] >>> 0;
  }
}
