// Bounded startup tracer for the ESP32-C3 — test and development only.
//
// The RP2040 milestones were unblocked by tracing rather than by reading code,
// and the same applies here: the first ESP32-C3 blocker was found by logging
// every entry into the mask ROM. This packages that method so the next blocker
// takes minutes instead of a session.
//
// Everything is bounded: a fixed-size ring buffer, optional PC filtering, and
// stop conditions that guarantee a run ends with a stated reason rather than
// by exhausting memory or wedging a suite.
//
// Nothing here is ESP32-C3-specific beyond the symbol loader, so it serves any
// RISC-V target CircuitDesk adds later.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Esp32C3Machine, type MmioEvent, type RomCallEvent } from '../../src/simulation/esp32c3/esp32c3Machine';
import { RiscvFault } from '../../src/simulation/riscv/rv32Core';

export interface TraceEntry {
  index: number;
  pc: number;
  symbol?: string;
  /** Values of the registers named in `registers`, in the same order. */
  registers?: number[];
}

export interface TraceOptions {
  /** Ring-buffer capacity; oldest entries are overwritten. Default 4096. */
  capacity?: number;
  /** Record only while the program counter is inside one of these ranges. */
  ranges?: { start: number; end: number }[];
  /** Register numbers to snapshot with each entry. */
  registers?: number[];
  /** Stop when a single address is reached this many times. */
  repeatLimit?: number;
  /** Record MMIO accesses no peripheral claimed. */
  captureUnclaimedMmio?: boolean;
  /** Ring-buffer capacity for MMIO and ROM events. Default 512. */
  eventCapacity?: number;
}

export interface RunResult {
  instructions: number;
  wallMs: number;
  reason: 'until' | 'repeat' | 'fault' | 'maxInstructions' | 'maxWallMs';
  pc: number;
  fault?: Error;
}

/**
 * Reads symbol names out of an ELF with the toolchain's own `nm`.
 *
 * Diagnostics only — the runtime never needs an ELF, and a missing toolchain
 * degrades to unnamed addresses rather than failing.
 */
