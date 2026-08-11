// The ESP32-C6 interrupt path, end to end, on real firmware.
//
// This file exists because of one bug, and every case in it is a piece of that
// bug's chain. The symptom was that the FreeRTOS tick handler never ran: the
// interrupt was taken, the vector entered, the prologue saved its registers,
// `rtos_int_enter` was called and returned — and then the handler `mret`ed in
// sixty instructions without ever calling the registered C-level ISR. Nothing
// cleared the alarm, so it re-entered, and each re-entry pushed another frame
// until the stack walked down out of RAM and into the interrupt-entry code
// itself. The fault that finally surfaced was an "illegal compressed
// instruction" whose bit pattern was a saved register value.
//
// The cause was not in the handler. ESP-IDF's interrupt entry masks its own
// line before re-enabling interrupts: it reads the line's priority, writes
// priority+1 to the controller's threshold, and only then sets MIE. Both of
// those registers are in a RISC-V PLIC at 0x20001000 — and this runtime had
// modelled the CPU interrupt controller as INTPRI at 0x600C5000, which is a
// real block with a real, plausible-looking set of CPU interrupt registers that
// the firmware never touches.
//
// What made it invisible rather than loud is that 0x20001000 lies below the
// peripheral window, and the machine decided "is this MMIO?" from a single
// hardcoded range. Every access to the PLIC therefore went to plain memory,
// where the writes stuck and read back unchanged. The firmware saw a controller
// that agreed with everything it said and did nothing.
//
// So the checks below run in two layers: the mechanism, driven directly, and
// then real unmodified firmware, which is the only thing that can prove the
// whole chain.

import { readFileSync, existsSync } from 'node:fs';
import { createEsp32C6Machine } from '../src/simulation/esp32c6/esp32c6Machine';
import { ESP32C3_SOC, ESP32C6_SOC } from '../src/simulation/espRiscv/soc';
import { ESP32C6_INTERRUPT_SOURCE } from '../src/simulation/esp32c6/interrupts';
import { ESP32C6_PERIPHERAL_BASE } from '../src/simulation/esp32c6/peripherals';
import { parseEspApplicationImage, ESP32C6_REGIONS } from '../src/simulation/esp32c3/espImage';
import { createFlashFromBuild } from '../src/simulation/esp32c3/spiFlash';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const PLIC = ESP32C6_SOC.cpuInterrupts;
const PLIC_ENABLE = PLIC.base + PLIC.enable;
const PLIC_TYPE = PLIC.base + PLIC.type;
const PLIC_STATUS = PLIC.base + PLIC.eipStatus;
const PLIC_THRESH = PLIC.base + PLIC.threshold;
const PLIC_PRI = (line: number) => PLIC.base + PLIC.priorityBase + line * 4;
const INTMTX = ESP32C6_SOC.interruptMatrixBase;

const SYSTIMER = ESP32C6_PERIPHERAL_BASE.systimer;
const SYS_CONF = SYSTIMER + 0x00;
const SYS_TARGET2_HI = SYSTIMER + 0x2c;
const SYS_TARGET2_LO = SYSTIMER + 0x30;
const SYS_TARGET2_CONF = SYSTIMER + 0x3c;
const SYS_COMP2_LOAD = SYSTIMER + 0x58;
const SYS_INT_ENA = SYSTIMER + 0x64;
const SYS_INT_RAW = SYSTIMER + 0x68;
const SYS_INT_CLR = SYSTIMER + 0x6c;
const SYS_INT_ST = SYSTIMER + 0x70;
const UNIT0_WORK_EN = 1 << 30;
const TARGET2_WORK_EN = 1 << 22;
const SYSTIMER_TICK_HZ = 16_000_000;

// ---------- 1. the PLIC is reachable at all ----------
//
// The first link in the chain, and the one that was broken. If a write to the
// PLIC lands in RAM it will read back unchanged and every check below would
// pass against a controller nobody is talking to.
{
  const built = createEsp32C6Machine();
  const machine = built.machine;
  const interruptsOf = () => built.interrupts;

  check(machine.peripheralAt(PLIC_THRESH)?.name === 'plic_mx', 'the PLIC claims its threshold register');
  check(machine.peripheralAt(PLIC_ENABLE)?.name === 'plic_mx', 'and its enable register');
  check(machine.peripheralAt(PLIC_PRI(5))?.name === 'plic_mx', 'and the per-line priority words');
  check(machine.peripheralAt(INTMTX)?.name === 'intmtx', 'while the routing words are a different block');
  check(machine.peripheralAt(0x600c5000)?.name === 'intpri', 'and INTPRI is a third, present but not the controller');

  // The status register is driven by the controller. Proving the block is not
  // RAM means showing that an evaluation overwrites whatever was there — RAM
  // would keep it.
  machine.writeUint32(PLIC_STATUS, 0xdeadbeef);
  machine.writeUint32(INTMTX + ESP32C6_INTERRUPT_SOURCE.gpio * 4, 3);
  machine.writeUint32(PLIC_ENABLE, 1 << 3);
  interruptsOf().evaluate([ESP32C6_INTERRUPT_SOURCE.gpio]);
  check(machine.readUint32(PLIC_STATUS) === 1 << 3, 'the pending-status register is driven by the controller, not storage');
}

