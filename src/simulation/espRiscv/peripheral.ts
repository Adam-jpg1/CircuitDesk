// The vocabulary a machine and its peripherals share.
//
// This module deliberately imports nothing. Peripherals need these types, and
// the machine needs the peripherals, so anything defined alongside the machine
// would make the two import each other in a circle. Keeping the vocabulary in a
// leaf is what lets the C3's blocks, the C6's blocks and the shared machine all
// refer to the same interfaces without one of them owning the others.
//
// Three roles matter to the machine beyond plain register access: something
// that translates a cache address to a flash offset, something that decides
// which CPU interrupt line is pending, and something that can assert an
// interrupt source. Each is declared with a marker property rather than
// detected by shape, so a peripheral that happens to have a method called
// `translate` cannot be mistaken for the flash MMU.

/** Simulated time since power-on, shared by everything that counts. */
export interface SimulatedClock {
  /** Nanoseconds of simulated time since power-on. */
  readonly nanos: number;
}

/** A memory-mapped peripheral. Addresses are offsets from its base. */
export interface Peripheral {
  readonly name: string;
  readonly base: number;
  readonly size: number;
  readUint32(offset: number): number;
  writeUint32(offset: number, value: number): void;
  reset?(): void;
}

/**
 * The flash MMU, whichever form the chip gives it.
 *
 * The C3 exposes its table as a flat array of registers; the C6 has no such
 * array and reaches every entry through an index/content register pair on SPI0.
 * Both answer the same three questions, and the machine only ever asks those,
 * so the difference stays inside the peripheral where it belongs.
 */
export interface FlashMapper {
  readonly isFlashMapper: true;
  /** The table entry a cache address falls in. */
  entryOf(address: number): number;
  /** Points a cache page at a flash page. */
  map(entry: number, flashPage: number): void;
  /** Flash offset for a cache address, or undefined when its page is unmapped. */
  translate(address: number): number | undefined;
}

/** Byte-addressable flash, as the cache reads it. */
export interface FlashBytes {
  readonly bytes: Uint8Array;
}

/** A peripheral that owns the flash device the cache reads through. */
export interface FlashOwner {
  readonly isFlashOwner: true;
  readonly flash: FlashBytes;
}

/**
 * Whatever decides which CPU interrupt line the core should take.
 *
 * On the C3 this is one block. On the C6 the routing and the prioritising live
 * in two blocks at different addresses, so the controller there is one object
 * presenting two peripheral views — which the machine never has to know.
 */
export interface InterruptRouter {
  readonly isInterruptRouter: true;
  /** Recomputes pending lines from the asserted sources and returns the enabled ones. */
  evaluate(asserted: Iterable<number>): number;
  /** Which line to deliver, from those pending and enabled. */
  select(pending: number): number | undefined;
}

/**
 * A peripheral that can raise an interrupt.
 *
 * The second method exists so the machine does not have to re-evaluate every
 * source after every instruction: a block that will assert at a known future
 * time says when, and one whose state only changes when firmware writes to it
 * says nothing.
 */
export interface InterruptingPeripheral {
  /** Source numbers this block is asserting right now. */
  assertedInterruptSources(): number[];
  /**
   * Earliest simulated time, in nanoseconds, at which the answer above could
   * change without a register write. Undefined when only a write can change it.
   */
  nextInterruptChangeNanos?(): number | undefined;
}

export function isFlashMapper(value: unknown): value is FlashMapper {
  return (value as FlashMapper)?.isFlashMapper === true;
}

export function isFlashOwner(value: unknown): value is FlashOwner {
  return (value as FlashOwner)?.isFlashOwner === true;
}

export function isInterruptRouter(value: unknown): value is InterruptRouter {
  return (value as InterruptRouter)?.isInterruptRouter === true;
}

/** True when a peripheral participates in interrupt delivery. */
export function isInterrupting(value: unknown): value is InterruptingPeripheral {
  return typeof (value as InterruptingPeripheral)?.assertedInterruptSources === 'function';
}

// ------------------------------------------------------------- trace events

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

// ------------------------------------------------------------ guest callbacks

/** Raised when a guest callback misbehaves, always naming what went wrong. */
export class GuestCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestCallError';
  }
}

export interface GuestCallOptions {
  /** Instructions the callback may retire before it is abandoned. */
  maxInstructions?: number;
}

export interface GuestCallResult {
  /** a0, the conventional return value. */
  value: number;
  /** a1, for the few callbacks returning a 64-bit pair. */
  high: number;
  instructions: number;
}
