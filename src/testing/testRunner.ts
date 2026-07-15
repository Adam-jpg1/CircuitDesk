// Automated test bench: runs each test on a fresh, headless emulator instance
// (accelerated — no realtime pacing), applies input events at their scheduled
// times, and evaluates assertions against real firmware behavior.

import { AVRRunner, F_CPU } from '../simulation/avrRunner';
import { CircuitBinding, emptyControls } from '../simulation/circuitSim';
import type { CircuitProject, TestAssertion, TestCase, TestResult, TestAssertionResult } from '../types';

const CHUNK_CYCLES = F_CPU / 200; // 5 ms of simulated time per chunk

interface PinEventLog {
  atMs: number;
  pin: number;
  high: boolean;
}

export async function runTest(project: CircuitProject, hex: string, test: TestCase): Promise<TestResult> {
  const started = performance.now();
  let runner: AVRRunner;
  try {
    runner = new AVRRunner(hex);
  } catch (err) {
    return {
      testId: test.id,
      status: 'error',
      durationMs: 0,
      assertionResults: [],
      message: err instanceof Error ? err.message : 'Failed to load firmware.',
    };
  }

  let serial = '';
  const decoder = new TextDecoder();
  runner.onSerialByte = (b) => {
    serial += decoder.decode(new Uint8Array([b]), { stream: true });
  };
  const pinLog: PinEventLog[] = [];
  runner.onPinChange = (pin, high) => {
    if (pinLog.length < 20_000) pinLog.push({ atMs: runner.timeMs, pin, high });
  };

  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();
  const events = [...test.events].sort((a, b) => a.atMs - b.atMs);
  let eventIdx = 0;

  const totalMs = Math.max(test.timeoutMs, ...test.assertions.map((a) => (a.withinMs ?? 0) + (a.holdMs ?? 0)), 100);
  const totalCycles = (totalMs / 1000) * F_CPU;
  const timeline: { atMs: number; event: string }[] = [];

  try {
    let lastYield = performance.now();
    while (runner.cpu.cycles < totalCycles) {
      // apply due input events
      while (eventIdx < events.length && events[eventIdx].atMs <= runner.timeMs) {
        const ev = events[eventIdx++];
        switch (ev.action) {
          case 'press':
            controls.pressedButtons.add(ev.componentId);
            timeline.push({ atMs: ev.atMs, event: `press ${ev.componentId}` });
            break;
          case 'release':
            controls.pressedButtons.delete(ev.componentId);
            timeline.push({ atMs: ev.atMs, event: `release ${ev.componentId}` });
            break;
          case 'toggle':
            controls.toggleStates.set(ev.componentId, !(controls.toggleStates.get(ev.componentId) ?? false));
            timeline.push({ atMs: ev.atMs, event: `toggle ${ev.componentId}` });
            break;
          case 'set-analog':
            controls.potPositions.set(ev.componentId, ev.value ?? 0.5);
            timeline.push({ atMs: ev.atMs, event: `pot ${((ev.value ?? 0.5) * 100).toFixed(0)}%` });
            break;
          case 'set-value':
            controls.sensorValues.set(ev.componentId, ev.value ?? 0);
            timeline.push({ atMs: ev.atMs, event: `sensor value ${ev.value}` });
            break;
        }
      }
      runner.runToCycles(runner.cpu.cycles + CHUNK_CYCLES);
      binding.update(controls);

      // keep the UI alive during long tests
      if (performance.now() - lastYield > 40) {
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
      if (performance.now() - started > 30_000) {
        throw new Error('Test exceeded the 30 s wall-clock budget.');
      }
    }
  } catch (err) {
    return {
      testId: test.id,
      status: 'error',
      durationMs: performance.now() - started,
      assertionResults: [],
      message: err instanceof Error ? err.message : 'Simulation crashed during the test.',
      serialOutput: serial,
    };
  }

  const assertionResults: TestAssertionResult[] = test.assertions.map((a) =>
    evaluateAssertion(a, pinLog, serial, runner),
  );
  const passed = assertionResults.every((r) => r.passed);
  return {
    testId: test.id,
    status: passed ? 'passed' : 'failed',
    durationMs: performance.now() - started,
    assertionResults,
    serialOutput: serial.slice(0, 4000),
    timeline: [
      ...timeline,
      ...pinLog.slice(0, 60).map((e) => ({ atMs: e.atMs, event: `pin ${e.pin} → ${e.high ? 'HIGH' : 'LOW'}` })),
    ].sort((a, b) => a.atMs - b.atMs).slice(0, 100),
  };
}

function pinStateAt(pinLog: PinEventLog[], pin: number, atMs: number): boolean {
  let state = false;
  for (const e of pinLog) {
    if (e.pin !== pin) continue;
    if (e.atMs > atMs) break;
    state = e.high;
  }
  return state;
}

function evaluateAssertion(
  a: TestAssertion,
  pinLog: PinEventLog[],
  serial: string,
  runner: AVRRunner,
): TestAssertionResult {
  const label = (p?: number) => (p !== undefined ? (p >= 14 ? `A${p - 14}` : `D${p}`) : '?');
  switch (a.kind) {
    case 'pin-becomes-high':
    case 'pin-becomes-low': {
      const wantHigh = a.kind === 'pin-becomes-high';
      const within = a.withinMs ?? 1000;
      const hit = pinLog.find((e) => e.pin === a.pin && e.high === wantHigh && e.atMs <= within);
      return {
        assertionId: a.id,
        passed: Boolean(hit),
        expected: `${label(a.pin)} becomes ${wantHigh ? 'HIGH' : 'LOW'} within ${within} ms`,
        actual: hit
          ? `${label(a.pin)} went ${wantHigh ? 'HIGH' : 'LOW'} at ${hit.atMs.toFixed(1)} ms`
          : `no ${wantHigh ? 'HIGH' : 'LOW'} transition on ${label(a.pin)} within ${within} ms`,
        atMs: hit?.atMs,
      };
    }
    case 'pin-high':
    case 'pin-low': {
      const wantHigh = a.kind === 'pin-high';
      const t = a.atMs ?? runner.timeMs;
      const state = pinStateAt(pinLog, a.pin!, t);
      const holdOk =
        a.holdMs === undefined ||
        !pinLog.some((e) => e.pin === a.pin && e.atMs > t && e.atMs <= t + a.holdMs! && e.high !== wantHigh);
      return {
        assertionId: a.id,
        passed: state === wantHigh && holdOk,
        expected: `${label(a.pin)} is ${wantHigh ? 'HIGH' : 'LOW'} at ${t.toFixed(0)} ms${a.holdMs ? ` and stays for ${a.holdMs} ms` : ''}`,
        actual: `${label(a.pin)} was ${state ? 'HIGH' : 'LOW'}${holdOk ? '' : ' but changed during the hold window'}`,
        atMs: t,
      };
    }
    case 'serial-contains': {
      const ok = serial.includes(a.text ?? '');
      return {
        assertionId: a.id,
        passed: ok,
        expected: `serial output contains "${a.text}"`,
        actual: ok ? 'found in serial output' : `not found (got ${serial.length} bytes)`,
      };
    }
    case 'pin-toggles': {
      const within = a.withinMs ?? 2000;
      const count = pinLog.filter((e) => e.pin === a.pin && e.atMs <= within).length;
      const min = a.minToggles ?? 2;
      return {
        assertionId: a.id,
        passed: count >= min,
        expected: `${label(a.pin)} toggles at least ${min}× within ${within} ms`,
        actual: `${count} transitions observed`,
      };
    }
    default:
      return { assertionId: a.id, passed: false, expected: 'known assertion type', actual: `unknown kind` };
  }
}
