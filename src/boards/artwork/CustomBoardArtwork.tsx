// A board somebody brought, drawn so it looks like a board.
//
// Two cases, and the second is the one that decides whether this feature feels
// finished. If the user supplied artwork, it is drawn — already sanitised, so
// what reaches here is shapes and nothing else. If they did not, the board is
// drawn FROM WHAT IT IS: its outline, its pin rows, its processor and its name.
//
// The alternative — a plain rectangle with a label — is what "custom board
// support" usually means and it is why imported boards always look like a
// placeholder. A board with a silkscreen edge, a visible package for the chip
// it carries, pads at its real pin positions and its own name printed on it
// reads as hardware at the zoom the canvas opens at, which is the whole point.
//
// Nothing here brands the board. No CircuitDesk mark, no invented manufacturer:
// it is the user's board and it carries the user's name for it.

import { memo } from 'react';
import type { BoardDefinition } from '../../types';
import { MM } from '../pinHelpers';

/** Reads a stored SVG back as drawable nodes, without ever parsing HTML. */
function ArtworkImage({ svg, w, h }: { svg: string; w: number; h: number }) {
  // Rendered through an <image> with a data URL rather than dangerouslySet
  // markup: the SVG was sanitised on the way in, and this keeps it in a
  // replaced element where its own document cannot reach this one regardless.
  const encoded = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  return <image href={encoded} width={w} height={h} preserveAspectRatio="xMidYMid meet" />;
}

export const CustomBoardArtwork = memo(function CustomBoardArtwork({ def }: { def: BoardDefinition }) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const color = (def.metadata.color as string) ?? '#1e3a5f';
  const svg = def.artwork.kind === 'svg' ? def.artwork.svg : undefined;

  if (svg) {
    return (
      <g>
        <rect x="1.5" y="2.5" width={W} height={H} rx="7" fill="rgba(0,0,0,0.35)" />
        <ArtworkImage svg={svg} w={W} h={H} />
      </g>
    );
  }

  // No artwork: build one from the board's own facts.
  const leftPins = def.pins.filter((p) => p.x < W / 2);
  const rightPins = def.pins.filter((p) => p.x >= W / 2);
  const chipW = Math.min(W * 0.42, 70);
  const chipH = Math.min(H * 0.26, 70);
  const chipX = W / 2 - chipW / 2;
  const chipY = H / 2 - chipH / 2;
  const processor = def.processor;
  const hasProcessor = Boolean(def.processorProfileId);

  return (
    <g>
      <rect x="1.5" y="2.5" width={W} height={H} rx="6" fill="rgba(0,0,0,0.35)" />
      <rect width={W} height={H} rx="6" fill={color} stroke="rgba(0,0,0,0.55)" strokeWidth="1.2" />
      {/* A soft top light, so the board reads as a physical object. */}
      <rect x="1" y="1" width={W - 2} height={H / 2} rx="5" fill="rgba(255,255,255,0.05)" />
      {/* Silkscreen edge, the way a fabricated board has one. */}
      <rect
        x={2.4 * MM}
        y={2.4 * MM}
        width={W - 4.8 * MM}
        height={H - 4.8 * MM}
        rx="3"
        fill="none"
        stroke="rgba(255,255,255,0.16)"
        strokeWidth="0.8"
      />
      {/* Mounting holes at the corners. */}
      {[
        [3.2, 3.2], [W / MM - 3.2, 3.2], [3.2, H / MM - 3.2], [W / MM - 3.2, H / MM - 3.2],
      ].map(([x, y], i) => (
        <circle key={i} cx={x * MM} cy={y * MM} r={1.1 * MM} fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.18)" />
      ))}

      {/* Header strips under the pin rows, so the pads sit on something. */}
      {[leftPins, rightPins].map((row, i) =>
        row.length < 2 ? null : (
          <rect
            key={i}
            x={Math.min(...row.map((p) => p.x)) - 1.6 * MM}
            y={Math.min(...row.map((p) => p.y)) - 1.6 * MM}
            width={Math.max(...row.map((p) => p.x)) - Math.min(...row.map((p) => p.x)) + 3.2 * MM}
            height={Math.max(...row.map((p) => p.y)) - Math.min(...row.map((p) => p.y)) + 3.2 * MM}
            rx="2"
            fill="rgba(0,0,0,0.28)"
          />
        ),
      )}

      {/* The chip it carries, when it carries one. A board with no processor
          shows no package, because drawing one would be a claim. */}
      {hasProcessor && (
        <g>
          <rect x={chipX} y={chipY} width={chipW} height={chipH} rx="2" fill="#15181c" stroke="#0a0d10" />
          <rect x={chipX} y={chipY} width={chipW} height={chipH * 0.4} rx="2" fill="rgba(255,255,255,0.06)" />
          <circle cx={chipX + chipW * 0.16} cy={chipY + chipH * 0.24} r={Math.min(chipW, chipH) * 0.07} fill="#2c3238" />
          <text
            x={chipX + chipW / 2}
            y={chipY + chipH * 0.62}
            textAnchor="middle"
            fontSize={Math.min(chipW * 0.17, 9)}
            fill="rgba(255,255,255,0.62)"
            fontFamily="monospace"
          >
            {processor}
          </text>
        </g>
      )}

      {/* The board's own name, printed on it. */}
      <text
        x={W / 2}
        y={H - 3.2 * MM}
        textAnchor="middle"
        fontSize={Math.min(W * 0.075, 11)}
        fill="rgba(255,255,255,0.8)"
        fontFamily="sans-serif"
        fontWeight={600}
      >
        {def.name}
      </text>
      {!hasProcessor && (
        <text
          x={W / 2}
          y={H / 2}
          textAnchor="middle"
          fontSize={Math.min(W * 0.06, 9)}
          fill="rgba(255,255,255,0.45)"
          fontFamily="sans-serif"
        >
          wiring only
        </text>
      )}

      {/* Pin labels alongside the pads, which is what a custom board is for:
          the header says what the maker called it. */}
      {def.pins.map((pin) => {
        const onLeft = pin.x < W / 2;
        return (
          <text
            key={pin.id}
            x={pin.x + (onLeft ? 3.4 * MM : -3.4 * MM)}
            y={pin.y + 2.4}
            textAnchor={onLeft ? 'start' : 'end'}
            fontSize="7"
            fill="rgba(255,255,255,0.72)"
            fontFamily="monospace"
          >
            {pin.label}
          </text>
        );
      })}
    </g>
  );
});
