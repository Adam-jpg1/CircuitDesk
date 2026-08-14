// DS1307 — the RTC that keeps time from the simulation's clock.
//
// Two things decide whether an RTC model is worth anything.
//
// The first is where the time comes from. It comes from SimulationWorld's
// elapsed time, never from the host — so a test that sets the clock and steps
// three hours sees three hours, and produces the same answer on any machine at
// any time of day. An RTC that read `Date.now()` would make every test that
// touched it non-deterministic and would break the moment someone ran it at
// midnight.
//
// The second is BCD. Every register on this part is packed decimal, so 0x59 is
// fifty-nine and not eighty-nine, and a sketch that forgets to convert reads
// nonsense. That is the single most common DS1307 bug, and a model that stored
// plain binary would hide it completely.
//
// The clock-halt bit is modelled because it is the reason a fresh DS1307 does
// nothing until firmware clears it: bit 7 of the seconds register comes up set,
// and the oscillator does not run until it is written low.
//
// NOT modelled: the square-wave output pin, battery backup as distinct from
// main supply, oscillator trim, or the 56 bytes of user NVRAM's persistence
// across a project reload (the RAM is real and lives as long as the device).

import type { DeviceSnapshot, I2cDevice } from './types';

export const DS1307_ADDRESS = 0x68;

/** Decimal to packed BCD, which is what every register on this part holds. */
export function toBcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

/** Packed BCD back to decimal. */
export function fromBcd(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}

export class Ds1307Device implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;
  private readonly nowMs: () => number;

  /** Seconds since the epoch this device was set to. */
  private baseSeconds = 0;
  /** Simulation time at which `baseSeconds` was true. */
  private baseAtMs = 0;
  /** Bit 7 of register 0: the oscillator is stopped until firmware clears it. */
  private halted = true;

  /** Registers 0x08-0x3F: 56 bytes of battery-backed user RAM. */
  private nvram = new Uint8Array(56);
  private control = 0x00;

  private pointer = 0;
  private pointerSet = false;
  private reading = false;
  private log: string[] = [];

  constructor(instanceId: string, address: number = DS1307_ADDRESS, nowMs: () => number = () => 0) {
    this.instanceId = instanceId;
    this.address = address;
    this.nowMs = nowMs;
    this.baseAtMs = nowMs();
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  /** Seconds of simulated time elapsed while the oscillator has been running. */
  private currentSeconds(): number {
    if (this.halted) return this.baseSeconds;
    return this.baseSeconds + Math.floor((this.nowMs() - this.baseAtMs) / 1000);
  }

  /** The current time, broken out. Sunday is day 1, per the datasheet. */
  private fields(): { s: number; m: number; h: number; day: number; date: number; month: number; year: number } {
    const total = this.currentSeconds();
    const d = new Date(total * 1000);
    return {
      s: d.getUTCSeconds(),
      m: d.getUTCMinutes(),
      h: d.getUTCHours(),
      day: d.getUTCDay() + 1,
      date: d.getUTCDate(),
      month: d.getUTCMonth() + 1,
      // The DS1307's year register is two digits; the century is the sketch's
      // problem, as it is on the real part.
      year: d.getUTCFullYear() % 100,
    };
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    if (write) this.pointerSet = false;
  }

  stop(): void {
    this.pointerSet = false;
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    if (!this.pointerSet) {
      this.pointer = value & 0x3f;
      this.pointerSet = true;
      return true;
    }
    this.writeRegister(this.pointer, value & 0xff);
    this.pointer = (this.pointer + 1) & 0x3f;
    return true;
  }

  readByte(): number {
    const value = this.readRegister(this.pointer);
    this.pointer = (this.pointer + 1) & 0x3f;
    return value;
  }

  private writeRegister(reg: number, value: number): void {
    if (reg >= 0x08) {
      this.nvram[reg - 0x08] = value;
      return;
    }
    if (reg === 0x07) {
      this.control = value;
      return;
    }
    // Setting any time register re-bases the clock from the whole set of
    // registers, so a library writing seven bytes in a row lands on one time
    // rather than seven partial ones.
    const f = this.fields();
    const next = { ...f };
    switch (reg) {
      case 0x00:
        next.s = fromBcd(value & 0x7f);
        this.halted = (value & 0x80) !== 0;
        this.note(this.halted ? 'oscillator halted' : 'oscillator running');
        break;
      case 0x01: next.m = fromBcd(value & 0x7f); break;
      case 0x02:
        // 12-hour mode is accepted and converted; libraries overwhelmingly use
        // 24-hour, but a sketch that sets bit 6 should not silently lose twelve
        // hours.
        if ((value & 0x40) !== 0) {
          const pm = (value & 0x20) !== 0;
          const h12 = fromBcd(value & 0x1f) % 12;
          next.h = pm ? h12 + 12 : h12;
        } else {
          next.h = fromBcd(value & 0x3f);
        }
        break;
      case 0x03: next.day = fromBcd(value & 0x07); break;
      case 0x04: next.date = fromBcd(value & 0x3f); break;
      case 0x05: next.month = fromBcd(value & 0x1f); break;
      case 0x06: next.year = fromBcd(value); break;
      default: break;
    }
    this.rebase(next);
  }

  private rebase(f: { s: number; m: number; h: number; date: number; month: number; year: number }): void {
    // Two-digit years are 2000-2099, which is what the part is used for.
    const ms = Date.UTC(2000 + f.year, f.month - 1, f.date, f.h, f.m, f.s);
    this.baseSeconds = Math.floor(ms / 1000);
    this.baseAtMs = this.nowMs();
  }

  private readRegister(reg: number): number {
    if (reg >= 0x08) return this.nvram[reg - 0x08];
    if (reg === 0x07) return this.control;
    const f = this.fields();
    switch (reg) {
      case 0x00: return (this.halted ? 0x80 : 0x00) | toBcd(f.s);
      case 0x01: return toBcd(f.m);
      case 0x02: return toBcd(f.h);
      case 0x03: return toBcd(f.day);
      case 0x04: return toBcd(f.date);
      case 0x05: return toBcd(f.month);
      case 0x06: return toBcd(f.year);
      default: return 0;
    }
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  /** The time as an ISO string, for tests and the inspector. */
  get isoTime(): string {
    return new Date(this.currentSeconds() * 1000).toISOString().replace('.000Z', 'Z');
  }
  get isHalted(): boolean {
    return this.halted;
  }
  get userRam(): Uint8Array {
    return this.nvram;
  }

  reset(): void {
    // A power cycle does not clear an RTC — that is the entire point of one, and
    // of its backup cell. Time and NVRAM survive; only the bus state resets.
    this.pointer = 0;
    this.pointerSet = false;
    this.reading = false;
  }

  snapshot(): DeviceSnapshot {
    return {
      status: `DS1307 @0x${this.address.toString(16)} — ${this.halted ? 'halted' : 'running'}, ${this.isoTime}`,
      log: [...this.log],
    };
  }
}
