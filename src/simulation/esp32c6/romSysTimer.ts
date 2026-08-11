// The ESP32-C6's ROM system-timer HAL.
//
// Another family the C6's mask ROM publishes and the C3's does not: there is no
// `esp32c3.rom.systimer.ld`, so the C3 links its own copy and the C3 runtime
// never needed these. On a C6 they matter more than most, because this is where
// FreeRTOS gets its tick and where `esp_timer` gets the time — the whole
// runtime's sense of when things happen runs through them.
//
// Written from the documented HAL interface in `hal/include/hal/systimer_hal.h`
// and the register definitions in
// `soc/esp32c6/register/soc/systimer_reg.h`. No ROM code was read,
// disassembled or copied. Each entry point does what its documentation says by
// driving the real system-timer registers, which are modelled as hardware
// already — so firmware that goes round the HAL and writes those registers
// itself, as ESP-IDF sometimes does, sees exactly the same timer.
//
// The conversion between ticks and microseconds is not done here. The HAL
// context carries two function pointers for it, and they are the firmware's
// own; calling them is what keeps the answer consistent with whatever tick rate
// the firmware believes in, rather than with a rate this file assumed.

import type { RomCallContext, RomFunction, RomHandler } from '../esp32c3/romFunctions';
import { ESP32C6_PERIPHERAL_BASE } from './peripherals';

/**
 * `systimer_hal_context_t`:
 *
 *   struct { systimer_soc_handle_t dev; ticks_to_us_func_t ticks_to_us;
 *            us_to_ticks_func_t us_to_ticks; }
 */
const CONTEXT_DEV = 0x00;
const CONTEXT_TICKS_TO_US = 0x04;
const CONTEXT_US_TO_TICKS = 0x08;

const CONF = 0x00;
const UNIT_OP = [0x04, 0x08] as const;
const UNIT_LOAD_HI = [0x0c, 0x14] as const;
const UNIT_LOAD_LO = [0x10, 0x18] as const;
const TARGET_HI = [0x1c, 0x24, 0x2c] as const;
const TARGET_LO = [0x20, 0x28, 0x30] as const;
const TARGET_CONF = [0x34, 0x38, 0x3c] as const;
const UNIT_VALUE_HI = [0x40, 0x48] as const;
const UNIT_VALUE_LO = [0x44, 0x4c] as const;
const COMP_LOAD = [0x50, 0x54, 0x58] as const;
const UNIT_LOAD = [0x5c, 0x60] as const;
const INT_ENA = 0x64;

const UNIT_UPDATE = 1 << 30;
const UNIT_WORK_EN = [1 << 30, 1 << 29] as const;
const TARGET_WORK_EN = [1 << 24, 1 << 23, 1 << 22] as const;
const TARGET_PERIOD_MASK = 0x03ffffff;
const TARGET_PERIOD_MODE = 1 << 30;
const TARGET_UNIT_SEL = 1 << 31;

/** The counter's high half is 20 bits wide, so the whole counter is 52. */
const HI_MASK = 0xfffff;

/** UNITn_CAN_STALL_BY_CPUn, two bits per unit from bit 28 downwards. */
const UNIT_STALL = [
  [1 << 28, 1 << 27],
  [1 << 26, 1 << 25],
] as const;

/** The peripheral address the HAL context should be carrying. */
const SYSTIMER_BASE = ESP32C6_PERIPHERAL_BASE.systimer;

function devOf(context: RomCallContext): number {
  const dev = context.bus.readUint32((((context.args[0] >>> 0) + CONTEXT_DEV) >>> 0)) >>> 0;
  // A context the firmware has not filled in yet still has to reach the real
  // peripheral rather than address zero.
  return dev === 0 ? SYSTIMER_BASE : dev;
}

const read = (context: RomCallContext, offset: number): number =>
  context.bus.readUint32(((devOf(context) + offset) >>> 0)) >>> 0;

const write = (context: RomCallContext, offset: number, value: number): void =>
  context.bus.writeUint32(((devOf(context) + offset) >>> 0), value >>> 0);

function update(context: RomCallContext, offset: number, set: number, clear: number): void {
  write(context, offset, (read(context, offset) & ~clear) | set);
}

/** Returns a 64-bit value the way the RISC-V ILP32 ABI does: a0 low, a1 high. */
function return64(context: RomCallContext, value: number): number {
  context.registers[11] = Math.floor(value / 0x1_0000_0000) | 0;
  return value >>> 0;
}

/** Latches a counter and reads the snapshot back, which is a real handshake. */
function counterValue(context: RomCallContext, unit: number): number {
  write(context, UNIT_OP[unit], UNIT_UPDATE);
  const hi = read(context, UNIT_VALUE_HI[unit]) & HI_MASK;
  const lo = read(context, UNIT_VALUE_LO[unit]);
  return hi * 0x1_0000_0000 + lo;
}

