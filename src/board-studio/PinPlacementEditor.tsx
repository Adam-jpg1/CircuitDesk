// Putting the pins where they are on the board.
//
// This is the step nothing else can answer. A CSV knows a pin is called
// SENSOR_SDA and reaches GP4; only the person holding the board knows it is the
// fourth pin down the right-hand edge. So the editor's whole job is to make
// that quick: drag a pin, see it land, and see it land in millimetres because
// that is what the canvas will use.
//
// Two decisions worth stating. Positions are millimetres on the BOARD, not
// pixels on the screen, so a board drawn at any zoom stores the same numbers.
// And a pin that has never been placed is stacked down the left edge rather
// than hidden at 0,0 — an unplaced pin the user cannot see is an unplaced pin
// they will not place.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudioStore } from './studioStore';
import { UNITS_PER_MM } from '../types';
import type { CustomBoardPin } from '../custom-boards/schema';

/** Screen pixels per millimetre in the editor. Fixed: this is a workbench. */
const PX_PER_MM = 6;

const PIN_COLOR: Record<string, string> = {
  'power-5v': '#e05c4a',
  'power-3v3': '#e08a3c',
  'power-vin': '#c94f3c',
  ground: '#4a4f57',
  analog: '#4aa3e0',
  digital: '#3fa66a',
  reset: '#b05ce0',
  aref: '#8a8f97',
  nc: '#5a6069',
};

export function PinPlacementEditor() {
  const draft = useStudioStore((s) => s.draft);
  const selectedPinId = useStudioStore((s) => s.selectedPinId);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);

  const toBoardMm = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = ((clientX - rect.left) / rect.width) * (draft?.outline.widthMm ?? 1);
    const y = ((clientY - rect.top) / rect.height) * (draft?.outline.heightMm ?? 1);
    // 2.54 mm is 0.1 inch, which is the pitch nearly every header on nearly
    // every board is on. Snapping to it is the difference between a pin map
    // that lines up with a breadboard and one that nearly does.
    const step = 2.54;
    return snap
      ? { x: Math.round(x / step) * step, y: Math.round(y / step) * step }
      : { x, y };
  }, [draft?.outline.widthMm, draft?.outline.heightMm, snap]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const at = toBoardMm(e.clientX, e.clientY);
      if (at) useStudioStore.getState().movePin(dragging, at.x, at.y);
    };
    const up = () => setDragging(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging, toBoardMm]);

  if (!draft) return null;
  const { widthMm, heightMm } = draft.outline;

  return (
    <div className="studio-placement">
      <div className="studio-hint">
        <span>
          Drag each pin to where it is on the board. Positions are in millimetres, so they hold at any zoom.
        </span>
        <label className="studio-check">
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
          Snap to 2.54 mm
        </label>
      </div>
      <div className="studio-board-wrap">
        <svg
          ref={svgRef}
          className="studio-board"
          width={widthMm * PX_PER_MM}
          height={heightMm * PX_PER_MM}
          viewBox={`0 0 ${widthMm} ${heightMm}`}
          data-testid="pin-placement"
          onPointerDown={(e) => {
            if (e.target === svgRef.current) useStudioStore.getState().selectPin(null);
          }}
        >
          <rect
            x={0}
            y={0}
            width={widthMm}
            height={heightMm}
            rx={1.5}
            fill={draft.outline.color ?? '#1e3a5f'}
            stroke="rgba(0,0,0,0.5)"
            strokeWidth={0.2}
          />
          {draft.outline.artworkSvg && (
            <image
              href={`data:image/svg+xml;utf8,${encodeURIComponent(draft.outline.artworkSvg)}`}
              x={0}
              y={0}
              width={widthMm}
              height={heightMm}
              preserveAspectRatio="none"
            />
          )}
          {/* A millimetre grid, so "about a third of the way down" becomes a number. */}
          {Array.from({ length: Math.floor(widthMm / 5) }, (_, i) => (
            <line key={`v${i}`} x1={(i + 1) * 5} y1={0} x2={(i + 1) * 5} y2={heightMm} stroke="rgba(255,255,255,0.07)" strokeWidth={0.1} />
          ))}
          {Array.from({ length: Math.floor(heightMm / 5) }, (_, i) => (
            <line key={`h${i}`} x1={0} y1={(i + 1) * 5} x2={widthMm} y2={(i + 1) * 5} stroke="rgba(255,255,255,0.07)" strokeWidth={0.1} />
          ))}
          {draft.pins.map((pin) => (
            <PinHandle
              key={pin.id}
              pin={pin}
              selected={pin.id === selectedPinId}
              onGrab={() => {
                useStudioStore.getState().selectPin(pin.id);
                setDragging(pin.id);
              }}
            />
          ))}
        </svg>
      </div>
      <PinList />
    </div>
  );
}

function PinHandle({ pin, selected, onGrab }: { pin: CustomBoardPin; selected: boolean; onGrab: () => void }) {
  const color = PIN_COLOR[pin.type] ?? '#3fa66a';
  return (
    <g
      transform={`translate(${pin.xMm} ${pin.yMm})`}
      style={{ cursor: 'grab' }}
      data-pin={pin.id}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onGrab();
      }}
    >
      <circle r={selected ? 1.5 : 1.1} fill={color} stroke={selected ? '#fff' : 'rgba(0,0,0,0.55)'} strokeWidth={selected ? 0.35 : 0.18} />
      <text
        x={2.2}
        y={0.5}
        fontSize={1.7}
        fill="rgba(255,255,255,0.92)"
        style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.65)', strokeWidth: 0.4 }}
      >
        {pin.label}
      </text>
    </g>
  );
}

/**
 * The same pins as a list, because a mouse is not the only way to be precise.
 *
 * Typing 3.81 is faster than dragging to it, and a pin that has ended up under
 * another one can only be got at from here.
 */
function PinList() {
  const draft = useStudioStore((s) => s.draft);
  const selectedPinId = useStudioStore((s) => s.selectedPinId);
  if (!draft) return null;
  return (
    <div className="studio-pinlist">
      <table className="kv-table">
        <thead>
          <tr><th>Pin</th><th>Label</th><th>Pad</th><th>X mm</th><th>Y mm</th><th /></tr>
        </thead>
        <tbody>
          {draft.pins.map((pin) => (
            <tr
              key={pin.id}
              className={pin.id === selectedPinId ? 'selected' : undefined}
              onClick={() => useStudioStore.getState().selectPin(pin.id)}
            >
              <td>{pin.id}</td>
              <td>{pin.label}</td>
              <td>{pin.pad ?? <span className="studio-muted">—</span>}</td>
              <td>
                <input
                  type="number"
                  step={0.01}
                  value={pin.xMm}
                  onChange={(e) => useStudioStore.getState().movePin(pin.id, Number(e.target.value), pin.yMm)}
                />
              </td>
              <td>
                <input
                  type="number"
                  step={0.01}
                  value={pin.yMm}
                  onChange={(e) => useStudioStore.getState().movePin(pin.id, pin.xMm, Number(e.target.value))}
                />
              </td>
              <td>
                <button className="btn sm" onClick={() => useStudioStore.getState().removePin(pin.id)}>Remove</button>
              </td>
            </tr>
          ))}
          {draft.pins.length === 0 && (
            <tr><td colSpan={6} className="studio-muted">No pins yet. Add them by hand or import a pin map.</td></tr>
          )}
        </tbody>
      </table>
      <div className="studio-muted" style={{ padding: '6px 8px' }}>
        The canvas draws at {UNITS_PER_MM} units per millimetre, so these are the positions a wire will attach to.
      </div>
    </div>
  );
}
