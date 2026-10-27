// Real Raspberry Pi Pico firmware, executed end to end.
//
// Every sketch below is compiled by the same backend the application uses, by
// the real rp2040 Arduino core, and the resulting UF2 is executed unmodified.
// Nothing is patched, no startup function is skipped by address, the program
// counter is never forced into user code, and no Arduino function is
// intercepted: execution begins at the reset vector the image itself
// publishes and every observation is made at the GPIO pads or the UART.
//
// The suite deliberately uses several independently compiled images with
// different pins and different timings, so a pass cannot come from behaviour
// that happens to suit one particular sketch.
//
// It needs the compiler backend with the rp2040 core installed. Without it,
// every firmware section skips with a clear message rather than pretending.

import { ROM_DATA_CODES } from '../src/simulation/rp2040/bootStub';
import { isMappedAddress, loadRp2040js, PicoMachine, parseUf2, FLASH_BASE } from './harness/picoMachine.mts';
import { traceRomLookups } from './harness/trace.mts';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log('SKIP:', msg);
  skipped++;
}

// --------------------------------------------------------------- compiling

interface CompileResult {
  uf2: Uint8Array | null;
  format?: string;
  error?: string;
}

async function compile(source: string): Promise<CompileResult> {
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boardId: 'board.raspberry-pi-pico',
        fqbn: 'rp2040:rp2040:rpipico',
        files: [{ name: 'sketch.ino', content: source }],
      }),
    });
    const json = (await res.json()) as {
      success: boolean;
      firmware?: { data: string; format: string };
      message?: string;
    };
    if (!json.success || !json.firmware) return { uf2: null, error: json.message ?? 'compile failed' };
    return {
      uf2: Uint8Array.from(atob(json.firmware.data), (c) => c.charCodeAt(0)),
      format: json.firmware.format,
    };
  } catch (err) {
    return { uf2: null, error: String(err) };
  }
}

// The sketches. Each is ordinary Arduino code a user could type.
const SKETCHES = {
  empty: 'void setup() {}\nvoid loop() {}',
  blink15:
    'void setup() { pinMode(15, OUTPUT); }\n' +
    'void loop() { digitalWrite(15, HIGH); delay(100); digitalWrite(15, LOW); delay(100); }',
  blink2:
    'void setup() { pinMode(2, OUTPUT); }\n' +
    'void loop() { digitalWrite(2, HIGH); delay(50); digitalWrite(2, LOW); delay(50); }',
  button:
    'void setup() { pinMode(16, INPUT_PULLUP); pinMode(15, OUTPUT); }\n' +
    'void loop() { digitalWrite(15, digitalRead(16) == LOW ? HIGH : LOW); }',
  uart: 'void setup() { Serial1.begin(115200); }\nvoid loop() { Serial1.println("CD-OK"); delay(10); }',
  pinRange:
    'void setup() { for (int i = 0; i < 29; i++) { pinMode(i, OUTPUT); digitalWrite(i, i % 2 ? HIGH : LOW); } }\n' +
    'void loop() {}',
} as const;

const rp2040js = await loadRp2040js();
if (!rp2040js) {
  skip('rp2040js is not installed — no firmware can be executed');
  report();
}
const { RP2040 } = rp2040js!;

// A single probe compile decides whether the whole suite can run.
const probe = await compile(SKETCHES.empty);
if (!probe.uf2) {
  skip(`the Pico toolchain is unavailable (${probe.error}) — firmware sections cannot run`);
  report();
}

const firmware: Record<string, Uint8Array> = { empty: probe.uf2! };
for (const [name, source] of Object.entries(SKETCHES)) {
  if (name === 'empty') continue;
  const result = await compile(source);
  if (!result.uf2) {
    console.log('FAIL: could not compile the', name, 'sketch:', result.error);
    failures++;
  } else {
    firmware[name] = result.uf2;
  }
}

/** Boots an image the documented way and returns the running machine. */
function boot(name: string) {
  const machine = new PicoMachine(RP2040);
  machine.loadFirmware(firmware[name]);
  const info = machine.boot();
  return { machine, info };
}

