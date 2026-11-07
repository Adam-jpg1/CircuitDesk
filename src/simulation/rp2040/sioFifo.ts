// The RP2040's second core, and the SIO block's per-core registers.
//
// rp2040js runs one Cortex-M0+. The chip has two, sharing every bus and
// peripheral, and Arduino-Pico starts the second one whenever a sketch defines
// setup1() or loop1(). Without it such a sketch never got as far as setup():
// core 0 waited forever for core 1 to answer the launch handshake. So the
// simulator provides core 1 here:
//
//   * a second CortexM0Core on the same RP2040 object, stepped in turn with
//     core 0 (Rp2040Runner.step). While it executes, rp.core points at it, so
//     the PPB (its own NVIC, VTOR and SCB, as each core has its own), the
//     breakpoint traps and anything else reading rp.core see the right core;
//   * the per-core parts of SIO: CPUID, the two inter-core FIFOs (eight words
//     each way, FIFO_ST/WR/RD as each core sees them, with the sticky WOF/ROE
//     flags), and the hardware divider and interpolators, which are per-core
//     on the chip and swapped in and out with the core;
//   * the SIO_IRQ_PROC0/PROC1 lines, raised while a core's FIFO has data or
//     an error flag is set. Every other interrupt line reaches both cores'
//     NVICs, as on the chip; each core takes only those it enables;
//   * SEV, which rp2040js treats as a no-op: it sets both cores' event
//     registers and wakes a core sleeping in WFE, which is how the SDK's FIFO
//     and lock code wakes the other side;
//   * the boot ROM's part: core 1 starts in the ROM, echoing each word core 0
//     sends until it has seen 0, 0, 1, vector table, stack pointer and entry
//     point, then runs from there (RP2040 datasheet 2.8.2). Forcing core 1 off
//     through the PSM puts it back in that loop.
//
// Core 1's SysTick is not separate (the PPB timer is shared), and GPIO
// interrupts reach core 1 only through PROC0's enables; Arduino-Pico's own use
// of the second core needs neither.

import type { RP2040 } from 'rp2040js';

const CPUID = 0x00;
const FIFO_ST = 0x50;
const FIFO_WR = 0x54;
const FIFO_RD = 0x58;

const ST_VLD = 1 << 0;
const ST_RDY = 1 << 1;
const ST_WOF = 1 << 2;
const ST_ROE = 1 << 3;

const FIFO_DEPTH = 8;
const SIO_IRQ_PROC = [15, 16] as const;

const PSM_FRCE_OFF = 0x04;
const PSM_PROC1 = 1 << 16;

const OP_WFE = 0xbf20;

/** Where core 1 returns to if its entry function returns: back into the ROM's wait. */
export const CORE1_RETURN = 0x00003ff0;

/** The fields of a CortexM0Core this module touches. */
interface Core {
  PC: number;
  SP: number;
  LR: number;
  VTOR: number;
  waiting: boolean;
  eventRegistered: boolean;
  pendingInterrupts: number;
  interruptsUpdated: boolean;
  registers: Uint32Array;
  executeInstruction(): number;
  setInterrupt(irq: number, value: boolean): void;
  reset(): void;
}

/** The SIO block's per-core state that rp2040js keeps as one. */
interface SioState {
  divDividend: number;
  divDivisor: number;
  divQuotient: number;
  divRemainder: number;
  divCSR: number;
  interp0: unknown;
  interp1: unknown;
}

type Sio = SioState & {
  readUint32(offset: number): number;
  writeUint32(offset: number, value: number): void;
};

type Machine = Omit<RP2040, 'core' | 'sio' | 'setInterrupt'> & {
  readonly core: Core;
  sio: Sio;
  setInterrupt(irq: number, value: boolean): void;
  peripherals: Record<number, { writeUint32(offset: number, value: number): void }>;
};

export class DualCore {
  readonly cores: [Core, Core];
  /** The core executing now: what CPUID reads and whose FIFO view applies. */
  private active: 0 | 1 = 0;
  /** inbox[n]: words waiting for core n. */
  private readonly inbox: [number[], number[]] = [[], []];
  private readonly sticky = [0, 0];
  private readonly sioState: [SioState | null, SioState | null] = [null, null];
  /** Core 1 is running sketch code (false: it is in the ROM's wait loop). */
  running = false;
  /** What core 1's ROM loop has heard so far of the launch sequence. */
  private heard: number[] = [];
  private readonly sleepingInWfe = [false, false];
  /** rp2040js executes SEV as a logged no-op; the log line is how it is seen. */
  private sevSeen = false;