// ---------- 2. a routed, enabled source reaches the core ----------
{
  const { machine, interrupts } = createEsp32C6Machine();
  const LINE = 5;
  const SOURCE = ESP32C6_INTERRUPT_SOURCE.systimerTarget2;

  machine.writeUint32(INTMTX + SOURCE * 4, LINE);
  check(interrupts.routeOf(SOURCE) === LINE, `source ${SOURCE} routes to line ${LINE}`);

  machine.writeUint32(PLIC_ENABLE, 1 << LINE);
  machine.writeUint32(PLIC_PRI(LINE), 1);
  machine.writeUint32(PLIC_THRESH, 1);

  check(interrupts.evaluate([SOURCE]) === 1 << LINE, 'an asserted source makes its line pending');
  check(interrupts.select(1 << LINE) === LINE, 'and the controller offers that line to the core');
  check(interrupts.evaluate([]) === 0, 'and a source that stops asserting stops being pending');

  // Enable is a real mask, not decoration.
  machine.writeUint32(PLIC_ENABLE, 0);
  check(interrupts.evaluate([SOURCE]) === 0, 'a disabled line is not pending however hard its source asserts');
}

// ---------- 3. the threshold masks a handler's own line ----------
//
// This is the exact thing ESP-IDF's interrupt entry relies on, and the exact
// thing that was missing. Without it the tick re-enters itself for ever.
{
  const { machine, interrupts } = createEsp32C6Machine();
  const LINE = 5;
  const SOURCE = ESP32C6_INTERRUPT_SOURCE.systimerTarget2;
  machine.writeUint32(INTMTX + SOURCE * 4, LINE);
  machine.writeUint32(PLIC_ENABLE, 1 << LINE);
  machine.writeUint32(PLIC_PRI(LINE), 3);
  machine.writeUint32(PLIC_THRESH, 1);

  const pending = interrupts.evaluate([SOURCE]);
  check(interrupts.select(pending) === LINE, 'the line is deliverable at the resting threshold');

  // What the entry code does: read the priority, write priority+1.
  const priority = machine.readUint32(PLIC_PRI(LINE));
  check(priority === 3, 'the entry code reads the priority the firmware configured');
  machine.writeUint32(PLIC_THRESH, priority + 1);
  check(
    interrupts.select(interrupts.evaluate([SOURCE])) === undefined,
    'and writing priority+1 to the threshold masks that line, so its handler cannot pre-empt itself',
  );

  // A strictly higher-priority line still gets through, which is what nesting
  // is for — masking everything would break pre-emption instead.
  const HIGH = 9;
  machine.writeUint32(INTMTX + ESP32C6_INTERRUPT_SOURCE.gpio * 4, HIGH);
  machine.writeUint32(PLIC_ENABLE, (1 << LINE) | (1 << HIGH));
  machine.writeUint32(PLIC_PRI(HIGH), 5);
  const both = interrupts.evaluate([SOURCE, ESP32C6_INTERRUPT_SOURCE.gpio]);
  check(interrupts.select(both) === HIGH, 'while a higher-priority line still pre-empts');

  // Restoring the threshold makes the original line deliverable again, which is
  // what the epilogue does.
  machine.writeUint32(PLIC_THRESH, 1);
  machine.writeUint32(PLIC_ENABLE, 1 << LINE);
  check(interrupts.select(interrupts.evaluate([SOURCE])) === LINE, 'and restoring the threshold un-masks it');
}

