// ESP32-C3 peripherals that produce values hardware produces.
//
// These are the blocks where returning stored writes is not enough: a counter
// that does not count, or a status bit nothing sets, makes firmware spin for
// ever. Each case here drives the peripheral the way ESP-IDF drives it and
// checks the answer is derived from something real rather than fixed.

import {
  SysTimer,
  SYSTIMER_TICK_HZ,
  SystemConfiguration,
  TimerGroup,
  CALIBRATION_CLOCK_HZ,
  XTAL_HZ,
  PERIPHERAL_BASE,
} from '../src/simulation/esp32c3/peripherals';
import type { SimulatedClock } from '../src/simulation/esp32c3/esp32c3Machine';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

/** A clock a test can advance by hand. */
class TestClock implements SimulatedClock {
  nanos = 0;
  advanceMicros(us: number): void {
    this.nanos += us * 1000;
  }
}

const CONF = 0x00;
const UNIT0_OP = 0x04;
const UNIT0_LOAD_HI = 0x0c;
const UNIT0_LOAD_LO = 0x10;
const TARGET0_HI = 0x1c;
const TARGET0_LO = 0x20;
const TARGET0_CONF = 0x34;
const UNIT0_VALUE_HI = 0x40;
const UNIT0_VALUE_LO = 0x44;
const COMP0_LOAD = 0x50;
const UNIT0_LOAD = 0x5c;
const INT_ENA = 0x64;
const INT_RAW = 0x68;
const INT_CLR = 0x6c;
const INT_ST = 0x70;

const VALUE_VALID = 1 << 29;
const UPDATE = 1 << 30;
const UNIT0_WORK_EN = 1 << 30;
const TARGET0_WORK_EN = 1 << 24;
const PERIOD_MODE = 1 << 30;

// ---------- 1. reading a counter is a handshake ----------
{
  const clock = new TestClock();
  const timer = new SysTimer(clock);

  check(timer.base === PERIPHERAL_BASE.systimer, 'the system timer sits at its documented base address');
  check((timer.readUint32(CONF) & UNIT0_WORK_EN) !== 0, 'unit 0 counts out of reset, as the manual specifies');

  // This is the exact sequence systimer_hal_get_counter_value performs.
  const snapshot = (): number => {
    timer.writeUint32(UNIT0_OP, timer.readUint32(UNIT0_OP) | UPDATE);
    let guard = 0;
    while ((timer.readUint32(UNIT0_OP) & VALUE_VALID) === 0) {
      // Nothing advances the clock here on purpose: the snapshot has to
      // complete on its own, which is what the firmware's poll depends on.
      if (++guard > 1000) throw new Error('the valid bit never appeared');
    }
    return timer.readUint32(UNIT0_VALUE_LO) >>> 0;
  };

  check(snapshot() === 0, 'the counter starts at zero');

  clock.advanceMicros(1000);
  const afterMillisecond = snapshot();
  check(
    afterMillisecond === SYSTIMER_TICK_HZ / 1000,
    `a millisecond of simulated time is ${SYSTIMER_TICK_HZ / 1000} ticks (${afterMillisecond})`,
  );

  clock.advanceMicros(1000);
  check(snapshot() === afterMillisecond * 2, 'and the count keeps pace with time rather than with reads');

  // A snapshot is a snapshot: it must not drift while nothing updates it.
  const held = timer.readUint32(UNIT0_VALUE_LO) >>> 0;
  clock.advanceMicros(5000);
  check((timer.readUint32(UNIT0_VALUE_LO) >>> 0) === held, 'a latched value stays put until the next update');
  check(snapshot() > held, 'and the next update picks up the time that passed');
}