  constructor(private readonly rp: Machine) {
    const core0 = rp.core;
    const CoreClass = core0.constructor as new (rp: unknown) => Core;
    const core1 = new CoreClass(rp);
    this.cores = [core0, core1];
    this.installSio();
    this.installInterrupts();
    this.installSevWatch();
    this.installPsm();
  }

  /** Core 1, for the runner's stepping and error reports. */
  get core1(): Core {
    return this.cores[1];
  }

  // ---------------------------------------------------------------- stepping

  /**
   * Executes one instruction on core `n` (which must not be waiting), with
   * rp.core and the per-core SIO state switched to it. Returns its cycles.
   */
  execute(n: 0 | 1): number {
    const core = this.cores[n];
    if (n !== this.active) this.switchTo(n);
    this.sevSeen = false;
    let cycles: number;
    try {
      cycles = core.executeInstruction() || 1;
    } finally {
      if (n !== 0) this.switchTo(0);
    }
    if (this.sevSeen) this.signalEvent();
    if (core.waiting) {
      // It went to sleep: on WFE an SEV wakes it, on WFI only an interrupt.
      this.sleepingInWfe[n] = this.rp.readUint16((core.PC - 2) >>> 0) === OP_WFE;
    }
    return cycles;
  }

  /** SEV: both cores' event registers set; a core asleep in WFE wakes. */
  private signalEvent(): void {
    for (const n of [0, 1] as const) {
      const core = this.cores[n];
      if (n === 1 && !this.running) continue;
      if (core.waiting && this.sleepingInWfe[n]) {
        core.waiting = false;
        this.sleepingInWfe[n] = false;
      } else {
        core.eventRegistered = true;
      }
    }
  }

  private switchTo(n: 0 | 1): void {
    const sio = this.rp.sio;
    const out = this.sioState[this.active] ?? (this.sioState[this.active] = this.freshSio());
    out.divDividend = sio.divDividend;
    out.divDivisor = sio.divDivisor;
    out.divQuotient = sio.divQuotient;
    out.divRemainder = sio.divRemainder;
    out.divCSR = sio.divCSR;
    out.interp0 = sio.interp0;
    out.interp1 = sio.interp1;
    const next = this.sioState[n] ?? (this.sioState[n] = this.freshSio());
    sio.divDividend = next.divDividend;
    sio.divDivisor = next.divDivisor;
    sio.divQuotient = next.divQuotient;
    sio.divRemainder = next.divRemainder;
    sio.divCSR = next.divCSR;
    sio.interp0 = next.interp0;
    sio.interp1 = next.interp1;
    this.active = n;
    (this.rp as unknown as { core: Core }).core = this.cores[n];
  }

  /** A core's own divider and interpolators, as they come out of reset. */
  private freshSio(): SioState {
    const Interp = (this.rp.sio.interp0 as { constructor: new (index: number) => unknown }).constructor;
    return { divDividend: 0, divDivisor: 1, divQuotient: 0, divRemainder: 0, divCSR: 0, interp0: new Interp(0), interp1: new Interp(1) };
  }

  // --------------------------------------------------------------- launching

  /** A word arrived for core 1 while it is still in the ROM: echo it, and start on the full sequence. */
  private romReceive(word: number): void {
    this.inbox[1].shift();
    this.heard.push(word >>> 0);
    if (this.heard.length > 6) this.heard.shift();
    // The ROM drains its FIFO on a 0, so the echo is all core 0 will find.
    this.deliver(0, word);
    const h = this.heard;
    if (h.length === 6 && h[0] === 0 && h[1] === 0 && h[2] === 1) this.launch(h[3], h[4], h[5]);
  }

  private launch(vectorTable: number, stack: number, entry: number): void {
    const core = this.cores[1];
    core.reset();
    core.VTOR = vectorTable >>> 0;
    core.SP = stack >>> 0;
    core.PC = entry & ~1;
    core.LR = CORE1_RETURN | 1;
    core.pendingInterrupts = 0;
    core.waiting = false;
    this.sleepingInWfe[1] = false;
    this.heard = [];
    this.running = true;
  }