const getCounterValue: RomHandler = (context) => return64(context, counterValue(context, context.args[1] & 1));

/**
 * `systimer_hal_get_time(hal, counter_id)`.
 *
 * The tick-to-microsecond conversion is the firmware's own function, called
 * through the guest-call mechanism with the counter value it asked about. Doing
 * the arithmetic here instead would mean assuming a tick rate, and the whole
 * reason the context carries the function pointer is that the rate is not this
 * layer's to know.
 */
const getTime: RomHandler = (context) => {
  const ticks = counterValue(context, context.args[1] & 1);
  const convert = context.bus.readUint32((((context.args[0] >>> 0) + CONTEXT_TICKS_TO_US) >>> 0)) >>> 0;
  if (convert === 0) return return64(context, 0);
  const result = context.callGuest(convert, [ticks >>> 0, Math.floor(ticks / 0x1_0000_0000) | 0]);
  context.registers[11] = result.high | 0;
  return result.value;
};

const setTickRateOps: RomHandler = ({ args, bus }) => {
  const hal = args[0] >>> 0;
  const ops = args[1] >>> 0;
  if (ops === 0) return;
  bus.writeUint32((hal + CONTEXT_TICKS_TO_US) >>> 0, bus.readUint32(ops));
  bus.writeUint32((hal + CONTEXT_US_TO_TICKS) >>> 0, bus.readUint32((ops + 4) >>> 0));
};

/**
 * `systimer_hal_set_alarm_target(hal, alarm_id, target)`.
 *
 * A 64-bit argument arrives in a register pair, and on RISC-V ILP32 that pair
 * is aligned — so the target is in a2/a3 rather than a1/a2, with a1 holding the
 * alarm id. Reading it from the wrong pair would arm the comparator at a
 * nonsense time, which is the sort of mistake that looks like a timer bug.
 */
const setAlarmTarget: RomHandler = (context) => {
  const alarm = context.args[1] & 3;
  const low = context.args[2] >>> 0;
  const high = context.args[3] & HI_MASK;
  // One-shot: the comparator compares against a fixed target rather than
  // reloading itself.
  update(context, TARGET_CONF[alarm], 0, TARGET_PERIOD_MODE | TARGET_PERIOD_MASK);
  write(context, TARGET_HI[alarm], high);
  write(context, TARGET_LO[alarm], low);
  // COMP_LOAD is what makes the written target take effect.
  write(context, COMP_LOAD[alarm], 1);
};

const setAlarmPeriod: RomHandler = (context) => {
  const alarm = context.args[1] & 3;
  const period = context.args[2] & TARGET_PERIOD_MASK;
  update(context, TARGET_CONF[alarm], TARGET_PERIOD_MODE | period, TARGET_PERIOD_MASK);
  write(context, COMP_LOAD[alarm], 1);
};

const getAlarmValue: RomHandler = (context) => {
  const alarm = context.args[1] & 3;
  const hi = read(context, TARGET_HI[alarm]) & HI_MASK;
  const lo = read(context, TARGET_LO[alarm]);
  return return64(context, hi * 0x1_0000_0000 + lo);
};

const enableAlarmInterrupt: RomHandler = (context) => {
  const alarm = context.args[1] & 3;
  update(context, INT_ENA, 1 << alarm, 0);
  // An alarm that is not working is not going to interrupt either.
  update(context, CONF, TARGET_WORK_EN[alarm], 0);
};

const selectAlarmMode: RomHandler = (context) => {
  const alarm = context.args[1] & 3;
  // SYSTIMER_ALARM_MODE_ONETIME is 0, SYSTIMER_ALARM_MODE_PERIOD is 1.
  const periodic = (context.args[2] & 1) !== 0;
  update(context, TARGET_CONF[alarm], periodic ? TARGET_PERIOD_MODE : 0, periodic ? 0 : TARGET_PERIOD_MODE);
};

const connectAlarmCounter: RomHandler = (context) => {
  const alarm = context.args[1] & 3;
  const unit = context.args[2] & 1;
  update(context, TARGET_CONF[alarm], unit === 1 ? TARGET_UNIT_SEL : 0, unit === 1 ? 0 : TARGET_UNIT_SEL);
};

const enableCounter: RomHandler = (context) => {
  const unit = context.args[1] & 1;
  update(context, CONF, UNIT_WORK_EN[unit], 0);
};

const counterCanStallByCpu: RomHandler = (context) => {
  const unit = context.args[1] & 1;
  const cpu = context.args[2] & 1;
  const can = (context.args[3] & 1) !== 0;
  const bit = UNIT_STALL[unit][cpu];
  update(context, CONF, can ? bit : 0, can ? 0 : bit);
};

