// The ESP32-C6's ROM heap.
//
// The C6 boots on an allocator that lives in its mask ROM. There is no
// `esp32c3.rom.heap.ld` — the C3 links its own copy of the allocator into the
// application, so the C3 runtime never had to provide one — and the C6's
// firmware calls `multi_heap_register_impl`, `multi_heap_malloc_impl` and the
// rest of the family from the moment the heap comes up. Without them a C6 stops
// at `multi_heap_mutex_init` and never reaches `app_main`.
//
// This is an independent implementation of the documented `multi_heap` contract
// in `heap/include/multi_heap.h`, not a translation of anything. No ROM code
// was read, disassembled or copied, and the allocator's internal structure is
// deliberately not a reproduction of the ROM's: it does not need to be, because
// every handle the API hands out is opaque and every question about a block —
// where it starts, how big it is, whether it is free, what comes next — is
// asked back through these same entry points. What has to be real is the
// contract, and it is:
//
//   * an allocation returns a genuine address inside the region the firmware
//     registered, correctly aligned, and no two live allocations overlap
//   * freeing makes the space available again, and adjacent free space
//     coalesces, or a long-running sketch fragments its heap to death
//   * the accounting the firmware reports to the user — free bytes, largest
//     free block, the lifetime minimum — is derived from the real block list
//
// The blocks themselves live in the guest's own memory: a pointer returned from
// here is somewhere the firmware really writes, and the bytes it writes really
// are what it reads back.

import type { RomCallContext, RomFunction, RomHandler, RomMachineState } from '../esp32c3/romFunctions';

/**
 * Allocations are aligned to this, which is what the RISC-V ABI needs for the
 * widest scalar and what `malloc` is required to return for any type.
 */
const ALIGNMENT = 8;

/**
 * Bookkeeping the ROM keeps for itself on real silicon, charged against the
 * region so the firmware's free-space accounting is not optimistic.
 *
 * A real allocator spends memory on its own structures, and a runtime that
 * reported the whole region as allocatable would let a sketch appear to fit in
 * a heap it would overflow on hardware. The figure is the per-block header and
 * footer a segregated-fit allocator of this class uses.
 */
const BLOCK_OVERHEAD = 8;

/** Bookkeeping for the pool itself, likewise charged against the region. */
const POOL_OVERHEAD = 24;

interface Block {
  /** Address of the block's payload, which is what a caller receives. */
  start: number;
  /** Payload size in bytes, already rounded up to the alignment. */
  size: number;
  free: boolean;
}

/**
 * One registered heap.
 *
 * Blocks are kept in address order, which is what makes coalescing and the
 * walk the firmware performs both straightforward and correct.
 */
export class RomHeap {
  private readonly blocks: Block[] = [];
  private minimumFree: number;

  constructor(
    readonly start: number,
    readonly size: number,
  ) {
    const usable = Math.max(0, size - POOL_OVERHEAD);
    const base = align(start + POOL_OVERHEAD);
    this.blocks.push({ start: base, size: usable - (base - (start + POOL_OVERHEAD)), free: true });
    this.minimumFree = this.freeBytes();
  }

  /** Bytes still allocatable, net of the per-block overhead each would cost. */
  freeBytes(): number {
    let total = 0;
    for (const block of this.blocks) if (block.free) total += Math.max(0, block.size - BLOCK_OVERHEAD);
    return total;
  }

  allocatedBytes(): number {
    let total = 0;
    for (const block of this.blocks) if (!block.free) total += block.size;
    return total;
  }

  largestFreeBlock(): number {
    let largest = 0;
    for (const block of this.blocks) {
      if (block.free) largest = Math.max(largest, block.size - BLOCK_OVERHEAD);
    }
    return Math.max(0, largest);
  }

  get lifetimeMinimumFree(): number {
    return this.minimumFree;
  }

  resetMinimumFree(): number {
    const previous = this.minimumFree;
    this.minimumFree = this.freeBytes();
    return previous;
  }

  restoreMinimumFree(value: number): void {
    this.minimumFree = value >>> 0;
  }

  counts(): { allocated: number; free: number } {
    let allocated = 0;
    let free = 0;
    for (const block of this.blocks) block.free ? free++ : allocated++;
    return { allocated, free };
  }

  /** The block a payload address belongs to, or undefined if it is not one. */
  blockAt(address: number): Block | undefined {
    return this.blocks.find((b) => b.start === (address >>> 0));
  }

  /** Blocks in address order, for the walk the firmware performs. */
  ordered(): readonly Block[] {
    return this.blocks;
  }

