// RPi.GPIO and gpiozero for CircuitDesk's Raspberry Pi headers.
//
// Both are written against the documented behaviour of the real libraries:
// RPi.GPIO's numbering modes, setup/output/input, software PWM, edge
// detection with callbacks and bounce time, and wait_for_edge; gpiozero's
// LED, PWMLED, Button, Buzzer, MotionSensor, Servo and the plain digital
// devices, with their background blinking and when_* callbacks. Pins are the
// header's BCM GPIO numbers; the runner (piRunner.ts) moves them.

import type { Interpreter } from './interpreter';
import { PyFunction } from './interpreter';
import { PyBound, PyClass, PyError, PyInstance, PyList, PyModule, PyTuple, type CallArgs, type PyValue, type Run } from './values';

export interface PiGpioHost {
  /** Sets a pin up: direction, pull, and the level an output starts at. */
  setup(pin: number, dir: 'in' | 'out', pull: 'up' | 'down' | 'off', initial?: boolean): void;
  /** Back to an input with no pull, as cleanup() leaves it. */
  release(pin: number): void;
  mode(pin: number): 'unset' | 'in' | 'out';
  write(pin: number, high: boolean): void;
  read(pin: number): boolean;
  /** Software PWM: frequency in hertz, duty 0..1; null stops it. */
  pwm(pin: number, freq: number, duty: number | null): void;
  /** Calls `fn` on every change of the pin's level; returns the unsubscribe. */
  onEdge(pin: number, fn: (high: boolean) => void): () => void;
  /** Runs `body` as another thread of the script (a callback, a blink). */
  spawn(name: string, body: () => Run<unknown>): { stop(): void };
  nowMs(): number;
}

/** Physical header pin (BOARD numbering) to BCM GPIO. */
export const BOARD_TO_BCM: Record<number, number> = {
  3: 2, 5: 3, 7: 4, 8: 14, 10: 15, 11: 17, 12: 18, 13: 27, 15: 22, 16: 23, 18: 24, 19: 10, 21: 9, 22: 25,
  23: 11, 24: 8, 26: 7, 27: 0, 28: 1, 29: 5, 31: 6, 32: 12, 33: 13, 35: 19, 36: 16, 37: 26, 38: 20, 40: 21,
};

const sleep = (ms: number): Run<void> =>
  (function* () {
    yield { k: 'sleep', ms };
  })();

/** Calls a Python callback with the arguments it can take (gpiozero passes the device only if asked for). */
function* callback(py: Interpreter, f: PyValue, args: PyValue[]): Run<void> {
  if (f === null) return;
  let take = args.length;
  const fn = f instanceof PyBound ? f.fn : f;
  if (fn instanceof PyFunction) {
    const positional = fn.params.filter((p) => p.kind === 'pos').length - (f instanceof PyBound ? 1 : 0);
    const star = fn.params.some((p) => p.kind === 'star');
    if (!star) take = Math.min(args.length, Math.max(0, positional));
  }
  yield* py.call(f, args.slice(0, take));
}

