import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore, type BottomTab } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { simulationController } from '../simulation/simulationController';
import { fetchCompilerHealth } from '../compiler/compilerClient';
import { resolveDefinition } from '../project/partsRegistry';
import { buildPinStatesModel } from '../simulation/pinStatesModel';
import { CodePanel } from './CodePanel';
import { TestsPanel } from './TestsPanel';
import { ErrorIcon, InfoIcon, WarnIcon } from '../ui/icons';
import type { CompilerHealth } from '../types';

const TABS: { id: BottomTab; label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'serial', label: 'Serial' },
  { id: 'compiler', label: 'Compiler' },
  { id: 'validation', label: 'Validation' },
  { id: 'tests', label: 'Tests' },
  { id: 'pins', label: 'Pin states' },
  { id: 'debug', label: 'Debug' },
];

export function BottomPanel() {
  const tab = useEditorStore((s) => s.bottomTab);
  const issues = useEditorStore((s) => s.validationIssues);
  const lastCompile = useEditorStore((s) => s.lastCompile);
  const testCount = useEditorStore((s) => s.project?.tests.length ?? 0);
  const s = useEditorStore.getState();

  const errCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warning').length;
  const compileErrs = lastCompile?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;

  return (
    <div className="bottom-panel" style={{ flex: 1, minHeight: 0 }}>
      <div className="bottom-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`bottom-tab ${tab === t.id ? 'active' : ''}`} onClick={() => s.setBottomTab(t.id)}>
            {t.label}
            {t.id === 'validation' && issues.length > 0 && (
              <span className={`count ${errCount > 0 ? 'err' : warnCount > 0 ? 'warn' : ''}`}>{issues.length}</span>
            )}
            {t.id === 'compiler' && compileErrs > 0 && <span className="count err">{compileErrs}</span>}
            {t.id === 'tests' && testCount > 0 && <span className="count">{testCount}</span>}
          </button>
        ))}
      </div>
      <div className="bottom-content">
        {tab === 'code' && <CodePanel />}
        {tab === 'serial' && <SerialPanel />}
        {tab === 'compiler' && <CompilerPanel />}
        {tab === 'validation' && <ValidationPanel />}
        {tab === 'tests' && <TestsPanel />}
        {tab === 'pins' && <PinsPanel />}
        {tab === 'debug' && <DebugPanel />}
      </div>
    </div>
  );
}

function SerialPanel() {
  const serialText = useSimulationStore((s) => s.serialText);
  const status = useSimulationStore((s) => s.status);
  const outRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [serialText, autoScroll]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div ref={outRef} className="mono-out">
        {serialText || (
          <span style={{ color: 'var(--text-2)' }}>
            {status === 'stopped'
              ? 'Serial monitor — output from the emulated UART (USART0 @ your sketch’s baud rate) appears here when the simulation runs.'
              : 'Waiting for serial output…'}
          </span>
        )}
      </div>
      <div className="serial-input-row">
        <input
          placeholder={status === 'running' ? 'Send to the sketch (Enter appends \\n)…' : 'Start the simulation to send serial input'}
          disabled={status !== 'running' && status !== 'paused'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.length > 0) {
              simulationController.sendSerial(input + '\n');
              setInput('');
            }
          }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-2)' }}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> autoscroll
        </label>
        <button className="btn sm" onClick={() => useSimulationStore.getState().clearSerial()}>Clear</button>
      </div>
    </div>
  );
}

