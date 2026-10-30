import { memo } from 'react';
import type { BoardDefinition } from '../../types';
import { MM } from '../pinHelpers';

/**
 * Detailed vector artwork for the Arduino Uno R3. Header strips and pin
 * holes are generated from the pin definitions themselves, so the visual
 * always matches the interactive connection points.
 */
export const UnoArtwork = memo(function UnoArtwork({ def }: { def: BoardDefinition }) {
  // The Uno R4 Minima is the same board shape with different silicon: it names itself.
  const title = typeof def.metadata?.artworkTitle === 'string' ? def.metadata.artworkTitle : 'ARDUINO UNO R3';
  const chip = typeof def.metadata?.artworkChip === 'string' ? def.metadata.artworkChip : 'ATmega328P';
  const chipMark = typeof def.metadata?.artworkChipMark === 'string' ? def.metadata.artworkChipMark : 'ATMEGA328P';
  // The R4 runs from the RA4M1's internal oscillator: no 16 MHz crystal to draw.
  const crystal = def.metadata?.artworkCrystal !== false;
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const topPins = def.pins.filter((p) => p.y < H / 2);
  const bottomPins = def.pins.filter((p) => p.y >= H / 2);

  const headerBlocks = (pins: typeof def.pins) => {
    const sorted = [...pins].sort((a, b) => a.x - b.x);
    const blocks: { x1: number; x2: number; y: number; pins: typeof def.pins }[] = [];
    for (const p of sorted) {
      const last = blocks[blocks.length - 1];
      if (last && p.x - last.x2 < 6 * MM && Math.abs(p.y - last.y) < 2) {
        last.x2 = p.x;
        last.pins.push(p);
      } else {
        blocks.push({ x1: p.x, x2: p.x, y: p.y, pins: [p] });
      }
    }
    return blocks;
  };

  return (
    <g>
      <defs>
        <linearGradient id="uno-pcb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1f7cb8" />
          <stop offset="1" stopColor="#155e8f" />
        </linearGradient>
        <linearGradient id="uno-metal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d7dde3" />
          <stop offset="0.5" stopColor="#aab3bc" />
          <stop offset="1" stopColor="#8a949e" />
        </linearGradient>
      </defs>

      {/* drop shadow + PCB */}
      <rect x="2" y="3" width={W} height={H} rx="10" fill="rgba(0,0,0,0.35)" />
      <rect width={W} height={H} rx="10" fill="url(#uno-pcb)" stroke="#0d4166" strokeWidth="1.5" />

      {/* subtle traces */}
      <g stroke="#2c8ac2" strokeWidth="1.2" fill="none" opacity="0.5">
        <path d={`M${30 * MM} ${12 * MM} h${8 * MM} v${10 * MM} h${12 * MM}`} />
        <path d={`M${24 * MM} ${44 * MM} h${14 * MM} v-${8 * MM} h${10 * MM}`} />
        <path d={`M${52 * MM} ${20 * MM} v${8 * MM} h-${6 * MM}`} />
      </g>

      {/* mounting holes */}
      {[
        [2.6, 2.6], [66, 7.6], [66, 35.5], [15.3, 50.6],
      ].map(([x, y], i) => (
        <g key={i}>
          <circle cx={x * MM} cy={y * MM} r={1.6 * MM} fill="#0d4166" />
          <circle cx={x * MM} cy={y * MM} r={1.0 * MM} fill="#0d1117" />
        </g>
      ))}

      {/* USB-B connector */}
      <g>
        <rect x={-2 * MM} y={7.5 * MM} width={16 * MM} height={12 * MM} rx="3" fill="url(#uno-metal)" stroke="#6b747d" />
        <rect x={-2 * MM} y={8.7 * MM} width={16 * MM} height={1.4 * MM} fill="#e9edf0" opacity="0.7" />
        <rect x={0.5 * MM} y={10 * MM} width={10 * MM} height={7 * MM} rx="1.5" fill="#59626b" />
      </g>

      {/* barrel jack */}
      <g>
        <rect x={-2 * MM} y={38.5 * MM} width={13.5 * MM} height={11 * MM} rx="4" fill="#14181d" stroke="#000" />
        <rect x={-2 * MM} y={40 * MM} width={3 * MM} height={8 * MM} rx="1.5" fill="#22282f" />
        <circle cx={1 * MM} cy={44 * MM} r={2.6 * MM} fill="#090b0e" />
      </g>

      {/* ATmega328P DIP-28 */}
      <g>
        <rect x={39 * MM} y={35.5 * MM} width={35 * MM * 0.72} height={8.4 * MM} rx="2" fill="#15181c" stroke="#000" />
        <circle cx={40.8 * MM} cy={39.6 * MM} r="2.4" fill="#2c333b" />
        {Array.from({ length: 14 }).map((_, i) => (
          <g key={i}>
            <rect x={(40 + i * 1.68) * MM} y={34.7 * MM} width="2.6" height={1 * MM} fill="#9aa4ad" />
            <rect x={(40 + i * 1.68) * MM} y={43.8 * MM} width="2.6" height={1 * MM} fill="#9aa4ad" />
          </g>
        ))}
        <text x={48 * MM} y={40.4 * MM} fontSize="7.5" fill="#8b949e" fontFamily="monospace" textAnchor="middle">
          {chipMark}
        </text>
      </g>

      {/* 16 MHz crystal */}
      {crystal && (
        <>
          <rect x={26 * MM} y={28 * MM} width={9 * MM} height={3.6 * MM} rx={1.8 * MM} fill="url(#uno-metal)" stroke="#79828b" />
          <text x={30.5 * MM} y={30.7 * MM} fontSize="6" fill="#4a525a" textAnchor="middle" fontFamily="monospace">16MHz</text>
        </>
      )}

      {/* USB interface IC */}
      <rect x={16 * MM} y={12.5 * MM} width={5.5 * MM} height={5.5 * MM} rx="1" fill="#15181c" stroke="#000" transform={`rotate(45 ${18.7 * MM} ${15.2 * MM})`} />

      {/* voltage regulator */}
      <rect x={13 * MM} y={42 * MM} width={6.5 * MM} height={5 * MM} rx="1" fill="#22282f" stroke="#000" />
      <rect x={13 * MM} y={40.8 * MM} width={6.5 * MM} height={1.6 * MM} fill="#9aa4ad" />

      {/* capacitors */}
      <circle cx={22 * MM} cy={44 * MM} r={3.2 * MM} fill="#20262d" stroke="#0c0f13" />
      <circle cx={22 * MM} cy={44 * MM} r={2.2 * MM} fill="#2b323b" />
      <circle cx={28.5 * MM} cy={44 * MM} r={3.2 * MM} fill="#20262d" stroke="#0c0f13" />
      <circle cx={28.5 * MM} cy={44 * MM} r={2.2 * MM} fill="#2b323b" />

      {/* small passives */}
      {[[30, 22], [34, 22], [30, 24.5], [34, 24.5]].map(([x, y], i) => (
        <rect key={i} x={x * MM} y={y * MM} width={3 * MM} height={1.4 * MM} rx="1" fill={i % 2 ? '#7d5b28' : '#20262d'} stroke="#11151a" strokeWidth="0.5" />
      ))}

      {/* reset button */}
      <g>
        <rect x={5.5 * MM} y={24 * MM} width={6.2 * MM} height={6.2 * MM} rx="1" fill="#c7ccd1" stroke="#8a939c" />
        <circle cx={8.6 * MM} cy={27.1 * MM} r={2 * MM} fill="#b33a3a" stroke="#7d2626" />
      </g>
      <text x={8.6 * MM} y={32.6 * MM} fontSize="6" fill="#cfe3f0" textAnchor="middle">RESET</text>

      {/* ICSP header */}
      <g>
        {[0, 1, 2].map((c) =>
          [0, 1].map((r) => (
            <circle key={`${c}-${r}`} cx={(63.5 + c * 2.54) * MM} cy={(26 + r * 2.54) * MM} r={1 * MM} fill="#c9a227" stroke="#7a6114" />
          )),
        )}
      </g>

      {/* status LEDs */}
      <g fontFamily="monospace" fontSize="6" fill="#cfe3f0">
        <rect x={37 * MM} y={20.5 * MM} width={2.6 * MM} height={1.6 * MM} fill="#3a4a35" stroke="#1d2a1a" strokeWidth="0.5" />
        <text x={41 * MM} y={22 * MM}>ON</text>
        <rect x={28 * MM} y={16 * MM} width={2.6 * MM} height={1.6 * MM} fill="#4a4535" stroke="#2a2415" strokeWidth="0.5" />
        <text x={32 * MM} y={17.5 * MM}>TX</text>
        <rect x={28 * MM} y={18.6 * MM} width={2.6 * MM} height={1.6 * MM} fill="#4a4535" stroke="#2a2415" strokeWidth="0.5" />
        <text x={32 * MM} y={20.2 * MM}>RX</text>
        <rect x={37 * MM} y={16 * MM} width={2.6 * MM} height={1.6 * MM} fill="#4a4a35" stroke="#2a2a15" strokeWidth="0.5" />
        <text x={41 * MM} y={17.5 * MM}>L</text>
      </g>

      {/* Board name silkscreen.

          This is a third-party product, and the artwork says so. CircuitDesk
          did not make this board, and marking it as though it had would
          misrepresent whose hardware a learner is looking at. The name here is
          the manufacturer's own; CircuitDesk's branding belongs in the
          application around the canvas, not on the board on it. */}
      <text x={22 * MM} y={33 * MM} fontSize="11" fontWeight="700" fill="#e8f1f8" fontFamily="sans-serif" letterSpacing="0.5">
        {title}
      </text>
      <text x={22 * MM} y={35.6 * MM} fontSize="6.5" fill="#a9c8dd" fontFamily="sans-serif">
        {chip}
      </text>
      <text x={44 * MM} y={11.2 * MM} fontSize="6.5" fill="#cfe3f0" fontFamily="sans-serif" textAnchor="middle" letterSpacing="1">
        DIGITAL (PWM ~)
      </text>

      {/* header strips generated from pin definitions */}
      {[...headerBlocks(topPins), ...headerBlocks(bottomPins)].map((block, i) => {
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
                {p.label.length <= 2 ? (
                  <text
                    x={p.x}
                    y={isTop ? block.y + 4.6 * MM : block.y - 2.8 * MM}
                    fontSize="5.4"
                    fill="#dce9f3"
                    fontFamily="monospace"
                    textAnchor="middle"
                  >
                    {p.label}
                  </text>
                ) : (
                  <text
                    x={p.x}
                    y={isTop ? block.y + 2.6 * MM : block.y - 2.6 * MM}
                    fontSize="4.8"
                    fill="#dce9f3"
                    fontFamily="monospace"
                    textAnchor={isTop ? 'start' : 'end'}
                    transform={`rotate(90 ${p.x} ${isTop ? block.y + 2.6 * MM : block.y - 2.6 * MM})`}
                  >
                    {p.label}
                  </text>
                )}
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
});
