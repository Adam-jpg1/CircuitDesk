// Minimal RP2040 boot ROM stub — independently implemented.
//
// WHY THIS EXISTS
//
// rp2040js models the boot ROM as a plain 16 KB memory region and ships no ROM
// image of its own. Raspberry Pi's own boot ROM cannot be redistributed here:
// bootrom/mufplib.S and bootrom/mufplib-double.S are third-party code
// (© 2020 Mark Owen, Quinapalus) licensed either "solely on a Raspberry Pi
// RP2040 device" or under GPLv2 — neither of which permits shipping them
// inside a browser simulator under CircuitDesk's terms.
//
// Firmware built with the Pico SDK does not boot without *something* at those
// addresses: the SDK resolves memcpy/memset through the ROM's function lookup
// table during startup, and a zeroed ROM makes it branch to address 0.
//
// So this file provides the smallest thing that lets flash firmware run: the
// documented lookup structure, byte-wise implementations of the memory
// routines, the four integer bit helpers the SDK resolves during startup, and
// the flash housekeeping entry points. Everything here is written from the
// public RP2040 datasheet's description of the ROM *interface* (section 2.8,
// "Bootrom"), which documents the table layout and function signatures. No
// Raspberry Pi source code was consulted, copied, translated or derived — in
// particular nothing from mufplib. The implementations below are deliberately
// naive shift and byte loops; they are not, and are not derived from,
// Raspberry Pi's optimised versions.
//
// WHAT IS DELIBERATELY ABSENT
//
// The floating-point and double-precision function tables are the mufplib
// routines. They are NOT provided, so a lookup for them returns the
// documented 0 and firmware that calls through the returned pointer fails
// loudly rather than silently computing wrong numbers. tests/harness/trace.mts
// records every code a firmware asks for, so an unresolved lookup can be
// named rather than guessed at.

/** The RP2040 boot ROM is 16 KB, which is what rp2040js allocates. */
export const BOOTROM_WORDS = 4096;

/**
 * Documented ROM function codes: two ASCII characters packed little-endian.
 * The unimplemented ones are listed so an unresolved lookup can be reported by
 * name instead of as a bare number.
 */
export const ROM_FUNC_CODES: Record<string, number> = {
  // Memory routines.
  memcpy: code('M', 'C'),
  memcpy44: code('C', '4'),
  memset: code('M', 'S'),
  memset4: code('S', '4'),
  // Integer bit helpers, resolved by the SDK during startup.
  popcount32: code('P', '3'),
  reverse32: code('R', '3'),
  clz32: code('L', '3'),
  ctz32: code('T', '3'),
  // Flash housekeeping, which has no observable effect on emulated flash.
  connect_internal_flash: code('I', 'F'),
  flash_exit_xip: code('E', 'X'),
  flash_flush_cache: code('F', 'C'),
  flash_enter_cmd_xip: code('C', 'X'),
  // Documented but not implemented: these write to a real flash device, which
  // this simulator does not model.
  flash_range_erase: code('R', 'E'),
  flash_range_program: code('R', 'P'),
  reset_usb_boot: code('U', 'B'),
  wait_for_vector: code('W', 'V'),
};

/**
 * Data-table codes that are deliberately withheld. These point at the mufplib
 * soft-float routines, which cannot be redistributed here — see the file
 * header and THIRD_PARTY_NOTICES.md.
 */
export const ROM_WITHHELD_CODES: Record<string, number> = {
  soft_float_table: code('S', 'F'),
  soft_double_table: code('S', 'D'),
};

function code(a: string, b: string): number {
  return a.charCodeAt(0) | (b.charCodeAt(0) << 8);
}

/** Reverse map for reporting which function an unresolved lookup wanted. */
export const ROM_FUNC_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ROM_FUNC_CODES).map(([name, value]) => [value, name]),
);

// ---------------------------------------------------------------- assembler
//
// A very small Thumb-1 emitter. Only the handful of encodings used below are
// implemented, each with its datasheet-documented bit layout spelled out.

class Thumb {
  readonly code: number[] = [];
  private labels = new Map<string, number>();
  private fixups: { at: number; label: string; kind: 'b' | 'beq' }[] = [];