// ---------- 2. stopping, loading and the 52-bit width ----------
{
  const clock = new TestClock();
  const timer = new SysTimer(clock);
  const snapshot = (): number => {
    timer.writeUint32(UNIT0_OP, UPDATE);
    return (timer.readUint32(UNIT0_VALUE_HI) & 0xfffff) * 0x100000000 + (timer.readUint32(UNIT0_VALUE_LO) >>> 0);
  };

  clock.advanceMicros(1000);
  timer.writeUint32(CONF, 0);
  const frozen = snapshot();
  clock.advanceMicros(10_000);
  check(snapshot() === frozen, 'clearing the work-enable bit stops the counter');

  timer.writeUint32(CONF, UNIT0_WORK_EN);
  clock.advanceMicros(1000);
  check(
    snapshot() === frozen + SYSTIMER_TICK_HZ / 1000,
    'restarting resumes from where it stopped rather than from the elapsed time',
  );

  // The counter is 52 bits, so a load has to carry the high half.
  timer.writeUint32(UNIT0_LOAD_HI, 3);
  timer.writeUint32(UNIT0_LOAD_LO, 0xfffffffe);
  timer.writeUint32(UNIT0_LOAD, 1);
  check(snapshot() === 3 * 0x100000000 + 0xfffffffe, 'a load sets the whole 52-bit counter');

  clock.advanceMicros(1000);
  check(
    snapshot() === 3 * 0x100000000 + 0xfffffffe + SYSTIMER_TICK_HZ / 1000,
    'and counting carries across the 32-bit boundary',
  );
}

// ---------- 3. comparators ----------
{
  const clock = new TestClock();
  const timer = new SysTimer(clock);

  // A one-shot alarm 5 ms out.
  const target = (SYSTIMER_TICK_HZ / 1000) * 5;
  timer.writeUint32(TARGET0_CONF, 0);
  timer.writeUint32(TARGET0_HI, 0);
  timer.writeUint32(TARGET0_LO, target);
  timer.writeUint32(COMP0_LOAD, 1);
  timer.writeUint32(CONF, UNIT0_WORK_EN | TARGET0_WORK_EN);
  timer.writeUint32(INT_ENA, 1);

  clock.advanceMicros(4999);
  check((timer.readUint32(INT_RAW) & 1) === 0, 'a comparator does not fire before its target');
  clock.advanceMicros(2);
  check((timer.readUint32(INT_RAW) & 1) !== 0, 'and does fire once the counter reaches it');
  check((timer.readUint32(INT_ST) & 1) !== 0, 'the masked status follows the raw status when enabled');

  // A one-shot comparator is a comparison, not a latch: once the counter has
  // passed the target the condition stays true, so clearing the status only
  // holds until the next look. Firmware moves the target on instead, which is
  // exactly what the timer driver does for a one-shot alarm.
  timer.writeUint32(INT_CLR, 1);
  check((timer.readUint32(INT_RAW) & 1) !== 0, 'a one-shot target already passed re-asserts after a clear');

  timer.writeUint32(TARGET0_LO, target * 4);
  timer.writeUint32(COMP0_LOAD, 1);
  timer.writeUint32(INT_CLR, 1);
  check((timer.readUint32(INT_RAW) & 1) === 0, 'moving the target forward stops it');
  // The new target is four times the original, so the counter has to run well
  // past where it already is before the comparison becomes true again.
  clock.advanceMicros(20_000);
  check((timer.readUint32(INT_RAW) & 1) !== 0, 'and it fires again when the counter reaches the new target');

  // Disabling the comparator silences it whatever its target.
  timer.writeUint32(INT_CLR, 1);
  timer.writeUint32(CONF, UNIT0_WORK_EN);
  check((timer.readUint32(INT_RAW) & 1) === 0, 'a comparator with its work-enable clear asserts nothing');
  timer.writeUint32(CONF, UNIT0_WORK_EN | TARGET0_WORK_EN);

  // A period comparator repeats, and keeps its phase.
  const period = SYSTIMER_TICK_HZ / 1000;
  timer.writeUint32(TARGET0_CONF, PERIOD_MODE | period);
  timer.writeUint32(COMP0_LOAD, 1);
  timer.writeUint32(INT_CLR, 1);
  clock.advanceMicros(999);
  check((timer.readUint32(INT_RAW) & 1) === 0, 'a period comparator waits out its first period');
  clock.advanceMicros(2);
  check((timer.readUint32(INT_RAW) & 1) !== 0, 'then fires');

  timer.writeUint32(INT_CLR, 1);
  clock.advanceMicros(1000);
  check((timer.readUint32(INT_RAW) & 1) !== 0, 'and fires again a period later');

  // Reading late must not shift the phase: after a long gap the next alarm is
  // still on the original grid, so a tick cannot drift.
  timer.writeUint32(INT_CLR, 1);
  clock.advanceMicros(5000);
  check((timer.readUint32(INT_RAW) & 1) !== 0, 'a late read still sees the alarms it missed');
  timer.writeUint32(INT_CLR, 1);
  clock.advanceMicros(1000);
  check((timer.readUint32(INT_RAW) & 1) !== 0, 'and the repeat stays on its original phase');

  // Switching a comparator to periodic after its target was loaded has to take
  // effect: the mode bits are live configuration, not something latched by the
  // load. Getting this wrong leaves the FreeRTOS tick firing exactly once.
  timer.writeUint32(INT_CLR, 1);
  clock.advanceMicros(3000);
  let repeats = 0;
  for (let i = 0; i < 3; i++) {
    if ((timer.readUint32(INT_RAW) & 1) !== 0) repeats++;
    timer.writeUint32(INT_CLR, 1);
    clock.advanceMicros(1000);
  }
  check(repeats === 3, `a periodic comparator keeps firing indefinitely (${repeats} of 3)`);

  // A comparator whose work-enable is off produces nothing.
  timer.writeUint32(INT_CLR, 1);
  timer.writeUint32(CONF, UNIT0_WORK_EN);
  clock.advanceMicros(5000);
  check((timer.readUint32(INT_RAW) & 1) === 0, 'a disabled comparator stays quiet');
  check(timer.pendingInterrupts() === 0, 'and asserts no interrupt line');
}

