// The ESP32-C3's interrupt matrix and CPU interrupt controller.
//
// The chip has far more peripherals that can interrupt than the CPU has
// interrupt lines, so a matrix sits between them: each peripheral source owns
// one word holding the CPU line it is routed to, and the controller then
// enables, prioritises and delivers those lines.
//
// This is the piece without which a FreeRTOS application cannot start at all.
// `xPortStartScheduler` sets up the tick, unmasks interrupts, and calls
// `vPortYield`, which raises the from-CPU software interrupt and then polls
// for the handler to clear it. If no interrupt is ever delivered, that poll
// never finishes and the scheduler never runs a task — which is exactly where
// startup stopped before this existed.
//
// Register offsets, source numbers and bit positions are the documented ones
// from the ESP32-C3 technical reference manual.

import { RegisterFile } from './registerFile';
import type { InterruptingPeripheral, InterruptRouter } from '../espRiscv/peripheral';

export { isInterrupting, type InterruptingPeripheral } from '../espRiscv/peripheral';

export const INTERRUPT_MATRIX_BASE = 0x600c2000;

/**
 * Peripheral interrupt source numbers.
 *
 * Only the sources this runtime can actually raise are named. A source's
 * number is also the index of its routing word, so the matrix needs no table.
 */
export const INTERRUPT_SOURCE = {
  gpio: 16,
  spi1: 18,
  spi2: 19,
  uart0: 21,
  uart1: 22,
  systimerTarget0: 37,
  systimerTarget1: 38,
  systimerTarget2: 39,
  fromCpu0: 50,
  fromCpu1: 51,
  fromCpu2: 52,
  fromCpu3: 53,
} as const;

/** The matrix has one routing word per source, and there are 62 of them. */
const SOURCE_COUNT = 62;
const MAP_BASE = 0x000;

const CPU_INT_ENABLE = 0x104;
const CPU_INT_TYPE = 0x108;
const CPU_INT_CLEAR = 0x10c;
const CPU_INT_EIP_STATUS = 0x110;
const CPU_INT_PRI_BASE = 0x114;
const CPU_INT_THRESH = 0x194;

/** Line 0 does not exist; a routing word of zero means "not routed". */
const LINE_COUNT = 32;

export class InterruptMatrix extends RegisterFile implements InterruptRouter {
  /** This block decides which CPU interrupt line the core takes. */
  readonly isInterruptRouter = true;

  /**
   * Edge-triggered lines latch when their source rises, and stay latched until
   * firmware clears them. Level-triggered lines simply follow their source, so
   * they need no state here.
   */
  private edgeLatched = 0;

  /** Sources asserted at the previous evaluation, to spot an edge. */
  private previousSources = new Set<number>();

  constructor() {
    super('interrupt_matrix', INTERRUPT_MATRIX_BASE, 0x1000);
  }

  override reset(): void {
    super.reset();
    this.edgeLatched = 0;
    this.previousSources.clear();
  }

  protected override onWrite(offset: number, value: number): void {
    if (offset !== CPU_INT_CLEAR) return;
    // Clearing is a pulse: the bits written are cleared and the register does
    // not stay set.
    this.edgeLatched &= ~value;
    this.registers.set(CPU_INT_CLEAR, 0);
  }

  /** The CPU line a source is routed to, or 0 when it is not routed. */
  routeOf(source: number): number {
    if (source < 0 || source >= SOURCE_COUNT) return 0;
    return this.peek(MAP_BASE + source * 4) & (LINE_COUNT - 1);
  }

  /**
   * Priority assigned to a CPU line.
   *
   * The priority words are indexed by line number from zero, which the
   * firmware's own dispatcher relies on: it reads the priority of the line it
   * is servicing and writes that value plus one to the threshold, so that an
   * interrupt of equal or lower priority cannot pre-empt it. Indexing these
   * from one instead leaves every interrupt able to re-enter itself.
   */
  priorityOf(line: number): number {
    if (line < 1 || line >= LINE_COUNT) return 0;
    return this.peek(CPU_INT_PRI_BASE + line * 4) & 0xf;
  }

  /** Lines below this priority are masked. */
  get threshold(): number {
    return this.peek(CPU_INT_THRESH) & 0xf;
  }

  /**
   * Recomputes which CPU lines are asserted and returns the enabled ones.
   *
   * Edge lines latch on a rising source; level lines track theirs. The result
   * is also stored in the status register, which is where firmware reads it.
   */
  evaluate(asserted: Iterable<number>): number {
    const sources = new Set(asserted);
    const type = this.peek(CPU_INT_TYPE);

    let level = 0;
    for (const source of sources) {
      const line = this.routeOf(source);
      if (line === 0) continue;
      const bit = 1 << line;
      if ((type & bit) !== 0) {
        // Only a source that was not asserted a moment ago is an edge.
        if (!this.previousSources.has(source)) this.edgeLatched |= bit;
      } else {
        level |= bit;
      }
    }
    this.previousSources = sources;

    const pending = (level | this.edgeLatched) >>> 0;
    const enabled = (pending & this.peek(CPU_INT_ENABLE)) >>> 0;
    this.registers.set(CPU_INT_EIP_STATUS, enabled);
    return enabled;
  }

  /**
   * Picks the line to take from those pending.
   *
   * A line whose priority is below the threshold is masked out entirely. Among
   * the rest the highest priority wins, and the highest-numbered line breaks a
   * tie — the order the controller itself resolves in.
   */
  select(pending: number): number | undefined {
    let best: number | undefined;
    let bestPriority = -1;
    for (let line = 1; line < LINE_COUNT; line++) {
      if ((pending & (1 << line)) === 0) continue;
      const priority = this.priorityOf(line);
      if (priority < this.threshold) continue;
      if (priority >= bestPriority) {
        bestPriority = priority;
        best = line;
      }
    }
    return best;
  }
}

// ------------------------------------------------------- from-CPU interrupts

/**
 * The system register block, which also carries the software interrupts a CPU
 * raises on itself.
 *
 * FreeRTOS switches tasks through one of these: `vPortYield` writes 1 here and
 * then spins until the interrupt handler writes 0 back. Storing the write
 * without delivering an interrupt turns that into an endless loop, so this
 * block has to be a real interrupt source rather than a register file.
 */
const SYSTEM_CPU_INTR_FROM_CPU_BASE = 0x28;
const FROM_CPU_COUNT = 4;

export class SystemRegisters extends RegisterFile implements InterruptingPeripheral {
  constructor(base: number, size: number) {
    super('system', base, size);
  }

  assertedInterruptSources(): number[] {
    const sources: number[] = [];
    for (let i = 0; i < FROM_CPU_COUNT; i++) {
      if ((this.peek(SYSTEM_CPU_INTR_FROM_CPU_BASE + i * 4) & 1) !== 0) sources.push(INTERRUPT_SOURCE.fromCpu0 + i);
    }
    return sources;
  }
}
