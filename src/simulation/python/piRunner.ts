// The Raspberry Pi header runner: a Python GPIO script on simulated time.
//
// This is not a Linux emulator. A Pi's GPIO script is ordinary Python driving
// pins through RPi.GPIO or gpiozero, so that is what runs: the interpreter in
// interpreter.ts executes main.py, its threads (the script, its callbacks,
// gpiozero's background blinking) take turns on the simulated clock, and the
// header's 28 GPIO pins are what the canvas sees. print() goes to the Serial
// Monitor and input() reads from it.

import type { BoardRunner, PinLevel, PinSnapshot } from '../boardRunner';
import { Interpreter } from './interpreter';
import { makeGpiozero, makeRpiGpio, type PiGpioHost } from './piGpio';
import { PyError, type Run, type Wait } from './values';
import { PySyntaxError } from './lexer';

export const PI_GPIO_COUNT = 28;

interface Pin {
  mode: 'unset' | 'in' | 'out';
  out: boolean;
  pull: 'up' | 'down' | 'off';
  ext: boolean | null;
  /** The level as last reported, to detect edges. */
  level: boolean;
  pwm: { freq: number; duty: number; cancel: (() => void) | null } | null;
  listeners: Set<(high: boolean) => void>;
  // Duty measurement for the canvas.
  highSince: number;
  highMs: number;
  windowStart: number;
  toggles: number;
}

interface Thread {
  name: string;
  gen: Run<unknown>;
  wakeAt: number;
  ready?: () => boolean;
  deadline?: number;
  resume?: unknown;
  done: boolean;
}

interface TimedEvent {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

export class PiRunner implements BoardRunner {
  readonly engine = 'python' as const;
  onPinChange: ((pin: number, high: boolean) => void) | null = null;
  onSerialByte: ((byte: number) => void) | null = null;
  onUsbSerialByte: ((byte: number) => void) | null = null;

  private now = 0;
  private readonly pins: Pin[] = Array.from({ length: PI_GPIO_COUNT }, () => ({
    mode: 'unset', out: false, pull: 'off', ext: null, level: false, pwm: null, listeners: new Set(),
    highSince: 0, highMs: 0, windowStart: 0, toggles: 0,
  }));
  private readonly listeners = new Set<(pin: number, high: boolean) => void>();
  private threads: Thread[] = [];
  private events: TimedEvent[] = [];
  private readonly stdin: string[] = [];
  private stdinPartial = '';
  private readonly py: Interpreter;
  private finished = false;

  constructor(source: string) {
    const host: PiGpioHost = {
      setup: (pin, dir, pull, initial) => {
        const p = this.pins[pin];
        p.mode = dir;
        p.pull = dir === 'in' ? pull : 'off';
        if (dir === 'out' && initial !== undefined) p.out = initial;
        this.refresh(pin);
      },
      release: (pin) => {
        const p = this.pins[pin];
        this.stopPwm(pin);
        p.mode = 'in';
        p.pull = 'off';
        this.refresh(pin);
      },
      mode: (pin) => this.pins[pin].mode,
      write: (pin, high) => {
        this.stopPwm(pin);
        this.pins[pin].out = high;
        this.refresh(pin);
      },
      read: (pin) => this.level(pin),
      pwm: (pin, freq, duty) => this.setPwm(pin, freq, duty),
      onEdge: (pin, fn) => {
        this.pins[pin].listeners.add(fn);
        return () => this.pins[pin].listeners.delete(fn);
      },
      spawn: (name, body) => {
        const t = this.spawn(name, body());
        return { stop: () => (t.done = true) };
      },
      nowMs: () => this.now,
    };
    this.py = new Interpreter({
      write: (text) => this.write(text),
      readLine: () => this.stdin.shift(),
      module: (name, py) => {
        if (name === 'RPi.GPIO') return makeRpiGpio(py, host);
        if (name === 'gpiozero') return makeGpiozero(py, host);
        return undefined;
      },
      nowMs: () => this.now,
    });
    this.spawn('main', this.main(source));
  }

  private *main(source: string): Run<void> {
    try {
      yield* this.py.runModule(source);
    } finally {
      // The script is over: like the process exiting, every other thread stops.
      for (const t of this.threads) t.done = true;
      this.finished = true;
    }
  }

