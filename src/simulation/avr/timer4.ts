// The ATmega32U4's Timer/Counter4: the Leonardo's PWM on D13 and D6.
//
// Timer4 is the 32U4's own design — 10-bit, high speed, with its own register
// set — and avr8js has no model of it, so analogWrite() on D13 (OC4A, PC7) and
// D6 (OC4D, PD7) left those pins flat. This models what analogWrite() uses of
// it, from the datasheet's register descriptions:
//
//   * the clock: the system clock over TCCR4B.CS43:0 (1, 2, 4 … 16384);
//   * TOP: OCR4C (reset value 0xFF), and the two waveform modes the Arduino
//     core can select in TCCR4D.WGM41:40 — fast PWM (0) and phase-and-
//     frequency-correct PWM (1, which the core's init sets);
//   * the compare outputs OC4A and OC4D, enabled by PWM4A / PWM4D with
//     COM4x1:0 = 2 (clear on match, the non-inverting output analogWrite
//     selects) or 3 (set on match, inverted);
//   * 10-bit compare values, the high bits latched through TC4H.
//
// The period and each channel's high time follow from those: fast PWM is high
// for OCR + 1 of TOP + 1 counts, phase-correct for OCR of TOP counts at half
// the frequency. Edges are scheduled on the CPU's own clock, so the pin
// toggles at the timer's real rate. Not modelled: OC4B, the complementary
// outputs, dead time, the PLL clock source and Timer4's interrupts — the
// Arduino core uses none of them.

import type { CPU, AVRIOPort } from 'avr8js';

const TCNT4 = 0xbe;
const TC4H = 0xbf;
const TCCR4A = 0xc0;
const TCCR4B = 0xc1;
const TCCR4C = 0xc2;
const TCCR4D = 0xc3;
const OCR4A = 0xcf;
const OCR4C = 0xd1;
const OCR4D = 0xd2;

/** avr8js's PinOverrideMode, which its index does not export. */
const OVERRIDE_NONE = 0;
const OVERRIDE_SET = 2;
const OVERRIDE_CLEAR = 3;

interface Channel {
  /** OCR register, and its port and bit. */
  ocr: number;
  port: AVRIOPort;
  bit: number;
  /** Whether PWM is on for it and how: 2 non-inverting, 3 inverting. */
  mode(): number;
}

export class Timer4 {
  private readonly ocr = new Map<number, number>([[OCR4A, 0], [OCR4C, 0xff], [OCR4D, 0]]);
  private readonly channels: Channel[];
  /** Bumped on every reconfiguration, so events from an older period do nothing. */
  private generation = 0;
  private active = new Set<Channel>();

  constructor(private readonly cpu: CPU, portC: AVRIOPort, portD: AVRIOPort) {
    const reg = (address: number) => cpu.data[address];
    this.channels = [
      // OC4A: PWM4A (TCCR4A bit 1), COM4A1:0 (TCCR4A bits 7:6) on PC7 = D13.
      { ocr: OCR4A, port: portC, bit: 7, mode: () => (reg(TCCR4A) & 0x02 ? (reg(TCCR4A) >> 6) & 0x3 : 0) },
      // OC4D: PWM4D (TCCR4C bit 0), COM4D1:0 (TCCR4C bits 3:2) on PD7 = D6.
      { ocr: OCR4D, port: portD, bit: 7, mode: () => (reg(TCCR4C) & 0x01 ? (reg(TCCR4C) >> 2) & 0x3 : 0) },
    ];
    for (const address of [TCCR4A, TCCR4B, TCCR4C, TCCR4D]) {
      cpu.writeHooks[address] = (value) => {
        cpu.data[address] = value;
        this.reconfigure();
        return true;
      };
    }
    for (const address of [OCR4A, OCR4C, OCR4D]) {
      cpu.writeHooks[address] = (value) => {
        // A 10-bit value: the low byte written here, the high bits from TC4H.
        this.ocr.set(address, ((cpu.data[TC4H] & 0x3) << 8) | (value & 0xff));
        cpu.data[address] = value;
        this.reconfigure();
        return true;
      };
    }
    cpu.writeHooks[TCNT4] = (value) => {
      cpu.data[TCNT4] = value;
      return true;
    };
  }

  private get prescale(): number {
    const cs = this.cpu.data[TCCR4B] & 0x0f;
    return cs === 0 ? 0 : 2 ** (cs - 1);
  }

  private get phaseCorrect(): boolean {
    return (this.cpu.data[TCCR4D] & 0x03) === 0x01;
  }

  private reconfigure(): void {
    this.generation++;
    const before = this.active;
    this.active = new Set(this.channels.filter((c) => c.mode() >= 2));
    for (const c of before) if (!this.active.has(c)) c.port.timerOverridePin(c.bit, OVERRIDE_NONE);
    if (this.active.size === 0 || this.prescale === 0) {
      for (const c of this.active) c.port.timerOverridePin(c.bit, OVERRIDE_NONE);
      return;
    }
    this.period(this.generation);
  }

  /** One PWM period: every active channel goes to its on level, and back at its compare time. */
  private period(generation: number): void {
    if (generation !== this.generation) return;
    const top = this.ocr.get(OCR4C)!;
    const phase = this.phaseCorrect;
    const counts = phase ? 2 * top : top + 1;
    const periodCycles = Math.max(1, counts * this.prescale);
    for (const c of this.active) {
      const ocr = this.ocr.get(c.ocr)!;
      // High time in counts, as a fraction of the period, for the non-inverted output.
      const highFraction = phase ? Math.min(1, ocr / Math.max(1, top)) : Math.min(1, (ocr + 1) / (top + 1));
      const inverted = c.mode() === 3;
      const on = inverted ? OVERRIDE_CLEAR : OVERRIDE_SET;
      const off = inverted ? OVERRIDE_SET : OVERRIDE_CLEAR;
      if (highFraction <= 0) {
        c.port.timerOverridePin(c.bit, off);
        continue;
      }
      c.port.timerOverridePin(c.bit, on);
      if (highFraction < 1) {
        this.cpu.addClockEvent(() => {
          if (generation === this.generation) c.port.timerOverridePin(c.bit, off);
        }, Math.max(1, Math.round(periodCycles * highFraction)));
      }
    }
    this.cpu.addClockEvent(() => this.period(generation), periodCycles);
  }
}
