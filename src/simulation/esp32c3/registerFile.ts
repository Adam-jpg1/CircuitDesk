// A peripheral whose registers hold whatever was written to them.
//
// Two kinds of register appear on this chip, and they need different
// treatment. Configuration registers simply hold what firmware wrote, and a
// register file models them exactly — returning zero instead would make
// firmware read back a configuration it never asked for. Status registers are
// driven by hardware, and they are where a simulation either works or hangs:
// firmware polls a ready bit and spins for ever if nothing ever sets it.
//
// So this base class stores writes, and each peripheral overrides only the
// registers whose value the hardware itself produces. Anything not modelled
// reads back what was written, which is the honest default — and a status bit
// nobody sets makes the firmware hang visibly rather than continue on invented
// data.
//
// It lives in its own module so peripherals that need it can also be imported
// by each other without a cycle.

import type { Peripheral } from '../espRiscv/peripheral';

/**
 * A peripheral whose registers hold whatever was written to them.
 *
 * Subclasses override `onWrite` and `onRead` for the registers hardware
 * drives; everything else behaves as storage.
 */
export class RegisterFile implements Peripheral {
  protected readonly registers = new Map<number, number>();

  constructor(
    readonly name: string,
    readonly base: number,
    readonly size: number,
  ) {}

  readUint32(offset: number): number {
    const handled = this.onRead(offset);
    if (handled !== undefined) return handled >>> 0;
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  writeUint32(offset: number, value: number): void {
    this.registers.set(offset, value >>> 0);
    this.onWrite(offset, value >>> 0);
  }

  /** Return a value to override plain storage, or undefined to use it. */
  protected onRead(_offset: number): number | undefined {
    return undefined;
  }

  protected onWrite(_offset: number, _value: number): void {}

  reset(): void {
    this.registers.clear();
  }

  /** Raw stored value, for tests and diagnostics. */
  peek(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }
}

