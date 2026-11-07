// The three ROM families the ESP32-C6 publishes and the ESP32-C3 does not.
//
// The C3 links its own watchdog HAL, its own allocator and its own system-timer
// HAL into the application. The C6's mask ROM provides all three, and its
// firmware calls them, so this runtime has to. Nothing here could be shared
// with the C3, borrowed from it or renamed into place — each had to be written.
//
// These check behaviour rather than presence. An allocator that returned
// plausible-looking addresses without tracking them, or a timer HAL that
// answered from remembered state instead of the registers, would satisfy a
// presence check and fail the firmware.

import { createEsp32C6Machine } from '../src/simulation/esp32c6/esp32c6Machine';
import { romTableFor } from '../src/simulation/esp32c6/romDispatch';
import {
  RomHeap,
  ROM_HEAP_ALIGNMENT,
  ROM_HEAP_BLOCK_OVERHEAD,
  ROM_HEAP_POOL_OVERHEAD,
} from '../src/simulation/esp32c6/romHeap';
import { ESP32C6_ROM_SYSTIMER } from '../src/simulation/esp32c6/romSysTimer';
import { ESP32C6_ROM_HEAP } from '../src/simulation/esp32c6/romHeap';
import { ESP32C6_PERIPHERAL_BASE } from '../src/simulation/esp32c6/peripherals';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

/** Calls a ROM entry point on a machine, as firmware would. */
function romCall(machine: ReturnType<typeof createEsp32C6Machine>['machine'], address: number, ...args: number[]) {
  machine.core.registers[1] = 0x40800000; // a return address outside the ROM
  for (let i = 0; i < 6; i++) machine.core.registers[10 + i] = args[i] ?? 0;
  machine.core.pc = address;
  machine.step();
  return { a0: machine.core.registers[10] | 0, a1: machine.core.registers[11] | 0 };
}

// ---------- 1. none of these exist on a C3 ----------
{
  const c3 = romTableFor('esp32c3');
  const c6 = romTableFor('esp32c6');
  const families = [
    ['heap', ESP32C6_ROM_HEAP],
    ['system timer', ESP32C6_ROM_SYSTIMER],
  ] as const;

  for (const [name, family] of families) {
    check(family.length > 0, `the C6 ${name} family has ${family.length} entry points`);
    check(
      family.every((f) => c6.entries.get(f.address) === f),
      `and every one is dispatchable on a C6`,
    );
    check(
      family.every((f) => c3.entries.get(f.address) !== f),
      `and none of them is offered on a C3, whose ROM publishes no ${name} HAL`,
    );
  }
  check(
    ESP32C6_ROM_SYSTIMER.every((f) => f.address >= 0x400003c8 && f.address <= 0x400003f8),
    'the system-timer addresses lie in the range esp32c6.rom.systimer.ld gives them',
  );
}