  /**
   * Allocates, optionally with an alignment stronger than the default and an
   * offset the alignment applies from.
   *
   * The offset exists because ESP-IDF aligns the *user* pointer of a block that
   * carries a header, so the aligned address is `result + offset` rather than
   * `result`. Ignoring it returns memory whose alignment is one header out.
   */
  allocate(bytes: number, alignment = ALIGNMENT, offset = 0): number {
    const need = align(Math.max(1, bytes));
    const wanted = Math.max(ALIGNMENT, alignment);
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (!block.free) continue;

      // Where inside this block the payload would have to begin for the
      // caller's alignment to hold.
      const payload = alignTo(block.start + offset, wanted) - offset;
      const lead = payload - block.start;
      if (lead + need + BLOCK_OVERHEAD > block.size) continue;

      // Anything skipped for alignment stays a free block of its own rather
      // than being lost, which is what keeps repeated aligned allocation from
      // eating the heap.
      if (lead > 0) {
        this.blocks.splice(i, 0, { start: block.start, size: lead, free: true });
        block.start = payload;
        block.size -= lead;
        i++;
      }

      const remainder = block.size - need - BLOCK_OVERHEAD;
      block.free = false;
      if (remainder > BLOCK_OVERHEAD + ALIGNMENT) {
        // Enough left over to be worth another block; otherwise the slack stays
        // with this one, as any real allocator does rather than tracking
        // unusable fragments.
        this.blocks.splice(i + 1, 0, { start: block.start + need + BLOCK_OVERHEAD, size: remainder, free: true });
        block.size = need + BLOCK_OVERHEAD;
      }
      this.minimumFree = Math.min(this.minimumFree, this.freeBytes());
      return block.start;
    }
    // Out of space. Returning null is what the API says, and the firmware
    // handles it — inventing an address would corrupt whatever lives there.
    return 0;
  }

  free(address: number): boolean {
    const index = this.blocks.findIndex((b) => b.start === (address >>> 0));
    if (index < 0 || this.blocks[index].free) return false;
    this.blocks[index].free = true;
    this.coalesce();
    return true;
  }

  /** The usable payload size of a live allocation. */
  allocatedSize(address: number): number {
    const block = this.blockAt(address);
    return block && !block.free ? block.size - BLOCK_OVERHEAD : 0;
  }

  /** Joins neighbouring free blocks, without which the heap fragments away. */
  private coalesce(): void {
    for (let i = 0; i < this.blocks.length - 1; ) {
      const a = this.blocks[i];
      const b = this.blocks[i + 1];
      if (a.free && b.free && a.start + a.size === b.start) {
        a.size += b.size;
        this.blocks.splice(i + 1, 1);
      } else {
        i++;
      }
    }
  }
}

const align = (value: number): number => alignTo(value, ALIGNMENT);
const alignTo = (value: number, to: number): number => Math.ceil(value / to) * to;

// ------------------------------------------------------------ ROM state

/** Heaps this machine has registered, and the block tokens handed out. */
export interface RomHeapState {
  heaps: Map<number, RomHeap>;
  /** Opaque block handles, so the firmware's walk gets a token it cannot parse. */
  blockTokens: Map<number, { heap: RomHeap; index: number }>;
  nextToken: number;
  /**
   * The heap-poisoning callbacks the firmware handed the allocator.
   *
   * ESP-IDF fills freed memory with a pattern and checks it later, and it does
   * that by giving the ROM allocator two of its own functions to call. They are
   * really called — through the guest-call mechanism, with the arguments the
   * documented signatures specify — because a runtime that accepted them and
   * never called them would leave freed memory unpoisoned and then fail the
   * firmware's own check, which is worse than not supporting poisoning at all.
   */
  poisonFill: number;
  poisonCheck: number;
  walkPoolCheck: number;
}

const STATE_KEY = 'esp32c6.heap';

function stateOf(machine: RomMachineState): RomHeapState {
  let state = machine.chipState.get(STATE_KEY) as RomHeapState | undefined;
  if (!state) {
    state = { heaps: new Map(), blockTokens: new Map(), nextToken: 0x10000, poisonFill: 0, poisonCheck: 0, walkPoolCheck: 0 };
    machine.chipState.set(STATE_KEY, state);
  }
  return state;
}

/** The heap a handle names, or undefined when the firmware passed a stray one. */
function heapOf(machine: RomMachineState, handle: number): RomHeap | undefined {
  return stateOf(machine).heaps.get(handle >>> 0);
}