// ---------- 1. The artifact is genuinely an RP2040 image ----------
//
// If the backend ever fell back to an AVR target, this is where it shows.
{
  const uf2 = firmware.blink15 ?? probe.uf2!;
  check(probe.format === 'uf2', `the Pico target produces a UF2 artifact (format: ${probe.format})`);
  check(uf2.length % 512 === 0 && uf2.length > 0, `the UF2 is a whole number of blocks (${uf2.length} bytes)`);
  const parsed = parseUf2(uf2);
  check(parsed.families.has(0xe48bff56), 'the UF2 declares the RP2040 family id');
  check(parsed.families.size === 1, 'the UF2 declares no other family');
  check(uf2[0] !== ':'.charCodeAt(0), 'the artifact is not AVR Intel HEX');
  check([...parsed.blocks.keys()].every((a) => a >= FLASH_BASE), 'every block targets the XIP flash window');
}

// ---------- 2. The image's own second stage boots ----------
{
  const { machine, info } = boot('blink15');
  check(info.boot2Returned, `the image's own boot2 runs and returns (${info.boot2Instructions} instructions)`);
  check(info.sp === 0x20042000, `the application stack pointer comes from the image (0x${info.sp.toString(16)})`);
  check(
    info.pc >= FLASH_BASE && info.pc < FLASH_BASE + 0x200000,
    `the reset handler is in flash (0x${info.pc.toString(16)})`,
  );
  check(machine.rp.core.PC === info.pc, 'execution is handed to the published reset vector, not an address we chose');
}

// ---------- 3. An empty sketch runs indefinitely without faulting ----------
//
// The weakest possible program: if the runtime is broken, this still breaks.
{
  const { machine } = boot('empty');
  const result = machine.run({ maxInstructions: 3_000_000, maxWallMs: 30_000 });
  check(result.instructions === 3_000_000, `an empty sketch retires instructions steadily (${result.instructions})`);
  check(isMappedAddress(result.pc), `execution stays inside mapped memory (PC = 0x${result.pc.toString(16)})`);
  check(machine.millis > 1, `simulated time advances (${machine.millis.toFixed(1)} ms)`);
}

// ---------- 4. GPIO output: GP15 blinks at the programmed interval ----------
{
  const { machine } = boot('blink15');
  const gp15 = machine.watchGpio(15);
  const others = [2, 16, 25].map((p) => ({ pin: p, rec: machine.watchGpio(p) }));

  const result = machine.run({ maxInstructions: 40_000_000, maxWallMs: 60_000, until: () => gp15.count >= 8 });
  check(gp15.count >= 8, `GP15 toggles repeatedly (${gp15.count} edges in ${result.instructions} instructions)`);

  // The steady-state period, ignoring the pin-configuration edges at startup.
  const steady = gp15.times.slice(-5);
  const gaps = steady.slice(1).map((t, i) => t - steady[i]);
  const accurate = gaps.every((g) => Math.abs(g - 100) < 5);
  check(accurate, `each half-period is the programmed delay(100) (${gaps.map((g) => g.toFixed(1)).join(', ')} ms)`);
  check(
    gp15.states.slice(-4).some((s) => s === 1) && gp15.states.slice(-4).some((s) => s === 0),
    'GP15 alternates between driving high and driving low',
  );
  for (const { pin, rec } of others) check(rec.count === 0, `GP${pin} is untouched by a sketch that never mentions it`);
}

// ---------- 5. A different pin and a different delay ----------
//
// Independently compiled. A pass here cannot come from anything specific to
// GP15 or to a 100 ms interval.
{
  const { machine } = boot('blink2');
  const gp2 = machine.watchGpio(2);
  const gp15 = machine.watchGpio(15);
  machine.run({ maxInstructions: 40_000_000, maxWallMs: 60_000, until: () => gp2.count >= 8 });

  check(gp2.count >= 8, `GP2 toggles repeatedly (${gp2.count} edges)`);
  check(gp15.count === 0, 'GP15 stays idle for a sketch that only drives GP2');
  const steady = gp2.times.slice(-5);
  const gaps = steady.slice(1).map((t, i) => t - steady[i]);
  check(
    gaps.every((g) => Math.abs(g - 50) < 5),
    `each half-period is the programmed delay(50) (${gaps.map((g) => g.toFixed(1)).join(', ')} ms)`,
  );
}