  /** Core 1 back in the ROM: after a forced power-off, or when its entry function returns. */
  parkCore1(): void {
    this.running = false;
    this.heard = [];
    this.inbox[1].length = 0;
    this.sticky[1] = 0;
    this.sioState[1] = null;
    const core = this.cores[1];
    core.waiting = false;
    this.updateIrqs();
  }

  // -------------------------------------------------------------- the FIFOs

  private deliver(to: 0 | 1, word: number): void {
    const box = this.inbox[to];
    if (box.length >= FIFO_DEPTH) {
      // Writing a full FIFO sets the writer's WOF and drops the word.
      this.sticky[to === 0 ? 1 : 0] |= ST_WOF;
    } else {
      box.push(word >>> 0);
    }
    this.updateIrqs();
  }

  private updateIrqs(): void {
    for (const n of [0, 1] as const) {
      const raised = this.inbox[n].length > 0 || this.sticky[n] !== 0;
      for (const core of this.cores) core.setInterrupt(SIO_IRQ_PROC[n], raised);
    }
  }

  private installSio(): void {
    const sio = this.rp.sio;
    const read = sio.readUint32.bind(sio);
    const write = sio.writeUint32.bind(sio);
    sio.readUint32 = (offset: number): number => {
      const me = this.active;
      switch (offset) {
        case CPUID:
          return me;
        case FIFO_ST: {
          const other = me === 0 ? 1 : 0;
          return (this.inbox[me].length ? ST_VLD : 0) | (this.inbox[other].length < FIFO_DEPTH ? ST_RDY : 0) | this.sticky[me];
        }
        case FIFO_RD: {
          const word = this.inbox[me].shift();
          if (word === undefined) {
            // Reading an empty FIFO is an error the hardware records and returns 0.
            this.sticky[me] |= ST_ROE;
            this.updateIrqs();
            return 0;
          }
          this.updateIrqs();
          return word;
        }
        default:
          return read(offset);
      }
    };
    sio.writeUint32 = (offset: number, value: number): void => {
      const me = this.active;
      switch (offset) {
        case FIFO_ST:
          // Writing a 1 clears a sticky flag; the other bits are read-only.
          this.sticky[me] &= ~(value & (ST_WOF | ST_ROE));
          this.updateIrqs();
          return;
        case FIFO_WR: {
          const to = me === 0 ? 1 : 0;
          this.deliver(to, value);
          if (to === 1 && !this.running) this.romReceive(value);
          return;
        }
        default:
          write(offset, value);
      }
    };
  }

  /** Every interrupt line reaches both NVICs, as on the chip. */
  private installInterrupts(): void {
    this.rp.setInterrupt = (irq: number, value: boolean) => {
      this.cores[0].setInterrupt(irq, value);
      this.cores[1].setInterrupt(irq, value);
    };
  }

  private installSevWatch(): void {
    const logger = (this.rp as unknown as { logger: { info(tag: string, msg: string): void } }).logger;
    const info = logger.info.bind(logger);
    logger.info = (tag: string, msg: string) => {
      if (msg === 'SEV') this.sevSeen = true;
      else info(tag, msg);
    };
  }

  private installPsm(): void {
    const psm = this.rp.peripherals[0x40010];
    const write = psm.writeUint32.bind(psm);
    let forcedOff = false;
    psm.writeUint32 = (offset: number, value: number) => {
      write(offset, value);
      if (offset !== PSM_FRCE_OFF) return;
      if (value & PSM_PROC1) {
        forcedOff = true;
        this.parkCore1();
      } else if (forcedOff) {
        // Out of reset, core 1's ROM announces itself with a 0 (the SDK's
        // multicore_reset_core1 waits for it), and signals the event.
        forcedOff = false;
        this.deliver(0, 0);
        this.signalEvent();
      }
    };
  }
}

/** The bit layout, exported so tests can assert against named constants. */
export const SIO_FIFO_BITS = { VLD: ST_VLD, RDY: ST_RDY, WOF: ST_WOF, ROE: ST_ROE, FIFO_ST, FIFO_WR, FIFO_RD };