export function makeRpiGpio(py: Interpreter, host: PiGpioHost): PyModule {
  const mod = new PyModule('RPi.GPIO');
  const d = mod.dict;
  const C = { BOARD: 10n, BCM: 11n, OUT: 0n, IN: 1n, HIGH: 1n, LOW: 0n, PUD_OFF: 20n, PUD_DOWN: 21n, PUD_UP: 22n, RISING: 31n, FALLING: 32n, BOTH: 33n, HARD_PWM: 43n, SERIAL: 40n, SPI: 41n, I2C: 42n, UNKNOWN: -1n };
  for (const [k, v] of Object.entries(C)) d.set(k, v);
  d.set('VERSION', '0.7.1');
  d.set('RPI_REVISION', 3n);
  let numbering: bigint | null = null;
  let warnings = true;
  const events = new Map<number, { edge: bigint; callbacks: PyValue[]; bounceMs: number; lastMs: number; detected: boolean; off: () => void }>();

  const err = (msg: string) => py.error('RuntimeError', msg);
  const channel = (v: PyValue): number => {
    if (numbering === null) throw err('Please set pin numbering mode using GPIO.setmode(GPIO.BOARD) or GPIO.setmode(GPIO.BCM)');
    const n = Number(py.toBig(v));
    if (numbering === C.BOARD) {
      const bcm = BOARD_TO_BCM[n];
      if (bcm === undefined) throw py.error('ValueError', 'The channel sent is invalid on a Raspberry Pi');
      return bcm;
    }
    if (n < 0 || n > 27) throw py.error('ValueError', 'The channel sent is invalid on a Raspberry Pi');
    return n;
  };
  const channels = (v: PyValue): number[] => (v instanceof PyList || v instanceof PyTuple ? v.items.map(channel) : [channel(v)]);

  d.set('setmode', py.fn('setmode', (a) => {
    const m = py.toBig(py.arg(a, 0, 'mode'));
    if (m !== C.BOARD && m !== C.BCM) throw py.error('ValueError', 'An invalid mode was passed to setmode()');
    if (numbering !== null && numbering !== m) throw py.error('ValueError', 'A different mode has already been set!');
    numbering = m;
    return null;
  }));
  d.set('getmode', py.fn('getmode', () => numbering));
  d.set('setwarnings', py.fn('setwarnings', (a) => {
    warnings = py.truthy(a.args[0]);
    return null;
  }));
  d.set('setup', py.fn('setup', (a) => {
    const dir = py.toBig(py.arg(a, 1, 'direction'));
    const pud = py.toBig(a.kwargs.get('pull_up_down') ?? (a.args[2] ?? C.PUD_OFF));
    const initial = a.kwargs.get('initial') ?? a.args[3] ?? null;
    if (dir !== C.IN && dir !== C.OUT) throw py.error('ValueError', 'An invalid direction was passed to setup()');
    for (const pin of channels(py.arg(a, 0, 'channel'))) {
      if (dir === C.OUT && pud !== C.PUD_OFF) throw py.error('ValueError', 'pull_up_down parameter is not valid for outputs');
      if (warnings && host.mode(pin) !== 'unset') {
        host.nowMs();
      }
      const pull = pud === C.PUD_UP ? 'up' : pud === C.PUD_DOWN ? 'down' : 'off';
      host.setup(pin, dir === C.OUT ? 'out' : 'in', pull, initial === null ? undefined : py.truthy(initial));
    }
    return null;
  }));
  d.set('output', py.fn('output', (a) => {
    const pins = channels(py.arg(a, 0, 'channel'));
    const vals = py.arg(a, 1, 'value');
    const levels = vals instanceof PyList || vals instanceof PyTuple ? vals.items : pins.map(() => vals);
    if (levels.length !== pins.length) throw err('Number of channels != number of values');
    pins.forEach((pin, i) => {
      if (host.mode(pin) !== 'out') throw err('The GPIO channel has not been set up as an OUTPUT');
      host.write(pin, py.truthy(levels[i]));
    });
    return null;
  }));
  d.set('input', py.fn('input', (a) => {
    const pin = channel(py.arg(a, 0, 'channel'));
    if (host.mode(pin) === 'unset') throw err('You must setup() the GPIO channel first');
    return host.read(pin) ? 1n : 0n;
  }));
  d.set('gpio_function', py.fn('gpio_function', (a) => {
    const m = host.mode(channel(a.args[0]));
    return m === 'out' ? C.OUT : C.IN;
  }));
  d.set('cleanup', py.fn('cleanup', (a) => {
    const pins = a.args.length && a.args[0] !== null ? channels(a.args[0]) : [...Array(28).keys()].filter((p) => host.mode(p) !== 'unset');
    for (const pin of pins) {
      events.get(pin)?.off();
      events.delete(pin);
      host.pwm(pin, 0, null);
      host.release(pin);
    }
    if (!a.args.length) numbering = null;
    return null;
  }));

  const edgeMatches = (edge: bigint, high: boolean) => edge === C.BOTH || (edge === C.RISING ? high : !high);
  const addDetect = (a: CallArgs) => {
    const pin = channel(py.arg(a, 0, 'channel'));
    const edge = py.toBig(py.arg(a, 1, 'edge'));
    if (edge !== C.RISING && edge !== C.FALLING && edge !== C.BOTH) throw py.error('ValueError', 'The edge must be set to RISING, FALLING or BOTH');
    if (host.mode(pin) !== 'in') throw err('You must setup() the GPIO channel as an input first');
    if (events.has(pin)) throw err('Conflicting edge detection already enabled for this GPIO channel');
    const cb = a.kwargs.get('callback') ?? a.args[2] ?? null;
    const bounce = a.kwargs.get('bouncetime') ?? a.args[3] ?? null;
    const state = { edge, callbacks: cb !== null ? [cb] : [], bounceMs: bounce === null ? 0 : py.toNum(bounce), lastMs: -Infinity, detected: false, off: () => {} };
    state.off = host.onEdge(pin, (high) => {
      if (!edgeMatches(state.edge, high)) return;
      const now = host.nowMs();
      if (now - state.lastMs < state.bounceMs) return;
      state.lastMs = now;
      state.detected = true;
      for (const f of state.callbacks) host.spawn('callback', () => callback(py, f, [BigInt(pin)]));
    });
    events.set(pin, state);
    return null;
  };
  d.set('add_event_detect', py.fn('add_event_detect', addDetect));
  d.set('add_event_callback', py.fn('add_event_callback', (a) => {
    const pin = channel(py.arg(a, 0, 'channel'));
    const e = events.get(pin);
    if (!e) throw err('Add event detection using add_event_detect first before adding a callback');
    e.callbacks.push(py.arg(a, 1, 'callback'));
    return null;
  }));
  d.set('remove_event_detect', py.fn('remove_event_detect', (a) => {
    const pin = channel(a.args[0]);
    events.get(pin)?.off();
    events.delete(pin);
    return null;
  }));
  d.set('event_detected', py.fn('event_detected', (a) => {
    const e = events.get(channel(a.args[0]));
    if (!e) return false;
    const r = e.detected;
    e.detected = false;
    return r;
  }));
  d.set('wait_for_edge', py.blocking('wait_for_edge', (a) => {
    const pin = channel(py.arg(a, 0, 'channel'));
    const edge = py.toBig(py.arg(a, 1, 'edge'));
    const timeout = a.kwargs.get('timeout') ?? null;
    if (host.mode(pin) !== 'in') throw err('You must setup() the GPIO channel as an input first');
    return (function* (): Run<PyValue> {
      let hit = false;
      const off = host.onEdge(pin, (high) => {
        if (edgeMatches(edge, high)) hit = true;
      });
      try {
        yield { k: 'until', ready: () => hit, timeoutMs: timeout === null ? undefined : py.toNum(timeout) };
      } finally {
        off();
      }
      return hit ? BigInt(pin) : null;
    })();
  }));

  // Software PWM, as RPi.GPIO does it: GPIO.PWM(channel, frequency).
  const PWM = py.nativeClass('PWM', {
    init: (self, a) => {
      const pin = channel(py.arg(a, 0, 'channel'));
      if (host.mode(pin) !== 'out') throw err('You must setup() the GPIO channel as an output first');
      const freq = py.toNum(py.arg(a, 1, 'frequency'));
      if (freq <= 0) throw py.error('ValueError', 'frequency must be greater than 0.0');
      self.native = { pin, freq, duty: 0, running: false };
    },
    methods: {
      start: (self, a) => {
        const n = self.native as { pin: number; freq: number; duty: number; running: boolean };
        n.duty = dutyArg(py, py.arg(a, 0, 'dutycycle'));
        n.running = true;
        host.pwm(n.pin, n.freq, n.duty / 100);
        return null;
      },
      ChangeDutyCycle: (self, a) => {
        const n = self.native as { pin: number; freq: number; duty: number; running: boolean };
        n.duty = dutyArg(py, py.arg(a, 0, 'dutycycle'));
        if (n.running) host.pwm(n.pin, n.freq, n.duty / 100);
        return null;
      },
      ChangeFrequency: (self, a) => {
        const n = self.native as { pin: number; freq: number; duty: number; running: boolean };
        n.freq = py.toNum(py.arg(a, 0, 'frequency'));
        if (n.freq <= 0) throw py.error('ValueError', 'frequency must be greater than 0.0');
        if (n.running) host.pwm(n.pin, n.freq, n.duty / 100);
        return null;
      },
      stop: (self) => {
        const n = self.native as { pin: number; running: boolean };
        n.running = false;
        host.pwm(n.pin, 0, null);
        return null;
      },
    },
  });
  d.set('PWM', PWM);
  return mod;
}