// ---------- 6. GPIO input: a button on the internal pull-up ----------
//
// Released is an open switch, so the pad is held by its own pull-up; pressed
// ties it to ground. The sketch mirrors the reading onto GP15.
{
  const { machine } = boot('button');
  const gp15 = machine.watchGpio(15);
  const gp16 = machine.rp.gpio[16];

  machine.run({ maxInstructions: 6_000_000, maxWallMs: 40_000, until: () => gp16.pullupEnabled });
  check(gp16.pullupEnabled, 'pinMode(INPUT_PULLUP) enables the pad pull-up');
  check(gp16.inputEnable, 'pinMode(INPUT_PULLUP) enables the input buffer');
  check(!gp16.outputEnable, 'an input pin does not drive the pad');

  machine.run({ maxInstructions: 2_000_000, maxWallMs: 20_000 });
  check(machine.readPin(16), 'an open switch reads HIGH through the internal pull-up');
  check(!machine.rp.gpio[15].outputValue, 'the sketch drives GP15 low while the button is released');

  const before = gp15.count;
  machine.drivePin(16, false); // press
  machine.run({ maxInstructions: 2_000_000, maxWallMs: 20_000 });
  check(!machine.readPin(16), 'pressing the button pulls the pad to ground');
  check(machine.rp.gpio[15].outputValue, 'the sketch responds to the press by driving GP15 high');
  check(gp15.count > before, `the response is an actual edge on GP15 (${gp15.count - before})`);

  machine.drivePin(16, null); // release
  machine.run({ maxInstructions: 2_000_000, maxWallMs: 20_000 });
  check(machine.readPin(16), 'releasing returns the pad to the pull-up level');
  check(!machine.rp.gpio[15].outputValue, 'the sketch returns GP15 low');
}

// ---------- 7. Every GP pin in the range takes the state it is given ----------
{
  const { machine } = boot('pinRange');
  machine.run({ maxInstructions: 8_000_000, maxWallMs: 40_000, until: () => machine.rp.gpio[28].outputEnable });

  let wrong: string[] = [];
  for (let pin = 0; pin <= 28; pin++) {
    const gpio = machine.rp.gpio[pin];
    const expected = pin % 2 === 1;
    if (!gpio.outputEnable || gpio.outputValue !== expected) {
      wrong.push(`GP${pin}(oe=${gpio.outputEnable},v=${gpio.outputValue},want=${expected})`);
    }
  }
  check(wrong.length === 0, `GP0 through GP28 each hold the state the sketch assigned${wrong.length ? ': ' + wrong.join(' ') : ''}`);
  check(machine.rp.gpio.length >= 30, `the machine exposes the full GPIO bank (${machine.rp.gpio.length} pins)`);
}

// ---------- 8. UART output reaches the pins ----------
//
// On the Pico, Serial is USB CDC (not simulated) and Serial1 is UART0 on
// GP0/GP1, which is what this asserts.
{
  const { machine } = boot('uart');
  const uart0 = machine.watchUart(0);
  const result = machine.run({
    maxInstructions: 30_000_000,
    maxWallMs: 60_000,
    until: () => uart0.bytes.length >= 21,
  });
  check(uart0.bytes.length > 0, `the firmware transmits on UART0 (${uart0.bytes.length} bytes)`);
  check(uart0.text.startsWith('CD-OK\r\n'), `the transmitted bytes are the sketch's own text (${JSON.stringify(uart0.text.slice(0, 16))})`);
  check(uart0.text.split('CD-OK').length - 1 >= 3, 'loop() runs repeatedly, printing more than once');
  check(machine.rp.uart[0].enabled, 'Serial1.begin() enables UART0');
  check(result.reason === 'until', `the run ended on its own condition, not a limit (${result.reason})`);
}

