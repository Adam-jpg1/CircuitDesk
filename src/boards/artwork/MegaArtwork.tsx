import { memo } from 'react';
import type { BoardDefinition } from '../../types';
import { MM } from '../pinHelpers';

/**
 * Vector artwork for the Arduino Mega 2560. Header strips and pin
 * holes are generated from the pin definitions themselves (same approach as
 * the Uno artwork), so the visual always matches the interactive connection
 * points — including the 2x18 double header.
 */
export const MegaArtwork = memo(function MegaArtwork({ def }: { def: BoardDefinition }) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;

  // Group pins into header strips: horizontal runs share a y, the double
  // header forms two vertical columns.
  const horizontal = def.pins.filter((p) => p.y < 4 * MM || p.y > H - 4 * MM);
  const vertical = def.pins.filter((p) => !horizontal.includes(p));

  const rowBlocks: { x1: number; x2: number; y: number; pins: typeof def.pins }[] = [];
  for (const p of [...horizontal].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = rowBlocks[rowBlocks.length - 1];
    if (last && Math.abs(p.y - last.y) < 2 && p.x - last.x2 < 6 * MM) {
      last.x2 = p.x;
      last.pins.push(p);
    } else {
      rowBlocks.push({ x1: p.x, x2: p.x, y: p.y, pins: [p] });
    }
  }

  const colXs = [...new Set(vertical.map((p) => Math.round(p.x)))];
  const colMinY = vertical.length > 0 ? Math.min(...vertical.map((p) => p.y)) : 0;
  const colMaxY = vertical.length > 0 ? Math.max(...vertical.map((p) => p.y)) : 0;

  return (
    <g>
      <defs>
        <linearGradient id="mega-pcb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1f7cb8" />
          <stop offset="1" stopColor="#155e8f" />
        </linearGradient>
        <linearGradient id="mega-metal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d7dde3" />
          <stop offset="0.5" stopColor="#aab3bc" />
          <stop offset="1" stopColor="#8a949e" />
        </linearGradient>
      </defs>

      <rect x="2" y="3" width={W} height={H} rx="10" fill="rgba(0,0,0,0.35)" />
      <rect width={W} height={H} rx="10" fill="url(#mega-pcb)" stroke="#0d4166" strokeWidth="1.5" />

      {/* subtle traces */}
      <g stroke="#2c8ac2" strokeWidth="1.2" fill="none" opacity="0.45">
        <path d={`M${30 * MM} ${12 * MM} h${14 * MM} v${9 * MM} h${18 * MM}`} />
        <path d={`M${26 * MM} ${42 * MM} h${20 * MM} v-${7 * MM} h${16 * MM}`} />
        <path d={`M${70 * MM} ${18 * MM} v${10 * MM} h${12 * MM}`} />
      </g>

      {/* mounting holes */}
      {[[2.6, 2.6], [66, 7.6], [66, 35.5], [15.3, 50.6], [96, 2.6], [96, 50.6]].map(([x, y], i) => (
        <g key={i}>
          <circle cx={x * MM} cy={y * MM} r={1.6 * MM} fill="#0d4166" />
          <circle cx={x * MM} cy={y * MM} r={1.0 * MM} fill="#0d1117" />
        </g>
      ))}

      {/* USB-B + barrel jack at the left edge */}
      <g>
        <rect x={-2 * MM} y={7.5 * MM} width={16 * MM} height={12 * MM} rx="3" fill="url(#mega-metal)" stroke="#6b747d" />
        <rect x={0.5 * MM} y={10 * MM} width={10 * MM} height={7 * MM} rx="1.5" fill="#59626b" />
      </g>
      <g>
        <rect x={-2 * MM} y={38.5 * MM} width={13.5 * MM} height={11 * MM} rx="4" fill="#14181d" stroke="#000" />
        <circle cx={1 * MM} cy={44 * MM} r={2.6 * MM} fill="#090b0e" />
      </g>

      {/* ATmega2560 TQFP-100 */}
      <g>
        <rect x={54 * MM} y={22 * MM} width={16 * MM} height={16 * MM} rx="1.5" fill="#15181c" stroke="#000" />
        <circle cx={56 * MM} cy={24 * MM} r="2.4" fill="#2c333b" />
        {Array.from({ length: 22 }).map((_, i) => {
          const off = (54.8 + i * 0.7) * MM;
          return (
            <g key={i} fill="#9aa4ad">
              <rect x={off} y={21.2 * MM} width="1.6" height={0.9 * MM} />
              <rect x={off} y={37.9 * MM} width="1.6" height={0.9 * MM} />
              <rect x={53.2 * MM} y={(22.8 + i * 0.7) * MM} width={0.9 * MM} height="1.6" />
              <rect x={69.9 * MM} y={(22.8 + i * 0.7) * MM} width={0.9 * MM} height="1.6" />
            </g>
          );
        })}
        <text x={62 * MM} y={30.5 * MM} fontSize="6.5" fill="#8b949e" fontFamily="monospace" textAnchor="middle">
          ATMEGA
        </text>
        <text x={62 * MM} y={33 * MM} fontSize="6.5" fill="#8b949e" fontFamily="monospace" textAnchor="middle">
          2560
        </text>
      </g>

      {/* crystal, regulator, passives */}
      <rect x={44 * MM} y={28 * MM} width={9 * MM} height={3.6 * MM} rx={1.8 * MM} fill="url(#mega-metal)" stroke="#79828b" />
      <rect x={13 * MM} y={42 * MM} width={6.5 * MM} height={5 * MM} rx="1" fill="#22282f" stroke="#000" />
      <circle cx={24 * MM} cy={44 * MM} r={3.2 * MM} fill="#20262d" stroke="#0c0f13" />
      <circle cx={31 * MM} cy={44 * MM} r={3.2 * MM} fill="#20262d" stroke="#0c0f13" />

      {/* reset button + status LEDs */}
      <g>
        <rect x={5.5 * MM} y={24 * MM} width={6.2 * MM} height={6.2 * MM} rx="1" fill="#c7ccd1" stroke="#8a939c" />
        <circle cx={8.6 * MM} cy={27.1 * MM} r={2 * MM} fill="#b33a3a" stroke="#7d2626" />
      </g>
      <g fontFamily="monospace" fontSize="6" fill="#cfe3f0">
        <rect x={36 * MM} y={17 * MM} width={2.6 * MM} height={1.6 * MM} fill="#4a4a35" stroke="#2a2a15" strokeWidth="0.5" />
        <text x={40 * MM} y={18.5 * MM}>L</text>
        <rect x={36 * MM} y={20 * MM} width={2.6 * MM} height={1.6 * MM} fill="#3a4a35" stroke="#1d2a1a" strokeWidth="0.5" />
        <text x={40 * MM} y={21.5 * MM}>ON</text>
      </g>

      {/* Board name silkscreen.

          This is a third-party product, and the artwork says so. CircuitDesk
          did not make this board, and marking it as though it had would
          misrepresent whose hardware a learner is looking at. The name here is
          the manufacturer's own; CircuitDesk's branding belongs in the
          application around the canvas, not on the board on it. */}
      <text x={22 * MM} y={34 * MM} fontSize="10" fontWeight="700" fill="#e8f1f8" fontFamily="sans-serif" letterSpacing="0.5">
        ARDUINO MEGA 2560
      </text>
      <text x={22 * MM} y={37 * MM} fontSize="6.5" fill="#a9c8dd" fontFamily="sans-serif">
        ATmega2560
      </text>

      {/* double-header body */}
      {colXs.length > 0 && (
        <rect
          x={Math.min(...colXs) - 1.4 * MM}
          y={colMinY - 1.4 * MM}
          width={Math.max(...colXs) - Math.min(...colXs) + 2.8 * MM}
          height={colMaxY - colMinY + 2.8 * MM}
          rx="2"
          fill="#14181d"
          stroke="#000"
        />
      )}

      {/* horizontal header strips */}
      {rowBlocks.map((block, i) => {
        const isTop = block.y < H / 2;
        return (
          <g key={i}>
            <rect
              x={block.x1 - 1.6 * MM}
              y={block.y - 1.3 * MM}
              width={block.x2 - block.x1 + 3.2 * MM}
              height={2.6 * MM}
              rx="2"
              fill="#14181d"
              stroke="#000"
            />
            {block.pins.map((p) => (
              <g key={p.id}>
                <circle cx={p.x} cy={p.y} r={0.9 * MM} fill="#c9a227" stroke="#7a6114" strokeWidth="0.6" />
                <circle cx={p.x} cy={p.y} r={0.4 * MM} fill="#3d3312" />
                <text
                  x={p.x}
                  y={isTop ? block.y + 2.6 * MM : block.y - 2.6 * MM}
                  fontSize="4.6"
                  fill="#dce9f3"
                  fontFamily="monospace"
                  textAnchor={isTop ? 'start' : 'end'}
                  transform={`rotate(90 ${p.x} ${isTop ? block.y + 2.6 * MM : block.y - 2.6 * MM})`}
                >
                  {p.label}
                </text>
              </g>
            ))}
          </g>
        );
      })}

      {/* double-header pads */}
      {vertical.map((p) => (
        <g key={p.id}>
          <circle cx={p.x} cy={p.y} r={0.85 * MM} fill="#c9a227" stroke="#7a6114" strokeWidth="0.6" />
          <circle cx={p.x} cy={p.y} r={0.35 * MM} fill="#3d3312" />
        </g>
      ))}
    </g>
  );
});
