// The ESP8266's two FRC timers, at 0x60000600 (esp8266_peri.h):
//
//   FRC1: T1L 0x00 load, T1V 0x04 count, T1C 0x08 control, T1I 0x0C clear.
//   A 23-bit down-counter: writing the load value starts it, reaching zero
//   raises CPU interrupt 9 and, with auto-reload (T1C bit 6), starts it again.
//   This is the timer the Arduino core's waveform generator — analogWrite,
//   tone, Servo — schedules every edge with, through the NMI (see nmiRouted).
//
//   FRC2: T2L 0x20 load, T2V 0x24 count, T2C 0x28 control, T2I 0x2C clear,
//   T2A 0x30 alarm. A free-running 32-bit up-counter that raises CPU
//   interrupt 10 when it passes the alarm; the SDK's software timers
//   (os_timer, and so delay()) run on it.
//
// Both count the 80 MHz APB clock through the prescaler in control bits 3:2
// (divide by 1, 16 or 256) and run while control bit 7 is set. The interrupt
// is an edge: it stays pending until the dispatcher takes it or firmware
// writes the clear register.

import type { InterruptingPeripheral, Peripheral, SimulatedClock } from '../espRiscv/peripheral';

const APB_HZ = 80e6;
const DIVIDERS = [1, 16, 256, 256];
export const FRC1_INUM = 9;
export const FRC2_INUM = 10;

export class Esp8266Timers implements Peripheral, InterruptingPeripheral {
  readonly name = 'frc';
  readonly base = 0x60000600;
  readonly size = 0x40;
  // FRC1
  private t1Load = 0;
  private t1Ctrl = 0;
  /** When the current count started from `t1Start`, and from what. */
  private t1At = 0;
  private t1Start = 0;
  private t1Running = false;
  private t1Pending = false;
  // FRC2
  private t2Ctrl = 0;
  private t2Alarm = 0;
  private t2At = 0;
  private t2Base = 0;
  private t2Pending = false;
  /** The count the last alarm check reached, so an alarm fires once. */
  private t2Checked = 0;

  /**
   * Set when DPORT routes FRC1 to the NMI instead (the Arduino core's
   * waveform generator does): each expiry is then an NMI edge.
   */
  nmiRouted: () => boolean = () => false;
  onNmiEdge: (() => void) | null = null;

  constructor(private readonly clock: SimulatedClock) {}

  reset(): void {
    this.t1Load = this.t1Ctrl = this.t1At = this.t1Start = 0;
    this.t1Running = this.t1Pending = false;
    this.t2Ctrl = this.t2Alarm = this.t2At = this.t2Base = this.t2Checked = 0;
    this.t2Pending = false;
  }

  private tickNs(ctrl: number): number {
    return (1e9 * DIVIDERS[(ctrl >>> 2) & 3]) / APB_HZ;
  }

  // ------------------------------------------------------------- FRC1

  private t1Expiry(): number | undefined {
    if (!this.t1Running || !(this.t1Ctrl & 0x80)) return undefined;
    return this.t1At + this.t1Start * this.tickNs(this.t1Ctrl);
  }

  private t1Advance(now: number): void {
    for (let guard = 0; guard < 1_000_000; guard++) {
      const at = this.t1Expiry();
      if (at === undefined || at > now) return;
      if (this.nmiRouted()) this.onNmiEdge?.();
      else this.t1Pending = true;
      if (this.t1Ctrl & 0x40 && this.t1Load > 0) {
        this.t1At = at;
        this.t1Start = this.t1Load;
      } else {
        this.t1Running = false;
        return;
      }
    }
  }

  private t1Count(now: number): number {
    if (!this.t1Running || !(this.t1Ctrl & 0x80)) return 0;
    const elapsed = Math.floor((now - this.t1At) / this.tickNs(this.t1Ctrl) + 1e-9);
    return Math.max(0, this.t1Start - elapsed) & 0x7fffff;
  }

  // ------------------------------------------------------------- FRC2