// ---------- 2. the allocator allocates ----------
//
// Driven directly, without a machine, so the block arithmetic is checked
// without anything else in the way.
{
  const START = 0x40810000;
  const SIZE = 0x8000;
  const heap = new RomHeap(START, SIZE);

  check(heap.freeBytes() > 0 && heap.freeBytes() < SIZE, `a fresh heap reports ${heap.freeBytes()} of ${SIZE} free`);
  check(
    SIZE - heap.freeBytes() >= ROM_HEAP_POOL_OVERHEAD,
    'and charges its own bookkeeping against the region rather than reporting all of it allocatable',
  );

  const a = heap.allocate(100);
  const b = heap.allocate(100);
  check(a >= START && a < START + SIZE, 'an allocation lands inside the registered region');
  check(b >= START && b < START + SIZE, 'and so does the next');
  check(a !== b, 'and they are not the same address');
  check(Math.abs(a - b) >= 100, 'and do not overlap');
  check(a % ROM_HEAP_ALIGNMENT === 0 && b % ROM_HEAP_ALIGNMENT === 0, 'both are aligned for any scalar type');
  check(heap.allocatedSize(a) >= 100, 'and the reported size covers what was asked for');

  const afterTwo = heap.freeBytes();
  check(afterTwo < heap.lifetimeMinimumFree + 1, 'free space fell');

  // Freeing and reallocating the same size must reuse the space, not grow the
  // heap — the difference between an allocator and a bump pointer.
  heap.free(a);
  heap.free(b);
  const c = heap.allocate(100);
  check(heap.freeBytes() > afterTwo, 'freeing gives the space back');
  check(c === a, 'and the next allocation of the same size reuses it');

  // Coalescing: three neighbours freed must become one block big enough for
  // their combined size, or a long-running sketch fragments its heap away.
  const p = heap.allocate(1000);
  const q = heap.allocate(1000);
  const r = heap.allocate(1000);
  heap.free(p);
  heap.free(q);
  heap.free(r);
  const big = heap.allocate(2800);
  check(big !== 0, 'three freed neighbours coalesce into one block large enough for all of them');
  check(big === p, 'starting where the first of them did');
  heap.free(big);
  heap.free(c);

  // The lifetime minimum is a low-water mark, not the current value.
  const minimum = heap.lifetimeMinimumFree;
  check(minimum < heap.freeBytes(), 'the lifetime minimum remembers the worst moment, not the present one');
  const previous = heap.resetMinimumFree();
  check(previous === minimum && heap.lifetimeMinimumFree === heap.freeBytes(), 'and can be restarted');

  // A request larger than the heap fails rather than returning something.
  check(heap.allocate(SIZE * 2) === 0, 'an impossible request returns null rather than an invented address');
  check(heap.allocate(16) !== 0, 'and the heap still works afterwards');

  // Stronger alignment, with the offset ESP-IDF applies for a block header.
  const aligned = heap.allocate(64, 512, 8);
  check(aligned !== 0, 'an aligned allocation succeeds');
  check((aligned + 8) % 512 === 0, 'and it is the address plus the offset that is aligned, as the API specifies');

  // Nothing overlaps after a mixed workload.
  const live: number[] = [];
  for (let i = 0; i < 20; i++) {
    const address = heap.allocate(37 * (i + 1));
    if (address !== 0) live.push(address);
  }
  const sorted = [...live].sort((x, y) => x - y);
  let overlapping = false;
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i] + heap.allocatedSize(sorted[i]) > sorted[i + 1]) overlapping = true;
  }
  check(!overlapping, `${live.length} live allocations of assorted sizes, none overlapping`);
  check(
    live.every((address) => address >= START && address + heap.allocatedSize(address) <= START + SIZE),
    'and every one of them inside the region',
  );
  check(ROM_HEAP_BLOCK_OVERHEAD > 0, 'each block costs the heap something, as a real allocator does');
}