function CompilerPanel() {
  const lastCompile = useEditorStore((s) => s.lastCompile);
  const compiling = useEditorStore((s) => s.compiling);
  const [health, setHealth] = useState<CompilerHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCompilerHealth().then((h) => !cancelled && setHealth(h));
    return () => {
      cancelled = true;
    };
  }, [lastCompile]);

  return (
    <div className="mono-out">
      {health && (
        <div style={{ color: health.available ? 'var(--text-2)' : '#e8c35a', marginBottom: 8 }}>
          Toolchain: {health.available ? `${health.toolchain} — ${health.version}` : 'unavailable'}. {health.detail}
        </div>
      )}
      {compiling && <div>Compiling…</div>}
      {!compiling && !lastCompile && <span style={{ color: 'var(--text-2)' }}>No compile yet. Press Compile or Run (Ctrl+Enter).</span>}
      {!compiling && lastCompile && (
        <>
          <div style={{ color: lastCompile.success ? 'var(--ok)' : 'var(--error)', fontWeight: 700 }}>
            {lastCompile.success ? '✓ Build succeeded' : '✗ Build failed'}
            <span style={{ color: 'var(--text-2)', fontWeight: 400 }}>
              {' '}— {lastCompile.toolchain} · {(lastCompile.durationMs / 1000).toFixed(1)} s
            </span>
          </div>
          {lastCompile.memory && (
            <div style={{ color: 'var(--text-1)' }}>
              Flash: {lastCompile.memory.flashBytes} / {lastCompile.memory.flashMaxBytes} bytes ·
              RAM (static): {lastCompile.memory.ramBytes} / {lastCompile.memory.ramMaxBytes} bytes
            </div>
          )}
          {lastCompile.error && <div className="err-line">{lastCompile.error}</div>}
          {lastCompile.diagnostics.map((d, i) => (
            <div key={i} className={d.severity === 'error' ? 'err-line' : d.severity === 'warning' ? 'warn-line' : ''}>
              {d.file}:{d.line}:{d.column}: {d.severity}: {d.message}
            </div>
          ))}
          {lastCompile.stderr && lastCompile.diagnostics.length === 0 && <div>{lastCompile.stderr}</div>}
          {lastCompile.stdout && <div style={{ color: 'var(--text-2)' }}>{lastCompile.stdout}</div>}
        </>
      )}
    </div>
  );
}

