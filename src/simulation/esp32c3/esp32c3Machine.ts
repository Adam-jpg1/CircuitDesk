// An ESP32-C3 machine: memory map, ROM dispatch and peripheral routing.
//
// This is the piece between the generic RV32 core and the chip's own
// behaviour. The core knows only how to execute instructions against a `Bus`;
// everything that makes those instructions mean something on an ESP32-C3 —
// where RAM lives, which addresses are peripherals, what happens when the
// program counter enters the mask ROM — is here.
//
// Kept separate from the runner so the same machine can be driven by a test,
// a trace harness or the production adapter without any of them reimplementing
// the memory map.

import { Rv32Core, type Bus } from '../riscv/rv32Core';
import type { EspApplicationImage } from './espImage';
import {
  ARG_REGISTER_BASE,
  buildRomTable,
  createRomMachineState,
  isRomAddress,
  ResetReason,
  UnimplementedRomCallError,
  type RomFunction,
  type RomMachineState,
} from './romFunctions';

/** Documented ESP32-C3 address ranges this machine models. */
export const MEMORY_MAP = {
  rom: { start: 0x40000000, end: 0x40060000 },
  iram: { start: 0x40380000, end: 0x403e0000 },
  dram: { start: 0x3fc80000, end: 0x3fce0000 },
  drom: { start: 0x3c000000, end: 0x3c800000 },
  irom: { start: 0x42000000, end: 0x42800000 },
  rtcFast: { start: 0x50000000, end: 0x50002000 },
  peripheral: { start: 0x60000000, end: 0x60100000 },
} as const;

/**
 * The stack the mask ROM is running on when it enters the application.
 *
 * ESP-IDF names this SOC_ROM_STACK_START, and `call_start_cpu0` runs on it
 * until it switches to its own. Because this runtime enters the application
 * directly rather than executing the ROM's boot flow, it has to establish the
 * same starting condition — without it the very first function prologue pushes
 * its return address to whatever address a zero stack pointer produces, and
 * the eventual return goes to nowhere.
 *
 * This is startup register state, not a patch: it reproduces what the firmware
 * would have found on entry.
 */
export const ROM_STACK_TOP = 0x3fcde710;

/** A memory-mapped peripheral. Addresses are offsets from its base. */
export interface Peripheral {
  readonly name: string;
  readonly base: number;
  readonly size: number;
  readUint32(offset: number): number;
  writeUint32(offset: number, value: number): void;
  reset?(): void;
}

export interface MmioEvent {
  address: number;
  value: number;
  write: boolean;
  peripheral: string | undefined;
  pc: number;
}

export interface RomCallEvent {
  address: number;
  symbol: string | undefined;
  args: number[];
  result: number | undefined;
  pc: number;
}

export interface Esp32C3MachineOptions {
  /** Extra or replacement ROM entry points, for tests. */
  romFunctions?: RomFunction[];
  resetReason?: ResetReason;
  /** Called for every access to an address no peripheral claims. */
  onUnclaimedMmio?: (event: MmioEvent) => void;
  onRomCall?: (event: RomCallEvent) => void;
}

/**
 * Sparse byte memory.
 *
 * The C3's address space is wide and mostly empty, so memory is allocated in
 * 64 KB pages on first touch rather than as one enormous array.
 */
class SparseMemory {
  private readonly pages = new Map<number, Uint8Array>();

  page(address: number): Uint8Array {
    const key = address >>> 16;
    let page = this.pages.get(key);
    if (!page) {
      page = new Uint8Array(0x10000);
      this.pages.set(key, page);
    }
    return page;
  }

  clear(): void {
    this.pages.clear();
  }
}

export class Esp32C3Machine implements Bus {
  readonly core: Rv32Core;
  readonly romState: RomMachineState;

  private readonly memory = new SparseMemory();
  private readonly romTable: Map<number, RomFunction>;
  private readonly peripherals: Peripheral[] = [];
  private image: EspApplicationImage | null = null;

  /** Symbol names by address, for diagnostics. Populated from an ELF if one is available. */
  symbols = new Map<number, string>();

  constructor(private readonly options: Esp32C3MachineOptions = {}) {
    this.romTable = buildRomTable(options.romFunctions);
    this.romState = createRomMachineState(options.resetReason ?? ResetReason.PowerOn);
    this.core = new Rv32Core(this);
  }

  /** Registers a peripheral. Later registrations win for overlapping ranges. */
  addPeripheral(peripheral: Peripheral): void {
    this.peripherals.push(peripheral);
  }

  peripheralAt(address: number): Peripheral | undefined {
    const a = address >>> 0;
    for (let i = this.peripherals.length - 1; i >= 0; i--) {
      const p = this.peripherals[i];
      if (a >= p.base && a < p.base + p.size) return p;
    }
    return undefined;
  }

  /**
   * Places an application image's segments at their own load addresses and
   * points the core at its own entry point.
   *
   * This is what the second-stage bootloader does on hardware. Nothing is
   * patched and no address is chosen by this runtime.
   */
  loadImage(image: EspApplicationImage): void {
    this.image = image;
    this.memory.clear();
    for (const segment of image.segments) {
      for (let i = 0; i < segment.data.length; i++) this.writeByte(segment.loadAddress + i, segment.data[i]);
    }
    this.core.reset(image.entryPoint);
    // The application is entered on the ROM's stack, exactly as it would be on
    // hardware. x2 is sp in the RISC-V calling convention.
    this.core.registers[2] = ROM_STACK_TOP | 0;
  }