  /** Byte address of the next instruction, relative to the ROM base. */
  get here(): number {
    return this.base + this.code.length * 2;
  }

  constructor(readonly base: number) {}

  label(name: string): this {
    this.labels.set(name, this.here);
    return this;
  }

  emit(halfword: number): this {
    this.code.push(halfword & 0xffff);
    return this;
  }

  /** Unconditional branch to a label (T2 encoding). */
  b(label: string): this {
    this.fixups.push({ at: this.code.length, label, kind: 'b' });
    return this.emit(0xe000);
  }

  /** Branch if equal (T1 encoding). */
  beq(label: string): this {
    return this.cond(label, 0x0);
  }

  /** Branch if not equal. */
  bne(label: string): this {
    return this.cond(label, 0x1);
  }

  /** Branch if carry set (the bit shifted out was 1). */
  bcs(label: string): this {
    return this.cond(label, 0x2);
  }

  /** Branch if carry clear (the bit shifted out was 0). */
  bcc(label: string): this {
    return this.cond(label, 0x3);
  }

  /** Conditional branch T1: 1101 cond imm8. */
  private cond(label: string, condition: number): this {
    this.fixups.push({ at: this.code.length, label, kind: 'beq' });
    return this.emit(0xd000 | (condition << 8));
  }

  /** Resolves branch offsets; must be called once the labels are all defined. */
  link(): number[] {
    for (const fix of this.fixups) {
      const target = this.labels.get(fix.label);
      if (target === undefined) throw new Error(`bootrom stub: undefined label ${fix.label}`);
      // Thumb branches are relative to PC, which reads as the instruction
      // address + 4, and the offset is stored in halfwords.
      const delta = (target - (this.base + fix.at * 2 + 4)) / 2;
      this.code[fix.at] |= fix.kind === 'b' ? delta & 0x7ff : delta & 0xff;
    }
    return this.code;
  }
}

// Instruction encodings used below (Thumb-1, from the ARMv6-M architecture
// reference): the bit patterns are fixed by the instruction set, not copied
// from anyone's implementation.
const PUSH_R0_LR = 0xb501;
const POP_R0_PC = 0xbd01;
const CMP_R2_0 = 0x2a00;
const CMP_R2_R1 = 0x428a;
const LDRB_R3_R1 = 0x780b;
const STRB_R3_R0 = 0x7003;
const STRB_R1_R0 = 0x7001;
const LDRH_R2_R0 = 0x8802;
const LDRH_R0_R0_2 = 0x8840;
const ADDS_R0_1 = 0x3001;
const ADDS_R0_4 = 0x3004;
const ADDS_R1_1 = 0x3101;
const SUBS_R2_1 = 0x3a01;
const MOVS_R0_0 = 0x2000;
const MOVS_R1_0 = 0x2100;
const MOVS_R2_0 = 0x2200;
const MOVS_R3_32 = 0x2320;
const MOV_R0_R1 = 0x0008; // lsls r0, r1, #0
const MOV_R0_R2 = 0x0010; // lsls r0, r2, #0
const LSLS_R0_1 = 0x0040;
const LSLS_R2_1 = 0x0052;
const LSRS_R0_1 = 0x0840;
const ADDS_R1_1_IMM = 0x3101;
const ADDS_R2_1 = 0x3201;
const SUBS_R3_1 = 0x3b01;
const CMP_R1_32 = 0x2920;
const BX_LR = 0x4770;

/** memcpy(dest=r0, src=r1, n=r2) -> r0. A plain byte loop. */
function emitMemcpy(base: number): number[] {
  const t = new Thumb(base);
  t.emit(PUSH_R0_LR)
    .label('loop')
    .emit(CMP_R2_0)
    .beq('done')
    .emit(LDRB_R3_R1)
    .emit(STRB_R3_R0)
    .emit(ADDS_R0_1)
    .emit(ADDS_R1_1)
    .emit(SUBS_R2_1)
    .b('loop')
    .label('done')
    .emit(POP_R0_PC);
  return t.link();
}

