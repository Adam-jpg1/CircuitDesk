// Automated test bench: runs each test on a fresh, headless emulator instance
// (accelerated — no realtime pacing), applies input events at their scheduled
// times, and evaluates assertions against real firmware behavior.
//
// It runs on whatever the board's own adapter executes. That is a deliberate
// change from what this used to be: it constructed an AVRRunner directly and
// refused any board without an AVR profile, so a Pico or an ESP32-C6 project
// could be compiled and run live but could not be ASSERTED — the one place a
// claim gets checked was the one place that only understood one architecture.
// A starter nobody can assert is a starter nobody can trust, and a custom
// board on an RP2040 had the same problem.
//
// Everything here now goes through the BoardRunner interface the live
// simulation uses, so a bench proves the same thing on every engine: real
// firmware, real pads, real serial bytes.

import { getSimulatorAdapter, assertFirmwareMatchesBoard, type FirmwareArtifact } from '../simulation/adapters';
import { arduinoPinLabel } from '../boards/pinMaps';
import { resolveDefinition } from '../project/partsRegistry';
import { CircuitBinding, emptyControls } from '../simulation/circuitSim';
import type { BoardRunner } from '../simulation/boardRunner';
import type { BoardDefinition, CircuitProject, TestAssertion, TestCase, TestResult, TestAssertionResult } from '../types';

/** Simulated milliseconds per step. Small enough to place an event precisely. */
const CHUNK_MS = 5;

interface PinEventLog {
  atMs: number;
  pin: number;
  high: boolean;
}

/**
 * Firmware plus the board it was compiled for — the pair is inseparable.
 *
 * `data` is whatever that engine executes: Intel HEX text for AVR, base64 UF2
 * for an RP2040, a base64 image for an ESP part. `regions` carries the other
 * flash regions a chip needs before it will run anything at all — an ESP32
 * reads its partition table out of flash first — so a bench on those parts
 * gets the same bytes the live simulation does.
 */
export interface TestFirmware {
  data: string;
  boardId: string;
  format?: string;
  regions?: { offset: number; data: string }[];
}

export async function runTest(project: CircuitProject, firmware: TestFirmware, test: TestCase): Promise<TestResult> {
  const started = performance.now();
  const boardInst = project.boardInstances.find((b) => {
    const def = resolveDefinition(b.definitionId, project);
    return def?.isBoard && def.simulation?.supported === true;
  });
  // Narrowed to a BOARD once, here, rather than re-asking `isBoard` at each
  // use: everything below needs board-only fields, and a component that
  // reached this far would be a bug rather than a case to handle.
  const resolved = boardInst ? resolveDefinition(boardInst.definitionId, project) : undefined;
  const boardDef: BoardDefinition | undefined = resolved?.isBoard ? resolved : undefined;
  const adapter = boardDef ? getSimulatorAdapter(boardDef) : null;
  if (!boardDef || !adapter) {
    return {
      testId: test.id,
      status: 'error',
      durationMs: 0,
      assertionResults: [],
      message:
        'This project has no board CircuitDesk can execute firmware on, so there is nothing for a test to assert. ' +
        'Boards that run firmware carry a runtime profile; the rest validate and wire.',
    };
  }
  // Same guard as the live simulation path: firmware never executes on a
  // board it was not built for, however stale the cached build is.
  try {
    assertFirmwareMatchesBoard(firmware.boardId, boardDef);
  } catch (err) {
    return {
      testId: test.id,
      status: 'error',
      durationMs: performance.now() - started,
      assertionResults: [],
      message: err instanceof Error ? err.message : 'Firmware does not match the board on the canvas.',
    };
  }
  const artifact: FirmwareArtifact = {
    data: firmware.data,
    format: firmware.format ?? adapter.firmwareFormat,
    ...(firmware.regions ? { regions: firmware.regions } : {}),
  };
  let runner: BoardRunner;
  try {
    runner = await adapter.createRunner(artifact, boardDef);
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
  const timeline: { atMs: number; event: string }[] = [];

  try {
    let lastYield = performance.now();
    while (runner.timeMs < totalMs) {
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
      runner.runFor(CHUNK_MS);
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
    evaluateAssertion(a, pinLog, serial, runner, boardDef),
  );
  runner.dispose?.();
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
  runner: BoardRunner,
  board: BoardDefinition,
): TestAssertionResult {
  // An assertion names a pin by the number the firmware uses, and what that
  // number is CALLED depends on the board: D13 and A0 on an AVR, GP15 on an
  // RP2040, IO8 on an ESP32. The label is for the person reading the result,
  // so it comes from the board rather than from an assumption about Arduino
  // numbering that only one architecture has.
  const label = (p?: number) => {
    if (p === undefined) return '?';
    if ((board.architecture ?? 'other') === 'avr') return arduinoPinLabel(board, p);
    const named = board.pins.find((pin) => (board.padMap?.[pin.id] ?? pin.id) === `GP${p}`)
      ?? board.pins.find((pin) => (board.padMap?.[pin.id] ?? pin.id) === `IO${p}`);
    return named ? named.label : `pin ${p}`;
  };
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