  /** Returns the machine to its power-on state and boots the same image again. */
  reset(): void {
    for (const peripheral of this.peripherals) peripheral.reset?.();
    this.romState.regi2c.clear();
    this.romState.cache.iCacheEnabled = false;
    this.romState.cache.iromMmuSize = 0;
    this.romState.cache.dromMmuSize = 0;
    if (this.image) this.loadImage(this.image);
  }

  /**
   * Executes one instruction, dispatching a ROM call if the program counter
   * has entered the mask ROM.
   *
   * Returns the bytes the instruction occupied, or 0 for a ROM call, so a
   * caller can advance a cycle counter.
   */
  step(): number {
    const pc = this.core.pc >>> 0;
    if (isRomAddress(pc)) {
      this.dispatchRomCall(pc);
      return 0;
    }
    return this.core.step();
  }

  /**
   * Runs a ROM function natively and returns to the caller through `ra`.
   *
   * The firmware still makes a real call with real arguments and still
   * observes a real result; only the implementation is native rather than
   * emitted machine code.
   */
  private dispatchRomCall(pc: number): void {
    const entry = this.romTable.get(pc);
    const returnAddress = this.core.registers[1] >>> 0;
    if (!entry) {
      throw new UnimplementedRomCallError(pc, this.symbols.get(pc), returnAddress);
    }
    const args = [0, 1, 2, 3, 4, 5].map((i) => this.core.registers[ARG_REGISTER_BASE + i] | 0);
    const result = entry.handler({ args, bus: this, machine: this.romState, registers: this.core.registers });
    if (typeof result === 'number') this.core.registers[ARG_REGISTER_BASE] = result | 0;
    this.options.onRomCall?.({ address: pc, symbol: entry.name, args, result: typeof result === 'number' ? result : undefined, pc: returnAddress });
    this.core.pc = returnAddress;
  }

  // ------------------------------------------------------------------ bus

  private isPeripheralAddress(address: number): boolean {
    const a = address >>> 0;
    return a >= MEMORY_MAP.peripheral.start && a < MEMORY_MAP.peripheral.end;
  }

  private writeByte(address: number, value: number): void {
    this.memory.page(address >>> 0)[(address >>> 0) & 0xffff] = value & 0xff;
  }

  private readByte(address: number): number {
    return this.memory.page(address >>> 0)[(address >>> 0) & 0xffff];
  }

  /**
   * Peripheral registers are 32 bits wide and are accessed as words even when
   * firmware reads a byte out of one, so a narrow access reads the containing
   * word and extracts from it.
   */
  private readPeripheral(address: number): number {
    const a = address >>> 0;
    const peripheral = this.peripheralAt(a);
    if (peripheral) return peripheral.readUint32(a - peripheral.base) >>> 0;
    this.options.onUnclaimedMmio?.({ address: a, value: 0, write: false, peripheral: undefined, pc: this.core.pc >>> 0 });
    // An unmodelled register reads as zero. Firmware polling a status bit that
    // never sets will hang rather than proceed on invented data, which is the
    // honest failure and is visible through the unclaimed-MMIO callback.
    return 0;
  }

  private writePeripheral(address: number, value: number): void {
    const a = address >>> 0;
    const peripheral = this.peripheralAt(a);
    if (peripheral) {
      peripheral.writeUint32(a - peripheral.base, value >>> 0);
      return;
    }
    this.options.onUnclaimedMmio?.({ address: a, value: value >>> 0, write: true, peripheral: undefined, pc: this.core.pc >>> 0 });
  }

  readUint8(address: number): number {
    if (this.isPeripheralAddress(address)) return (this.readPeripheral(address & ~3) >>> ((address & 3) * 8)) & 0xff;
    return this.readByte(address);
  }

  readUint16(address: number): number {
    if (this.isPeripheralAddress(address)) return (this.readPeripheral(address & ~3) >>> ((address & 2) * 8)) & 0xffff;
    return this.readByte(address) | (this.readByte(address + 1) << 8);
  }

  readUint32(address: number): number {
    if (this.isPeripheralAddress(address)) return this.readPeripheral(address);
    return (
      (this.readByte(address) |
        (this.readByte(address + 1) << 8) |
        (this.readByte(address + 2) << 16) |
        (this.readByte(address + 3) << 24)) >>>
      0
    );
  }

  writeUint8(address: number, value: number): void {
    if (this.isPeripheralAddress(address)) {
      const shift = (address & 3) * 8;
      const word = this.readPeripheral(address & ~3);
      this.writePeripheral(address & ~3, (word & ~(0xff << shift)) | ((value & 0xff) << shift));
      return;
    }
    this.writeByte(address, value);
  }

  writeUint16(address: number, value: number): void {
    if (this.isPeripheralAddress(address)) {
      const shift = (address & 2) * 8;
      const word = this.readPeripheral(address & ~3);
      this.writePeripheral(address & ~3, (word & ~(0xffff << shift)) | ((value & 0xffff) << shift));
      return;
    }
    this.writeByte(address, value);
    this.writeByte(address + 1, value >> 8);
  }

  writeUint32(address: number, value: number): void {
    if (this.isPeripheralAddress(address)) {
      this.writePeripheral(address, value);
      return;
    }
    this.writeByte(address, value);
    this.writeByte(address + 1, value >> 8);
    this.writeByte(address + 2, value >> 16);
    this.writeByte(address + 3, value >> 24);
  }
}