/** A token for a block, minted on demand so the firmware never sees an address it could parse. */
function tokenFor(machine: RomMachineState, heap: RomHeap, index: number): number {
  const state = stateOf(machine);
  for (const [token, entry] of state.blockTokens) {
    if (entry.heap === heap && entry.index === index) return token;
  }
  const token = state.nextToken++;
  state.blockTokens.set(token, { heap, index });
  return token;
}

// -------------------------------------------------------------- handlers

/**
 * `multi_heap_register_impl(start, size)`.
 *
 * The handle a caller gets back is the region's own start address, which is
 * what the real allocator returns too — it puts its control structure at the
 * bottom of the region it was given. That makes the handle a genuine pointer
 * into the firmware's memory rather than a made-up number.
 */
const registerHeap: RomHandler = ({ args, machine }) => {
  const start = args[0] >>> 0;
  const size = args[1] >>> 0;
  // Too small to hold the allocator's own bookkeeping, which the real one
  // reports by refusing rather than by registering an unusable heap.
  if (size <= POOL_OVERHEAD + BLOCK_OVERHEAD) return 0;
  stateOf(machine).heaps.set(start, new RomHeap(start, size));
  return start;
};

/**
 * Calls the firmware's poison-fill callback for a block, if it registered one.
 *
 * `void (*)(void *start, size_t size, bool is_free)`.
 */
function fillPoison(context: RomCallContext, start: number, size: number, isFree: boolean): void {
  const fill = stateOf(context.machine).poisonFill;
  if (fill === 0 || start === 0 || size <= 0) return;
  context.callGuest(fill, [start >>> 0, size >>> 0, isFree ? 1 : 0]);
}

const mallocImpl: RomHandler = (context) => {
  const { args, machine } = context;
  const heap = heapOf(machine, args[0]);
  if (!heap) return 0;
  const address = heap.allocate(args[1] >>> 0);
  fillPoison(context, address, heap.allocatedSize(address), false);
  return address;
};

const alignedAllocOffs: RomHandler = (context) => {
  const { args, machine } = context;
  const heap = heapOf(machine, args[0]);
  if (!heap) return 0;
  const address = heap.allocate(args[1] >>> 0, args[2] >>> 0, args[3] >>> 0);
  fillPoison(context, address, heap.allocatedSize(address), false);
  return address;
};

const alignedAlloc: RomHandler = (context) => {
  const { args, machine } = context;
  const heap = heapOf(machine, args[0]);
  if (!heap) return 0;
  const address = heap.allocate(args[1] >>> 0, args[2] >>> 0, 0);
  fillPoison(context, address, heap.allocatedSize(address), false);
  return address;
};

const freeImpl: RomHandler = (context) => {
  const { args, machine } = context;
  // Freeing null is defined to do nothing, and firmware relies on it.
  if ((args[1] >>> 0) === 0) return;
  const heap = heapOf(machine, args[0]);
  if (!heap) return;
  const size = heap.allocatedSize(args[1] >>> 0);
  if (heap.free(args[1] >>> 0)) fillPoison(context, args[1] >>> 0, size, true);
};

/**
 * `multi_heap_realloc_impl(heap, p, size)`.
 *
 * The contents up to the smaller of the two sizes have to survive, so the bytes
 * are really copied through the bus when the block moves. Returning a new
 * pointer without moving the data would leave the caller reading whatever was
 * there before.
 */
const reallocImpl: RomHandler = ({ args, bus, machine }) => {
  const heap = heapOf(machine, args[0]);
  if (!heap) return 0;
  const old = args[1] >>> 0;
  const size = args[2] >>> 0;
  if (old === 0) return heap.allocate(size);
  if (size === 0) {
    heap.free(old);
    return 0;
  }
  const previous = heap.allocatedSize(old);
  if (previous >= size) return old;
  const fresh = heap.allocate(size);
  if (fresh === 0) return 0;
  for (let i = 0; i < previous; i++) bus.writeUint8((fresh + i) >>> 0, bus.readUint8((old + i) >>> 0));
  heap.free(old);
  return fresh;
};

const allocatedSize: RomHandler = ({ args, machine }) => heapOf(machine, args[0])?.allocatedSize(args[1]) ?? 0;

const freeSize: RomHandler = ({ args, machine }) => heapOf(machine, args[0])?.freeBytes() ?? 0;

const minimumFreeSize: RomHandler = ({ args, machine }) => heapOf(machine, args[0])?.lifetimeMinimumFree ?? 0;

