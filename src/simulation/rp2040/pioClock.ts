// RP2040 PIO, run on the simulated clock.
//
// rp2040js executes PIO in bursts of a thousand instructions per setTimeout,
// on the host's wall clock, one instruction per step whatever the state
// machine's clock divider and however many delay cycles the instruction
// carries. A PIO program is nothing but timing — a servo pulse, a tone, a
// NeoPixel bit — so none of them came out right: Arduino-Pico's Servo and
// tone() both run on PIO, and neither moved a pin in simulated time.
//
// Here each enabled state machine is owed `system cycles / divider` PIO
// cycles as the CPU runs, and steps until the debt is paid. A step costs what
// rp2040js counts for it — one cycle plus the instruction's delay — and a
// stalled step (waiting on a pin, an IRQ or the FIFO) costs one cycle, which
// is how often the hardware re-evaluates a stall. The divider is the
// register's integer part plus its fraction / 256, with 0 meaning 65536, as
// the datasheet defines it.

interface PioMachine {
  enabled: boolean;
  cycles: number;
  clockDivInt: number;
  clockDivFrac: number;
  pc: number;
  x: number;
  y: number;
  waiting: boolean;
  execValid: boolean;
  sidesetCount: number;
  execCtrl: number;
  inputShiftReg: number;
  inputShiftCount: number;
  outputShiftReg: number;
  outputShiftCount: number;
  txFIFO: { itemCount: number; reset(): void };
  rxFIFO: { itemCount: number; reset(): void };
  shiftCtrl: number;
  writeUint32(offset: number, value: number): void;
  updateDMATx?(): void;
  updateDMARx?(): void;
  step(): void;
}

interface PioBlock {
  machines: PioMachine[];
  instructions: Uint32Array | number[];
  pinValues: number;
  pinDirections: number;
  stopped: boolean;
  run(): void;
  checkChangedPins(): void;
}

/** Steps a single machine may take in one advance, as a runaway guard. */
const MAX_STEPS_PER_ADVANCE = 1_000_000;

export class PioClock {
  private readonly owed: number[][];

  constructor(private readonly blocks: PioBlock[]) {
    this.owed = blocks.map((block) => block.machines.map(() => 0));
    // The wall-clock loop is replaced, not supplemented: enabling a machine
    // still clears `stopped`, and advance() does the running.
    for (const block of blocks) block.run = () => {};
    for (const block of blocks) for (const machine of block.machines) clearFifosOnJoinChange(machine);
  }

  /** Whether any PIO block is running, so the caller can keep time fine-grained. */
  get active(): boolean {
    for (const block of this.blocks) if (!block.stopped) return true;
    return false;
  }

  /** Runs every enabled state machine for `systemCycles` of clk_sys. */
  advance(systemCycles: number): void {
    for (let b = 0; b < this.blocks.length; b++) {
      const block = this.blocks[b];
      if (block.stopped) continue;
      let stepped = false;
      const owed = this.owed[b];
      for (let m = 0; m < block.machines.length; m++) {
        const machine = block.machines[m];
        if (!machine.enabled) {
          owed[m] = 0;
          continue;
        }
        let owe = owed[m] + systemCycles / divider(machine);
        for (let steps = 0; owe >= 1 && steps < MAX_STEPS_PER_ADVANCE; steps++) {
          owe -= step(block, machine);
          stepped = true;
        }
        owed[m] = owe;
      }
      if (stepped) block.checkChangedPins();
    }
  }

