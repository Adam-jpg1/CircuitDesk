// Bounded execution tracer for the RP2040 harness — test and development only.
//
// Written after a diagnosis that guesswork could not have produced. The RP2040
// stall at PC 0x108 was only explained once every entry to rom_table_lookup
// was logged with the requested code: four documented integer helpers were
// being asked for and were not advertised, so the lookup returned 0, the
// caller executed `blx 0`, and control slid through the zeroed ROM header back
// into the lookup with garbage in r1. No amount of reading the code showed
// that; a trace showed it immediately.
//
// This class exists so the next stall is diagnosed the same way. Everything it
// does is bounded: a fixed-size ring buffer, an optional PC filter, and stop
// conditions that guarantee a run ends with a stated reason rather than by
// exhausting memory or wedging a test suite.

import { buildBootStub } from '../../src/simulation/rp2040/bootStub';
import type { PicoMachine } from './picoMachine.mts';

export interface TraceRange {
  /** Inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
  name?: string;
}

export interface TraceEntry {
  /** Instruction ordinal since tracing began, including filtered-out steps. */
  index: number;
  pc: number;
  symbol?: string;
  sp: number;
  lr: number;
  /** Values of the registers named in `registers`, in the same order. */
  registers?: number[];
  /** Simulated time in milliseconds. */
  millis: number;
}

export interface TraceOptions {
  /** Ring-buffer capacity. Oldest entries are overwritten. Default 4096. */
  capacity?: number;
  /**
   * Record only while the program counter is inside one of these ranges.
   * Omit to record every step — expensive, so pair it with a small capacity.
   */
  ranges?: TraceRange[];
  /** Record only these exact addresses (the Thumb bit is ignored). */
  addresses?: number[];
  /** Register numbers to snapshot with each entry, e.g. [0, 1, 2]. */
  registers?: number[];
  /** Extra address-to-name annotations, merged over the boot stub's own. */
  symbols?: Record<number, string>;
  /**
   * Stop the run when one address is reached this many times. This catches the
   * exact failure mode above: a tight loop that never terminates.
   */
  repeatLimit?: number;
  /** Stop the run when this returns true for a recorded entry. */
  stopWhen?: (entry: TraceEntry) => boolean;
  /** Called for every recorded entry, for streaming output. */
  onEntry?: (entry: TraceEntry) => void;
  /**
   * Capture rp2040js's own log output — unhandled peripheral reads and writes
   * surface here, e.g. "Write to invalid SIO address".
   */
  capturePeripheralLogs?: boolean;
  /** Ring-buffer capacity for peripheral log lines. Default 256. */
  logCapacity?: number;
}

export interface PeripheralLogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  millis: number;
}

export class Tracer {
  private readonly capacity: number;
  private readonly ring: (TraceEntry | undefined)[];
  private write = 0;
  private recorded = 0;
  private index = 0;

  private readonly ranges: TraceRange[];
  private readonly addresses: Set<number> | null;
  private readonly registers: number[] | undefined;
  private readonly symbols: Map<number, string>;
  private readonly counts = new Map<number, number>();

  private readonly logRing: PeripheralLogLine[] = [];
  private readonly logCapacity: number;
  private logsAttached = false;

  /** Set once a stop condition fires; PicoMachine.run ends the run. */
  stopRequested = false;
  /** Why tracing asked for the stop. */
  stopReason: string | null = null;

  constructor(private readonly options: TraceOptions = {}) {
    this.capacity = options.capacity ?? 4096;
    this.ring = new Array(this.capacity);
    this.ranges = options.ranges ?? [];
    this.addresses = options.addresses ? new Set(options.addresses.map((a) => a & ~1)) : null;
    this.registers = options.registers;
    this.logCapacity = options.logCapacity ?? 256;

    // Boot-stub symbols come for free, so a trace reads as function names
    // rather than as bare ROM addresses.
    this.symbols = new Map();
    const stub = buildBootStub();
    const seen = new Map<number, string[]>();
    for (const [name, addr] of Object.entries(stub.functions)) {
      const list = seen.get(addr) ?? [];
      list.push(name);
      seen.set(addr, list);
    }
    for (const [addr, names] of seen) this.symbols.set(addr, `rom:${names.join('/')}`);
    this.symbols.set(stub.functionTableAddress, 'rom:function_table');
    for (const [addr, name] of Object.entries(options.symbols ?? {})) this.symbols.set(Number(addr), name);
  }

  /** Names an address in later output. */
  addSymbol(address: number, name: string): void {
    this.symbols.set(address & ~1, name);
  }