// ---------- 9. Reset really restarts the machine ----------
{
  const { machine } = boot('blink15');
  const first = machine.watchGpio(15);
  machine.run({ maxInstructions: 40_000_000, maxWallMs: 60_000, until: () => first.count >= 8 });
  check(first.count >= 8, `the first run blinks (${first.count} edges)`);
  check(machine.rp.gpio[15].outputEnable, 'GP15 is left driving at the end of the first run');
  const firstGaps = periods(first.times);

  machine.reset();
  check(!machine.rp.gpio[15].outputEnable, 'reset returns GP15 to its power-on input state');
  check(machine.rp.gpio[15].pulldownEnabled, 'reset restores the pad default pull-down');
  check(machine.rp.readUint32(0x20000000) === 0, 'reset clears SRAM');
  check(machine.millis === 0, 'reset restarts the simulated clock');

  const info = machine.boot();
  check(info.boot2Returned, 'the same image boots again after a reset');
  const second = machine.watchGpio(15);
  machine.run({ maxInstructions: 40_000_000, maxWallMs: 60_000, until: () => second.count >= 8 });
  check(second.count >= 8, `the sketch blinks again after a reset (${second.count} edges)`);

  const secondGaps = periods(second.times);
  check(secondGaps.length >= 3, `there are enough edges after a reset to measure (${secondGaps.length} intervals)`);
  check(
    secondGaps.length >= 3 && secondGaps.every((g) => Math.abs(g - 100) < 5),
    `timing after a reset matches the first run (${secondGaps.map((g) => g.toFixed(1)).join(', ')} ms)`,
  );
  check(
    firstGaps.length === secondGaps.length && firstGaps.every((g, i) => Math.abs(g - secondGaps[i]) < 1),
    'the run after a reset reproduces the first run exactly',
  );
}

/**
 * Steady-state intervals between edges.
 *
 * The first few edges of any run are the pin-configuration transitions that
 * pinMode() produces, all within the same microsecond, so only the tail is
 * meaningful. Callers collect at least eight edges before measuring.
 */
function periods(times: number[]): number[] {
  const steady = times.slice(-5);
  return steady.slice(1).map((t, i) => t - steady[i]);
}

// ---------- 10. Execution is bounded, never a lock-up ----------
{
  const { machine } = boot('empty');
  const started = Date.now();
  const result = machine.run({ maxInstructions: 5_000_000_000, maxWallMs: 750 });
  check(result.reason === 'maxWallMs', `a wall-clock limit ends a run (${result.reason})`);
  check(Date.now() - started < 5_000, `the limit is honoured promptly (${Date.now() - started} ms)`);

  const capped = boot('empty').machine.run({ maxInstructions: 1000, maxWallMs: 30_000 });
  check(capped.instructions === 1000, `an instruction limit ends a run exactly (${capped.instructions})`);
}

// ---------- 11. The ROM interface is fully satisfied ----------
//
// The stall this milestone fixed was an unresolved ROM lookup branching to
// address 0. This asserts the condition can no longer arise: real firmware
// asks only for codes the stub advertises, and never reaches address 0.
{
  const { machine } = boot('blink15');
  const rom = traceRomLookups({ capacity: 4096 });
  const gp15 = machine.watchGpio(15);
  machine.run({ trace: rom.tracer, maxInstructions: 40_000_000, maxWallMs: 60_000, until: () => gp15.count >= 6 });

  check(rom.branchesToZero === 0, `firmware never branches to address 0 (${rom.branchesToZero} times)`);
  console.log('      ROM codes requested:', rom.summary().map((r) => `${r.tag}x${r.count}`).join(' '));

  const ADVERTISED = ['MC', 'C4', 'MS', 'S4', 'IF', 'EX', 'FC', 'CX', 'L3', 'T3', 'P3', 'R3'];
  // 'SF' and 'SD' are the soft-float and soft-double *data* tables, which the
  // SDK looks up during startup. The stub publishes them with its own trap
  // implementations behind every slot (romFloat.ts).
  const DATA = Object.values(ROM_DATA_CODES).map((c) => String.fromCharCode(c & 0xff, (c >> 8) & 0xff));
  const unexpected = rom.summary().filter((r) => !ADVERTISED.includes(r.tag) && !DATA.includes(r.tag));
  check(
    unexpected.length === 0,
    `firmware requests nothing outside the advertised functions and data tables${unexpected.length ? ': ' + unexpected.map((u) => u.tag).join(' ') : ''}`,
  );
  check(
    rom.summary().filter((r) => ADVERTISED.includes(r.tag)).length >= 8,
    'the advertised routines are the ones actually being used',
  );
}

report();

function report(): never {
  console.log(
    failures === 0
      ? `\nRP2040 firmware checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
