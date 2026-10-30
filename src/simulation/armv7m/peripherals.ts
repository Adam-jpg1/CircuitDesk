// What every ARM chip model here is built from: registers, a clock of
// scheduled events, and pads.
//
// The chips (SAM3X, STM32F4, RA4M1, nRF52, i.MX RT) are different silicon
// with different register maps, but they all need the same three things
// around the core: peripheral registers that read back what was written
// unless behaviour says otherwise, events scheduled in CPU cycles (a byte
// finishing on a UART, a timer compare), and pads whose level comes from
// whoever drives them — the GPIO block, a peripheral the pad is muxed to, a
// pull resistor, or the circuit on the canvas.

/** A one-shot event in CPU cycles. Cancelled events stay in the heap and are skipped. */
interface QueuedEvent {
  at: number;
  seq: number;
  fn: () => void;
  live: boolean;
}

export class EventQueue {
  private heap: QueuedEvent[] = [];
  private seq = 0;
  /**
   * When the earliest queued event is due. A lower bound: it may name an
   * event since cancelled, which costs one extra look and nothing else. Kept
   * as a field so the run loop can compare against it after every
   * instruction — an instruction can schedule an event inside the slice.
   */
  earliest = Infinity;

  constructor(private readonly now: () => number) {}

  /** Runs `fn` `delay` cycles from now; returns a cancel function. */
  schedule(delay: number, fn: () => void): () => void {
    return this.scheduleAt(this.now() + Math.max(1, Math.ceil(delay)), fn);
  }

  scheduleAt(at: number, fn: () => void): () => void {
    const ev: QueuedEvent = { at, seq: this.seq++, fn, live: true };
    this.push(ev);
    if (at < this.earliest) this.earliest = at;
    return () => {
      ev.live = false;
    };
  }

  get nextAt(): number {
    while (this.heap.length && !this.heap[0].live) this.pop();
    this.earliest = this.heap.length ? this.heap[0].at : Infinity;
    return this.earliest;
  }

  /** Runs every event due at or before `now`, in time order. */
  runDue(now: number): void {
    for (;;) {
      const next = this.nextAt;
      if (next > now) return;
      const ev = this.pop()!;
      if (ev.live) {
        ev.live = false;
        ev.fn();
      }
    }
  }

  clear(): void {
    this.heap = [];
    this.earliest = Infinity;
  }