function ValidationPanel() {
  const issues = useEditorStore((s) => s.validationIssues);
  const highlighted = useEditorStore((s) => s.highlightedIssueId);
  const s = useEditorStore.getState();

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {issues.length === 0 && (
        <div className="empty-state">
          <p>No validation results yet — press Validate in the toolbar.</p>
          <p style={{ fontSize: 11.5 }}>Checks include missing ground, LED resistors, polarity, 5 V→3.3 V conflicts, floating inputs, I2C/UART pin use and code↔circuit mismatches.</p>
        </div>
      )}
      {issues.map((issue) => (
        <div
          key={issue.id}
          className={`issue-item ${highlighted === issue.id ? 'highlighted' : ''}`}
          onClick={() => s.setHighlightedIssue(highlighted === issue.id ? null : issue.id)}
          title="Click to highlight the affected parts on the canvas"
        >
          <span className="issue-icon">
            {issue.severity === 'error' ? (
              <ErrorIcon style={{ width: 15, height: 15, color: 'var(--error)' }} />
            ) : issue.severity === 'warning' ? (
              <WarnIcon style={{ width: 15, height: 15, color: 'var(--warn)' }} />
            ) : (
              <InfoIcon style={{ width: 15, height: 15, color: 'var(--accent)' }} />
            )}
          </span>
          <div>
            <div className="issue-title">{issue.title}</div>
            <div className="issue-desc">{issue.description}</div>
            {issue.why && <div className="issue-why">{issue.why}</div>}
            {issue.suggestedFix && <div className="issue-fix">Fix: {issue.suggestedFix}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function PinsPanel() {
  const snapshot = useSimulationStore((s) => s.pinSnapshot);
  const status = useSimulationStore((s) => s.status);
  const project = useEditorStore((s) => s.project);

  // The panel is generated from the selected board's own definition —
  // never from a hard-coded Uno pin list.
  const model = useMemo(() => {
    const inst = project?.boardInstances[0];
    const def = inst ? resolveDefinition(inst.definitionId, project) : undefined;
    return buildPinStatesModel(def?.isBoard ? def : null);
  }, [project]);

  if (model.kind === 'no-board') {
    return <div className="empty-state">Place a board on the canvas to see its pins.</div>;
  }
  if (model.kind === 'not-simulated') {
    return (
      <div className="empty-state">
        <p>Live pin states require simulation support for {model.boardName}.</p>
        <p style={{ fontSize: 11.5 }}>
          This board's badge describes what is supported. Its pins are still real connection points for wiring
          and validation — CircuitDesk just doesn't pretend to show live activity it can't simulate.
        </p>
      </div>
    );
  }
  if (!snapshot || status === 'stopped') {
    return <div className="empty-state">Run the simulation to see live pin states from the emulator ({model.boardName}).</div>;
  }
  return (
    <div className="pins-grid">
      {model.rows.map((row) => {
        if (row.pin === undefined) {
          return (
            <div className="pin-chip" key={row.label} title="ADC-only input — no digital pin state">
              <span className="pin-dot input" />
              <span style={{ minWidth: 26 }}>{row.label}</span>
              <span style={{ color: 'var(--text-2)' }}>ADC</span>
            </div>
          );
        }
        const state = snapshot.states[row.pin];
        const duty = snapshot.duty[row.pin];
        const isPwm = state === 'high' || state === 'low' ? duty > 0.02 && duty < 0.98 : false;
        return (
          <div className="pin-chip" key={row.label} title={`${snapshot.toggles[row.pin]} transitions since start`}>
            <span className={`pin-dot ${state === 'high' ? 'high' : state === 'low' ? 'low' : state === 'input-pullup' ? 'pullup' : 'input'}`} />
            <span style={{ minWidth: 26 }}>{row.label}</span>
            <span style={{ color: 'var(--text-2)' }}>
              {state === 'input-pullup' ? 'IN·PU' : state.toUpperCase().slice(0, 5)}
              {isPwm ? ` ${(duty * 100).toFixed(0)}%` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DebugPanel() {
  const simTimeMs = useSimulationStore((s) => s.simTimeMs);
  const speedFactor = useSimulationStore((s) => s.speedFactor);
  const status = useSimulationStore((s) => s.status);
  const error = useSimulationStore((s) => s.error);
  const lastCompile = useEditorStore((s) => s.lastCompile);
  const project = useEditorStore((s) => s.project);

  const stats = useMemo(() => {
    if (!project) return null;
    return {
      boards: project.boardInstances.length,
      components: project.componentInstances.length,
      wires: project.connections.length,
      files: project.codeFiles.length,
      tests: project.tests.length,
    };
  }, [project]);

  return (
    <div className="mono-out">
      <div>Simulation status : {status}{error ? ` — ${error}` : ''}</div>
      <div>Simulated time    : {(simTimeMs / 1000).toFixed(3)} s</div>
      <div>Execution speed   : {(speedFactor * 100).toFixed(0)}% of real time (16 MHz AVR)</div>
      <div>Firmware          : {lastCompile?.success ? `${lastCompile.memory?.flashBytes ?? '?'} bytes flash, built by ${lastCompile.toolchain} in ${(lastCompile.durationMs / 1000).toFixed(1)} s` : 'not compiled'}</div>
      {stats && (
        <div style={{ marginTop: 8, color: 'var(--text-2)' }}>
          Project: {stats.boards} board(s), {stats.components} component(s), {stats.wires} wire(s), {stats.files} code file(s), {stats.tests} test(s)
        </div>
      )}
      <div style={{ marginTop: 8, color: 'var(--text-2)' }}>
        Pipeline: Arduino C++ → {lastCompile?.toolchain ?? 'avr-gcc / arduino-cli'} → Intel HEX → AVR8js (ATmega328P) → port state → circuit graph → component visuals.
      </div>
    </div>
  );
}
