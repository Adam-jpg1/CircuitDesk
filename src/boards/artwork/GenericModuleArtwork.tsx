import { memo } from 'react';
import type { BoardDefinition } from '../../types';
import { MM } from '../pinHelpers';

/** Parameterized PCB artwork for dual-row dev boards (DevKit style). */
export const GenericModuleArtwork = memo(function GenericModuleArtwork({ def }: { def: BoardDefinition }) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const color = (def.metadata.color as string) ?? '#0b3d2e';
  const usb = (def.metadata.usb as string) ?? 'micro';
  const isEsp = def.family === 'Espressif';
  const leftPins = def.pins.filter((p) => p.x < W / 2);
  const rightPins = def.pins.filter((p) => p.x >= W / 2);
  const chipW = Math.min(W * 0.55, 90);
  const chipH = Math.min(H * 0.3, 100);

  return (
    <g>
      <rect x="1.5" y="2.5" width={W} height={H} rx="7" fill="rgba(0,0,0,0.35)" />
      <rect width={W} height={H} rx="7" fill={color} stroke="rgba(0,0,0,0.5)" strokeWidth="1.2" />
      <rect x="1" y="1" width={W - 2} height={H / 2} rx="6" fill="rgba(255,255,255,0.05)" />

      {/* USB connector at the top */}
      {usb !== 'none' && (
        <g>
          <rect
            x={W / 2 - (usb === 'usb-c' ? 4.5 : 4) * MM}
            y={-1.5 * MM}
            width={(usb === 'usb-c' ? 9 : 8) * MM}
            height={(usb === 'usb-c' ? 3.4 : 4.4) * MM}
            rx={usb === 'usb-c' ? 6 : 2}
            fill="#b9c1c9"
            stroke="#79828b"
          />
          <rect x={W / 2 - 3 * MM} y={-0.5 * MM} width={6 * MM} height={2 * MM} rx="2" fill="#59626b" />
        </g>
      )}

      {/* main chip / shielded module */}
      {isEsp ? (
        <g>
          <rect x={W / 2 - chipW / 2} y={H * 0.12} width={chipW} height={chipH} rx="3" fill="#b9c1c9" stroke="#79828b" />
          <rect x={W / 2 - chipW / 2 + 4} y={H * 0.12 + 4} width={chipW - 8} height={chipH - 8} rx="2" fill="#a7b0b9" />
          {/* antenna */}
          <path
            d={`M${W / 2 - chipW / 2 + 6} ${H * 0.09} h6 v-3 h6 v3 h6 v-3 h6 v3 h6`}
            stroke="#c9a227"
            strokeWidth="1.6"
            fill="none"
          />
          <text x={W / 2} y={H * 0.12 + chipH / 2 + 3} fontSize="7" fill="#3d444c" textAnchor="middle" fontFamily="monospace">
            {def.processor.split(' ')[0]}
          </text>
        </g>
      ) : (
        <g>
          <rect x={W / 2 - chipW / 2} y={H / 2 - chipH / 2} width={chipW} height={chipH} rx="2.5" fill="#15181c" stroke="#000" />
          <circle cx={W / 2 - chipW / 2 + 6} cy={H / 2 - chipH / 2 + 6} r="2" fill="#2c333b" />
          <text x={W / 2} y={H / 2 + 3} fontSize="6.5" fill="#8b949e" textAnchor="middle" fontFamily="monospace">
            {def.processor.split(' ')[0].slice(0, 12)}
          </text>
        </g>
      )}

      {/* passives */}
      <rect x={W * 0.2} y={H * 0.82} width={3 * MM} height={1.3 * MM} rx="1" fill="#7d5b28" />
      <rect x={W * 0.6} y={H * 0.82} width={3 * MM} height={1.3 * MM} rx="1" fill="#20262d" />
      <rect x={W * 0.4} y={H * 0.86} width={2.5 * MM} height={1.2 * MM} rx="1" fill="#20262d" />

      {/* board name */}
      <text x={W / 2} y={H - 4 * MM} fontSize="6.5" fill="rgba(255,255,255,0.85)" textAnchor="middle" fontFamily="sans-serif" fontWeight="600">
        {def.name.length > 22 ? def.name.slice(0, 22) : def.name}
      </text>

      {/* pin headers + silkscreen labels generated from pin definitions */}
      {[leftPins, rightPins].map((pins, side) =>
        pins.length === 0 ? null : (
          <g key={side}>
            <rect
              x={(side === 0 ? Math.min(...pins.map((p) => p.x)) : Math.min(...pins.map((p) => p.x))) - 1.3 * MM}
              y={Math.min(...pins.map((p) => p.y)) - 1.5 * MM}
              width={2.6 * MM}
              height={Math.max(...pins.map((p) => p.y)) - Math.min(...pins.map((p) => p.y)) + 3 * MM}
              rx="2"
              fill="#14181d"
              stroke="#000"
            />
            {pins.map((p) => (
              <g key={p.id}>
                <circle cx={p.x} cy={p.y} r={0.85 * MM} fill="#c9a227" stroke="#7a6114" strokeWidth="0.6" />
                <circle cx={p.x} cy={p.y} r={0.35 * MM} fill="#3d3312" />
                <text
                  x={side === 0 ? p.x + 2.2 * MM : p.x - 2.2 * MM}
                  y={p.y + 1.8}
                  fontSize="4.6"
                  fill="rgba(255,255,255,0.8)"
                  fontFamily="monospace"
                  textAnchor={side === 0 ? 'start' : 'end'}
                >
                  {p.label.slice(0, 9)}
                </text>
              </g>
            ))}
          </g>
        ),
      )}
    </g>
  );
});