  private less(a: QueuedEvent, b: QueuedEvent): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }

  private push(ev: QueuedEvent): void {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  private pop(): QueuedEvent | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

type ReadHook = () => number;
type WriteHook = (value: number, previous: number) => void;

/**
 * A peripheral's registers.
 *
 * Words are stored by offset and read back what was written, unless a hook
 * gives the register behaviour. Narrower accesses read a slice of the word and
 * write by merging into it, which is what these buses do.
 */
export class Periph {
  private readonly store = new Map<number, number>();
  private readonly readHooks = new Map<number, ReadHook>();
  private readonly writeHooks = new Map<number, WriteHook>();

  constructor(
    readonly name: string,
    readonly base: number,
    readonly size: number,
  ) {}

  /** Behaviour for one register. Either side may be omitted. */
  reg(offset: number, read?: ReadHook, write?: WriteHook): this {
    if (read) this.readHooks.set(offset, read);
    if (write) this.writeHooks.set(offset, write);
    return this;
  }

  /** A register whose initial value is not zero. */
  init(offset: number, value: number): this {
    this.store.set(offset, value >>> 0);
    return this;
  }

  peek(offset: number): number {
    return this.store.get(offset) ?? 0;
  }

  poke(offset: number, value: number): void {
    this.store.set(offset, value >>> 0);
  }

  read(offset: number, width: 1 | 2 | 4): number {
    const word = offset & ~3;
    const hook = this.readHooks.get(word);
    const value = hook ? hook() >>> 0 : this.store.get(word) ?? 0;
    if (width === 4 && word === offset) return value;
    const shift = (offset & 3) * 8;
    return (value >>> shift) & (width === 1 ? 0xff : width === 2 ? 0xffff : 0xffffffff);
  }

  write(offset: number, value: number, width: 1 | 2 | 4): void {
    const word = offset & ~3;
    const previous = this.store.get(word) ?? 0;
    let merged = value >>> 0;
    if (width !== 4) {
      const shift = (offset & 3) * 8;
      const mask = (width === 1 ? 0xff : 0xffff) << shift;
      merged = ((previous & ~mask) | ((value << shift) & mask)) >>> 0;
    }
    this.store.set(word, merged);
    this.writeHooks.get(word)?.(merged, previous);
  }
}

/** Peripherals by address, with whatever is not modelled reading back what was written. */
export class PeriphBus {
  private readonly list: Periph[] = [];
  private last: Periph | null = null;
  private readonly unmapped = new Map<number, number>();
  /** Addresses firmware touched that nothing models, for diagnostics. */
  readonly unknown = new Set<number>();

  add<T extends Periph>(p: T): T {
    this.list.push(p);
    return p;
  }

  find(address: number): Periph | null {
    const last = this.last;
    if (last && address >= last.base && address < last.base + last.size) return last;
    for (const p of this.list) {
      if (address >= p.base && address < p.base + p.size) {
        this.last = p;
        return p;
      }
    }
    return null;
  }

  read(address: number, width: 1 | 2 | 4): number {
    const p = this.find(address);
    if (p) return p.read(address - p.base, width);
    this.unknown.add(address & ~3);
    const v = this.unmapped.get(address & ~3) ?? 0;
    const shift = (address & 3) * 8;
    return width === 4 ? v : (v >>> shift) & (width === 1 ? 0xff : 0xffff);
  }

  write(address: number, value: number, width: 1 | 2 | 4): void {
    const p = this.find(address);
    if (p) {
      p.write(address - p.base, value, width);
      return;
    }
    this.unknown.add(address & ~3);
    const word = address & ~3;
    const prev = this.unmapped.get(word) ?? 0;
    if (width === 4) this.unmapped.set(word, value >>> 0);
    else {
      const shift = (address & 3) * 8;
      const mask = (width === 1 ? 0xff : 0xffff) << shift;
      this.unmapped.set(word, ((prev & ~mask) | ((value << shift) & mask)) >>> 0);
    }
  }
}

export const NOT_DRIVEN = -1;

/**
 * Every pad of a chip: who drives it, how it is pulled, and what the circuit
 * holds it at. The level a pad reads is its driver's if it has one, else the
 * circuit's, else its pull resistor's.
 */
export class Pads {
  /** -1 not driven, 0 driving low, 1 driving high. */
  readonly drive: Int8Array;
  /** 0 none, 1 pull-up, 2 pull-down. */
  readonly pull: Uint8Array;
  /** -1 nothing on the canvas, else the level the circuit holds it at. */
  readonly external: Int8Array;
  private readonly levels: Uint8Array;
  /** The pad's level changed (driven by the chip, the circuit or a pull). */
  onChange: ((pin: number, high: boolean) => void) | null = null;

  constructor(readonly count: number) {
    this.drive = new Int8Array(count).fill(NOT_DRIVEN);
    this.pull = new Uint8Array(count);
    this.external = new Int8Array(count).fill(-1);
    this.levels = new Uint8Array(count);
  }

  level(pin: number): boolean {
    return this.levels[pin] === 1;
  }

  setDrive(pin: number, value: number): void {
    if (pin < 0 || pin >= this.count || this.drive[pin] === value) return;
    this.drive[pin] = value;
    this.update(pin);
  }

  setPull(pin: number, pull: number): void {
    if (pin < 0 || pin >= this.count || this.pull[pin] === pull) return;
    this.pull[pin] = pull;
    this.update(pin);
  }

  setExternal(pin: number, value: boolean | undefined): void {
    if (pin < 0 || pin >= this.count) return;
    const v = value === undefined ? -1 : value ? 1 : 0;
    if (this.external[pin] === v) return;
    this.external[pin] = v;
    this.update(pin);
  }

  private update(pin: number): void {
    const d = this.drive[pin];
    const e = this.external[pin];
    const level = d !== NOT_DRIVEN ? d : e !== -1 ? e : this.pull[pin] === 1 ? 1 : this.pull[pin] === 2 ? 0 : this.levels[pin];
    if (level !== this.levels[pin]) {
      this.levels[pin] = level;
      this.onChange?.(pin, level === 1);
    }
  }
}