/** memset(dest=r0, c=r1, n=r2) -> r0. A plain byte loop. */
function emitMemset(base: number): number[] {
  const t = new Thumb(base);
  t.emit(PUSH_R0_LR)
    .label('loop')
    .emit(CMP_R2_0)
    .beq('done')
    .emit(STRB_R1_R0)
    .emit(ADDS_R0_1)
    .emit(SUBS_R2_1)
    .b('loop')
    .label('done')
    .emit(POP_R0_PC);
  return t.link();
}

/**
 * The flash housekeeping routines, which return immediately.
 *
 * On silicon these drive the QSPI pads and the XIP cache:
 * `connect_internal_flash` muxes the pads to the SSI, `flash_exit_xip` takes
 * the flash out of continuous-read mode, `flash_flush_cache` invalidates the
 * XIP cache and `flash_enter_cmd_xip` puts the interface back into XIP.
 *
 * None of that has an observable effect here, because the emulator models
 * flash as plain memory: there is no physical QSPI device to reconfigure and
 * no XIP cache to invalidate. Returning immediately is therefore the
 * *correct* emulated behaviour, not a shortcut — the memory the firmware then
 * reads is exactly the memory it would have read on hardware. This is why the
 * SDK's RAM-resident `flash_do_cmd_cs` can complete: it looks these up through
 * the ROM table before touching the SSI.
 */
function emitReturnImmediately(base: number): number[] {
  return new Thumb(base).emit(BX_LR).link();
}

// ------------------------------------------------- documented bit helpers
//
// The SDK resolves these four through the ROM table during startup. They are
// plain integer routines with published signatures — nothing to do with the
// restricted floating-point library — and are implemented here from those
// signatures alone. Cortex-M0+ has no CLZ instruction, so each is a shift
// loop using the carry flag.

/** clz32(v=r0) -> number of leading zero bits (32 when v is 0). */
function emitClz32(base: number): number[] {
  const t = new Thumb(base);
  t.emit(MOVS_R1_0)
    .label('loop')
    .emit(LSLS_R0_1) // MSB falls into the carry flag
    .bcs('done')
    .emit(ADDS_R1_1_IMM)
    .emit(CMP_R1_32)
    .bne('loop')
    .label('done')
    .emit(MOV_R0_R1)
    .emit(BX_LR);
  return t.link();
}

/** ctz32(v=r0) -> number of trailing zero bits (32 when v is 0). */
function emitCtz32(base: number): number[] {
  const t = new Thumb(base);
  t.emit(MOVS_R1_0)
    .label('loop')
    .emit(LSRS_R0_1) // LSB falls into the carry flag
    .bcs('done')
    .emit(ADDS_R1_1_IMM)
    .emit(CMP_R1_32)
    .bne('loop')
    .label('done')
    .emit(MOV_R0_R1)
    .emit(BX_LR);
  return t.link();
}

/** popcount32(v=r0) -> number of set bits. */
function emitPopcount32(base: number): number[] {
  const t = new Thumb(base);
  t.emit(MOVS_R1_0)
    .emit(MOVS_R3_32)
    .label('loop')
    .emit(LSRS_R0_1)
    .bcc('skip')
    .emit(ADDS_R1_1_IMM)
    .label('skip')
    .emit(SUBS_R3_1)
    .bne('loop')
    .emit(MOV_R0_R1)
    .emit(BX_LR);
  return t.link();
}

/** reverse32(v=r0) -> the 32 bits in reverse order. */
function emitReverse32(base: number): number[] {
  const t = new Thumb(base);
  t.emit(MOVS_R2_0)
    .emit(MOVS_R3_32)
    .label('loop')
    .emit(LSLS_R2_1)
    .emit(LSRS_R0_1)
    .bcc('skip')
    .emit(ADDS_R2_1)
    .label('skip')
    .emit(SUBS_R3_1)
    .bne('loop')
    .emit(MOV_R0_R2)
    .emit(BX_LR);
  return t.link();
}

/**
 * rom_table_lookup(table=r0, code=r1) -> r0.
 *
 * The datasheet describes the table as pairs of halfwords — a two-character
 * code and the entry's address — terminated by a zero code.
 */
