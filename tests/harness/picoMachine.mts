// RP2040 boot harness — test and development only.
//
// Nothing under src/ imports this file. It exists so every RP2040 test boots
// firmware through one documented implementation of the datasheet's startup
// sequence instead of each test re-deriving it, and so a failure is always a
// failure of the simulator rather than of a copy-pasted boot snippet.
//
// The sequence modelled here is the public one from RP2040 datasheet section
// 2.8: the boot ROM copies the 256-byte second stage from the start of flash
// to the top of SRAM and executes it; the second stage configures execute-in-
// place and returns; the ROM then reads the application's vector table from
// flash + 0x100 and enters the reset handler. The image's own boot2 is used —
// it comes from the user's compiled firmware and is never patched or skipped.

import { buildBootStub } from '../../src/simulation/rp2040/bootStub';
import { PadPullResolver } from '../../src/simulation/rp2040/gpioPulls';
import type { Tracer } from './trace.mts';

export const FLASH_BASE = 0x10000000;
export const FLASH_SIZE = 0x200000;
export const RP2040_FAMILY_ID = 0xe48bff56;
export const SRAM_TOP = 0x20042000;

/** Where the ROM places the second stage before running it. */
export const BOOT2_RAM = SRAM_TOP - 0x100;

/**
 * Return address handed to boot2 in LR. It points into the ROM header block,
 * which holds no code, so reaching it can only mean the second stage returned.
 */
export const BOOT2_SENTINEL = 0x00000f00;

export const DEFAULT_CLOCK_HZ = 125e6;

// ------------------------------------------------------------------- UF2

export interface Uf2Image {
  /** Flash payloads keyed by absolute target address. */
  blocks: Map<number, Uint8Array>;
  /** Family ids declared by the file, for validation. */
  families: Set<number>;
}

/**
 * Strict RP2040 UF2 reader. Every documented field is checked, because a UF2
 * that is silently mis-parsed produces a firmware image that fails in ways
 * that look like simulator bugs.
 */
export function parseUf2(buf: Uint8Array): Uf2Image {
  if (buf.length === 0 || buf.length % 512 !== 0) throw new Error('UF2 length must be a multiple of 512');
  const blocks = new Map<number, Uint8Array>();
  const families = new Set<number>();
  for (let off = 0; off + 512 <= buf.length; off += 512) {
    const dv = new DataView(buf.buffer, buf.byteOffset + off, 512);
    if (dv.getUint32(0, true) !== 0x0a324655) throw new Error('bad UF2 magic 0');
    if (dv.getUint32(4, true) !== 0x9e5d5157) throw new Error('bad UF2 magic 1');
    if (dv.getUint32(508, true) !== 0x0ab16f30) throw new Error('bad UF2 final magic');
    const flags = dv.getUint32(8, true);
    const addr = dv.getUint32(12, true);
    const len = dv.getUint32(16, true);
    if (len > 476) throw new Error('UF2 payload too large');
    if (flags & 0x2000) families.add(dv.getUint32(28, true));
    if (flags & 0x0001) continue; // not a main-flash block
    if (addr < FLASH_BASE || addr + len > FLASH_BASE + FLASH_SIZE) throw new Error('address outside RP2040 flash');
    blocks.set(addr, buf.slice(off + 32, off + 32 + len));
  }
  if (families.size && !families.has(RP2040_FAMILY_ID)) throw new Error('wrong UF2 family id');
  return { blocks, families };
}

