// A SAMD21 peripheral's registers as bytes, with behaviour where hardware has some.

type Hook = {
  read?: () => number;
  /** Called after the write has landed in the block's storage. */
  write?: (value: number, previous: number) => void;
  width: 1 | 2 | 4;
};

/**
 * A peripheral as bytes, with behaviour where hardware has some.
 *
 * SAMD21 registers are 8, 16 or 32 bits wide and firmware accesses each at its
 * own width (the CMSIS bitfield structs compile to ldrb/ldrh/ldr), so storage is
 * byte-addressed and a hook is keyed by the register's offset and width.
 */
export class RegisterBlock {
  readonly bytes: Uint8Array;
  private readonly hooks = new Map<number, Hook>();

  constructor(readonly name: string, readonly base: number, readonly size: number) {
    this.bytes = new Uint8Array(size);
  }

  on(offset: number, hook: Hook): this {
    this.hooks.set(offset, hook);
    return this;
  }

  peek(offset: number, width: 1 | 2 | 4): number {
    let v = 0;
    for (let i = 0; i < width; i++) v |= (this.bytes[offset + i] ?? 0) << (8 * i);
    return v >>> 0;
  }

  poke(offset: number, value: number, width: 1 | 2 | 4): void {
    for (let i = 0; i < width; i++) this.bytes[offset + i] = (value >>> (8 * i)) & 0xff;
  }

  read(offset: number, width: 1 | 2 | 4): number {
    // A hooked register read at any width is that register's value, shifted
    // to the byte asked for.
    for (const [at, hook] of this.hooks) {
      if (hook.read && offset >= at && offset < at + hook.width) {
        const full = hook.read() >>> 0;
        const shift = 8 * (offset - at);
        return width === 4 ? full >>> shift : (full >>> shift) & (width === 1 ? 0xff : 0xffff);
      }
    }
    return this.peek(offset, width);
  }

  write(offset: number, value: number, width: 1 | 2 | 4): void {
    const touched: [number, Hook, number][] = [];
    for (const [at, hook] of this.hooks) {
      if (hook.write && offset < at + hook.width && at < offset + width) touched.push([at, hook, this.peek(at, hook.width)]);
    }
    this.poke(offset, value, width);
    for (const [at, hook, previous] of touched) hook.write!(this.peek(at, hook.width), previous);
  }
}