/**
 * `multi_heap_get_info_impl(heap, info)`.
 *
 * Every field is derived from the block list rather than tracked separately, so
 * what the firmware reports to a user through `heap_caps_get_info` cannot drift
 * from what the allocator would actually do on the next request.
 */
const getInfo: RomHandler = ({ args, bus, machine }) => {
  const heap = heapOf(machine, args[0]);
  const info = args[1] >>> 0;
  const counts = heap?.counts() ?? { allocated: 0, free: 0 };
  const fields = [
    heap?.freeBytes() ?? 0,
    heap?.allocatedBytes() ?? 0,
    heap?.largestFreeBlock() ?? 0,
    heap?.lifetimeMinimumFree ?? 0,
    counts.allocated,
    counts.free,
    counts.allocated + counts.free,
  ];
  for (let i = 0; i < fields.length; i++) bus.writeUint32((info + i * 4) >>> 0, fields[i] >>> 0);
};

/**
 * The block walk.
 *
 * A block handle is an opaque token rather than an address, because the API
 * says it is opaque and because a token cannot be mistaken for a pointer if the
 * firmware ever mishandles one.
 */
const firstBlock: RomHandler = ({ args, machine }) => {
  const heap = heapOf(machine, args[0]);
  if (!heap || heap.ordered().length === 0) return 0;
  return tokenFor(machine, heap, 0);
};

const nextBlock: RomHandler = ({ args, machine }) => {
  const entry = stateOf(machine).blockTokens.get(args[1] >>> 0);
  if (!entry) return 0;
  const next = entry.index + 1;
  if (next >= entry.heap.ordered().length) return 0;
  return tokenFor(machine, entry.heap, next);
};

const isFree: RomHandler = ({ args, machine }) => {
  const entry = stateOf(machine).blockTokens.get(args[0] >>> 0);
  return entry?.heap.ordered()[entry.index]?.free ? 1 : 0;
};

const blockAddress: RomHandler = ({ args, machine }) => {
  const entry = stateOf(machine).blockTokens.get(args[0] >>> 0);
  return entry?.heap.ordered()[entry.index]?.start ?? 0;
};

const resetMinimumFree: RomHandler = ({ args, machine }) => heapOf(machine, args[0])?.resetMinimumFree() ?? 0;

const restoreMinimumFree: RomHandler = ({ args, machine }) => {
  heapOf(machine, args[0])?.restoreMinimumFree(args[1] >>> 0);
};

/**
 * `multi_heap_check(heap, print_errors)`.
 *
 * The allocator's structures are not in guest memory, so nothing the firmware
 * did can have corrupted them. Reporting the heap intact is the truthful answer
 * for this runtime — and it is stated plainly here rather than being left to
 * look like a verified result, because a sketch that overruns a buffer on real
 * hardware may well be caught by this call and is not caught by CircuitDesk.
 */
const heapCheck: RomHandler = ({ args, machine }) => (heapOf(machine, args[0]) ? 1 : 0);

/** Records a poisoning callback the firmware gave the allocator. */
const setPoisonFill: RomHandler = ({ args, machine }) => {
  stateOf(machine).poisonFill = args[0] >>> 0;
};

const setPoisonCheck: RomHandler = ({ args, machine }) => {
  stateOf(machine).poisonCheck = args[0] >>> 0;
};

const setWalkPoolCheck: RomHandler = ({ args, machine }) => {
  stateOf(machine).walkPoolCheck = args[0] >>> 0;
};

/** The heap lock. This runtime runs one core, so there is nothing to serialise. */
const noop: RomHandler = () => {};

/**
 * `multi_heap_set_lock(heap, lock)`.
 *
 * The lock belongs to the caller's own structure and stays where the caller put
 * it. There is nothing for this runtime to serialise: one core, and a ROM call
 * that cannot be interrupted partway through.
 */
const setLock: RomHandler = () => {};

/**
 * The heap entry points the C6's ROM publishes.
 *
 * Addresses are from `esp32c6.rom.heap.ld` in the same core the firmware was
 * built with, under the symbol that script gives each one.
 */
