import { useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { compileAction } from '../app/actions';
import { uid, type TestAssertion, type TestCase, type TestInputEvent, type TestResult } from '../types';
import { Modal, toast } from '../ui/primitives';
import { resolveDefinition } from '../project/partsRegistry';
import type { TestFirmware } from '../testing/testRunner';

/** Shared with the export code so test reports include the latest results. */
export const testResultsCache = new Map<string, TestResult>();

export function TestsPanel() {
  const project = useEditorStore((s) => s.project);
  const lastCompile = useEditorStore((s) => s.lastCompile);
  const [results, setResults] = useState<Map<string, TestResult>>(new Map());
  const [running, setRunning] = useState<string | null>(null);
  const [editing, setEditing] = useState<TestCase | null>(null);

  if (!project) return null;
  const s = useEditorStore.getState();

  /**
   * Returns firmware that genuinely belongs to the board on the canvas.
   * A cached build for another board is never reused — it is rebuilt, and if
   * the rebuild still does not match, tests refuse to run.
   */
  async function ensureFirmware(): Promise<TestFirmware | null> {
    const currentBoardId = useEditorStore.getState().project?.boardInstances[0]
      ? resolveDefinition(useEditorStore.getState().project!.boardInstances[0].definitionId, useEditorStore.getState().project!)?.id
      : undefined;
    let compile = useEditorStore.getState().lastCompile;
    const stale =
      !compile?.success || !compile.firmware || (currentBoardId !== undefined && compile.boardId !== currentBoardId);
    if (stale) {
      toast(
        compile?.success && compile.boardId && compile.boardId !== currentBoardId
          ? 'The cached build targets a different board — recompiling before running tests…'
          : 'Compiling before running tests…',
      );
      const ok = await compileAction(false);
      if (!ok) return null;
      compile = useEditorStore.getState().lastCompile;
    }
    const data = compile?.firmware?.data;
    const boardId = compile?.boardId;
    if (!data || !boardId) return null;
    if (currentBoardId !== undefined && boardId !== currentBoardId) {
      toast('Firmware does not match the board on the canvas — tests were not run.', 'error');
      return null;
    }
    // Everything the engine needs, not just the executable image: an ESP part
    // reads its partition table out of flash before it will run anything.
    return {
      data,
      boardId,
      ...(compile?.firmware?.format ? { format: compile.firmware.format } : {}),
      ...(compile?.firmware?.regions ? { regions: compile.firmware.regions } : {}),
    };
  }

  async function run(test: TestCase) {
    const firmware = await ensureFirmware();
    if (!firmware || !project) return;
    setRunning(test.id);
    try {
      const { runTest } = await import('../testing/testRunner');
      const result = await runTest(project, firmware, test);
      testResultsCache.set(test.id, result);
      setResults(new Map(testResultsCache));
    } finally {
      setRunning(null);
    }
  }

  async function runAll() {
    const firmware = await ensureFirmware();
    if (!firmware || !project) return;
    const { runTest } = await import('../testing/testRunner');
    for (const test of project.tests) {
      setRunning(test.id);
      const result = await runTest(project, firmware, test);
      testResultsCache.set(test.id, result);
      setResults(new Map(testResultsCache));
    }
    setRunning(null);
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <button className="btn sm primary" disabled={running !== null || project.tests.length === 0} onClick={() => void runAll()}>
          Run all tests
        </button>
        <button
          className="btn sm"
          onClick={() =>
            setEditing({
              id: uid('test'),
              name: `Test ${project.tests.length + 1}`,
              events: [],
              assertions: [{ id: uid('as'), kind: 'pin-becomes-high', pin: 13, withinMs: 1000 }],
              timeoutMs: 3000,
            })
          }
        >
          + New test
        </button>
        <span style={{ color: 'var(--text-2)', fontSize: 11.5 }}>
          Tests run compiled firmware on a fresh emulator instance (accelerated, headless).
          {!lastCompile?.success && ' The sketch will be compiled first.'}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {project.tests.length === 0 && (
          <div className="empty-state">
            <p>No tests yet.</p>
            <p style={{ fontSize: 11.5 }}>
              Define tests like “press button → expect D13 HIGH within 500 ms” or “serial contains ‘Ready’”.
            </p>
          </div>
        )}
        {project.tests.map((test) => {
          const r = results.get(test.id);
          return (
            <div className="test-item" key={test.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className={`test-status ${r?.status ?? ''}`}>
                  {running === test.id ? 'RUNNING…' : r ? r.status.toUpperCase() : '—'}
                </span>
                <strong style={{ flex: 1 }}>{test.name}</strong>
                {r && <span style={{ color: 'var(--text-2)', fontSize: 11 }}>{(r.durationMs / 1000).toFixed(1)} s</span>}
                <button className="btn sm" disabled={running !== null} onClick={() => void run(test)}>Run</button>
                <button className="btn sm" onClick={() => setEditing(structuredClone(test))}>Edit</button>
                <button className="btn sm danger" onClick={() => s.removeTest(test.id)}>Delete</button>
              </div>
              {test.description && <div style={{ color: 'var(--text-2)', fontSize: 11.5, marginTop: 3 }}>{test.description}</div>}
              {r && (
                <div style={{ marginTop: 5 }}>
                  {r.assertionResults.map((a) => (
                    <div key={a.assertionId} className={`assertion-row ${a.passed ? 'pass' : 'fail'}`}>
                      {a.expected} — <span style={{ color: a.passed ? 'var(--text-2)' : '#ff8a80' }}>{a.actual}</span>
                    </div>
                  ))}
                  {r.message && <div className="assertion-row fail">{r.message}</div>}
                  {r.timeline && r.timeline.length > 0 && (
                    <details style={{ marginLeft: 20, marginTop: 4, fontSize: 11 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--text-2)' }}>Timeline ({r.timeline.length} events)</summary>
                      <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', maxHeight: 140, overflowY: 'auto', padding: '4px 0' }}>
                        {r.timeline.map((e, i) => (
                          <div key={i}>{e.atMs.toFixed(1).padStart(8)} ms  {e.event}</div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {editing && (
        <TestEditor
          test={editing}
          onSave={(t) => {
            if (project.tests.some((x) => x.id === t.id)) s.updateTest(t);
            else s.addTest(t);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

const ASSERTION_KINDS: { value: TestAssertion['kind']; label: string }[] = [
  { value: 'pin-becomes-high', label: 'Pin becomes HIGH within…' },
  { value: 'pin-becomes-low', label: 'Pin becomes LOW within…' },
  { value: 'pin-high', label: 'Pin is HIGH at time…' },
  { value: 'pin-low', label: 'Pin is LOW at time…' },
  { value: 'pin-toggles', label: 'Pin toggles N× within…' },
  { value: 'serial-contains', label: 'Serial output contains…' },
];

function TestEditor({ test, onSave, onClose }: { test: TestCase; onSave: (t: TestCase) => void; onClose: () => void }) {
  const project = useEditorStore((s) => s.project)!;
  const [draft, setDraft] = useState<TestCase>(test);

  const interactive = project.componentInstances.filter((i) => {
    const def = resolveDefinition(i.definitionId, project);
    return def && ['sim.push-button', 'sim.toggle-switch', 'sim.potentiometer', 'sim.ultrasonic', 'sim.tmp36', 'sim.ldr'].includes(def.simulationAdapterId ?? '');
  });

  const patch = (p: Partial<TestCase>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <Modal title="Edit test" onClose={onClose} width={640} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(draft)}>Save test</button>
      </>
    }>
      <div className="prop-row"><label>Name</label><input style={{ width: 280 }} value={draft.name} onChange={(e) => patch({ name: e.target.value })} /></div>
      <div className="prop-row"><label>Description</label><input style={{ width: 280 }} value={draft.description ?? ''} onChange={(e) => patch({ description: e.target.value })} /></div>
      <div className="prop-row"><label>Duration / timeout (ms)</label><input type="number" value={draft.timeoutMs} onChange={(e) => patch({ timeoutMs: Number(e.target.value) })} /></div>

      <h4 style={{ margin: '14px 0 6px' }}>Input events</h4>
      {draft.events.map((ev, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5, alignItems: 'center' }}>
          <input type="number" style={{ width: 80 }} value={ev.atMs} title="time (ms)" onChange={(e) => {
            const events = [...draft.events]; events[i] = { ...ev, atMs: Number(e.target.value) }; patch({ events });
          }} />
          <span style={{ color: 'var(--text-2)' }}>ms:</span>
          <select value={ev.action} onChange={(e) => { const events = [...draft.events]; events[i] = { ...ev, action: e.target.value as TestInputEvent['action'] }; patch({ events }); }}>
            <option value="press">press</option><option value="release">release</option><option value="toggle">toggle</option>
            <option value="set-analog">set pot (0-1)</option><option value="set-value">set sensor value</option>
          </select>
          <select value={ev.componentId} onChange={(e) => { const events = [...draft.events]; events[i] = { ...ev, componentId: e.target.value }; patch({ events }); }}>
            {interactive.map((c) => {
              const def = resolveDefinition(c.definitionId, project);
              return <option key={c.id} value={c.id}>{c.label || def?.name || c.id}</option>;
            })}
          </select>
          {(ev.action === 'set-analog' || ev.action === 'set-value') && (
            <input type="number" style={{ width: 70 }} step="0.1" value={ev.value ?? 0} onChange={(e) => { const events = [...draft.events]; events[i] = { ...ev, value: Number(e.target.value) }; patch({ events }); }} />
          )}
          <button className="btn sm danger" onClick={() => patch({ events: draft.events.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <button
        className="btn sm"
        disabled={interactive.length === 0}
        title={interactive.length === 0 ? 'Add an interactive part (button, pot, sensor) to the canvas first' : ''}
        onClick={() => patch({ events: [...draft.events, { atMs: 300, action: 'press', componentId: interactive[0].id }] })}
      >
        + Add event
      </button>

      <h4 style={{ margin: '14px 0 6px' }}>Assertions</h4>
      {draft.assertions.map((a, i) => (
        <div key={a.id} style={{ display: 'flex', gap: 6, marginBottom: 5, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={a.kind} onChange={(e) => { const assertions = [...draft.assertions]; assertions[i] = { ...a, kind: e.target.value as TestAssertion['kind'] }; patch({ assertions }); }}>
            {ASSERTION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          {a.kind !== 'serial-contains' && (
            <>
              <span style={{ color: 'var(--text-2)' }}>pin</span>
              <input type="number" style={{ width: 60 }} value={a.pin ?? 13} onChange={(e) => { const assertions = [...draft.assertions]; assertions[i] = { ...a, pin: Number(e.target.value) }; patch({ assertions }); }} />
            </>
          )}
          {a.kind === 'serial-contains' && (
            <input style={{ width: 160 }} placeholder="text" value={a.text ?? ''} onChange={(e) => { const assertions = [...draft.assertions]; assertions[i] = { ...a, text: e.target.value }; patch({ assertions }); }} />
          )}
          {(a.kind === 'pin-becomes-high' || a.kind === 'pin-becomes-low' || a.kind === 'pin-toggles' || a.kind === 'serial-contains') && (
            <>
              <span style={{ color: 'var(--text-2)' }}>within</span>
              <input type="number" style={{ width: 80 }} value={a.withinMs ?? 1000} onChange={(e) => { const assertions = [...draft.assertions]; assertions[i] = { ...a, withinMs: Number(e.target.value) }; patch({ assertions }); }} />
              <span style={{ color: 'var(--text-2)' }}>ms</span>
            </>
          )}
          {(a.kind === 'pin-high' || a.kind === 'pin-low') && (
            <>
              <span style={{ color: 'var(--text-2)' }}>at</span>
              <input type="number" style={{ width: 80 }} value={a.atMs ?? 1000} onChange={(e) => { const assertions = [...draft.assertions]; assertions[i] = { ...a, atMs: Number(e.target.value) }; patch({ assertions }); }} />
              <span style={{ color: 'var(--text-2)' }}>ms, hold</span>
              <input type="number" style={{ width: 70 }} value={a.holdMs ?? 0} onChange={(e) => { const assertions = [...draft.assertions]; assertions[i] = { ...a, holdMs: Number(e.target.value) }; patch({ assertions }); }} />
            </>
          )}
          {a.kind === 'pin-toggles' && (
            <>
              <span style={{ color: 'var(--text-2)' }}>min</span>
              <input type="number" style={{ width: 60 }} value={a.minToggles ?? 2} onChange={(e) => { const assertions = [...draft.assertions]; assertions[i] = { ...a, minToggles: Number(e.target.value) }; patch({ assertions }); }} />
            </>
          )}
          <button className="btn sm danger" onClick={() => patch({ assertions: draft.assertions.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <button className="btn sm" onClick={() => patch({ assertions: [...draft.assertions, { id: uid('as'), kind: 'pin-becomes-high', pin: 13, withinMs: 1000 }] })}>
        + Add assertion
      </button>
    </Modal>
  );
}