export function loadElfSymbols(elfPath: string, nmPath: string): Map<number, string> {
  const symbols = new Map<number, string>();
  if (!existsSync(elfPath) || !existsSync(nmPath)) return symbols;
  try {
    const output = execFileSync(nmPath, [elfPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of output.split('\n')) {
      const match = /^([0-9a-f]{8})\s+\S\s+(\S+)$/i.exec(line.trim());
      if (!match) continue;
      const address = Number.parseInt(match[1], 16);
      // Keep the first name for an address so the primary symbol wins over an
      // alias that happens to sort later.
      if (!symbols.has(address)) symbols.set(address, match[2]);
    }
  } catch {
    /* toolchain unavailable; addresses stay unnamed */
  }
  return symbols;
}

export class Esp32C3Tracer {
  private readonly capacity: number;
  private readonly ring: (TraceEntry | undefined)[];
  private write = 0;
  private index = 0;
  private readonly counts = new Map<number, number>();

  readonly mmio: MmioEvent[] = [];
  readonly romCalls: RomCallEvent[] = [];

  /** Set once a repeat limit fires. */
  stopReason: string | null = null;

  constructor(
    readonly machine: Esp32C3Machine,
    private readonly options: TraceOptions = {},
  ) {
    this.capacity = options.capacity ?? 4096;
    this.ring = new Array(this.capacity);
  }

  /** Wires the machine's MMIO and ROM callbacks into this tracer. */
  static attach(options: TraceOptions & { symbols?: Map<number, string> } = {}): {
    machine: Esp32C3Machine;
    tracer: Esp32C3Tracer;
  } {
    const eventCapacity = options.eventCapacity ?? 512;
    let tracer!: Esp32C3Tracer;
    const machine = new Esp32C3Machine({
      onUnclaimedMmio: (event) => {
        if (!options.captureUnclaimedMmio) return;
        if (tracer.mmio.length >= eventCapacity) tracer.mmio.shift();
        tracer.mmio.push(event);
      },
      onRomCall: (event) => {
        if (tracer.romCalls.length >= eventCapacity) tracer.romCalls.shift();
        tracer.romCalls.push(event);
      },
    });
    if (options.symbols) machine.symbols = options.symbols;
    tracer = new Esp32C3Tracer(machine, options);
    return { machine, tracer };
  }

  private matches(pc: number): boolean {
    const ranges = this.options.ranges;
    if (!ranges || ranges.length === 0) return true;
    return ranges.some((r) => pc >= r.start && pc < r.end);
  }

  private record(pc: number): boolean {
    const i = this.index++;
    if (!this.matches(pc)) return true;
    const count = (this.counts.get(pc) ?? 0) + 1;
    this.counts.set(pc, count);
    this.ring[this.write] = {
      index: i,
      pc,
      symbol: this.machine.symbols.get(pc),
      registers: this.options.registers?.map((r) => this.machine.core.registers[r] | 0),
    };
    this.write = (this.write + 1) % this.capacity;
    if (this.options.repeatLimit && count >= this.options.repeatLimit) {
      this.stopReason = `address 0x${pc.toString(16)} was reached ${count} times`;
      return false;
    }
    return true;
  }

  /** Runs the machine, bounded, recording as configured. */
  run(options: { maxInstructions?: number; maxWallMs?: number; until?: () => boolean } = {}): RunResult {
    const maxInstructions = options.maxInstructions ?? 20_000_000;
    const maxWallMs = options.maxWallMs ?? 60_000;
    const started = Date.now();
    let instructions = 0;
    let reason: RunResult['reason'] = 'maxInstructions';
    let fault: Error | undefined;

    while (instructions < maxInstructions) {
      if (options.until?.()) {
        reason = 'until';
        break;
      }
      if (instructions % 8192 === 0 && Date.now() - started >= maxWallMs) {
        reason = 'maxWallMs';
        break;
      }
      if (!this.record(this.machine.core.pc >>> 0)) {
        reason = 'repeat';
        break;
      }
      try {
        this.machine.step();
      } catch (err) {
        fault = err as Error;
        reason = 'fault';
        break;
      }
      instructions++;
    }
    return { instructions, wallMs: Date.now() - started, reason, pc: this.machine.core.pc >>> 0, fault };
  }

  /** Retained entries, oldest first. */
  get entries(): TraceEntry[] {
    const out: TraceEntry[] = [];
    for (let i = 0; i < this.capacity; i++) {
      const entry = this.ring[(this.write + i) % this.capacity];
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Visit counts per address, hottest first — finds the loop in a stall. */
  hottest(limit = 10): { pc: number; count: number; symbol?: string }[] {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([pc, count]) => ({ pc, count, symbol: this.machine.symbols.get(pc) }));
  }

  /**
   * The nearest preceding symbol for an address.
   *
   * A fault rarely lands exactly on a symbol, so naming the function it is
   * inside is what actually identifies the code.
   */
  nearestSymbol(address: number): { name: string; offset: number } | undefined {
    let best: { name: string; offset: number } | undefined;
    for (const [symbolAddress, name] of this.machine.symbols) {
      if (symbolAddress > address) continue;
      const offset = address - symbolAddress;
      if (!best || offset < best.offset) best = { name, offset };
    }
    return best;
  }

  /** A readable tail of the trace. */
  format(limit = 30): string {
    return this.entries
      .slice(-limit)
      .map((e) => {
        const where = e.symbol ? `0x${e.pc.toString(16)} <${e.symbol}>` : `0x${e.pc.toString(16)}`;
        const regs = e.registers ? '  ' + e.registers.map((v, i) => `x${this.options.registers![i]}=0x${(v >>> 0).toString(16)}`).join(' ') : '';
        return `#${e.index} ${where}${regs}`;
      })
      .join('\n');
  }

  /** Distinct unclaimed MMIO addresses, with how they were used. */
  unclaimedSummary(): { address: number; reads: number; writes: number }[] {
    const byAddress = new Map<number, { address: number; reads: number; writes: number }>();
    for (const event of this.mmio) {
      const entry = byAddress.get(event.address) ?? { address: event.address, reads: 0, writes: 0 };
      if (event.write) entry.writes++;
      else entry.reads++;
      byAddress.set(event.address, entry);
    }
    return [...byAddress.values()].sort((a, b) => b.reads + b.writes - (a.reads + a.writes));
  }

  /** Describes a fault with the function it happened inside. */
  describeFault(fault: Error | undefined): string {
    if (!fault) return 'no fault';
    if (fault instanceof RiscvFault) {
      const near = this.nearestSymbol(fault.pc >>> 0);
      return `${fault.message}${near ? ` in ${near.name}+0x${near.offset.toString(16)}` : ''}`;
    }
    return fault.message;
  }
}