  get timeMs(): number {
    return this.now;
  }

  /** True once the script has finished or failed. */
  get exited(): boolean {
    return this.finished;
  }

  private write(text: string): void {
    for (const b of new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'))) this.onUsbSerialByte?.(b);
  }

  // ------------------------------------------------------------- threads

  private spawn(name: string, gen: Run<unknown>): Thread {
    const t: Thread = { name, gen, wakeAt: this.now, done: false };
    this.threads.push(t);
    return t;
  }

  /** Runs one thread until it waits; false when it has finished. */
  private step(t: Thread): void {
    let r: IteratorResult<Wait, unknown>;
    try {
      r = t.gen.next(t.resume);
    } catch (e) {
      t.done = true;
      this.report(t, e);
      return;
    }
    t.resume = undefined;
    if (r.done) {
      t.done = true;
      return;
    }
    const w = r.value;
    if (w.k === 'tick') t.wakeAt = this.now + w.us / 1000;
    else if (w.k === 'sleep') t.wakeAt = this.now + w.ms;
    else if (w.ready()) {
      t.resume = true;
      t.wakeAt = this.now;
    } else {
      t.ready = w.ready;
      t.deadline = w.timeoutMs === undefined ? Infinity : this.now + w.timeoutMs;
      t.wakeAt = Infinity;
    }
  }

  private report(t: Thread, e: unknown): void {
    if (e instanceof PyError) {
      if (e.exc.cls.name === 'SystemExit') {
        const msg = String(e.exc.dict.get('__msg__') ?? '');
        if (msg && msg !== '0') this.write(msg + '\n');
        return;
      }
      const where = t.name === 'main' ? '<module>' : t.name;
      this.write(`Traceback (most recent call last):\n  File "main.py", line ${e.line ?? this.py.line}, in ${where}\n${this.py.describe(e)}\n`);
      return;
    }
    if (e instanceof PySyntaxError) {
      this.write(`  File "main.py", line ${e.line}\nSyntaxError: ${e.message}\n`);
      return;
    }
    this.write(`Internal error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  runFor(simMs: number): void {
    const end = this.now + simMs;
    let guard = 0;
    while (guard++ < 2_000_000) {
      this.threads = this.threads.filter((t) => !t.done);
      // Threads waiting on a condition wake when it holds or their time runs out.
      for (const t of this.threads) {
        if (!t.ready) continue;
        if (t.ready()) {
          t.ready = undefined;
          t.resume = true;
          t.wakeAt = this.now;
        } else if (t.deadline !== undefined && t.deadline <= this.now) {
          t.ready = undefined;
          t.resume = false;
          t.wakeAt = this.now;
        }
      }
      let next = Infinity;
      for (const t of this.threads) next = Math.min(next, t.ready ? t.deadline ?? Infinity : t.wakeAt);
      const ev = this.events.length ? this.events[0].at : Infinity;
      const at = Math.min(next, ev);
      if (at > end) break;
      this.now = Math.max(this.now, at);
      if (ev <= this.now) {
        const e = this.events.shift()!;
        if (!e.cancelled) e.fn();
        continue;
      }
      const runnable = this.threads.find((t) => !t.ready && t.wakeAt <= this.now);
      if (runnable) this.step(runnable);
    }
    this.now = Math.max(this.now, end);
  }

  private schedule(delayMs: number, fn: () => void): () => void {
    const e: TimedEvent = { at: this.now + delayMs, fn, cancelled: false };
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].at > e.at) i--;
    this.events.splice(i, 0, e);
    return () => (e.cancelled = true);
  }

  addMicrosecondEvent(us: number, callback: () => void): () => void {
    return this.schedule(us / 1000, callback);
  }

  nextEventMs(): number | undefined {
    let next = this.events.length ? this.events[0].at : Infinity;
    for (const t of this.threads) if (!t.done) next = Math.min(next, t.ready ? t.deadline ?? Infinity : t.wakeAt);
    return next === Infinity ? undefined : Math.max(0, next - this.now);
  }

  // ---------------------------------------------------------------- pins

  /** What the pin reads: its own output, or what drives it from outside, or its pull. */
  private level(pin: number): boolean {
    const p = this.pins[pin];
    if (p.mode === 'out') return p.pwm ? p.level : p.out;
    if (p.ext !== null) return p.ext;
    return p.pull === 'up';
  }

  private refresh(pin: number): void {
    const p = this.pins[pin];
    const high = p.mode === 'out' && p.pwm ? p.level : this.level(pin);
    if (high === p.level && !(p.mode === 'out' && p.pwm)) return;
    if (high === p.level) return;
    this.edge(pin, high);
  }

  private edge(pin: number, high: boolean): void {
    const p = this.pins[pin];
    if (p.level) p.highMs += this.now - p.highSince;
    p.level = high;
    p.highSince = this.now;
    p.toggles++;
    for (const l of [...p.listeners]) l(high);
    if (p.mode === 'out') {
      for (const l of this.listeners) l(pin, high);
      this.onPinChange?.(pin, high);
    }
  }

  private stopPwm(pin: number): void {
    const p = this.pins[pin];
    p.pwm?.cancel?.();
    p.pwm = null;
  }

  private setPwm(pin: number, freq: number, duty: number | null): void {
    this.stopPwm(pin);
    const p = this.pins[pin];
    if (duty === null || freq <= 0) {
      this.refresh(pin);
      return;
    }
    const d = Math.max(0, Math.min(1, duty));
    const period = 1000 / freq;
    const state = { freq, duty: d, cancel: null as (() => void) | null };
    p.pwm = state;
    if (d <= 0 || d >= 1) {
      p.out = d >= 1;
      p.pwm = null;
      this.refresh(pin);
      return;
    }
    const cycle = (high: boolean) => {
      if (p.pwm !== state) return;
      this.edge(pin, high);
      state.cancel = this.schedule(high ? period * d : period * (1 - d), () => cycle(!high));
    };
    cycle(true);
  }

  digitalPinLevel(pin: number): PinLevel | undefined {
    const p = this.pins[pin];
    if (!p) return undefined;
    if (p.mode === 'out') return p.level ? 'high' : 'low';
    // An input stays an input whatever is driving it: the circuit keeps
    // feeding pins it sees reported this way.
    return p.pull === 'up' ? 'input-pullup' : 'input';
  }

  isOutput(pin: number): boolean {
    return this.pins[pin]?.mode === 'out';
  }

  setDigitalInput(pin: number, value: boolean | null): void {
    const p = this.pins[pin];
    if (!p) return;
    p.ext = value;
    if (p.mode !== 'out') this.refresh(pin);
  }

  addPinListener(listener: (pin: number, high: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  adcChannelForPin(): number | undefined {
    return undefined;
  }

  setAnalogVolts(): void {}

  queueSerialInput(text: string): void {
    this.stdinPartial += text;
    let nl = this.stdinPartial.search(/\r?\n/);
    while (nl >= 0) {
      this.stdin.push(this.stdinPartial.slice(0, nl));
      this.stdinPartial = this.stdinPartial.slice(this.stdinPartial[nl] === '\r' ? nl + 2 : nl + 1);
      nl = this.stdinPartial.search(/\r?\n/);
    }
  }

  snapshot(): PinSnapshot {
    const states: PinLevel[] = [];
    const duty: number[] = [];
    const pulse: number[] = [];
    const toggles: number[] = [];
    for (let i = 0; i < PI_GPIO_COUNT; i++) {
      const p = this.pins[i];
      states.push(this.digitalPinLevel(i) ?? 'input');
      const window = this.now - p.windowStart;
      const high = p.highMs + (p.level ? this.now - p.highSince : 0);
      duty.push(window > 0 ? Math.max(0, Math.min(1, high / window)) : p.level ? 1 : 0);
      pulse.push(p.pwm && p.pwm.freq > 0 ? (1e6 / p.pwm.freq) * p.pwm.duty : 0);
      toggles.push(p.toggles);
      p.highMs = 0;
      p.highSince = this.now;
      p.windowStart = this.now;
    }
    return { states, duty, pulseWidthUs: pulse, toggles };
  }

  dispose(): void {
    for (const t of this.threads) t.done = true;
    this.threads = [];
    this.events = [];
  }
}
