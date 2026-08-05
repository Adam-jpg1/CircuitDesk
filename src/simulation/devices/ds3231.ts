// DS3231 real-time clock with temperature-compensated oscillator.
//
// Time is BCD-encoded in registers 0x00-0x06 exactly as the datasheet lays it
// out, and it genuinely advances: the clock is driven by the emulator's own
// microsecond counter, so a sketch that reads the seconds register twice a
// second apart sees it increment. Setting the registers sets the clock.
//
// The hours register carries the 12/24-hour flag in bit 6, with bit 5 doubling
// as either the 20-hour tens bit or the AM/PM flag depending on that mode —
// firmware that ignores the distinction misreads the time here too.
//
// NOT modelled: the alarms fire no interrupt (their registers are stored and
// read back, but INT/SQW is never driven), the 32 kHz output, the aging offset
// trim, and the oscillator-stop flag never sets because there is no battery
// domain to lose. Register 0x11/0x12 report the die temperature from the
// device's own simulated value.
//
// Note the address: the DS3231 lives at 0x68, which is also the MPU-6050's
// default. Putting both on one bus without moving the IMU's AD0 strap is a
// real collision, and the bus reports it as contention rather than hiding it.

import type { DeviceSnapshot } from './types';
import { RegisterI2cDevice } from './registerDevice';

/** The DS3231 address is fixed in silicon — there are no strap pins. */
export const DS3231_ADDRESS = 0x68;

const REG_SECONDS = 0x00;
const REG_CONTROL = 0x0e;
const REG_STATUS = 0x0f;
const REG_AGING = 0x10;
const REG_TEMP_MSB = 0x11;

function toBcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | value % 10;
}

function fromBcd(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}

export interface Ds3231Time {
  second: number;
  minute: number;
  hour: number;
  /** 1 = Sunday, as the datasheet numbers it. */
  weekday: number;
  date: number;
  month: number;
  /** Full year; the register only stores the last two digits plus a century bit. */
  year: number;
}

export class Ds3231Device extends RegisterI2cDevice {
  /** Simulated die temperature in °C, reported through registers 0x11/0x12. */
  temperatureC = 25;

  /** Wall-clock time at the moment the emulator's clock read `baseUs`. */
  private baseTime: Ds3231Time = { second: 0, minute: 0, hour: 12, weekday: 1, date: 1, month: 1, year: 2026 };
  private baseUs = 0;
  private nowUs: () => number;

  private hour12Mode = false;
  private control = 0x1c; // datasheet power-on value: oscillator on, SQW off
  private status = 0x00;
  private aging = 0x00;
  private alarms = new Uint8Array(0x0e - 0x07);

  constructor(instanceId: string, address: number = DS3231_ADDRESS, nowUs: () => number = () => 0) {
    super(instanceId, address);
    this.nowUs = nowUs;
    this.baseUs = nowUs();
  }

  /** Seconds of simulated time elapsed since the clock was last set. */
  private elapsedSeconds(): number {
    return Math.floor((this.nowUs() - this.baseUs) / 1_000_000);
  }

  /** The current time, base plus however long the emulator has been running. */
  get time(): Ds3231Time {
    const t = { ...this.baseTime };
    let carry = this.elapsedSeconds();
    if (carry <= 0) return t;

    t.second += carry;
    const minutes = Math.floor(t.second / 60);
    t.second %= 60;
    t.minute += minutes;
    const hours = Math.floor(t.minute / 60);
    t.minute %= 60;
    t.hour += hours;
    const days = Math.floor(t.hour / 24);
    t.hour %= 24;
    if (days > 0) {
      t.weekday = ((t.weekday - 1 + days) % 7) + 1;
      // Real calendar rollover, leap years included.
      const d = new Date(Date.UTC(t.year, t.month - 1, t.date));
      d.setUTCDate(d.getUTCDate() + days);
      t.year = d.getUTCFullYear();
      t.month = d.getUTCMonth() + 1;
      t.date = d.getUTCDate();
    }
    return t;
  }