  /** Installs a logger that records rp2040js's peripheral complaints. */
  attachPeripheralLogs(machine: PicoMachine): void {
    if (this.logsAttached) return;
    this.logsAttached = true;
    const push = (level: PeripheralLogLine['level']) => (...args: unknown[]) => {
      if (this.logRing.length >= this.logCapacity) this.logRing.shift();
      this.logRing.push({ level, message: args.map(String).join(' '), millis: machine.millis });
    };
    machine.rp.logger = { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
  }

  /** Called by PicoMachine.run before each instruction. */
  observe(machine: PicoMachine): void {
    if (this.options.capturePeripheralLogs && !this.logsAttached) this.attachPeripheralLogs(machine);

    const core = machine.rp.core;
    const pc = core.PC & ~1;
    const i = this.index++;
    if (!this.matches(pc)) return;

    const count = (this.counts.get(pc) ?? 0) + 1;
    this.counts.set(pc, count);

    const entry: TraceEntry = {
      index: i,
      pc,
      symbol: this.symbols.get(pc),
      sp: core.SP >>> 0,
      lr: core.registers[14] >>> 0,
      registers: this.registers?.map((r) => core.registers[r] >>> 0),
      millis: machine.millis,
    };
    this.ring[this.write] = entry;
    this.write = (this.write + 1) % this.capacity;
    this.recorded++;

    this.options.onEntry?.(entry);

    if (this.options.repeatLimit && count >= this.options.repeatLimit) {
      this.stop(`address 0x${pc.toString(16)} was reached ${count} times`);
    } else if (this.options.stopWhen?.(entry)) {
      this.stop(`stopWhen matched at 0x${pc.toString(16)}`);
    }
  }

  private matches(pc: number): boolean {
    if (this.addresses) return this.addresses.has(pc);
    if (this.ranges.length === 0) return true;
    return this.ranges.some((r) => pc >= r.start && pc < r.end);
  }

  private stop(reason: string): void {
    this.stopRequested = true;
    this.stopReason ??= reason;
  }

  /** How many steps were considered, recorded or not. */
  get observed(): number {
    return this.index;
  }

  /** How many entries were recorded, including ones the ring has discarded. */
  get recordedCount(): number {
    return this.recorded;
  }

  /** The retained entries, oldest first. */
  get entries(): TraceEntry[] {
    const out: TraceEntry[] = [];
    for (let i = 0; i < this.capacity; i++) {
      const e = this.ring[(this.write + i) % this.capacity];
      if (e) out.push(e);
    }
    return out;
  }

  /** Visit counts per address, hottest first — finds the loop in a stall. */
  hottest(limit = 10): { pc: number; count: number; symbol?: string }[] {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([pc, count]) => ({ pc, count, symbol: this.symbols.get(pc) }));
  }

  /** Peripheral log lines captured during the run. */
  get peripheralLogs(): PeripheralLogLine[] {
    return [...this.logRing];
  }

  /** A human-readable tail of the trace. */
  format(limit = 40): string {
    const rows = this.entries.slice(-limit).map((e) => {
      const where = e.symbol ? `0x${e.pc.toString(16)} <${e.symbol}>` : `0x${e.pc.toString(16)}`;
      const regs = e.registers ? '  ' + e.registers.map((v, i) => `r${this.registers![i]}=0x${v.toString(16)}`).join(' ') : '';
      return `#${e.index} ${e.millis.toFixed(3)}ms ${where} sp=0x${e.sp.toString(16)} lr=0x${e.lr.toString(16)}${regs}`;
    });
    return rows.join('\n');
  }
}

/**
 * Convenience tracer for the ROM interface: records every entry to
 * rom_table_lookup along with the requested function code. This is the exact
 * instrument that explained the 0x108 stall.
 */
export function traceRomLookups(options: { repeatLimit?: number; capacity?: number } = {}) {
  const stub = buildBootStub();
  const requests = new Map<number, number>();
  const tracer = new Tracer({
    addresses: [stub.functions.rom_table_lookup, 0],
    registers: [0, 1],
    capacity: options.capacity ?? 512,
    repeatLimit: options.repeatLimit,
    symbols: { 0: 'address-zero (unresolved lookup target)' },
    onEntry(entry) {
      if (entry.pc !== (stub.functions.rom_table_lookup & ~1)) return;
      const code = (entry.registers?.[1] ?? 0) & 0xffff;
      requests.set(code, (requests.get(code) ?? 0) + 1);
    },
  });
  return {
    tracer,
    /** Requested ROM function codes and how often each was asked for. */
    requests,
    /** Codes rendered as their two-character datasheet tags. */
    summary(): { tag: string; code: number; count: number }[] {
      return [...requests.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => ({ tag: String.fromCharCode(code & 0xff, (code >> 8) & 0xff), code, count }));
    },
    /** Times control reached address 0 — the signature of a failed lookup. */
    get branchesToZero(): number {
      return tracer.entries.filter((e) => e.pc === 0).length;
    },
  };
}