  private t2Count(now: number): number {
    if (!(this.t2Ctrl & 0x80)) return this.t2Base >>> 0;
    const elapsed = Math.floor((now - this.t2At) / this.tickNs(this.t2Ctrl) + 1e-9);
    return (this.t2Base + elapsed) % 2 ** 32;
  }

  /** Moves FRC2's anchor to now, keeping its count. */
  private t2Rebase(now: number): void {
    this.t2Base = this.t2Count(now);
    this.t2At = now;
    this.t2Checked = this.t2Base;
  }

  private t2AlarmAt(now: number): number | undefined {
    if (!(this.t2Ctrl & 0x80)) return undefined;
    const count = this.t2Count(now);
    const ahead = (this.t2Alarm - count) >>> 0;
    const tick = this.tickNs(this.t2Ctrl);
    const anchor = this.t2At + Math.floor((now - this.t2At) / tick + 1e-9) * tick;
    return anchor + (ahead === 0 ? 2 ** 32 : ahead) * tick;
  }

  private t2Advance(now: number): void {
    if (!(this.t2Ctrl & 0x80)) return;
    const count = this.t2Count(now);
    // Did the count pass the alarm since the last look?
    const since = (count - this.t2Checked) >>> 0;
    const toAlarm = (this.t2Alarm - this.t2Checked) >>> 0;
    if (toAlarm !== 0 && toAlarm <= since) this.t2Pending = true;
    this.t2Checked = count;
  }

  // ------------------------------------------------------------- registers

  readUint32(offset: number): number {
    const now = this.clock.nanos;
    switch (offset) {
      case 0x00: return this.t1Load;
      case 0x04: this.t1Advance(now); return this.t1Count(now);
      case 0x08: return this.t1Ctrl | (this.t1Pending ? 1 << 8 : 0);
      case 0x0c: return this.t1Pending ? 1 : 0;
      case 0x20: return 0;
      case 0x24: return this.t2Count(now);
      case 0x28: return this.t2Ctrl | (this.t2Pending ? 1 << 8 : 0);
      case 0x2c: return this.t2Pending ? 1 : 0;
      case 0x30: return this.t2Alarm;
    }
    return 0;
  }

  writeUint32(offset: number, value: number): void {
    const now = this.clock.nanos;
    value >>>= 0;
    switch (offset) {
      case 0x00:
        this.t1Advance(now);
        this.t1Load = value & 0x7fffff;
        this.t1Start = this.t1Load;
        this.t1At = now;
        this.t1Running = this.t1Load > 0;
        break;
      case 0x08:
        this.t1Advance(now);
        if (!(this.t1Ctrl & 0x80) && value & 0x80) this.t1At = now;
        this.t1Ctrl = value & 0xff;
        break;
      case 0x0c:
        this.t1Pending = false;
        break;
      case 0x20:
        this.t2Base = value;
        this.t2At = now;
        this.t2Checked = value;
        break;
      case 0x28:
        this.t2Advance(now);
        this.t2Rebase(now);
        this.t2Ctrl = value & 0xff;
        break;
      case 0x2c:
        this.t2Pending = false;
        break;
      case 0x30:
        this.t2Advance(now);
        this.t2Alarm = value;
        break;
    }
  }

  /** The dispatcher has taken an edge interrupt. */
  acknowledge(inum: number): void {
    if (inum === FRC1_INUM) this.t1Pending = false;
    if (inum === FRC2_INUM) this.t2Pending = false;
  }

  assertedInterruptSources(): number[] {
    const now = this.clock.nanos;
    this.t1Advance(now);
    this.t2Advance(now);
    const out: number[] = [];
    if (this.t1Pending) out.push(FRC1_INUM);
    if (this.t2Pending) out.push(FRC2_INUM);
    return out;
  }

  nextInterruptChangeNanos(): number | undefined {
    const now = this.clock.nanos;
    const a = this.t1Pending ? undefined : this.t1Expiry();
    const b = this.t2Pending ? undefined : this.t2AlarmAt(now);
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(a, b);
  }
}
