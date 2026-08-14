// A bigger keyboard to press, wired to the same contacts as the small one.
//
// The 50-key matrix is 118 mm across, which at the canvas's own zoom is a key
// about nine pixels wide. That is accurate — it is a small keyboard — and it is
// also close to unusable, so this is the panel you actually type on.
//
// What it is NOT is a keyboard driver. There is no HID, no character queue and
// nothing that reaches the firmware except by the route the hardware uses: a
// key here closes a crossing in the matrix, exactly as clicking the part on the
// canvas does, and firmware finds out by scanning its rows and columns. If the
// sketch never scans, pressing keys here does nothing at all — which is what
// would happen on the bench.
//
// The keys drawn are `interactiveHotspots`' own grid and the pressed state is
// the simulation's own contact map, so this panel cannot disagree with the part
// it is a view of.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../app/editorStore';
import { useSimulationStore } from '../simulation/simulationStore';
import { resolveDefinition } from '../project/partsRegistry';
import { interactiveHotspots } from '../components-library/artwork/interactiveGeometry';
import { contactStateKey } from '../simulation/devices/contacts';
import { keyCapDescription } from '../simulation/devices/matrixInput';
import type { ComponentDefinition } from '../types';

/** How much bigger than the part the overlay draws it. */
const SCALE = 2.6;

/**
 * Physical keys mapped onto matrix caps.
 *
 * A deliberate list rather than "whatever the browser reports", because the
 * mapping has to be to a *cap on this part* — a key the part does not have
 * cannot be pressed, and pretending otherwise is how a fake keyboard starts.
 */
function capForKeyboardEvent(e: KeyboardEvent): string | null {
  if (e.key.length === 1) return e.key.toUpperCase();
  switch (e.key) {
    case 'Enter': return '↵';
    case 'Backspace': return '⌫';
    case 'Shift': return '⇧';
    case 'Control': return 'C̲';
    case 'ArrowLeft': return '←';
    case 'ArrowRight': return '→';
    case ' ': return ' ';
    default: return null;
  }
}

/**
 * A key's legend, or a bar for the ones whose legend is a space.
 *
 * A blank cap is a real cap — four of the mini keyboard's keys are the space
 * bar — and drawing nothing on it makes them look like keys that failed to
 * render rather than keys with nothing printed on them.
 */
function KeyCap({ x, y, w, h, cap, down }: { x: number; y: number; w: number; h: number; cap: string; down: boolean }) {
  const colour = down ? '#eaf3ff' : '#d5dde5';
  if (cap.trim() === '') {
    return <rect x={x - w * 0.24} y={y + h * 0.52} width={w * 0.48} height={Math.max(1, h * 0.05)} rx="1" fill={colour} opacity="0.7" />;
  }
  return (
    <text
      x={x}
      y={y + h * 0.68}
      textAnchor="middle"
      fontSize={h * 0.5}
      fill={colour}
      fontFamily="sans-serif"
      fontWeight={600}
    >
      {cap.trim()}
    </text>
  );
}