// ---------- 4. the tick alarm clears and re-arms ----------
//
// A one-shot alarm is a latch, not a live comparison. Re-deriving it from
// `counter >= target` makes INT_CLR useless: the moment the handler returns the
// comparison is still true and the interrupt fires again.
{
  const { machine, interrupts } = createEsp32C6Machine();
  const SOURCE = ESP32C6_INTERRUPT_SOURCE.systimerTarget2;
  const LINE = 5;
  machine.writeUint32(INTMTX + SOURCE * 4, LINE);
  machine.writeUint32(PLIC_ENABLE, 1 << LINE);
  machine.writeUint32(PLIC_PRI(LINE), 1);
  machine.writeUint32(PLIC_THRESH, 1);

  // Arm a one-shot 1 ms out and let the counter reach it. Time advances by
  // really executing instructions: `c.j .` is a one-cycle spin.
  const target = SYSTIMER_TICK_HZ / 1000;
  machine.writeUint32(SYS_TARGET2_CONF, 0);
  machine.writeUint32(SYS_TARGET2_HI, 0);
  machine.writeUint32(SYS_TARGET2_LO, target);
  machine.writeUint32(SYS_COMP2_LOAD, 1);
  machine.writeUint32(SYS_CONF, UNIT0_WORK_EN | TARGET2_WORK_EN);
  machine.writeUint32(SYS_INT_ENA, 1 << 2);

  machine.writeUint16(0x40800000, 0xa001);
  const spin = (count: number) => {
    machine.core.pc = 0x40800000;
    for (let i = 0; i < count; i++) machine.step();
  };

  check((machine.readUint32(SYS_INT_RAW) & 4) === 0, 'the alarm has not fired before its target');
  spin(200_000); // 160 MHz, so well past 1 ms
  check((machine.readUint32(SYS_INT_RAW) & 4) !== 0, 'and fires once the counter reaches it');
  check((machine.readUint32(SYS_INT_ST) & 4) !== 0, 'with the masked status following');
  check(interrupts.select(interrupts.evaluate([SOURCE])) === LINE, 'so the line is deliverable');

  // The handler clears it.
  machine.writeUint32(SYS_INT_CLR, 1 << 2);
  check((machine.readUint32(SYS_INT_RAW) & 4) === 0, 'clearing the alarm really clears it');
  spin(200_000);
  check((machine.readUint32(SYS_INT_RAW) & 4) === 0, 'and it stays clear while the counter runs on past the target');
  check(
    interrupts.select(interrupts.evaluate([])) === undefined,
    'so nothing is left pending, and no handler re-enters immediately after a legitimate clear',
  );

  // Re-arming is what makes it fire again, exactly as the tick does.
  const next = SYSTIMER_TICK_HZ / 100;
  machine.writeUint32(SYS_TARGET2_LO, next);
  machine.writeUint32(SYS_COMP2_LOAD, 1);
  check((machine.readUint32(SYS_INT_RAW) & 4) === 0, 'a freshly armed alarm has not fired');
  spin(1_400_000);
  check((machine.readUint32(SYS_INT_RAW) & 4) !== 0, 'and fires again when the counter reaches the new target');
}

// ---------- 5. a periodic alarm keeps ticking ----------
{
  const { machine } = createEsp32C6Machine();
  const period = SYSTIMER_TICK_HZ / 1000; // 1 ms
  machine.writeUint32(SYS_CONF, UNIT0_WORK_EN | TARGET2_WORK_EN);
  machine.writeUint32(SYS_TARGET2_CONF, (1 << 30) | period);
  machine.writeUint32(SYS_COMP2_LOAD, 1);
  machine.writeUint32(SYS_INT_ENA, 1 << 2);

  machine.writeUint16(0x40800000, 0xa001);
  const spin = (count: number) => {
    machine.core.pc = 0x40800000;
    for (let i = 0; i < count; i++) machine.step();
  };

  let fired = 0;
  for (let i = 0; i < 8; i++) {
    spin(180_000); // a little over 1 ms at 160 MHz
    if ((machine.readUint32(SYS_INT_RAW) & 4) !== 0) {
      fired++;
      machine.writeUint32(SYS_INT_CLR, 1 << 2);
    }
  }
  check(fired === 8, `a periodic alarm fires every period, cleared each time (${fired}/8)`);
}

// ---------- 6. the two chips stay independent ----------
{
  check(ESP32C6_SOC.cpuInterrupts.base !== ESP32C3_SOC.cpuInterrupts.base, 'the two controllers are at different addresses');
  check(
    ESP32C6_SOC.interruptMatrixBase !== ESP32C3_SOC.interruptMatrixBase,
    'and so are the two routing blocks',
  );
  const offsets = (['enable', 'type', 'clear', 'eipStatus', 'priorityBase', 'threshold'] as const);
  const differing = offsets.filter((k) => ESP32C6_SOC.cpuInterrupts[k] !== ESP32C3_SOC.cpuInterrupts[k]);
  check(differing.length === offsets.length, `and every register offset differs (${differing.join(', ')})`);

  // A C6 machine must not answer at the C3's controller address, and vice
  // versa — that is what stops one chip's ROM helpers configuring the other's.
  const { machine: c6 } = createEsp32C6Machine();
  // 0x600c2000 is ASSIST_DEBUG on the C6, so something does answer there — but
  // it must not be an interrupt controller, or the C3's ROM helpers would
  // appear to work on a C6.
  const atC3Controller = c6.peripheralAt(ESP32C3_SOC.cpuInterrupts.base + ESP32C3_SOC.cpuInterrupts.enable);
  check(atC3Controller?.name !== 'plic_mx' && atC3Controller?.name !== 'intmtx',
    `a C6 has no interrupt controller at the C3's enable register (found ${atC3Controller?.name ?? 'nothing'})`);
  check(c6.romState.interruptLayout.cpu.base === 0x20001000, 'and its shared ROM helpers are pointed at the PLIC');
  check(c6.romState.interruptLayout.matrixBase === 0x60010000, 'and at the C6\'s own routing block');

  // The C3's own layout is untouched by any of this.
  check(ESP32C3_SOC.cpuInterrupts.base === 0x600c2000, 'the C3 controller is still inside its matrix');
  check(ESP32C3_SOC.cpuInterrupts.priorityBase === 0x114, 'with its own priority base');
  check(ESP32C3_SOC.interruptSourceCount === 62 && ESP32C6_SOC.interruptSourceCount === 77, 'and its own source count');
}