function emitTableLookup(base: number): number[] {
  const t = new Thumb(base);
  t.label('loop')
    .emit(LDRH_R2_R0)
    .emit(CMP_R2_0)
    .beq('notfound')
    .emit(CMP_R2_R1)
    .beq('found')
    .emit(ADDS_R0_4)
    .b('loop')
    .label('found')
    .emit(LDRH_R0_R0_2)
    .emit(BX_LR)
    .label('notfound')
    .emit(MOVS_R0_0)
    .emit(BX_LR);
  return t.link();
}

export interface BootStub {
  rom: Uint32Array;
  /** Byte address of each implemented function, for tests and diagnostics. */
  functions: Record<string, number>;
  /** Address of the function table, so unresolved lookups can be traced. */
  functionTableAddress: number;
}

/**
 * Builds the ROM image.
 *
 * Layout (all addresses are documented in the datasheet's ROM description):
 *   0x00  initial stack pointer   — unused here, we boot straight into flash
 *   0x04  reset handler           — unused here, same reason
 *   0x10  magic 'M','u',version
 *   0x14  halfword: address of the function table
 *   0x16  halfword: address of the data table
 *   0x18  halfword: address of rom_table_lookup
 */
export function buildBootStub(): BootStub {
  const bytes = new Uint8Array(BOOTROM_WORDS * 4);
  const dv = new DataView(bytes.buffer);

  // Code is placed well clear of the header block.
  let cursor = 0x100;
  const put = (halfwords: number[]): number => {
    const at = cursor;
    for (const hw of halfwords) {
      dv.setUint16(cursor, hw, true);
      cursor += 2;
    }
    // Keep every entry point halfword-aligned and tidy.
    cursor = (cursor + 3) & ~3;
    return at;
  };

  const lookupAddr = put(emitTableLookup(cursor));
  const memcpyAddr = put(emitMemcpy(cursor));
  const memsetAddr = put(emitMemset(cursor));
  const noopAddr = put(emitReturnImmediately(cursor));
  const clzAddr = put(emitClz32(cursor));
  const ctzAddr = put(emitCtz32(cursor));
  const popcountAddr = put(emitPopcount32(cursor));
  const reverseAddr = put(emitReverse32(cursor));

  // The word-aligned variants have the same contract as the byte versions for
  // any input the aligned callers produce, so they share an implementation.
  const functions: Record<string, number> = {
    rom_table_lookup: lookupAddr,
    memcpy: memcpyAddr,
    memcpy44: memcpyAddr,
    memset: memsetAddr,
    memset4: memsetAddr,
    connect_internal_flash: noopAddr,
    flash_exit_xip: noopAddr,
    flash_flush_cache: noopAddr,
    flash_enter_cmd_xip: noopAddr,
    clz32: clzAddr,
    ctz32: ctzAddr,
    popcount32: popcountAddr,
    reverse32: reverseAddr,
  };

  // Function table: (code, address) halfword pairs, zero-terminated. Addresses
  // carry the Thumb bit, as every Thumb function pointer must.
  const tableAddr = cursor;
  const advertised = [
    'memcpy',
    'memcpy44',
    'memset',
    'memset4',
    'connect_internal_flash',
    'flash_exit_xip',
    'flash_flush_cache',
    'flash_enter_cmd_xip',
    'clz32',
    'ctz32',
    'popcount32',
    'reverse32',
  ] as const;
  for (const name of advertised) {
    dv.setUint16(cursor, ROM_FUNC_CODES[name], true);
    cursor += 2;
    dv.setUint16(cursor, functions[name] | 1, true);
    cursor += 2;
  }
  dv.setUint16(cursor, 0, true); // terminator
  cursor += 4;

  // An empty (immediately terminated) data table: nothing here publishes data.
  const dataTableAddr = cursor;
  dv.setUint16(cursor, 0, true);

  // Header.
  dv.setUint8(0x10, 'M'.charCodeAt(0));
  dv.setUint8(0x11, 'u'.charCodeAt(0));
  dv.setUint8(0x12, 1); // ROM version
  dv.setUint8(0x13, 0);
  dv.setUint16(0x14, tableAddr, true);
  dv.setUint16(0x16, dataTableAddr, true);
  dv.setUint16(0x18, lookupAddr | 1, true);

  return { rom: new Uint32Array(bytes.buffer), functions, functionTableAddress: tableAddr };
}
