// The ESP32-C6's interrupt matrix and CPU interrupt controller.
//
// On the C3 these are one block. On the C6 they are two, and not adjacent:
//
//   * INTMTX at 0x60010000 holds the routing words, one per source, at
//     `source * 4`. (`soc/esp32c6/interrupt_matrix_reg.h`.)
//   * INTPRI at 0x600C5000 holds the enable mask, the trigger types, the
//     per-line priorities, the threshold, the clear register and the four
//     software interrupts — every one of them at a different offset from the
//     C3's, and the block sits exactly where the C3 keeps its flash MMU table.
//     (`soc/esp32c6/intpri_reg.h`.)
//
// Not one interrupt source number carries over either: GPIO is 30 here and 16
// on the C3, the system timer's first target is 57 against 37, and the
// software interrupts are 22-25 against 50-53.
//
// The machine asks one object which line to take, so this controller presents
// itself as that object and exposes the two register blocks as peripherals for
// the bus to route to. Splitting it any other way would mean the machine
// knowing that this chip has two.

import { RegisterFile } from '../esp32c3/registerFile';
import { ESP32C6_SOC } from '../espRiscv/soc';
import type { InterruptingPeripheral, InterruptRouter, Peripheral } from '../espRiscv/peripheral';

/** INTMTX_CORE0, the routing words. */
export const ESP32C6_INTERRUPT_MATRIX_BASE = 0x60010000;

/** INTPRI, the CPU interrupt controller. */
export const ESP32C6_INTPRI_BASE = ESP32C6_SOC.cpuInterrupts.base;

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
const SOURCE_COUNT = 77;
const MAP_BASE = 0x000;

const LAYOUT = ESP32C6_SOC.cpuInterrupts;
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
 * The prioritising half, INTPRI.
 *
 * It also carries the four software interrupts a CPU raises on itself, which
 * on the C3 live in a different block entirely. FreeRTOS switches tasks through
 * one of these: `vPortYield` writes 1 and then spins until the handler writes 0
 * back, so storing the write without delivering an interrupt turns that into an
 * endless loop.
 */
class Esp32C6InterruptPriority extends RegisterFile implements InterruptingPeripheral {
  /** Edge-triggered lines latch when their source rises; level lines follow theirs. */
  edgeLatched = 0;

  constructor() {
    super('intpri', LAYOUT.base, LAYOUT.size);
  }

  override reset(): void {
    super.reset();
    this.edgeLatched = 0;
  }

  protected override onWrite(offset: number, value: number): void {
    if (offset !== LAYOUT.clear) return;
    // Clearing is a pulse: the bits written are cleared and the register does
    // not stay set.
    this.edgeLatched &= ~value;
    this.registers.set(LAYOUT.clear, 0);
  }

  assertedInterruptSources(): number[] {
    const sources: number[] = [];
    for (let i = 0; i < FROM_CPU_COUNT; i++) {
      if ((this.peek(SOFTWARE.fromCpu0 + i * 4) & 1) !== 0) sources.push(ESP32C6_INTERRUPT_SOURCE.fromCpu0 + i);
    }
    return sources;
  }

  /**
   * Priority assigned to a CPU line.
   *
   * The priority words are indexed by line number from zero — INTPRI_CORE0_
   * CPU_INT_PRI_0_REG is the first — which the firmware's own dispatcher relies
   * on: it reads the priority of the line it is servicing and writes that plus
   * one to the threshold so an equal or lower interrupt cannot pre-empt it.
   * Indexing from one instead leaves every interrupt able to re-enter itself.
   */
  priorityOf(line: number): number {
    if (line < 1 || line >= LINE_COUNT) return 0;
    return this.peek(LAYOUT.priorityBase + line * 4) & 0xf;
  }

  get threshold(): number {
    return this.peek(LAYOUT.threshold) & 0xf;
  }

  get enableMask(): number {
    return this.peek(LAYOUT.enable) >>> 0;
  }

  get typeMask(): number {
    return this.peek(LAYOUT.type) >>> 0;
  }

  setStatus(value: number): void {
    this.registers.set(LAYOUT.eipStatus, value >>> 0);
  }
}

/**
 * The C6's interrupt controller, spanning both of its blocks.
 *
 * This is the object the machine consults. `peripherals` are the two register
 * windows the bus must route to, and `interruptSource` is INTPRI in its other
 * capacity as a block that can assert.
 */
export class Esp32C6InterruptController implements InterruptRouter {
  readonly isInterruptRouter = true;

  private readonly map = new Esp32C6InterruptMap();
  private readonly priority = new Esp32C6InterruptPriority();

  /** Sources asserted at the previous evaluation, to spot an edge. */
  private previousSources = new Set<number>();

  /** The two register windows this controller occupies. */
  get peripherals(): Peripheral[] {
    return [this.map, this.priority];
  }

  /** INTPRI, which also raises the software interrupts. */
  get interruptSource(): InterruptingPeripheral {
    return this.priority;
  }

  /** The CPU line a source is routed to. Exposed for tests and diagnostics. */
  routeOf(source: number): number {
    return this.map.routeOf(source);
  }

  /**
   * Recomputes which CPU lines are asserted and returns the enabled ones.
   *
   * Routing comes from one block and everything else from the other, which is
   * the whole reason this class exists.
   */
  evaluate(asserted: Iterable<number>): number {
    const sources = new Set(asserted);
    const type = this.priority.typeMask;

    let level = 0;
    for (const source of sources) {
      const line = this.map.routeOf(source);
      if (line === 0) continue;
      const bit = 1 << line;
      if ((type & bit) !== 0) {
        // Only a source that was not asserted a moment ago is an edge.
        if (!this.previousSources.has(source)) this.priority.edgeLatched |= bit;
      } else {
        level |= bit;
      }
    }
    this.previousSources = sources;

    const pending = (level | this.priority.edgeLatched) >>> 0;
    const enabled = (pending & this.priority.enableMask) >>> 0;
    this.priority.setStatus(enabled);
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
      const priority = this.priority.priorityOf(line);
      if (priority < this.priority.threshold) continue;
      if (priority >= bestPriority) {
        bestPriority = priority;
        best = line;
      }
    }
    return best;
  }

  reset(): void {
    this.map.reset();
    this.priority.reset();
    this.previousSources.clear();
  }
}
