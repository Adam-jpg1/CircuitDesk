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
import type { BoardDefinition, PinDefinition } from '../../types';
import { MM } from '../pinHelpers';

/** Reads a stored SVG back as drawable nodes, without ever parsing HTML. */
function ArtworkImage({ svg, w, h }: { svg: string; w: number; h: number }) {
  // Rendered through an <image> with a data URL rather than dangerouslySet
  // markup: the SVG was sanitised on the way in, and this keeps it in a
  // replaced element where its own document cannot reach this one regardless.
  const encoded = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  return <image href={encoded} width={w} height={h} preserveAspectRatio="xMidYMid meet" />;
}

/** Font size of a pin label on a generated board. Monospace, so widths are exact. */
const LABEL_SIZE = 7;

export interface GeneratedBoardLayout {
  leftPins: PinDefinition[];
  rightPins: PinDefinition[];
  processor: string;
  hasProcessor: boolean;
  LABEL_SIZE: number;
  /** Where the two label columns end, in canvas units. */
  labelRight: number;
  labelLeft: number;
  chipW: number;
  chipH: number;
  chipX: number;
  chipY: number;
  /** True when the package sits between the two headers rather than below them. */
  inMiddle: boolean;
  showChip: boolean;
  showName: boolean;
  showWiringOnly: boolean;
}

/**
 * Where everything goes on a board CircuitDesk draws for itself.
 *
 * Pulled out of the component so the rules can be tested without rendering:
 * the failure this exists to prevent is a silkscreen that reads as a mess —
 * a chip package sitting on top of somebody's pin names, or a board title
 * printed through its own labels — and that is a geometry question, not a
 * React one.
 *
 * The rule throughout is that the LABELS win. They are what the maker printed
 * and the reason a custom board looks like theirs; the decorations give way to
 * them, and a decoration with no room is not drawn at all rather than drawn
 * badly.
 */
export function generatedBoardLayout(def: BoardDefinition): GeneratedBoardLayout {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const leftPins = def.pins.filter((p) => p.x < W / 2);
  const rightPins = def.pins.filter((p) => p.x >= W / 2);
  const hasProcessor = Boolean(def.processorProfileId);

  // Label widths are estimated rather than measured, because this renders
  // inside an SVG with no layout pass to ask. A monospace face makes the
  // estimate reliable: every glyph is the same width.
  const labelWidth = (text: string) => text.length * LABEL_SIZE * 0.62;
  const labelRight = Math.max(0, ...leftPins.map((p) => p.x + 3.4 * MM + labelWidth(p.label)));
  const labelLeft = Math.min(W, ...rightPins.map((p) => p.x - 3.4 * MM - labelWidth(p.label)));
  const gap = labelLeft - labelRight;

  // Below the pin rows when the middle is spoken for, which is where a real
  // board would put a package it could not fit between two headers.
  const lowestPin = Math.max(0, ...def.pins.map((p) => p.y));
  const belowRoom = H - 5.5 * MM - (lowestPin + 3 * MM);
  const inMiddle = gap >= 26;
  const chipW = inMiddle ? Math.min(gap - 8, W * 0.42, 70) : Math.min(W * 0.42, 70);
  const chipH = Math.min(inMiddle ? H * 0.26 : Math.max(belowRoom - 6, 14), chipW, 70);
  const chipX = inMiddle ? labelRight + (gap - chipW) / 2 : W / 2 - chipW / 2;
  const chipY = inMiddle ? H / 2 - chipH / 2 : lowestPin + 3 * MM + Math.max(0, (belowRoom - chipH) / 2);

  return {
    leftPins,
    rightPins,
    processor: def.processor,
    hasProcessor,
    LABEL_SIZE,
    labelRight,
    labelLeft,
    chipW,
    chipH,
    chipX,
    chipY,
    inMiddle,
    // A package that would be a smudge is not drawn at all; the board still
    // names its processor in the inspector, and a 6-pixel black rectangle
    // claiming to be an RP2040 helps nobody.
    showChip: hasProcessor && chipW >= 18 && chipH >= 10,
    // The same rule for the silkscreen text. A 22 mm board with three pins a
    // side has no free space, and a name printed across its own pin labels is
    // worse than no name — the board is captioned everywhere else it appears.
    showName: H - 5 * MM - lowestPin >= 3.4 * MM,
    showWiringOnly: !hasProcessor && inMiddle && belowRoom >= 3 * MM,
  };
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
  const {
    leftPins, rightPins, processor, hasProcessor, LABEL_SIZE,
    chipW, chipH, chipX, chipY, showChip, showName, showWiringOnly,
  } = generatedBoardLayout(def);

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
      {showChip && (
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

      {/* The board's own name, printed on it — when there is room for it. */}
      {showName && (
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
      )}
      {showWiringOnly && (
        <text
          x={W / 2}
          y={chipY + chipH / 2}
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
            fontSize={LABEL_SIZE}
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
