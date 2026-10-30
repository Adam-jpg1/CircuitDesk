import { memo } from 'react';
import type { BoardDefinition } from '../../types';
import type { ComponentVisualState } from '../../simulation/circuitSim';
import { MM } from '../pinHelpers';

/**
 * The BBC micro:bit V2, front face: buttons A and B either side of the 5 x 5
 * LED matrix, the gold edge connector along the bottom. The matrix and the
 * buttons are live while a simulation runs — each LED's glow is the share of
 * the last frame it was actually lit, so a scanned display looks as it does on
 * the real board, and a held button shows pressed.
 *
 * The name on the board is the BBC's and the Micro:bit Educational
 * Foundation's; CircuitDesk's branding stays in the application around it.
 */
export const MicrobitArtwork = memo(function MicrobitArtwork({ def, visual }: { def: BoardDefinition; visual?: ComponentVisualState }) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const m = def.metadata.ledMatrix as { xMm: number; yMm: number; pitchMm: number; rows: string[]; cols: string[] } | undefined;
  const buttons = (def.metadata.onboardButtons as { key: string; xMm: number; yMm: number; rMm: number }[] | undefined) ?? [];
  const held = new Set(visual?.boardButtons ?? []);
  const lit = visual?.matrix;
  const edgeTop = (def.heightMm - 6.2) * MM;

  return (
    <g>
      <rect x="1.5" y="2.5" width={W} height={H} rx={3 * MM} fill="rgba(0,0,0,0.35)" />
      <rect width={W} height={H} rx={3 * MM} fill="#1b2229" stroke="#0a0d10" strokeWidth="1.2" />
      {/* The edge connector's gold, under the pins. */}
      <rect x={1.5 * MM} y={edgeTop} width={W - 3 * MM} height={6.2 * MM} fill="#c9a24a" opacity="0.85" />
      {def.pins.map((p) => {
        const wide = ['P0', 'P1', 'P2', '3V', 'GND'].includes(p.id);
        return wide ? (
          <g key={p.id}>
            <circle cx={p.x} cy={edgeTop + 1.8 * MM} r={1.9 * MM} fill="#1b2229" stroke="#e3c063" strokeWidth={0.6 * MM} />
            <text x={p.x} y={edgeTop - 1.2 * MM} fontSize="6" fontWeight="700" fill="#e8edf2" textAnchor="middle" fontFamily="sans-serif">
              {p.label}
            </text>
          </g>
        ) : null;
      })}

      {/* Buttons A and B */}
      {buttons.map((b) => {
        const down = held.has(b.key);
        return (
          <g key={b.key} data-board-button={b.key}>
            <rect
              x={(b.xMm - b.rMm - 1) * MM}
              y={(b.yMm - b.rMm - 1) * MM}
              width={(b.rMm * 2 + 2) * MM}
              height={(b.rMm * 2 + 2) * MM}
              rx={1.2 * MM}
              fill="#9aa4ad"
              stroke="#5c656e"
            />
            <circle cx={b.xMm * MM} cy={b.yMm * MM} r={b.rMm * MM} fill={down ? '#222a31' : '#353e47'} stroke="#11161b" strokeWidth={down ? 2 : 1} />
            <text x={b.xMm * MM} y={(b.yMm - b.rMm - 2.4) * MM} fontSize="8" fontWeight="700" fill="#e8edf2" textAnchor="middle" fontFamily="sans-serif">
              {b.key}
            </text>
          </g>
        );
      })}

      {/* The 5 x 5 matrix */}
      {m &&
        m.rows.map((_, i) =>
          m.cols.map((__, j) => {
            const x = (m.xMm + (j - (m.cols.length - 1) / 2) * m.pitchMm) * MM;
            const y = (m.yMm + (i - (m.rows.length - 1) / 2) * m.pitchMm) * MM;
            const b = lit?.[i * m.cols.length + j] ?? 0;
            return (
              <g key={`${i}-${j}`} data-matrix-led={`${i},${j}`} data-lit={b > 0.05 ? 'true' : 'false'}>
                {b > 0.05 && <rect x={x - 1.6 * MM} y={y - 2.2 * MM} width={3.2 * MM} height={4.4 * MM} rx={1.2 * MM} fill="#ff3b30" opacity={0.25 * b} />}
                <rect
                  x={x - 0.6 * MM}
                  y={y - 1.1 * MM}
                  width={1.2 * MM}
                  height={2.2 * MM}
                  rx={0.3 * MM}
                  fill={b > 0.05 ? `rgba(255,${Math.round(80 - 40 * b)},${Math.round(60 - 30 * b)},${0.45 + 0.55 * b})` : '#3a2a2a'}
                />
              </g>
            );
          }),
        )}

      {/* Logo (the V2's touch sensor) and the board's name */}
      <ellipse cx={W / 2} cy={4.6 * MM} rx={3 * MM} ry={1.6 * MM} fill="none" stroke="#c9a24a" strokeWidth={0.5 * MM} />
      <text x={W / 2} y={9.6 * MM} fontSize="5.5" fill="#9fb0bf" textAnchor="middle" fontFamily="sans-serif" letterSpacing="0.5">
        micro:bit
      </text>
    </g>
  );
});