// ---------- 3. the allocator through the ROM, on a real machine ----------
{
  const { machine } = createEsp32C6Machine();
  const REGISTER = 0x4000045c;
  const MALLOC = 0x4000047c;
  const FREE = 0x40000480;
  const REALLOC = 0x40000484;
  const GET_SIZE = 0x40000458;
  const FREE_SIZE = 0x40000498;
  const GET_INFO = 0x400004a0;
  const FIRST_BLOCK = 0x40000470;
  const NEXT_BLOCK = 0x40000474;
  const IS_FREE = 0x40000478;
  const BLOCK_ADDRESS = 0x40000454;

  const START = 0x40820000;
  const SIZE = 0x4000;
  const handle = romCall(machine, REGISTER, START, SIZE).a0 >>> 0;
  check(handle >= START && handle < START + SIZE, 'the heap handle is a real pointer inside the region');

  const p = romCall(machine, MALLOC, handle, 256).a0 >>> 0;
  check(p >= START && p < START + SIZE, 'malloc returns an address inside the region');
  check(romCall(machine, GET_SIZE, handle, p).a0 >= 256, 'and reports at least the size asked for');

  // The memory really is the guest's: what is written there reads back.
  machine.writeUint32(p, 0xdeadbeef);
  machine.writeUint32(p + 252, 0x5a5a5a5a);
  check(machine.readUint32(p) === 0xdeadbeef, 'the first word of the allocation holds what was written to it');
  check(machine.readUint32(p + 252) === 0x5a5a5a5a, 'and so does the last');

  // realloc must move the contents.
  const grown = romCall(machine, REALLOC, handle, p, 2048).a0 >>> 0;
  check(grown !== 0, 'realloc to a larger size succeeds');
  check(machine.readUint32(grown) === 0xdeadbeef, 'and the contents came with it');
  check(machine.readUint32(grown + 252) === 0x5a5a5a5a, 'all of them, not just the first word');

  const freeBefore = romCall(machine, FREE_SIZE, handle).a0 >>> 0;
  romCall(machine, FREE, handle, grown);
  const freeAfter = romCall(machine, FREE_SIZE, handle).a0 >>> 0;
  check(freeAfter > freeBefore, `freeing gives the space back (${freeBefore} -> ${freeAfter})`);

  // Freeing null is defined to do nothing.
  romCall(machine, FREE, handle, 0);
  check(romCall(machine, FREE_SIZE, handle).a0 >>> 0 === freeAfter, 'freeing null does nothing at all');

  // The info structure the firmware reports to the user.
  const INFO = 0x40830000;
  const keep = romCall(machine, MALLOC, handle, 512).a0 >>> 0;
  romCall(machine, GET_INFO, handle, INFO);
  const info = [0, 1, 2, 3, 4, 5, 6].map((i) => machine.readUint32(INFO + i * 4) >>> 0);
  check(info[0] > 0, `total_free_bytes is reported (${info[0]})`);
  check(info[1] >= 512, `total_allocated_bytes covers the live allocation (${info[1]})`);
  check(info[2] > 0 && info[2] <= info[0], 'largest_free_block is real and no larger than the total free');
  check(info[4] >= 1, `allocated_blocks counts the live block (${info[4]})`);
  check(info[6] === info[4] + info[5], 'and total_blocks is the sum of the two, as the structure documents');

  // The walk, which heap poisoning and the info calls use.
  let token = romCall(machine, FIRST_BLOCK, handle).a0 >>> 0;
  check(token !== 0, 'the block walk starts');
  let blocks = 0;
  let sawTheAllocation = false;
  let previous = 0;
  let ascending = true;
  while (token !== 0 && blocks < 64) {
    const address = romCall(machine, BLOCK_ADDRESS, token).a0 >>> 0;
    const free = romCall(machine, IS_FREE, token).a0;
    if (address === keep) sawTheAllocation = free === 0;
    if (address < previous) ascending = false;
    previous = address;
    blocks++;
    token = romCall(machine, NEXT_BLOCK, handle, token).a0 >>> 0;
  }
  check(blocks === info[6], `the walk visits every block the info call counted (${blocks})`);
  check(ascending, 'in address order');
  check(sawTheAllocation, 'and the live allocation appears in it, reported as not free');
}