/** Imports rp2040js if it is installed, so suites can degrade to a skip. */
export async function loadRp2040js(): Promise<any | null> {
  try {
    return await import('rp2040js');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- the machine

export interface RunOptions {
  /** Hard instruction ceiling. Always finite: nothing here may hang a suite. */
  maxInstructions?: number;
  /** Hard wall-clock ceiling in milliseconds. */
  maxWallMs?: number;
  /** Stop as soon as this returns true, checked before each instruction. */
  until?: () => boolean;
  /** Optional tracer, given every step and able to request a stop. */
  trace?: Tracer;
}

export interface RunResult {
  instructions: number;
  wallMs: number;
  /** Why the run ended — never "the process gave up". */
  reason: 'until' | 'trace' | 'maxInstructions' | 'maxWallMs';
  pc: number;
}

export interface GpioRecording {
  /** Simulated milliseconds at which the pin changed state. */
  times: number[];
  /** The state after each change. */
  states: number[];
  readonly count: number;
}

/**
 * A Pico with our own boot ROM stub in place of Raspberry Pi's.
 *
 * The firmware image is untouched: it is written into flash exactly as the
 * UF2 describes, and execution starts at the addresses the image itself
 * publishes. There is no patching, no skipping of startup functions by
 * address and no forcing of the program counter into user code.
 */
export class PicoMachine {
  private machine: any;
  private resolver: PadPullResolver;
  private readonly cycleNs: number;
  private readonly external = new Map<number, boolean>();
  private firmware: Uf2Image | null = null;

  constructor(
    private readonly RP2040: new () => any,
    private readonly options: { clockHz?: number; quiet?: boolean } = {},
  ) {
    this.cycleNs = 1e9 / (options.clockHz ?? DEFAULT_CLOCK_HZ);
    this.machine = this.build();
    this.resolver = new PadPullResolver(this.machine.gpio);
  }

  private build(): any {
    const rp = new this.RP2040();
    if (this.options.quiet !== false) {
      rp.logger = { debug() {}, info() {}, warn() {}, error() {} };
    }
    rp.loadBootrom(buildBootStub().rom);
    return rp;
  }

  get rp(): any {
    return this.machine;
  }

  /** Holds undriven pads at their configured pull level, as silicon does. */
  get pads(): PadPullResolver {
    return this.resolver;
  }

  /**
   * Connects an external driver to a GP pin — a button to ground, a sensor
   * output, a rail. Pass null to disconnect and let the pad's own pull
   * resistor decide, exactly as an open switch would.
   */
  drivePin(index: number, level: boolean | null): void {
    if (level === null) this.external.delete(index);
    else this.external.set(index, level);
    this.resolver.drive(index, level);
  }

  /** The level a GP pin's input buffer currently sees. */
  readPin(index: number): boolean {
    return this.rp.gpio[index].inputValue;
  }

  get nanos(): number {
    return Number(this.rp.clock.nanos ?? 0);
  }

  get millis(): number {
    return this.nanos / 1e6;
  }

  /** Writes a parsed UF2 into flash. */
  loadFirmware(image: Uf2Image | Uint8Array): this {
    const parsed = image instanceof Uint8Array ? parseUf2(image) : image;
    this.firmware = parsed;
    for (const [addr, data] of parsed.blocks) this.rp.flash.set(data, addr - FLASH_BASE);
    return this;
  }

  /** One instruction, or a clock advance while the core is halted on a WFI/WFE. */
  step(): void {
    const core = this.rp.core;
    if (core.waiting) {
      this.rp.clock.tick?.(this.rp.clock.nanosToNextAlarm ?? this.cycleNs);
    } else {
      const cycles = core.executeInstruction();
      this.rp.clock.tick?.((cycles || 1) * this.cycleNs);
    }
  }

  /**
   * Runs the image's own second stage the way the ROM does, then enters the
   * application through its published vector table.
   */
  boot(maxInstructions = 2_000_000): { boot2Returned: boolean; boot2Instructions: number; sp: number; pc: number } {
    for (let i = 0; i < 256; i++) this.rp.writeUint8(BOOT2_RAM + i, this.rp.readUint8(FLASH_BASE + i));
    this.rp.core.SP = SRAM_TOP;
    this.rp.core.registers[14] = BOOT2_SENTINEL | 1;
    this.rp.core.PC = BOOT2_RAM;

    let boot2Returned = false;
    let boot2Instructions = 0;
    for (let i = 0; i < maxInstructions; i++) {
      if ((this.rp.core.PC & ~1) === BOOT2_SENTINEL) {
        boot2Returned = true;
        boot2Instructions = i;
        break;
      }
      this.step();
    }

    const sp = this.rp.readUint32(FLASH_BASE + 0x100);
    const pc = this.rp.readUint32(FLASH_BASE + 0x104) & ~1;
    this.rp.core.SP = sp;
    this.rp.core.PC = pc;
    return { boot2Returned, boot2Instructions, sp, pc };
  }

  /** Bounded execution. Every exit path is a stated reason, never a hang. */
  run(options: RunOptions = {}): RunResult {
    const maxInstructions = options.maxInstructions ?? 40_000_000;
    const maxWallMs = options.maxWallMs ?? 60_000;
    const started = Date.now();
    let instructions = 0;
    let reason: RunResult['reason'] = 'maxInstructions';

    while (true) {
      if (options.until?.()) {
        reason = 'until';
        break;
      }
      if (instructions >= maxInstructions) {
        reason = 'maxInstructions';
        break;
      }
      if (instructions % 4096 === 0 && Date.now() - started >= maxWallMs) {
        reason = 'maxWallMs';
        break;
      }
      options.trace?.observe(this);
      if (options.trace?.stopRequested) {
        reason = 'trace';
        break;
      }
      this.step();
      instructions++;
    }
    return { instructions, wallMs: Date.now() - started, reason, pc: this.rp.core.PC };
  }

  /** Records every edge on a GP pin with the simulated time it happened. */
  watchGpio(pin: number): GpioRecording {
    const rec: GpioRecording = {
      times: [],
      states: [],
      get count() {
        return this.times.length;
      },
    };
    this.rp.gpio[pin].addListener((state: number) => {
      rec.times.push(this.millis);
      rec.states.push(state);
    });
    return rec;
  }

  /** Collects bytes the firmware transmits on a hardware UART. */
  watchUart(index = 0): { bytes: number[]; text: string } {
    const sink = {
      bytes: [] as number[],
      get text() {
        return String.fromCharCode(...this.bytes);
      },
    };
    this.rp.uart[index].onByte = (b: number) => sink.bytes.push(b);
    return sink;
  }

  /**
   * A power-on reset: every part of the chip returns to its reset state and
   * the same flash image is presented again, unchanged.
   *
   * rp2040js's own `reset()` clears only the core and the PWM block — SRAM,
   * the GPIO pads, the SIO and every other peripheral keep whatever the last
   * run left behind, which is not what a reset does and would let a sketch
   * appear to restart while running on stale state. Rebuilding the machine is
   * the accurate model, and it is what the application does when a user stops
   * and restarts a simulation.
   *
   * Callers holding a reference to `rp`, or listeners registered through
   * `watchGpio` / `watchUart`, are attached to the previous machine and must
   * be re-registered afterwards. Externally driven pins are re-applied, since
   * a reset does not unplug the surrounding circuit.
   */
  reset(): void {
    this.machine = this.build();
    this.resolver = new PadPullResolver(this.machine.gpio);
    if (this.firmware) this.loadFirmware(this.firmware);
    for (const [index, level] of this.external) this.resolver.drive(index, level);
  }
}

/** True when the address is inside a region the RP2040 actually maps. */
export function isMappedAddress(addr: number): boolean {
  return (
    addr < 0x4000 || // boot ROM
    (addr >= 0x20000000 && addr < SRAM_TOP) || // SRAM
    (addr >= FLASH_BASE && addr < FLASH_BASE + FLASH_SIZE) // XIP flash
  );
}
