// The ESP32-C6's interrupt matrix and CPU interrupt controller.
//
// On the C3 these are one block. On the C6 they are two, and the second is not
// where it looks like it should be:
//
//   * INTMTX at 0x60010000 holds the routing words, one per source, at
//     `source * 4`. (`soc/esp32c6/interrupt_matrix_reg.h`.)
//   * The CPU interrupt controller is a RISC-V PLIC at 0x20001000 —
//     DR_REG_PLIC_MX_BASE — holding the enable mask, the trigger types, the
//     per-line priorities, the threshold, the claim and the pending status.
//     (`soc/esp32c6/register/soc/plic_reg.h`, and
//     `soc/esp32c6/include/soc/interrupt_reg.h`, which maps every
//     INTERRUPT_CORE0_CPU_INT_* name onto a PLIC_MXINT_* register.)
//
// The C6 also has an INTPRI block at 0x600C5000 that carries a plausible-
// looking set of CPU interrupt registers, and a first version of this file used
// it. The firmware never touches them. It reads its threshold from 0x20001090
// and a line's priority from 0x20001010 + line*4, both in the PLIC — and
// 0x20001000 is below the peripheral window, so with the wrong block modelled
// every one of those accesses went to plain RAM. Nothing faulted. The
// controller simply never heard from the firmware, the FreeRTOS tick was never
// masked while its own handler ran, and it re-entered until its stack walked
// out of RAM and into the interrupt-entry code.
//
// What INTPRI really carries is the four software interrupts a CPU raises on
// itself, so that block is still here — as a source, not as the controller.
//
// Not one interrupt source number carries over from the C3 either: GPIO is 30
// here and 16 there, the system timer's first target is 57 against 37, and the
// software interrupts are 22-25 against 50-53.

import { RegisterFile } from '../esp32c3/registerFile';
import { ESP32C6_SOC } from '../espRiscv/soc';
import type { InterruptingPeripheral, InterruptRouter, Peripheral } from '../espRiscv/peripheral';

/** INTMTX_CORE0, the routing words. */
export const ESP32C6_INTERRUPT_MATRIX_BASE = ESP32C6_SOC.interruptMatrixBase;

/** DR_REG_PLIC_MX_BASE, the CPU interrupt controller. */
export const ESP32C6_PLIC_BASE = ESP32C6_SOC.cpuInterrupts.base;

/** DR_REG_INTPRI_BASE, which carries the software interrupts. */
export const ESP32C6_INTPRI_BASE = ESP32C6_SOC.softwareInterrupts.base;

/**
 * Peripheral interrupt source numbers.
 *
 * Read from `soc/esp32c6/include/soc/interrupts.h`, where the enumeration's
 * position is the source number. Only the sources this runtime can raise are
 * named.
 */
export const ESP32C6_INTERRUPT_SOURCE = {
  fromCpu0: 22,
  fromCpu1: 23,
  fromCpu2: 24,
  fromCpu3: 25,
  gpio: 30,
  mspi: 40,
  uart0: 43,
  uart1: 44,
  i2c0: 50,
  systimerTarget0: 57,
  systimerTarget1: 58,
  systimerTarget2: 59,
  spi2: 76,
} as const;

/**
 * The matrix has one routing word per source. INTMTX_CORE0_ECC_INTR_MAP_REG,
 * the last of them, sits at offset 0x130, so there are 77.
 */
const SOURCE_COUNT = ESP32C6_SOC.interruptSourceCount;
const MAP_BASE = 0x000;

const PLIC = ESP32C6_SOC.cpuInterrupts;
const SOFTWARE = ESP32C6_SOC.softwareInterrupts;

/** Line 0 does not exist; a routing word of zero means "not routed". */
const LINE_COUNT = 32;
const FROM_CPU_COUNT = 4;

/** The routing half, at its own base. Plain storage: firmware writes routes. */
class Esp32C6InterruptMap extends RegisterFile {
  constructor() {
    super('intmtx', ESP32C6_INTERRUPT_MATRIX_BASE, 0x1000);
  }

  /** The CPU line a source is routed to, or 0 when it is not routed. */
  routeOf(source: number): number {
    if (source < 0 || source >= SOURCE_COUNT) return 0;
    return this.peek(MAP_BASE + source * 4) & (LINE_COUNT - 1);
  }
}

/**
 * The PLIC: enable, type, priority, threshold and pending status.
 *
 * The threshold is the piece that makes the whole arrangement work. ESP-IDF's
 * interrupt entry reads the priority of the line it is about to service, writes
 * that priority plus one here, and only then re-enables interrupts — so a line
 * of equal or lower priority cannot pre-empt its own handler. A controller that
 * does not honour the threshold re-delivers the same line immediately.
 */
class Esp32C6Plic extends RegisterFile {
  /** Edge-triggered lines latch when their source rises; level lines follow theirs. */
  edgeLatched = 0;

  constructor() {
    super('plic_mx', PLIC.base, PLIC.size);
  }

  override reset(): void {
    super.reset();
    this.edgeLatched = 0;
  }