// ---------- 4. the system-timer HAL drives the real registers ----------
{
  const { machine } = createEsp32C6Machine();
  const SYSTIMER = ESP32C6_PERIPHERAL_BASE.systimer;
  const HAL = 0x40840000;

  const ENABLE_COUNTER = 0x400003ec;
  const GET_COUNTER = 0x400003cc;
  const SET_TARGET = 0x400003d4;
  const GET_ALARM = 0x400003dc;
  const SET_PERIOD = 0x400003d8;
  const SELECT_MODE = 0x400003f0;
  const CONNECT = 0x400003f4;
  const ENABLE_INT = 0x400003e0;

  // The HAL context carries the peripheral address, exactly as firmware fills
  // it in.
  machine.writeUint32(HAL, SYSTIMER);
  machine.writeUint32(HAL + 4, 0);
  machine.writeUint32(HAL + 8, 0);

  romCall(machine, ENABLE_COUNTER, HAL, 0);
  check((machine.readUint32(SYSTIMER) & (1 << 30)) !== 0, 'enabling counter 0 sets its work-enable bit in CONF');
  romCall(machine, ENABLE_COUNTER, HAL, 1);
  check((machine.readUint32(SYSTIMER) & (1 << 29)) !== 0, 'and counter 1 sets its own, not the same one');

  // The counter has to be a real, advancing count read through the latch
  // handshake — not a stored value.
  const first = romCall(machine, GET_COUNTER, HAL, 0).a0 >>> 0;
  // Let simulated time pass by really executing instructions: `c.j .` at the
  // return address, stepped, is a spin that costs one CPU cycle a time.
  machine.writeUint16(0x40800000, 0xa001);
  machine.core.pc = 0x40800000;
  for (let i = 0; i < 5000; i++) machine.step();
  const second = romCall(machine, GET_COUNTER, HAL, 0).a0 >>> 0;
  check(second > first, `the counter advances with simulated time (${first} -> ${second})`);

  // A 64-bit argument arrives in an aligned register pair, so the target is in
  // a2/a3 with the alarm id in a1. Reading the wrong pair arms it at nonsense.
  romCall(machine, SET_TARGET, HAL, 2, 0x1234_5678, 0x9);
  check(machine.readUint32(SYSTIMER + 0x30) === 0x12345678, 'a one-shot target reaches the low half of TARGET2');
  check((machine.readUint32(SYSTIMER + 0x2c) & 0xfffff) === 0x9, 'and its high half');
  const alarm = romCall(machine, GET_ALARM, HAL, 2);
  check((alarm.a0 >>> 0) === 0x12345678 && alarm.a1 === 0x9, 'and reading it back returns both halves in a0/a1');
  check((machine.readUint32(SYSTIMER + 0x3c) & (1 << 30)) === 0, 'a one-shot target clears periodic mode');

  // Periodic mode is what the FreeRTOS tick runs on, and it is a live setting:
  // firmware really does switch a comparator to periodic after loading a
  // one-shot target.
  romCall(machine, SET_PERIOD, HAL, 2, 16000);
  const conf = machine.readUint32(SYSTIMER + 0x3c);
  check((conf & (1 << 30)) !== 0, 'setting a period turns periodic mode on');
  check((conf & 0x03ffffff) === 16000, 'and stores the period itself');

  romCall(machine, SELECT_MODE, HAL, 2, 0);
  check((machine.readUint32(SYSTIMER + 0x3c) & (1 << 30)) === 0, 'and the mode can be switched back');

  romCall(machine, CONNECT, HAL, 2, 1);
  check((machine.readUint32(SYSTIMER + 0x3c) & (1 << 31)) !== 0, 'a comparator can be pointed at counter 1');
  romCall(machine, CONNECT, HAL, 2, 0);
  check((machine.readUint32(SYSTIMER + 0x3c) & (1 << 31)) === 0, 'and back at counter 0');

  romCall(machine, ENABLE_INT, HAL, 2);
  check((machine.readUint32(SYSTIMER + 0x64) & 0b100) !== 0, 'enabling the alarm interrupt unmasks comparator 2');
  check((machine.readUint32(SYSTIMER) & (1 << 22)) !== 0, 'and starts it, without which nothing would be delivered');

  // Everything above went through the registers, so a firmware that writes them
  // directly — as ESP-IDF sometimes does — sees the same timer.
  machine.writeUint32(SYSTIMER + 0x3c, 0);
  check(romCall(machine, GET_ALARM, HAL, 2).a0 === 0x12345678, 'the HAL reads state back from the registers, not from memory of its own');
}

console.log(failures === 0 ? '\nESP32-C6 ROM family checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