function dutyArg(py: Interpreter, v: PyValue): number {
  const d = py.toNum(v);
  if (d < 0 || d > 100) throw py.error('ValueError', 'dutycycle must have a value from 0.0 to 100.0');
  return d;
}

/** gpiozero's pin argument: 17, "GPIO17", "BCM17", "BOARD11", "J8:11". */
function zeroPin(py: Interpreter, v: PyValue): number {
  if (typeof v === 'bigint' || typeof v === 'boolean') {
    const n = Number(py.toBig(v));
    if (n >= 0 && n <= 27) return n;
  }
  if (typeof v === 'string') {
    const s = v.toUpperCase();
    let m = /^(?:GPIO|BCM)?(\d+)$/.exec(s);
    if (m && Number(m[1]) <= 27) return Number(m[1]);
    m = /^(?:BOARD|J8:)(\d+)$/.exec(s);
    if (m && BOARD_TO_BCM[Number(m[1])] !== undefined) return BOARD_TO_BCM[Number(m[1])];
  }
  throw py.error('ValueError', `${py.repr(v)} is not a valid pin (gpiozero uses BCM numbers, or names like "GPIO17" or "BOARD11")`);
}

interface OutState {
  pin: number;
  activeHigh: boolean;
  value: number;
  pwm: boolean;
  freq: number;
  thread: { stop(): void } | null;
  closed: boolean;
}