  /**
   * Runs the state machines while the CPU sleeps, for up to `maxNs`.
   *
   * Stepping a microsecond at a time made a sleeping sketch with a servo
   * attached run thirty times slower than one without. Instead the machines
   * step in time order, each at the moment its divider says it is due, and the
   * clock is moved only when a step changed a pin — so an edge lands at its
   * own time and the cost is the PIO work done, not the time elapsed. A step
   * that wakes the CPU (a PIO interrupt) ends the stretch there.
   *
   * Returns how far the clock was moved, which is `maxNs` unless the CPU woke.
   */
  advanceWhileIdle(maxNs: number, cycleNs: number, moveClockTo: (ns: number) => void, idle: () => boolean): number {
    const running: { block: PioBlock; owed: number[]; m: number; machine: PioMachine; perNs: number }[] = [];
    for (let b = 0; b < this.blocks.length; b++) {
      const block = this.blocks[b];
      if (block.stopped) continue;
      block.machines.forEach((machine, m) => {
        if (machine.enabled) running.push({ block, owed: this.owed[b], m, machine, perNs: 1 / (divider(machine) * cycleNs) });
        else this.owed[b][m] = 0;
      });
    }
    let now = 0;
    for (let steps = 0; running.length > 0 && steps < MAX_STEPS_PER_ADVANCE * 4; steps++) {
      // The machine due soonest, and how long until it is.
      let next = running[0];
      let wait = Infinity;
      for (const r of running) {
        const due = r.owed[r.m] >= 1 ? 0 : (1 - r.owed[r.m]) / r.perNs;
        if (due < wait) {
          wait = due;
          next = r;
        }
      }
      if (now + wait > maxNs) break;
      for (const r of running) r.owed[r.m] += wait * r.perNs;
      now += wait;
      const block = next.block as PioBlock & { pinValues?: number; pinDirections?: number; oldPinValues?: number; oldPinDirections?: number };
      next.owed[next.m] -= step(block, next.machine);
      if (block.pinValues !== block.oldPinValues || block.pinDirections !== block.oldPinDirections) {
        moveClockTo(now);
        block.checkChangedPins();
      }
      if (!idle()) {
        moveClockTo(now);
        return now;
      }
    }
    for (const r of running) r.owed[r.m] += (maxNs - now) * r.perNs;
    moveClockTo(maxNs);
    return maxNs;
  }
}

/** SMx_SHIFTCTRL, relative to the state machine's first register (SMx_CLKDIV). */
const SHIFTCTRL = 0x08;

/**
 * Changing a state machine's FIFO join (SHIFTCTRL.FJOIN_RX/TX) empties both
 * its FIFOs, as the datasheet says. The SDK's pio_sm_clear_fifos() is built on
 * exactly that — it flips FJOIN_RX and back — and rp2040js stored the
 * register without clearing anything. Arduino-Pico's Servo clears the FIFO
 * before every write() so a new angle replaces any not yet taken; without the
 * clear, writes queued behind stale ones, write() blocked for a servo frame at
 * a time, and a new angle took four frames to arrive.
 */
function clearFifosOnJoinChange(machine: PioMachine): void {
  const write = machine.writeUint32.bind(machine);
  machine.writeUint32 = (offset: number, value: number) => {
    const joinBefore = machine.shiftCtrl >>> 30;
    write(offset, value);
    if (offset === SHIFTCTRL && machine.shiftCtrl >>> 30 !== joinBefore) {
      machine.txFIFO.reset();
      machine.rxFIFO.reset();
      machine.updateDMATx?.();
      machine.updateDMARx?.();
    }
  };
}

/** The datasheet's divider: integer part plus fraction / 256, with 0 meaning 65536. */
function divider(machine: PioMachine): number {
  return (machine.clockDivInt || 65536) + machine.clockDivFrac / 256;
}

/** The loop a machine is in, as seen at its head on the last pass. */
interface LoopWatch {
  head: number;
  /** State at the head on the last pass, or null before the first. */
  seen: number[] | null;
  /** Whether every instruction since that pass is one a skip can stand in for. */
  pure: boolean;
}

const watches = new WeakMap<PioMachine, LoopWatch>();

function state(block: PioBlock, machine: PioMachine): number[] {
  return [
    machine.x, machine.y, machine.inputShiftReg, machine.inputShiftCount, machine.outputShiftReg,
    machine.outputShiftCount, machine.txFIFO.itemCount, machine.rxFIFO.itemCount, block.pinValues,
    block.pinDirections, machine.cycles,
  ];
}