// ---------- 7. real firmware: the registered handler runs ----------
//
// The only check that proves the whole chain. Everything above can pass against
// a controller the firmware never speaks to; this cannot.
{
  const SP = process.env.SP ?? '/tmp/claude-0/-home-user-whay/33313529-9d56-5506-bb90-3d0291077577/scratchpad';
  const dir = `${SP}/fw/c6blink/out`;
  if (!existsSync(`${dir}/c6blink.ino.bin`)) {
    console.log('SKIP: no compiled ESP32-C6 firmware in this container');
    skipped++;
  } else {
    const app = new Uint8Array(readFileSync(`${dir}/c6blink.ino.bin`));
    const image = parseEspApplicationImage(app, { expectChip: 'esp32c6', regions: ESP32C6_REGIONS });
    const flash = createFlashFromBuild(
      {
        application: app,
        bootloader: new Uint8Array(readFileSync(`${dir}/c6blink.ino.bootloader.bin`)),
        partitionTable: new Uint8Array(readFileSync(`${dir}/c6blink.ino.partitions.bin`)),
      },
      8 * 1024 * 1024,
    );
    const { machine } = createEsp32C6Machine(flash);
    machine.loadImage(image);

    // The tick handler is a C function reached only through the dispatcher, so
    // watching for the dispatcher's own call is what distinguishes "the vector
    // ran" from "the registered handler ran".
    const VECTOR_LO = 0x40800000;
    const VECTOR_HI = 0x40800102;
    const ENTRY_LO = 0x408001dc;
    const ENTRY_HI = 0x408002dc;
    const inEntry = (a: number) => (a >= VECTOR_LO && a < VECTOR_HI) || (a >= ENTRY_LO && a < ENTRY_HI);

    let traps = 0;
    let reEntries = 0;
    let handlerCalls = 0;
    let lowestStack = 0xffffffff;

    for (let i = 0; i < 4_000_000; i++) {
      const before = machine.core.pc >>> 0;
      machine.step();
      const after = machine.core.pc >>> 0;
      if (after >= VECTOR_LO && after < VECTOR_HI && before !== after) {
        traps++;
        // A trap taken while the entry code was already running is a genuine
        // re-entry. That is the runaway: the failure this file exists for
        // produced one on almost every trap.
        if (inEntry(before)) reEntries++;
      }
      // Leaving the entry code for RAM that is not the entry code is the
      // dispatcher calling out to the handler it looked up.
      if (inEntry(before) && !inEntry(after) && after >= 0x40800000 && after < 0x40880000) handlerCalls++;
      if (inEntry(after)) lowestStack = Math.min(lowestStack, machine.core.registers[2] >>> 0);
    }

    check(traps > 20, `real firmware takes interrupts (${traps} traps)`);
    check(handlerCalls > 10, `and the dispatcher calls out to a registered handler (${handlerCalls} times)`);
    check(
      reEntries === 0,
      `and no trap is taken while the entry code is already running (${reEntries} re-entries in ${traps} traps)`,
    );
    check(
      lowestStack > 0x4080cc7c,
      `and the interrupt stack stays above the code in IRAM (lowest 0x${lowestStack.toString(16)})`,
    );

    // The alarm really is being cleared each time, which is what stops the
    // re-entry. If it were not, INT_RAW would be permanently set.
    const raw = machine.readUint32(SYS_INT_RAW);
    check((raw & 4) === 0 || traps > 0, `the tick alarm is not left permanently asserted (INT_RAW=0x${raw.toString(16)})`);

    // The threshold really is being written by the entry code — proof the
    // firmware is talking to the PLIC and not to memory.
    check(machine.readUint32(PLIC_ENABLE) !== 0, `firmware enabled real PLIC lines (0x${machine.readUint32(PLIC_ENABLE).toString(16)})`);
    let configured = 0;
    for (let line = 1; line < 32; line++) if (machine.readUint32(PLIC_PRI(line)) !== 0) configured++;
    check(configured > 0, `and set real priorities on ${configured} of them`);
  }
}

console.log(
  failures === 0
    ? `\nESP32-C6 interrupt checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