// ---------- 4. the random number generator ----------
{
  const syscon = new SystemConfiguration();
  const first = syscon.readUint32(0xb0);
  const second = syscon.readUint32(0xb0);
  check(first !== second, 'consecutive reads of the RNG differ');
  check(first !== 0 && second !== 0, 'and neither is zero');

  const values = new Set<number>();
  for (let i = 0; i < 2000; i++) values.add(syscon.readUint32(0xb0));
  check(values.size === 2000, `2000 reads produced 2000 distinct values (${values.size})`);

  // Reproducibility is the point: the same run has to give the same sequence.
  const other = new SystemConfiguration();
  check(other.readUint32(0xb0) === first, 'a fresh block repeats the sequence, so a run is reproducible');

  syscon.reset();
  check(syscon.readUint32(0xb0) === first, 'and a reset returns to the start of it');
}

// ---------- 5. RTC clock calibration ----------
{
  const timg = new TimerGroup('timg0', PERIPHERAL_BASE.timg0);
  const RTCCALICFG = 0x68;
  const START = 1 << 31;
  const RDY = 1 << 15;

  // Measure 100 cycles of the external 32.768 kHz crystal, clock select 1.
  timg.writeUint32(RTCCALICFG, START | (100 << 16) | (1 << 13));
  check((timg.readUint32(RTCCALICFG) & RDY) !== 0, 'a calibration reports itself finished');
  const expected = Math.round((100 * XTAL_HZ) / CALIBRATION_CLOCK_HZ[1]);
  check(
    timg.calibrationValue === expected,
    `100 cycles of a 32.768 kHz clock is ${expected} crystal cycles (${timg.calibrationValue})`,
  );

  // Doubling the requested cycles doubles the answer, so it is derived rather
  // than a constant that happens to satisfy one caller.
  timg.writeUint32(RTCCALICFG, START | (200 << 16) | (1 << 13));
  const doubled = Math.round((200 * XTAL_HZ) / CALIBRATION_CLOCK_HZ[1]);
  check(
    timg.calibrationValue === doubled && Math.abs(doubled - expected * 2) <= 1,
    `twice the cycles measures twice as long (${timg.calibrationValue})`,
  );

  // A different source gives a different answer for the same cycle count.
  timg.writeUint32(RTCCALICFG, START | (100 << 16) | (0 << 13));
  check(
    timg.calibrationValue === Math.round((100 * XTAL_HZ) / CALIBRATION_CLOCK_HZ[0]),
    'and a different clock source measures differently',
  );
}

console.log(failures === 0 ? '\nESP32-C3 peripheral checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