/**
 * Whether an instruction neither reads nor drives anything outside the state
 * machine's own registers: a jump on X, Y or X!=Y, or a MOV into X or Y from
 * X, Y, NULL, ISR or OSR — with no side-set. A loop of only these does the
 * same thing every pass but count.
 */
function pure(machine: PioMachine, opcode: number): boolean {
  const delaySideset = (opcode >> 8) & 0x1f;
  const sideEnabled = (machine.execCtrl & (1 << 30)) !== 0;
  if (machine.sidesetCount > 0 && (!sideEnabled || (delaySideset & 0x10) !== 0)) return false;
  switch (opcode >>> 13) {
    case 0b000: // JMP: always, !X, X--, !Y, Y--, X!=Y — not PIN, not !OSRE
      return ((opcode >> 5) & 0x7) <= 0b101;
    case 0b101: { // MOV
      const destination = (opcode >> 5) & 0x7;
      const source = opcode & 0x7;
      return (destination === 1 || destination === 2) && source !== 0 && source !== 4 && source !== 5;
    }
    default:
      return false;
  }
}

/**
 * One step, in PIO cycles: what rp2040js counted (one plus any delay), or one
 * for a stalled step — then, if the machine is going round a counting loop,
 * as many passes of it as are certain to be identical, at once.
 *
 * PIO programs time a pulse by counting a register down: Arduino-Pico's
 * tone() spins `jmp y-- self`, its Servo a three-instruction loop that counts
 * Y down to X. Run at 200 MHz, that is 200 million instructions a simulated
 * second. A loop qualifies when two passes through its head differ in exactly
 * one thing — X or Y one lower — cost the same cycles, changed no pin, and ran
 * only pure() instructions. Every further pass then does the same until the
 * counter reaches a value a jump can test: zero, or the other register. Passes
 * up to two short of the nearest are applied in one go; the machine runs
 * ahead of the CPU, which is harmless since nothing it skipped reads or drives
 * anything, and it resumes stepping when the clock catches up.
 */
function step(block: PioBlock, machine: PioMachine): number {
  const from = machine.pc;
  const opcode = block.instructions[from] ?? 0;
  const before = machine.cycles;
  machine.step();
  const used = machine.cycles - before;
  const cost = used > 0 ? used : 1;
  let watch = watches.get(machine);
  if (!watch) {
    watch = { head: -1, seen: null, pure: false };
    watches.set(machine, watch);
  }
  if (machine.waiting || machine.execValid || used === 0) {
    watch.seen = null;
    return cost;
  }
  watch.pure = watch.pure && pure(machine, opcode);
  // A backward move — a jump or the program wrapping — is the head of a loop.
  if (machine.pc > from) return cost;
  const now = state(block, machine);
  const seen = watch.head === machine.pc ? watch.seen : null;
  watch.head = machine.pc;
  watch.seen = now;
  const wasPure = watch.pure;
  watch.pure = true;
  if (!seen || !wasPure) return cost;
  const perPass = now[10] - seen[10];
  for (let i = 2; i < 10; i++) if (now[i] !== seen[i]) return cost;
  const xCounts = ((seen[0] - now[0]) >>> 0) === 1 && now[1] === seen[1];
  const yCounts = ((seen[1] - now[1]) >>> 0) === 1 && now[0] === seen[0];
  if ((!xCounts && !yCounts) || perPass <= 0) return cost;
  const counter = xCounts ? now[0] : now[1];
  const other = xCounts ? now[1] : now[0];
  // Equal is the critical case itself: distance zero, so nothing is skipped.
  const passes = Math.min(counter, counter >= other ? counter - other : Infinity) - 2;
  if (passes <= 0) return cost;
  if (xCounts) machine.x = (machine.x - passes) >>> 0;
  else machine.y = (machine.y - passes) >>> 0;
  machine.cycles += passes * perPass;
  watch.seen = state(block, machine);
  return cost + passes * perPass;
}
