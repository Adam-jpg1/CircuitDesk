import { useRef, useState } from 'react';
import type { ImportedPin } from './types';

/**
 * Shared pin placement editor: shows the board artwork at physical scale,
 * click to add pins, drag to move them, edit metadata in the table.
 */
export function PinPlacementEditor({
  svg,
  imageDataUrl,
  widthMm,
  heightMm,
  pins,
  onChange,
}: {
  svg?: string;
  imageDataUrl?: string;
  widthMm: number;
  heightMm: number;
  pins: ImportedPin[];
  onChange: (pins: ImportedPin[]) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<string | null>(null);

  const viewW = 460;
  const scale = viewW / widthMm;
  const viewH = Math.min(360, heightMm * scale);
  const effScale = Math.min(scale, viewH / heightMm);

  const toMm = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(widthMm, (e.clientX - rect.left) / effScale)),
      y: Math.max(0, Math.min(heightMm, (e.clientY - rect.top) / effScale)),
    };
  };

  const artHref = svg ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}` : imageDataUrl;

  return (
    <div style={{ display: 'flex', gap: 14, minHeight: 0 }}>
      <div>
        <svg
          ref={svgRef}
          width={widthMm * effScale}
          height={heightMm * effScale}
          style={{ background: '#10151b', border: '1px solid var(--border)', borderRadius: 6, cursor: 'crosshair', flexShrink: 0 }}
          onPointerDown={(e) => {
            if (dragging.current) return;
            const { x, y } = toMm(e);
            const pin: ImportedPin = { id: `pin${pins.length + 1}_${Date.now() % 10000}`, label: `P${pins.length + 1}`, xMm: x, yMm: y };
            onChange([...pins, pin]);
            setSelected(pin.id);
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            const { x, y } = toMm(e);
            onChange(pins.map((p) => (p.id === dragging.current ? { ...p, xMm: x, yMm: y } : p)));
          }}
          onPointerUp={() => {
            dragging.current = null;
          }}
        >
          {artHref && <image href={artHref} width={widthMm * effScale} height={heightMm * effScale} preserveAspectRatio="xMidYMid meet" />}
          {!artHref && <rect width={widthMm * effScale} height={heightMm * effScale} fill="#1d2530" rx="4" />}
          {pins.map((p) => (
            <g key={p.id}>
              <circle
                cx={p.xMm * effScale}
                cy={p.yMm * effScale}
                r={selected === p.id ? 7 : 5}
                fill={selected === p.id ? 'rgba(61,157,242,0.9)' : 'rgba(201,162,39,0.9)'}
                stroke="#0d1117"
                style={{ cursor: 'grab' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  dragging.current = p.id;
                  setSelected(p.id);
                  (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                }}
              />
              <text x={p.xMm * effScale} y={p.yMm * effScale - 8} fontSize="9" fill="#cfe6ff" textAnchor="middle" pointerEvents="none">
                {p.label}
              </text>
            </g>
          ))}
        </svg>
        <div style={{ color: 'var(--text-2)', fontSize: 11, marginTop: 4 }}>
          Click the artwork to add a pin · drag pins to reposition · {widthMm.toFixed(1)} × {heightMm.toFixed(1)} mm
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', maxHeight: 380 }}>
        <table className="kv-table">
          <thead>
            <tr><th>Label</th><th>X (mm)</th><th>Y (mm)</th><th>Type</th><th>V</th><th /></tr>
          </thead>
          <tbody>
            {pins.map((p) => (
              <tr key={p.id} style={selected === p.id ? { background: 'var(--bg-3)' } : undefined} onClick={() => setSelected(p.id)}>
                <td><input style={{ width: 76, padding: '2px 5px' }} value={p.label} onChange={(e) => onChange(pins.map((q) => (q.id === p.id ? { ...q, label: e.target.value } : q)))} /></td>
                <td><input style={{ width: 58, padding: '2px 5px' }} type="number" step="0.1" value={Number(p.xMm.toFixed(2))} onChange={(e) => onChange(pins.map((q) => (q.id === p.id ? { ...q, xMm: Number(e.target.value) } : q)))} /></td>
                <td><input style={{ width: 58, padding: '2px 5px' }} type="number" step="0.1" value={Number(p.yMm.toFixed(2))} onChange={(e) => onChange(pins.map((q) => (q.id === p.id ? { ...q, yMm: Number(e.target.value) } : q)))} /></td>
                <td>
                  <select style={{ padding: '2px 4px' }} value={p.type ?? 'passive'} onChange={(e) => onChange(pins.map((q) => (q.id === p.id ? { ...q, type: e.target.value as ImportedPin['type'] } : q)))}>
                    {['passive', 'digital', 'analog', 'power-5v', 'power-3v3', 'power-vin', 'ground', 'reset', 'nc'].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td><input style={{ width: 44, padding: '2px 5px' }} type="number" step="0.1" value={p.voltage ?? ''} placeholder="—" onChange={(e) => onChange(pins.map((q) => (q.id === p.id ? { ...q, voltage: e.target.value === '' ? undefined : Number(e.target.value) } : q)))} /></td>
                <td><button className="btn sm danger" onClick={() => onChange(pins.filter((q) => q.id !== p.id))}>×</button></td>
              </tr>
            ))}
            {pins.length === 0 && (
              <tr><td colSpan={6} style={{ color: 'var(--text-2)', padding: 12 }}>No pins yet — click the artwork to place them.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