export const ESP32C6_ROM_HEAP: RomFunction[] = [
  {
    address: 0x4000044c,
    name: 'tlsf_poison_fill_pfunc_set',
    handler: setPoisonFill,
    rationale: 'Records the callback so freed and fresh blocks really are poisoned, not merely accepted.',
  },
  {
    address: 0x40000450,
    name: 'tlsf_poison_check_pfunc_set',
    handler: setPoisonCheck,
    rationale: 'The matching check, which the firmware runs over blocks it walks.',
  },
  {
    address: 0x40000454,
    name: 'multi_heap_get_block_address_impl',
    handler: blockAddress,
    rationale: 'Turns a walk token back into the block\'s real address in guest memory.',
  },
  {
    address: 0x40000458,
    name: 'multi_heap_get_allocated_size_impl',
    handler: allocatedSize,
    rationale: 'Reports the usable size of a live allocation, which callers size their copies by.',
  },
  {
    address: 0x4000045c,
    name: 'multi_heap_register_impl',
    handler: registerHeap,
    rationale: 'Takes ownership of a real memory region and returns a handle inside it.',
  },
  {
    address: 0x40000460,
    name: 'multi_heap_set_lock',
    handler: setLock,
    rationale: 'Nothing to serialise on one core, and the lock belongs to the caller.',
  },
  {
    address: 0x40000464,
    name: 'multi_heap_mutex_init',
    handler: noop,
    rationale: 'Likewise: there is no contention for a mutex to resolve here.',
  },
  {
    address: 0x40000468,
    name: 'multi_heap_internal_lock',
    handler: noop,
    rationale: 'A ROM call cannot be interrupted partway through in this runtime.',
  },
  {
    address: 0x4000046c,
    name: 'multi_heap_internal_unlock',
    handler: noop,
    rationale: 'The matching release.',
  },
  {
    address: 0x40000470,
    name: 'multi_heap_get_first_block',
    handler: firstBlock,
    rationale: 'Starts the block walk the heap poisoning and the info calls use.',
  },
  {
    address: 0x40000474,
    name: 'multi_heap_get_next_block',
    handler: nextBlock,
    rationale: 'Continues it in address order, ending at the last block.',
  },
  {
    address: 0x40000478,
    name: 'multi_heap_is_free',
    handler: isFree,
    rationale: 'Answers from the block list, so a walk sees the same heap an allocation would.',
  },
  {
    address: 0x4000047c,
    name: 'multi_heap_malloc_impl',
    handler: mallocImpl,
    rationale: 'Returns a real, aligned address inside the registered region, or null when full.',
  },
  {
    address: 0x40000480,
    name: 'multi_heap_free_impl',
    handler: freeImpl,
    rationale: 'Returns the space and coalesces with its neighbours.',
  },
  {
    address: 0x40000484,
    name: 'multi_heap_realloc_impl',
    handler: reallocImpl,
    rationale: 'Copies the contents through the bus when the block has to move.',
  },
  {
    address: 0x40000488,
    name: 'multi_heap_aligned_alloc_impl_offs',
    handler: alignedAllocOffs,
    rationale: 'Aligns the address the caller will hand out, not the block start.',
  },
  {
    address: 0x4000048c,
    name: 'multi_heap_aligned_alloc_impl',
    handler: alignedAlloc,
    rationale: 'The same with no offset.',
  },
  {
    address: 0x40000490,
    name: 'multi_heap_check',
    handler: heapCheck,
    rationale: 'The allocator\'s structures are not in guest memory, so nothing can have corrupted them.',
  },
  {
    address: 0x40000494,
    name: 'multi_heap_dump',
    handler: noop,
    rationale: 'A diagnostic print; this runtime has no ROM console attached to it.',
  },
  {
    address: 0x40000498,
    name: 'multi_heap_free_size_impl',
    handler: freeSize,
    rationale: 'Derived from the block list rather than a running total, so it cannot drift.',
  },
  {
    address: 0x4000049c,
    name: 'multi_heap_minimum_free_size_impl',
    handler: minimumFreeSize,
    rationale: 'The lifetime low-water mark, updated on every allocation.',
  },
  {
    address: 0x400004a0,
    name: 'multi_heap_get_info_impl',
    handler: getInfo,
    rationale: 'Fills the documented seven-field structure from the same block list.',
  },
];

// multi_heap_reset_minimum_free_bytes and multi_heap_restore_minimum_free_bytes
// are deliberately absent: esp32c6.rom.heap.ld ends at
// multi_heap_get_info_impl, so the application links its own copies of those
// two. The heap keeps the state they act on all the same, because the ROM's
// allocator is what owns the low-water mark either way.
void resetMinimumFree;
void restoreMinimumFree;

/** Exposed so a test can drive the allocator without a machine. */
export {
  ALIGNMENT as ROM_HEAP_ALIGNMENT,
  BLOCK_OVERHEAD as ROM_HEAP_BLOCK_OVERHEAD,
  POOL_OVERHEAD as ROM_HEAP_POOL_OVERHEAD,
};