/**
 * `systimer_hal_counter_value_advance(hal, counter_id, time_us)`.
 *
 * Moves a counter forward or back by a number of microseconds, which is how
 * ESP-IDF corrects for time spent asleep. The microseconds are converted to
 * ticks by the firmware's own function, for the same reason `get_time` uses its
 * counterpart.
 */
const counterValueAdvance: RomHandler = (context) => {
  const unit = context.args[1] & 1;
  const microseconds = context.args[2] | 0;
  const convert = context.bus.readUint32((((context.args[0] >>> 0) + CONTEXT_US_TO_TICKS) >>> 0)) >>> 0;
  let delta = 0;
  if (convert !== 0) {
    const result = context.callGuest(convert, [microseconds, microseconds < 0 ? -1 : 0]);
    delta = (result.high | 0) * 0x1_0000_0000 + (result.value >>> 0);
  }
  const target = Math.max(0, counterValue(context, unit) + delta);
  write(context, UNIT_LOAD_HI[unit], Math.floor(target / 0x1_0000_0000) & HI_MASK);
  write(context, UNIT_LOAD_LO[unit], target >>> 0);
  write(context, UNIT_LOAD[unit], 1);
};

/**
 * `systimer_hal_on_apb_freq_update(hal, apb_ticks_per_us)`.
 *
 * Nothing to do on this part. `SOC_SYSTIMER_FIXED_DIVIDER` is set for the C6:
 * its counters run from the crystal through a divider that does not change, so
 * an APB frequency change cannot move the tick rate. Doing something here would
 * be inventing a dependency the hardware does not have.
 */
const onApbFrequencyUpdate: RomHandler = () => {};

/**
 * The system-timer entry points the C6's ROM publishes.
 *
 * Addresses are from `esp32c6.rom.systimer.ld` in the same core the firmware
 * was built with, under the symbol that script gives each one.
 */
export const ESP32C6_ROM_SYSTIMER: RomFunction[] = [
  {
    address: 0x400003c8,
    name: 'systimer_hal_set_tick_rate_ops',
    handler: setTickRateOps,
    rationale: 'Stores the firmware\'s own tick conversion functions in its context, where the rest of the HAL finds them.',
  },
  {
    address: 0x400003cc,
    name: 'systimer_hal_get_counter_value',
    handler: getCounterValue,
    rationale: 'Performs the latch-and-read handshake against the real counter and returns 52 bits in a0/a1.',
  },
  {
    address: 0x400003d0,
    name: 'systimer_hal_get_time',
    handler: getTime,
    rationale: 'Converts through the firmware\'s own function rather than assuming a tick rate.',
  },
  {
    address: 0x400003d4,
    name: 'systimer_hal_set_alarm_target',
    handler: setAlarmTarget,
    rationale: 'Arms a one-shot comparator, taking the 64-bit target from the aligned register pair.',
  },
  {
    address: 0x400003d8,
    name: 'systimer_hal_set_alarm_period',
    handler: setAlarmPeriod,
    rationale: 'Puts a comparator into periodic mode, which is how the FreeRTOS tick repeats.',
  },
  {
    address: 0x400003dc,
    name: 'systimer_hal_get_alarm_value',
    handler: getAlarmValue,
    rationale: 'Reads the armed target back from the registers.',
  },
  {
    address: 0x400003e0,
    name: 'systimer_hal_enable_alarm_int',
    handler: enableAlarmInterrupt,
    rationale: 'Unmasks the comparator and starts it, both of which delivery needs.',
  },
  {
    address: 0x400003e4,
    name: 'systimer_hal_on_apb_freq_update',
    handler: onApbFrequencyUpdate,
    rationale: 'The C6 has a fixed systimer divider, so an APB change cannot move the tick rate.',
  },
  {
    address: 0x400003e8,
    name: 'systimer_hal_counter_value_advance',
    handler: counterValueAdvance,
    rationale: 'Reloads the counter with a real offset, converted by the firmware\'s own function.',
  },
  {
    address: 0x400003ec,
    name: 'systimer_hal_enable_counter',
    handler: enableCounter,
    rationale: 'Sets the counter\'s work-enable bit, without which it does not run.',
  },
  {
    address: 0x400003f0,
    name: 'systimer_hal_select_alarm_mode',
    handler: selectAlarmMode,
    rationale: 'Switches a comparator between one-shot and periodic, which is a live setting.',
  },
  {
    address: 0x400003f4,
    name: 'systimer_hal_connect_alarm_counter',
    handler: connectAlarmCounter,
    rationale: 'Chooses which of the two counters a comparator watches.',
  },
  {
    address: 0x400003f8,
    name: 'systimer_hal_counter_can_stall_by_cpu',
    handler: counterCanStallByCpu,
    rationale: 'Records whether a counter halts with a stalled CPU; firmware reads it back.',
  },
];