  protected override onWrite(offset: number, value: number): void {
    if (offset !== PLIC.clear) return;
    // Clearing is a pulse: the bits written are cleared and the register does
    // not stay set.
    this.edgeLatched &= ~value;
    this.registers.set(PLIC.clear, 0);
  }

  /**
   * Priority assigned to a CPU line.
   *
   * PLIC_MXINT0_PRI_REG is the first, so a line's word is at its own index.
   * Indexing from one instead leaves every interrupt able to re-enter itself,
   * because the entry code would read a neighbour's priority and mask the
   * wrong level.
   */
  priorityOf(line: number): number {
    if (line < 1 || line >= LINE_COUNT) return 0;
    return this.peek(PLIC.priorityBase + line * 4) & 0xff;
  }

  /** Lines below this priority are masked. PLIC_CPU_MXINT_THRESH is 8 bits. */
  get threshold(): number {
    return this.peek(PLIC.threshold) & 0xff;
  }

  get enableMask(): number {
    return this.peek(PLIC.enable) >>> 0;
  }

  get typeMask(): number {
    return this.peek(PLIC.type) >>> 0;
  }

  setStatus(value: number): void {
    this.registers.set(PLIC.eipStatus, value >>> 0);
  }
}

/**
 * INTPRI, which carries the four software interrupts a CPU raises on itself.
 *
 * FreeRTOS switches tasks through one of these: `vPortYield` writes 1 and then
 * spins until the handler writes 0 back, so storing the write without
 * delivering an interrupt turns that into an endless loop.
 */
class Esp32C6IntPri extends RegisterFile implements InterruptingPeripheral {
  constructor() {
    super('intpri', ESP32C6_INTPRI_BASE, 0x1000);
  }

  assertedInterruptSources(): number[] {
    const sources: number[] = [];
    for (let i = 0; i < FROM_CPU_COUNT; i++) {
      if ((this.peek(SOFTWARE.fromCpu0 + i * 4) & 1) !== 0) sources.push(ESP32C6_INTERRUPT_SOURCE.fromCpu0 + i);
    }
    return sources;
  }
}

/**
 * The C6's interrupt controller, spanning its three blocks.
 *
 * This is the object the machine consults. `peripherals` are the register
 * windows the bus must route to, and INTPRI appears in that list in its other
 * capacity as a block that can assert.
 */
export class Esp32C6InterruptController implements InterruptRouter {
  readonly isInterruptRouter = true;

  private readonly map = new Esp32C6InterruptMap();
  private readonly plic = new Esp32C6Plic();
  private readonly intpri = new Esp32C6IntPri();

  /** Sources asserted at the previous evaluation, to spot an edge. */
  private previousSources = new Set<number>();

  /** The register windows this controller occupies. */
  get peripherals(): Peripheral[] {
    return [this.map, this.plic, this.intpri];
  }

  /** INTPRI, which raises the software interrupts. */
  get interruptSource(): InterruptingPeripheral {
    return this.intpri;
  }

  /** The CPU line a source is routed to. Exposed for tests and diagnostics. */
  routeOf(source: number): number {
    return this.map.routeOf(source);
  }

  /** A line's configured priority, for tests and diagnostics. */
  priorityOf(line: number): number {
    return this.plic.priorityOf(line);
  }

  /** The controller's current masking threshold. */
  get threshold(): number {
    return this.plic.threshold;
  }

  /**
   * Recomputes which CPU lines are asserted and returns the enabled ones.
   *
   * Routing comes from one block and everything else from another, which is the
   * whole reason this class exists.
   */
  evaluate(asserted: Iterable<number>): number {
    const sources = new Set(asserted);
    const type = this.plic.typeMask;

    let level = 0;
    for (const source of sources) {
      const line = this.map.routeOf(source);
      if (line === 0) continue;
      const bit = 1 << line;
      if ((type & bit) !== 0) {
        // Only a source that was not asserted a moment ago is an edge.
        if (!this.previousSources.has(source)) this.plic.edgeLatched |= bit;
      } else {
        level |= bit;
      }
    }
    this.previousSources = sources;

    const pending = (level | this.plic.edgeLatched) >>> 0;
    const enabled = (pending & this.plic.enableMask) >>> 0;
    this.plic.setStatus(enabled);
    return enabled;
  }

  /**
   * Picks the line to take from those pending.
   *
   * A line whose priority is below the threshold is masked out entirely — which
   * is how a handler stops its own line pre-empting it, and without which the
   * FreeRTOS tick re-enters itself for ever. Among the rest the highest
   * priority wins, and the highest-numbered line breaks a tie.
   */
  select(pending: number): number | undefined {
    let best: number | undefined;
    let bestPriority = -1;
    const threshold = this.plic.threshold;
    for (let line = 1; line < LINE_COUNT; line++) {
      if ((pending & (1 << line)) === 0) continue;
      const priority = this.plic.priorityOf(line);
      // A line left at priority zero is disabled, as on any PLIC.
      if (priority === 0) continue;
      if (priority < threshold) continue;
      if (priority >= bestPriority) {
        bestPriority = priority;
        best = line;
      }
    }
    return best;
  }

  reset(): void {
    this.map.reset();
    this.plic.reset();
    this.intpri.reset();
    this.previousSources.clear();
  }
}