export function KeyMatrixOverlay({ instanceId, onClose }: { instanceId: string; onClose: () => void }) {
  const project = useEditorStore((s) => s.project);
  const status = useSimulationStore((s) => s.status);
  const visual = useSimulationStore((s) => s.visuals[instanceId]);
  const [latching, setLatching] = useState(false);
  const [captureKeys, setCaptureKeys] = useState(false);
  // Every contact this panel is currently holding down, so closing can let go
  // of exactly what it took and nothing else.
  const held = useRef(new Set<string>());

  const inst = project?.componentInstances.find((i) => i.id === instanceId);
  const def = inst && project ? resolveDefinition(inst.definitionId, project) : undefined;
  const keys = useMemo(
    () => (def && inst ? interactiveHotspots(def as ComponentDefinition, inst) : []),
    [def, inst],
  );

  const press = useCallback((key: string, down: boolean) => {
    const stateKey = contactStateKey(instanceId, key);
    useSimulationStore.getState().pressButton(stateKey, down);
    if (down) held.current.add(stateKey);
    else held.current.delete(stateKey);
  }, [instanceId]);

  const releaseAll = useCallback(() => {
    for (const stateKey of held.current) useSimulationStore.getState().pressButton(stateKey, false);
    held.current.clear();
  }, []);

  // Leaving must not leave a key stuck down: a latched key that outlives its
  // panel is a contact nothing can reach to open again.
  useEffect(() => releaseAll, [releaseAll]);

  // A stopped simulation has no contact state to hold, and resuming with a
  // stale held set would close contacts nobody is pressing.
  useEffect(() => {
    if (status !== 'running') releaseAll();
  }, [status, releaseAll]);

  // Escape closes it whether or not it is capturing keys, because a panel that
  // has taken the keyboard needs an exit that does not require finding a button.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  useEffect(() => {
    if (!captureKeys) return;
    const byCap = new Map(keys.map((k) => [k.cap.trim() || ' ', k.key]));
    const down = (e: KeyboardEvent) => {
      const cap = capForKeyboardEvent(e);
      const key = cap === null ? undefined : byCap.get(cap.trim() || ' ');
      if (!key) return;
      e.preventDefault();
      if (!e.repeat) press(key, true);
    };
    const up = (e: KeyboardEvent) => {
      const cap = capForKeyboardEvent(e);
      const key = cap === null ? undefined : byCap.get(cap.trim() || ' ');
      if (!key) return;
      e.preventDefault();
      press(key, false);
    };
    // A window that loses focus never delivers the keyup, so anything still
    // down when it happens has to be let go of here.
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAll);
      releaseAll();
    };
  }, [captureKeys, keys, press, releaseAll]);

  if (!def || !inst || keys.length === 0) return null;

  const w = def.widthMm * 4;
  const h = Math.max(...keys.map((k) => k.y + k.h)) + 6;
  const running = status === 'running';
  const downCount = Object.values(visual?.contacts ?? {}).filter(Boolean).length;

  return (
    <div className="keymatrix-overlay" data-testid="keymatrix-overlay">
      <div className="keymatrix-head">
        <strong>{def.name}</strong>
        <span className="keymatrix-note">
          {running
            ? `${downCount} key${downCount === 1 ? '' : 's'} down — closing matrix crossings, not sending characters`
            : 'Start the simulation to close contacts'}
        </span>
        <label className="keymatrix-toggle">
          <input type="checkbox" checked={latching} onChange={(e) => { setLatching(e.target.checked); if (!e.target.checked) releaseAll(); }} />
          Hold keys
        </label>
        <label className="keymatrix-toggle">
          <input type="checkbox" checked={captureKeys} onChange={(e) => setCaptureKeys(e.target.checked)} />
          Use my keyboard
        </label>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      <svg width={w * SCALE} height={h * SCALE} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
        {keys.map((k) => {
          const down = Boolean(visual?.contacts?.[k.key]);
          return (
            <g
              key={k.key}
              style={{ cursor: running ? 'pointer' : 'not-allowed' }}
              onPointerDown={(e) => {
                if (!running) return;
                e.preventDefault();
                if (latching) press(k.key, !down);
                else {
                  press(k.key, true);
                  const release = () => {
                    press(k.key, false);
                    window.removeEventListener('pointerup', release);
                  };
                  window.addEventListener('pointerup', release);
                }
              }}
            >
              <title>{`${keyCapDescription(k.cap)} — row/column crossing ${k.key}`}</title>
              <rect
                x={k.x}
                y={k.y + (down ? k.h * 0.05 : 0)}
                width={k.w}
                height={k.h}
                rx={k.radius}
                fill={down ? '#1f262e' : '#39424c'}
                stroke={down ? '#7fb2e8' : '#1a1f25'}
                strokeWidth={down ? 1.4 : 0.7}
              />
              {down ? (
                <rect x={k.x} y={k.y + k.h * 0.05} width={k.w} height={k.h * 0.4} rx={k.radius} fill="rgba(0,0,0,0.55)" />
              ) : (
                <rect x={k.x} y={k.y} width={k.w} height={k.h * 0.42} rx={k.radius} fill="rgba(255,255,255,0.09)" />
              )}
              <KeyCap
                x={k.x + k.w / 2}
                y={k.y + (down ? k.h * 0.05 : 0)}
                w={k.w}
                h={k.h}
                cap={k.cap}
                down={down}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
