import { memo } from 'react';
import type { BoardDefinition } from '../../types';
import { MM } from '../pinHelpers';

/**
 * Vector artwork for the Leonardo-compatible board. Header strips and pin
 * holes are generated from the pin definitions themselves (same approach as
 * the Uno and Mega artwork), so the visual always matches the interactive
 * connection points — including the ICSP block.
 */
export const LeonardoArtwork = memo(function LeonardoArtwork({ def }: { def: BoardDefinition }) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;

  // Header pins sit along the top and bottom edges; anything else (the ICSP
  // 2x3) is drawn as its own block.
  const edge = def.pins.filter((p) => p.y < 6 * MM || p.y > H - 6 * MM);
  const icsp = def.pins.filter((p) => !edge.includes(p));

  const rowBlocks: { x1: number; x2: number; y: number; pins: typeof def.pins }[] = [];
  for (const p of [...edge].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = rowBlocks[rowBlocks.length - 1];
    if (last && Math.abs(p.y - last.y) < 2 && p.x - last.x2 < 6 * MM) {
      last.x2 = p.x;
      last.pins.push(p);
    } else {
      rowBlocks.push({ x1: p.x, x2: p.x, y: p.y, pins: [p] });
    }
  }

  return (
    <g>
      <defs>
        <linearGradient id="leo-pcb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1f7cb8" />
          <stop offset="1" stopColor="#155e8f" />
        </linearGradient>
        <linearGradient id="leo-metal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d7dde3" />
          <stop offset="0.5" stopColor="#aab3bc" />
          <stop offset="1" stopColor="#8a949e" />
        </linearGradient>
      </defs>

      <rect x="2" y="3" width={W} height={H} rx="10" fill="rgba(0,0,0,0.35)" />
      <rect width={W} height={H} rx="10" fill="url(#leo-pcb)" stroke="#0d4166" strokeWidth="1.5" />

      {/* subtle traces */}
      <g stroke="#2c8ac2" strokeWidth="1.2" fill="none" opacity="0.45">
        <path d={`M${24 * MM} ${12 * MM} h${12 * MM} v${8 * MM} h${14 * MM}`} />
        <path d={`M${20 * MM} ${42 * MM} h${16 * MM} v-${6 * MM} h${12 * MM}`} />
      </g>

      {/* mounting holes */}
      {[[2.6, 15.3], [15.3, 50.6], [66, 7.6], [66, 35.5]].map(([x, y], i) => (
        <g key={i}>
          <circle cx={x * MM} cy={y * MM} r={1.6 * MM} fill="#0d4166" />
          <circle cx={x * MM} cy={y * MM} r={1.0 * MM} fill="#0d1117" />
        </g>
      ))}

      {/* micro-USB (the Leonardo's native USB port) + barrel jack */}
      <g>
        <rect x={-1 * MM} y={9.5 * MM} width={9 * MM} height={5.5 * MM} rx="1.6" fill="url(#leo-metal)" stroke="#6b747d" />
        <rect x={0.4 * MM} y={11 * MM} width={5.5 * MM} height={2.6 * MM} rx="0.8" fill="#59626b" />
      </g>
      <g>
        <rect x={-2 * MM} y={38.5 * MM} width={13.5 * MM} height={11 * MM} rx="4" fill="#14181d" stroke="#000" />
        <circle cx={1 * MM} cy={44 * MM} r={2.6 * MM} fill="#090b0e" />
      </g>

      {/* ATmega32U4 (TQFP-44, surface mount — no DIP socket on this board) */}
      <g>
        <rect x={36 * MM} y={26 * MM} width={11 * MM} height={11 * MM} rx="1.2" fill="#15181c" stroke="#000" />
        <circle cx={37.6 * MM} cy={27.6 * MM} r="2.2" fill="#2c333b" />
        {Array.from({ length: 11 }).map((_, i) => {
          const off = (36.6 + i * 0.95) * MM;
          return (
            <g key={i} fill="#9aa4ad">
              <rect x={off} y={25.4 * MM} width="1.5" height={0.8 * MM} />
              <rect x={off} y={36.9 * MM} width="1.5" height={0.8 * MM} />
              <rect x={35.4 * MM} y={(26.6 + i * 0.95) * MM} width={0.8 * MM} height="1.5" />
              <rect x={46.9 * MM} y={(26.6 + i * 0.95) * MM} width={0.8 * MM} height="1.5" />
            </g>
          );
        })}
        <text x={41.5 * MM} y={30.6 * MM} fontSize="5" fill="#8b949e" fontFamily="monospace" textAnchor="middle">
          ATMEGA
        </text>
        <text x={41.5 * MM} y={33 * MM} fontSize="5" fill="#8b949e" fontFamily="monospace" textAnchor="middle">
          32U4
        </text>
      </g>

      {/* crystal, regulator, passives */}
      <rect x={28 * MM} y={30 * MM} width={6 * MM} height={3 * MM} rx={1.5 * MM} fill="url(#leo-metal)" stroke="#79828b" />
      <rect x={13 * MM} y={42 * MM} width={6.5 * MM} height={5 * MM} rx="1" fill="#22282f" stroke="#000" />
      <circle cx={24 * MM} cy={44 * MM} r={3.2 * MM} fill="#20262d" stroke="#0c0f13" />

      {/* reset button + status LEDs */}
      <g>
        <rect x={5.5 * MM} y={24 * MM} width={6.2 * MM} height={6.2 * MM} rx="1" fill="#c7ccd1" stroke="#8a939c" />
        <circle cx={8.6 * MM} cy={27.1 * MM} r={2 * MM} fill="#b33a3a" stroke="#7d2626" />
      </g>
      <g fontFamily="monospace" fontSize="6" fill="#cfe3f0">
        <rect x={22 * MM} y={17 * MM} width={2.6 * MM} height={1.6 * MM} fill="#4a4a35" stroke="#2a2a15" strokeWidth="0.5" />
        <text x={26 * MM} y={18.5 * MM}>L</text>
        <rect x={22 * MM} y={20 * MM} width={2.6 * MM} height={1.6 * MM} fill="#3a4a35" stroke="#1d2a1a" strokeWidth="0.5" />
        <text x={26 * MM} y={21.5 * MM}>ON</text>
      </g>

      {/* silkscreen */}
      <text x={16 * MM} y={34 * MM} fontSize="9" fontWeight="700" fill="#e8f1f8" fontFamily="sans-serif" letterSpacing="0.5">
        CIRCUITDESK LEONARDO
      </text>
      <text x={16 * MM} y={37 * MM} fontSize="6" fill="#a9c8dd" fontFamily="sans-serif">
        ATmega32U4 · native USB
      </text>

      {/* ICSP block */}
      {icsp.length > 0 && (
        <rect
          x={Math.min(...icsp.map((p) => p.x)) - 1.4 * MM}
          y={Math.min(...icsp.map((p) => p.y)) - 1.4 * MM}
          width={Math.max(...icsp.map((p) => p.x)) - Math.min(...icsp.map((p) => p.x)) + 2.8 * MM}
          height={Math.max(...icsp.map((p) => p.y)) - Math.min(...icsp.map((p) => p.y)) + 2.8 * MM}
          rx="2"
          fill="#14181d"
          stroke="#000"
        />
      )}
      {icsp.map((p) => (
        <g key={p.id}>
          <circle cx={p.x} cy={p.y} r={0.85 * MM} fill="#c9a227" stroke="#7a6114" strokeWidth="0.6" />
          <circle cx={p.x} cy={p.y} r={0.35 * MM} fill="#3d3312" />
        </g>
      ))}

      {/* edge header strips */}
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
    </g>
  );
});