  /** Re-bases the clock so `time` reads this value from now on. */
  setTime(next: Partial<Ds3231Time>): void {
    this.baseTime = { ...this.time, ...next };
    this.baseUs = this.nowUs();
  }

  get is12HourMode(): boolean {
    return this.hour12Mode;
  }

  protected readRegister(reg: number): number | null {
    const t = this.time;
    switch (reg) {
      case 0x00:
        return toBcd(t.second);
      case 0x01:
        return toBcd(t.minute);
      case 0x02: {
        if (!this.hour12Mode) return toBcd(t.hour);
        // 12-hour mode: bit 6 set, bit 5 is PM, hours run 1-12.
        const pm = t.hour >= 12;
        const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
        return 0x40 | (pm ? 0x20 : 0) | toBcd(h12);
      }
      case 0x03:
        return toBcd(t.weekday);
      case 0x04:
        return toBcd(t.date);
      case 0x05:
        // Bit 7 is the century flag; years past 2099 are out of range anyway.
        return toBcd(t.month) | (t.year >= 2100 ? 0x80 : 0);
      case 0x06:
        return toBcd(t.year % 100);
      case REG_CONTROL:
        return this.control;
      case REG_STATUS:
        return this.status;
      case REG_AGING:
        return this.aging;
      case REG_TEMP_MSB:
        return Math.floor(this.temperatureC) & 0xff;
      case REG_TEMP_MSB + 1:
        // Fractional part in the top two bits, 0.25 °C per step.
        return (Math.round((this.temperatureC - Math.floor(this.temperatureC)) * 4) & 0x03) << 6;
      default:
        if (reg >= 0x07 && reg < 0x0e) return this.alarms[reg - 0x07];
        return null;
    }
  }

  protected writeRegister(reg: number, value: number): boolean {
    const t = this.time;
    switch (reg) {
      case 0x00:
        this.setTime({ second: fromBcd(value & 0x7f) });
        return true;
      case 0x01:
        this.setTime({ minute: fromBcd(value & 0x7f) });
        return true;
      case 0x02: {
        this.hour12Mode = (value & 0x40) !== 0;
        let hour: number;
        if (this.hour12Mode) {
          const h12 = fromBcd(value & 0x1f);
          hour = (h12 % 12) + (value & 0x20 ? 12 : 0);
        } else {
          hour = fromBcd(value & 0x3f);
        }
        this.setTime({ hour });
        return true;
      }
      case 0x03:
        this.setTime({ weekday: fromBcd(value & 0x07) });
        return true;
      case 0x04:
        this.setTime({ date: fromBcd(value & 0x3f) });
        return true;
      case 0x05:
        this.setTime({ month: fromBcd(value & 0x1f) });
        return true;
      case 0x06:
        this.setTime({ year: 2000 + fromBcd(value) + (t.year >= 2100 ? 100 : 0) });
        return true;
      case REG_CONTROL:
        this.control = value;
        return true;
      case REG_STATUS:
        // Only the flag bits are writable, and only to clear them.
        this.status &= value & 0x8f;
        return true;
      case REG_AGING:
        this.aging = value;
        return true;
      default:
        if (reg >= 0x07 && reg < 0x0e) {
          this.alarms[reg - 0x07] = value;
          return true;
        }
        return false;
    }
  }

  reset(): void {
    this.baseTime = { second: 0, minute: 0, hour: 12, weekday: 1, date: 1, month: 1, year: 2026 };
    this.baseUs = this.nowUs();
    this.hour12Mode = false;
    this.control = 0x1c;
    this.status = 0x00;
    this.aging = 0x00;
    this.alarms.fill(0);
    this.pointer = 0;
    this.unknownReads = [];
    this.unknownWrites = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    const t = this.time;
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      status:
        `DS3231 @0x${this.address.toString(16)} — ` +
        `${t.year}-${pad(t.month)}-${pad(t.date)} ${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}` +
        `${this.hour12Mode ? ' (12h mode)' : ''}, ${this.temperatureC.toFixed(2)} °C`,
      log: [...this.log],
    };
  }
}