interface InState {
  pin: number;
  pullUp: boolean | null;
  activeState: boolean;
  bounceMs: number;
  lastMs: number;
  off: () => void;
  closed: boolean;
  heldMs: number;
}

export function makeGpiozero(py: Interpreter, host: PiGpioHost): PyModule {
  const mod = new PyModule('gpiozero');
  const d = mod.dict;
  const used = new Set<number>();
  const claim = (pin: number) => {
    if (used.has(pin)) throw py.error('RuntimeError', `pin GPIO${pin} is already in use by another gpiozero object`);
    used.add(pin);
  };

  // ------------------------------------------------------------ outputs

  const out = (self: PyInstance) => self.native as unknown as OutState;
  const drive = (s: OutState) => {
    if (s.closed) return;
    if (s.pwm) {
      const duty = s.activeHigh ? s.value : 1 - s.value;
      host.pwm(s.pin, s.freq, duty);
    } else host.write(s.pin, (s.value > 0) === s.activeHigh);
  };
  const stopThread = (s: OutState) => {
    s.thread?.stop();
    s.thread = null;
  };
  const set = (s: OutState, v: number) => {
    s.value = v;
    drive(s);
  };
  const checkOpen = (s: OutState | InState) => {
    if (s.closed) throw py.error('RuntimeError', 'the device has been closed');
  };

  const initOut = (pwm: boolean) => (self: PyInstance, a: CallArgs) => {
    const pin = zeroPin(py, py.arg(a, 0, 'pin'));
    claim(pin);
    const activeHigh = py.truthy(a.kwargs.get('active_high') ?? a.args[1] ?? true);
    const initial = a.kwargs.get('initial_value') ?? a.args[2] ?? false;
    const freq = pwm ? py.toNum(a.kwargs.get('frequency') ?? a.args[3] ?? 100n) : 0;
    const s: OutState = { pin, activeHigh, value: 0, pwm, freq, thread: null, closed: false };
    self.native = s as unknown as Record<string, unknown>;
    host.setup(pin, 'out', 'off', !activeHigh);
    set(s, initial === null ? 0 : py.toNum(initial === true ? 1n : initial === false ? 0n : initial));
  };

  /** blink() and pulse(): a background thread stepping the value, n times or forever. */
  const animate = (self: PyInstance, a: CallArgs, steps: (fadeIn: number, fadeOut: number, on: number, off: number) => [number, number][], names: string[], defaults: number[]): Run<PyValue> | PyValue => {
    const s = out(self);
    checkOpen(s);
    const arg = (i: number) => {
      const v = a.kwargs.get(names[i]) ?? a.args[i];
      return v === undefined || v === null ? defaults[i] : py.toNum(v);
    };
    const [on, off, fadeIn, fadeOut] = [arg(0), arg(1), arg(2), arg(3)];
    const nArg = a.kwargs.get('n') ?? a.args[4] ?? null;
    const background = py.truthy(a.kwargs.get('background') ?? a.args[5] ?? true);
    const n = nArg === null ? Infinity : Number(py.toBig(nArg));
    const seq = steps(fadeIn, fadeOut, on, off);
    stopThread(s);
    const body = function* (): Run<void> {
      for (let i = 0; i < n; i++) {
        for (const [value, ms] of seq) {
          set(s, value);
          if (ms > 0) yield* sleep(ms);
        }
      }
      if (n !== Infinity) set(s, 0);
    };
    if (background) {
      s.thread = host.spawn('blink', body);
      return null;
    }
    return (function* (): Run<PyValue> {
      yield* body();
      return null;
    })();
  };
  const blinkSteps = (fadeIn: number, fadeOut: number, on: number, off: number): [number, number][] => {
    const out: [number, number][] = [];
    const fps = 25;
    for (let i = 1; i <= Math.round(fadeIn * fps); i++) out.push([i / Math.round(fadeIn * fps), 1000 / fps]);
    out.push([1, on * 1000]);
    for (let i = Math.round(fadeOut * fps) - 1; i >= 0 && fadeOut > 0; i--) out.push([i / Math.round(fadeOut * fps), 1000 / fps]);
    out.push([0, off * 1000]);
    return out;
  };

  const outputMethods = {
    on: (self: PyInstance) => {
      const s = out(self);
      checkOpen(s);
      stopThread(s);
      set(s, 1);
      return null;
    },
    off: (self: PyInstance) => {
      const s = out(self);
      checkOpen(s);
      stopThread(s);
      set(s, 0);
      return null;
    },
    toggle: (self: PyInstance) => {
      const s = out(self);
      checkOpen(s);
      stopThread(s);
      set(s, s.pwm ? 1 - s.value : s.value > 0 ? 0 : 1);
      return null;
    },
    close: (self: PyInstance) => {
      const s = out(self);
      if (s.closed) return null;
      stopThread(s);
      host.pwm(s.pin, 0, null);
      host.release(s.pin);
      used.delete(s.pin);
      s.closed = true;
      return null;
    },
    __enter__: (self: PyInstance) => self,
    __exit__: (self: PyInstance) => outputMethods.close(self),
  };
  const valueProp = (pwm: boolean) => ({
    get: (self: PyInstance) => (pwm ? out(self).value : out(self).value > 0 ? 1n : 0n),
    set: (self: PyInstance, v: PyValue) => {
      const s = out(self);
      checkOpen(s);
      const x = py.toNum(v === true ? 1n : v === false ? 0n : v);
      if (pwm && (x < 0 || x > 1)) throw py.error('ValueError', 'PWM value must be between 0 and 1');
      stopThread(s);
      set(s, pwm ? x : x > 0 ? 1 : 0);
    },
  });
  const common = {
    pin: { get: (self: PyInstance) => `GPIO${out(self).pin}` },
    closed: { get: (self: PyInstance) => out(self).closed },
    active_high: { get: (self: PyInstance) => out(self).activeHigh },
  };

  const DigitalOutputDevice = py.nativeClass('DigitalOutputDevice', {
    init: initOut(false),
    methods: {
      ...outputMethods,
      blink: (self, a) => animate(self, a, (_i, _o, on, off) => [[1, on * 1000], [0, off * 1000]], ['on_time', 'off_time'], [1, 1]),
    },
    blocking: ['blink'],
    props: { ...common, value: valueProp(false), is_active: { get: (self) => out(self).value > 0 }, is_lit: { get: (self) => out(self).value > 0 } },
  });
  const LED = py.nativeClass('LED', { base: DigitalOutputDevice });
  const Buzzer = py.nativeClass('Buzzer', {
    base: DigitalOutputDevice,
    methods: {
      beep: (self, a) => animate(self, a, (_i, _o, on, off) => [[1, on * 1000], [0, off * 1000]], ['on_time', 'off_time'], [1, 1]),
    },
    blocking: ['beep'],
  });
  const PWMOutputDevice = py.nativeClass('PWMOutputDevice', {
    init: initOut(true),
    methods: {
      ...outputMethods,
      blink: (self, a) => animate(self, a, blinkSteps, ['on_time', 'off_time', 'fade_in_time', 'fade_out_time'], [1, 1, 0, 0]),
      pulse: (self, a) => {
        const args: CallArgs = { args: [0n, 0n, a.args[0] ?? a.kwargs.get('fade_in_time') ?? 1n, a.args[1] ?? a.kwargs.get('fade_out_time') ?? 1n, a.args[2] ?? a.kwargs.get('n') ?? null, a.args[3] ?? a.kwargs.get('background') ?? true], kwargs: new Map() };
        return animate(self, args, blinkSteps, ['on_time', 'off_time', 'fade_in_time', 'fade_out_time'], [0, 0, 1, 1]);
      },
    },
    blocking: ['blink', 'pulse'],
    props: {
      ...common,
      value: valueProp(true),
      is_active: { get: (self) => out(self).value > 0 },
      is_lit: { get: (self) => out(self).value > 0 },
      frequency: {
        get: (self) => out(self).freq,
        set: (self, v) => {
          const s = out(self);
          s.freq = py.toNum(v);
          drive(s);
        },
      },
    },
  });
  const PWMLED = py.nativeClass('PWMLED', { base: PWMOutputDevice });

  // A servo: 50 Hz frames, value -1..1 between the minimum and maximum pulse.
  const servoPulse = (self: PyInstance) => self.native as unknown as OutState & { min: number; max: number; frame: number; v: number | null };
  const servoDrive = (s: ReturnType<typeof servoPulse>) => {
    if (s.v === null) host.pwm(s.pin, 0, null);
    else host.pwm(s.pin, 1 / s.frame, (s.min + ((s.v + 1) / 2) * (s.max - s.min)) / s.frame);
  };
  const Servo = py.nativeClass('Servo', {
    init: (self, a) => {
      const pin = zeroPin(py, py.arg(a, 0, 'pin'));
      claim(pin);
      const num = (name: string, i: number, def: number) => {
        const v = a.kwargs.get(name) ?? a.args[i];
        return v === undefined || v === null ? def : py.toNum(v);
      };
      const initial = a.kwargs.get('initial_value') ?? a.args[1] ?? 0n;
      self.native = { pin, closed: false, min: num('min_pulse_width', 2, 1 / 1000), max: num('max_pulse_width', 3, 2 / 1000), frame: num('frame_width', 4, 20 / 1000), v: initial === null ? null : py.toNum(initial), thread: null } as unknown as Record<string, unknown>;
      host.setup(pin, 'out', 'off', false);
      servoDrive(servoPulse(self));
    },
    methods: {
      min: (self) => ((servoPulse(self).v = -1), servoDrive(servoPulse(self)), null),
      mid: (self) => ((servoPulse(self).v = 0), servoDrive(servoPulse(self)), null),
      max: (self) => ((servoPulse(self).v = 1), servoDrive(servoPulse(self)), null),
      detach: (self) => ((servoPulse(self).v = null), servoDrive(servoPulse(self)), null),
      close: (self) => {
        const s = servoPulse(self);
        host.pwm(s.pin, 0, null);
        host.release(s.pin);
        used.delete(s.pin);
        s.closed = true;
        return null;
      },
    },
    props: {
      value: {
        get: (self) => servoPulse(self).v,
        set: (self, v) => {
          const s = servoPulse(self);
          if (v !== null && (py.toNum(v) < -1 || py.toNum(v) > 1)) throw py.error('ValueError', 'servo value must be between -1 and 1, or None');
          s.v = v === null ? null : py.toNum(v);
          servoDrive(s);
        },
      },
      pulse_width: { get: (self) => { const s = servoPulse(self); return s.v === null ? null : s.min + ((s.v + 1) / 2) * (s.max - s.min); } },
      pin: { get: (self) => `GPIO${servoPulse(self).pin}` },
    },
  });
  const AngularServo = py.nativeClass('AngularServo', {
    base: Servo,
    init: (self, a) => {
      const minAngle = py.toNum(a.kwargs.get('min_angle') ?? -90n);
      const maxAngle = py.toNum(a.kwargs.get('max_angle') ?? 90n);
      const angle = a.kwargs.get('initial_angle') ?? 0n;
      const rest = new Map(a.kwargs);
      for (const k of ['min_angle', 'max_angle', 'initial_angle']) rest.delete(k);
      const init = Servo.dict.get('__init__') as unknown as { fn: (a: CallArgs, self: PyValue) => void };
      init.fn({ args: [a.args[0]], kwargs: rest }, self);
      Object.assign(self.native, { minAngle, maxAngle });
      const s = servoPulse(self);
      s.v = angle === null ? null : ((py.toNum(angle) - minAngle) / (maxAngle - minAngle)) * 2 - 1;
      servoDrive(s);
    },
    props: {
      angle: {
        get: (self) => {
          const s = servoPulse(self) as ReturnType<typeof servoPulse> & { minAngle: number; maxAngle: number };
          return s.v === null ? null : s.minAngle + ((s.v + 1) / 2) * (s.maxAngle - s.minAngle);
        },
        set: (self, v) => {
          const s = servoPulse(self) as ReturnType<typeof servoPulse> & { minAngle: number; maxAngle: number };
          s.v = v === null ? null : ((py.toNum(v) - s.minAngle) / (s.maxAngle - s.minAngle)) * 2 - 1;
          servoDrive(s);
        },
      },
    },
  });

  // ------------------------------------------------------------- inputs

  const inp = (self: PyInstance) => self.native as unknown as InState & { whenOn: PyValue; whenOff: PyValue; whenHeld: PyValue; holdMs: number };
  const active = (s: InState) => host.read(s.pin) === s.activeState;
  const initIn = (defaultPullUp: boolean | null) => (self: PyInstance, a: CallArgs) => {
    const pin = zeroPin(py, py.arg(a, 0, 'pin'));
    claim(pin);
    const pu = a.kwargs.has('pull_up') ? a.kwargs.get('pull_up')! : a.args[1] ?? defaultPullUp;
    const pullUp = pu === null ? null : py.truthy(pu);
    const activeStateArg = a.kwargs.get('active_state') ?? null;
    const activeState = pullUp === null ? (activeStateArg === null ? true : py.truthy(activeStateArg)) : !pullUp;
    const bounce = a.kwargs.get('bounce_time') ?? null;
    const hold = a.kwargs.get('hold_time') ?? 1n;
    const s = {
      pin, pullUp, activeState, bounceMs: bounce === null ? 0 : py.toNum(bounce) * 1000, lastMs: -Infinity, closed: false, heldMs: 0,
      whenOn: null as PyValue, whenOff: null as PyValue, whenHeld: null as PyValue, holdMs: py.toNum(hold) * 1000, off: () => {},
    };
    self.native = s as unknown as Record<string, unknown>;
    host.setup(pin, 'in', pullUp === null ? 'off' : pullUp ? 'up' : 'down');
    let holdThread: { stop(): void } | null = null;
    s.off = host.onEdge(pin, (high) => {
      const now = host.nowMs();
      if (now - s.lastMs < s.bounceMs) return;
      s.lastMs = now;
      const isActive = high === s.activeState;
      const f = isActive ? s.whenOn : s.whenOff;
      if (f !== null) host.spawn('callback', () => callback(py, f, [self]));
      holdThread?.stop();
      holdThread = null;
      if (isActive && s.whenHeld !== null) {
        const held = s.whenHeld;
        holdThread = host.spawn('hold', function* () {
          yield* sleep(s.holdMs);
          if (active(s)) yield* callback(py, held, [self]);
        });
      }
    });
  };
  const waitFor = (want: boolean) => (self: PyInstance, a: CallArgs) => {
    const s = inp(self);
    const timeout = a.kwargs.get('timeout') ?? a.args[0] ?? null;
    return (function* (): Run<PyValue> {
      yield { k: 'until', ready: () => active(s) === want, timeoutMs: timeout === null ? undefined : py.toNum(timeout) * 1000 };
      return active(s) === want;
    })();
  };
  const callbackProp = (field: 'whenOn' | 'whenOff' | 'whenHeld') => ({
    get: (self: PyInstance) => inp(self)[field],
    set: (self: PyInstance, v: PyValue) => {
      inp(self)[field] = v;
    },
  });
  const inputMethods = {
    close: (self: PyInstance) => {
      const s = inp(self);
      if (s.closed) return null;
      s.off();
      host.release(s.pin);
      used.delete(s.pin);
      s.closed = true;
      return null;
    },
    __enter__: (self: PyInstance) => self,
    __exit__: (self: PyInstance) => inputMethods.close(self),
  };
  const inputProps = {
    value: { get: (self: PyInstance) => (active(inp(self)) ? 1n : 0n) },
    is_active: { get: (self: PyInstance) => active(inp(self)) },
    pin: { get: (self: PyInstance) => `GPIO${inp(self).pin}` },
    pull_up: { get: (self: PyInstance) => inp(self).pullUp },
    closed: { get: (self: PyInstance) => inp(self).closed },
  };
  const DigitalInputDevice = py.nativeClass('DigitalInputDevice', {
    init: initIn(false),
    methods: { ...inputMethods, wait_for_active: waitFor(true), wait_for_inactive: waitFor(false) },
    blocking: ['wait_for_active', 'wait_for_inactive'],
    props: { ...inputProps, when_activated: callbackProp('whenOn'), when_deactivated: callbackProp('whenOff') },
  });
  const Button = py.nativeClass('Button', {
    init: initIn(true),
    methods: { ...inputMethods, wait_for_press: waitFor(true), wait_for_release: waitFor(false), wait_for_active: waitFor(true), wait_for_inactive: waitFor(false) },
    blocking: ['wait_for_press', 'wait_for_release', 'wait_for_active', 'wait_for_inactive'],
    props: {
      ...inputProps,
      is_pressed: { get: (self) => active(inp(self)) },
      is_held: { get: (self) => active(inp(self)) && host.nowMs() - inp(self).lastMs >= inp(self).holdMs },
      when_pressed: callbackProp('whenOn'),
      when_released: callbackProp('whenOff'),
      when_held: callbackProp('whenHeld'),
      when_activated: callbackProp('whenOn'),
      when_deactivated: callbackProp('whenOff'),
    },
  });
  const MotionSensor = py.nativeClass('MotionSensor', {
    init: initIn(false),
    methods: { ...inputMethods, wait_for_motion: waitFor(true), wait_for_no_motion: waitFor(false) },
    blocking: ['wait_for_motion', 'wait_for_no_motion'],
    props: { ...inputProps, motion_detected: { get: (self) => active(inp(self)) }, when_motion: callbackProp('whenOn'), when_no_motion: callbackProp('whenOff') },
  });
  const LineSensor = py.nativeClass('LineSensor', {
    init: initIn(false),
    methods: { ...inputMethods, wait_for_line: waitFor(false), wait_for_no_line: waitFor(true) },
    blocking: ['wait_for_line', 'wait_for_no_line'],
    props: { ...inputProps, line_detected: { get: (self) => !active(inp(self)) }, when_line: callbackProp('whenOff'), when_no_line: callbackProp('whenOn') },
  });

  const classes: Record<string, PyClass> = {
    LED, PWMLED, Buzzer, DigitalOutputDevice, OutputDevice: DigitalOutputDevice, PWMOutputDevice, Servo, AngularServo,
    Button, DigitalInputDevice, InputDevice: DigitalInputDevice, MotionSensor, LineSensor,
  };
  for (const [k, v] of Object.entries(classes)) d.set(k, v);
  d.set('Device', py.types.get('object')!);
  const GPIOZeroError = new PyClass('GPIOZeroError', [py.exc.get('Exception')!]);
  d.set('GPIOZeroError', GPIOZeroError);
  void PyError;
  return mod;
}
