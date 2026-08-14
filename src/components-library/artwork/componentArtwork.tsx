import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentDefinition, ComponentInstance } from '../../types';
import type { ComponentVisualState } from '../../simulation/circuitSim';
import { MM } from '../../boards/pinHelpers';
import { dipActuatorRect, interactiveHotspots } from './interactiveGeometry';

export interface ArtProps {
  def: ComponentDefinition;
  instance: ComponentInstance;
  visual?: ComponentVisualState;
}

const LED_COLORS: Record<string, { lens: string; glow: string }> = {
  red: { lens: '#c43b3b', glow: '#ff5f52' },
  green: { lens: '#3ba05a', glow: '#4cd964' },
  blue: { lens: '#3b6fc4', glow: '#4f9dff' },
  yellow: { lens: '#c4b23b', glow: '#ffe14f' },
  orange: { lens: '#c4763b', glow: '#ff9b4f' },
  white: { lens: '#d8dce0', glow: '#ffffff' },
};

function LedArt({ def, instance, visual }: ArtProps) {
  const color = LED_COLORS[(instance.properties.color as string) ?? 'red'] ?? LED_COLORS.red;
  const on = Boolean(visual?.ledOn);
  const brightness = visual?.brightness ?? (on ? 1 : 0);
  const cx = def.widthMm * MM * 0.5;
  return (
    <g>
      {/* legs — anode longer */}
      <line x1={1.25 * MM} y1={5.8 * MM} x2={1.25 * MM} y2={9 * MM} stroke="#9aa4ad" strokeWidth="2" />
      <line x1={3.75 * MM} y1={5.8 * MM} x2={3.75 * MM} y2={8.4 * MM} stroke="#9aa4ad" strokeWidth="2" />
      {on && (
        <circle cx={cx} cy={3 * MM} r={5.5 * MM * (0.6 + 0.4 * brightness)} fill={color.glow} opacity={0.38 * brightness + 0.1} />
      )}
      {/* lens */}
      <path
        d={`M ${cx - 2.4 * MM} ${3.4 * MM} v -1.2 a ${2.4 * MM} ${2.4 * MM} 0 0 1 ${4.8 * MM} 0 v 1.2 z`}
        fill={color.lens}
        opacity={on ? 1 : 0.82}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth="0.6"
      />
      <rect x={cx - 2.75 * MM} y={3.2 * MM} width={5.5 * MM} height={1.1 * MM} rx="1" fill={color.lens} opacity={on ? 1 : 0.82} />
      {on && <path d={`M ${cx - 2.4 * MM} ${3.4 * MM} v -1.2 a ${2.4 * MM} ${2.4 * MM} 0 0 1 ${4.8 * MM} 0 v 1.2 z`} fill={color.glow} opacity={0.55 * brightness} />}
      {/* highlight */}
      <ellipse cx={cx - 0.9 * MM} cy={1.7 * MM} rx={0.65 * MM} ry={1 * MM} fill="rgba(255,255,255,0.65)" />
      {/* flat side marker on cathode */}
      <line x1={cx + 2.4 * MM} y1={2.6 * MM} x2={cx + 2.4 * MM} y2={3.4 * MM} stroke="rgba(0,0,0,0.4)" strokeWidth="1.4" />
    </g>
  );
}

function RgbLedArt({ def, visual }: ArtProps) {
  const rgb = visual?.rgb ?? [0, 0, 0];
  const on = rgb.some((c) => c > 0.02);
  const mix = `rgb(${Math.round(80 + rgb[0] * 175)}, ${Math.round(80 + rgb[1] * 175)}, ${Math.round(80 + rgb[2] * 175)})`;
  const cx = def.widthMm * MM * 0.5;
  return (
    <g>
      {['red', 'cathode', 'green', 'blue'].map((_, i) => (
        <line key={i} x1={(1 + i * 2) * MM} y1={6 * MM} x2={(1 + i * 2) * MM} y2={(i === 1 ? 10 : 9.2) * MM} stroke="#9aa4ad" strokeWidth="2" />
      ))}
      {on && <circle cx={cx} cy={3.2 * MM} r={6 * MM} fill={mix} opacity="0.4" />}
      <path
        d={`M ${cx - 2.8 * MM} ${3.8 * MM} v -1.4 a ${2.8 * MM} ${2.8 * MM} 0 0 1 ${5.6 * MM} 0 v 1.4 z`}
        fill={on ? mix : '#d5d9dd'}
        opacity="0.92"
        stroke="rgba(0,0,0,0.3)"
        strokeWidth="0.6"
      />
      <ellipse cx={cx - 1 * MM} cy={1.9 * MM} rx={0.7 * MM} ry={1.1 * MM} fill="rgba(255,255,255,0.7)" />
    </g>
  );
}

const BAND_COLORS = ['#0d0d0d', '#7b4a12', '#d0342c', '#e8770e', '#e8c216', '#3d9142', '#2d5fbd', '#8038b5', '#8a8a8a', '#f4f4f4'];

function resistorBands(ohms: number): [string, string, string] {
  let value = Math.max(1, Math.round(ohms));
  let magnitude = 0;
  while (value >= 100) {
    value = Math.round(value / 10);
    magnitude++;
  }
  const d1 = Math.floor(value / 10);
  const d2 = value % 10;
  return [BAND_COLORS[d1], BAND_COLORS[d2], BAND_COLORS[Math.min(magnitude, 9)]];
}

function ResistorArt({ def, instance }: ArtProps) {
  const ohms = Number(instance.properties.resistance ?? 220);
  const [b1, b2, b3] = resistorBands(ohms);
  const H = def.heightMm * MM;
  const W = def.widthMm * MM;
  return (
    <g>
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#9aa4ad" strokeWidth="2.2" />
      <rect x={2.2 * MM} y={0.4 * MM} width={W - 4.4 * MM} height={H - 0.8 * MM} rx={H / 2 - 1} fill="#d9c49a" stroke="#a8956e" strokeWidth="0.8" />
      <rect x={2.2 * MM} y={0.6 * MM} width={W - 4.4 * MM} height={(H - 1.2 * MM) / 2.4} rx="3" fill="rgba(255,255,255,0.35)" />
      <rect x={3.6 * MM} y={0.4 * MM} width={1.1 * MM} height={H - 0.8 * MM} fill={b1} />
      <rect x={5.3 * MM} y={0.4 * MM} width={1.1 * MM} height={H - 0.8 * MM} fill={b2} />
      <rect x={7.0 * MM} y={0.4 * MM} width={1.1 * MM} height={H - 0.8 * MM} fill={b3} />
      <rect x={9.0 * MM} y={0.4 * MM} width={1.1 * MM} height={H - 0.8 * MM} fill="#c9a227" />
    </g>
  );
}

/**
 * The cap of a tactile switch, up or down.
 *
 * Shared by the 12 mm and 6 mm buttons because they are the same part at two
 * sizes, and because the pressed state has to be the same gesture on both. It
 * used to be a four-tenths-of-a-millimetre radius change — under two pixels at
 * 1:1 — which meant that at the zoom the canvas opens at, pressing a button
 * looked exactly like not pressing it. A cap that is down now loses its
 * highlight, gains a ring of shadow where it has sunk into the housing, and
 * darkens, which is what a depressed cap looks like from above.
 */
function TactileCap({ cx, cy, r, pressed }: { cx: number; cy: number; r: number; pressed: boolean }) {
  return (
    <g>
      {/* The well the cap travels in, visible around it once it is down. */}
      <circle cx={cx} cy={cy} r={r * 1.24} fill="#0f1419" stroke="#0a0d11" strokeWidth="0.6" />
      <circle
        cx={cx}
        cy={cy + (pressed ? r * 0.06 : -r * 0.06)}
        r={pressed ? r * 0.86 : r}
        fill={pressed ? '#171d24' : '#39424c'}
        stroke="#0d1117"
        strokeWidth="0.8"
      />
      {pressed ? (
        <circle cx={cx} cy={cy} r={r * 0.86} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={r * 0.24} />
      ) : (
        <circle cx={cx - r * 0.3} cy={cy - r * 0.32} r={r * 0.3} fill="rgba(255,255,255,0.2)" />
      )}
    </g>
  );
}

function ButtonArt({ def, visual }: ArtProps) {
  const pressed = Boolean(visual?.pressed ?? visual?.contacts?.['']);
  const W = def.widthMm * MM;
  return (
    <g>
      {[[1.5, 1.5], [10.5, 1.5], [1.5, 10.5], [10.5, 10.5]].map(([x, y], i) => (
        <circle key={i} cx={x * MM} cy={y * MM} r={1.1 * MM} fill="#9aa4ad" stroke="#6b747d" strokeWidth="0.7" />
      ))}
      <rect x={1.2 * MM} y={1.2 * MM} width={W - 2.4 * MM} height={W - 2.4 * MM} rx="4" fill="#20262d" stroke="#0d1117" />
      <rect x={1.2 * MM} y={1.2 * MM} width={W - 2.4 * MM} height={(W - 2.4 * MM) / 2} rx="4" fill="rgba(255,255,255,0.06)" />
      <TactileCap cx={W / 2} cy={W / 2} r={3.2 * MM} pressed={pressed} />
    </g>
  );
}

function ToggleArt({ def, visual }: ArtProps) {
  const on = Boolean(visual?.toggledOn);
  const W = def.widthMm * MM;
  return (
    <g>
      <rect x={0.5 * MM} y={5 * MM} width={W - 1 * MM} height={6.5 * MM} rx="3" fill="#3a434d" stroke="#20262d" />
      <circle cx={W / 2} cy={8.2 * MM} r={2.6 * MM} fill="#20262d" />
      <line x1={W / 2} y1={8.2 * MM} x2={W / 2} y2={(on ? 2.8 : 12.2) * MM} stroke="#b9c1c9" strokeWidth={2.2 * MM} strokeLinecap="round" />
      {['no', 'com', 'nc'].map((_, i) => (
        <line key={i} x1={(1.2 + i * 2.8) * MM} y1={11.5 * MM} x2={(1.2 + i * 2.8) * MM} y2={13 * MM} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

function PotArt({ def, visual }: ArtProps) {
  const pos = visual?.potPosition ?? 0.5;
  const W = def.widthMm * MM;
  const cx = W / 2;
  const cy = 7 * MM;
  const angle = -135 + pos * 270;
  return (
    <g>
      {[2.5, 7.5, 12.5].map((x, i) => (
        <line key={i} x1={x * MM} y1={13 * MM} x2={x * MM} y2={16.6 * MM} stroke="#9aa4ad" strokeWidth="2" />
      ))}
      <rect x={0.6 * MM} y={0.6 * MM} width={W - 1.2 * MM} height={13 * MM} rx="4" fill="#2660a4" stroke="#17406f" />
      <circle cx={cx} cy={cy} r={4.8 * MM} fill="#d5d9dd" stroke="#8a939c" />
      <circle cx={cx} cy={cy} r={3.4 * MM} fill="#b9c1c9" />
      <line
        x1={cx}
        y1={cy}
        x2={cx + Math.sin((angle * Math.PI) / 180) * 3.2 * MM}
        y2={cy - Math.cos((angle * Math.PI) / 180) * 3.2 * MM}
        stroke="#20262d"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </g>
  );
}

function BuzzerArt({ def, visual }: ArtProps) {
  const on = Boolean(visual?.buzzerOn);
  const W = def.widthMm * MM;
  const cx = W / 2;
  const cy = 5.5 * MM;
  return (
    <g>
      <line x1={4.5 * MM} y1={10 * MM} x2={4.5 * MM} y2={12 * MM} stroke="#9aa4ad" strokeWidth="2" />
      <line x1={7.5 * MM} y1={10 * MM} x2={7.5 * MM} y2={12 * MM} stroke="#9aa4ad" strokeWidth="2" />
      <circle cx={cx} cy={cy} r={5.4 * MM} fill="#15181c" stroke="#000" />
      <circle cx={cx} cy={cy} r={5.4 * MM} fill="rgba(255,255,255,0.06)" clipPath="inset(0 0 50% 0)" />
      <circle cx={cx} cy={cy} r={1.2 * MM} fill="#0a0c0f" />
      <text x={cx} y={cy + 3.4 * MM} fontSize="5" fill="#6b7885" textAnchor="middle">+</text>
      {on && (
        <g stroke="#e8c35a" strokeWidth="1.4" fill="none" opacity="0.9">
          <path d={`M ${cx + 6.5 * MM} ${cy - 3 * MM} a 8 8 0 0 1 0 ${6 * MM}`} />
          <path d={`M ${cx + 8.5 * MM} ${cy - 4.5 * MM} a 12 12 0 0 1 0 ${9 * MM}`} />
        </g>
      )}
    </g>
  );
}

function ServoArt({ def, visual }: ArtProps) {
  const angle = visual?.servoAngle ?? 90;
  const W = def.widthMm * MM;
  const hubX = W * 0.62;
  const hubY = 7 * MM;
  return (
    <g>
      <rect x={3 * MM} y={4 * MM} width={W - 6 * MM} height={16 * MM} rx="3" fill="#2660a4" stroke="#17406f" />
      <rect x={0.5 * MM} y={10.5 * MM} width={3 * MM} height={9 * MM} rx="1.5" fill="#1c4a80" />
      <rect x={W - 6 * MM} y={7.5 * MM} width={4 * MM} height={2 * MM} rx="1" fill="#1c4a80" />
      <rect x={5 * MM} y={7.5 * MM} width={4 * MM} height={2 * MM} rx="1" fill="#1c4a80" />
      <circle cx={hubX} cy={hubY} r={4.4 * MM} fill="#1c4a80" />
      <circle cx={hubX} cy={hubY} r={2.2 * MM} fill="#e8e2cf" stroke="#b3ac93" />
      <g transform={`rotate(${angle - 90} ${hubX} ${hubY})`}>
        <path
          d={`M ${hubX - 1.4 * MM} ${hubY} L ${hubX - 0.6 * MM} ${hubY - 10 * MM} a ${0.7 * MM} ${0.7 * MM} 0 0 1 ${1.2 * MM} 0 L ${hubX + 1.4 * MM} ${hubY} z`}
          fill="#e8e2cf"
          stroke="#b3ac93"
          strokeWidth="0.7"
        />
      </g>
      <circle cx={hubX} cy={hubY} r={0.9 * MM} fill="#8a8264" />
      <text x={W * 0.45} y={17.5 * MM} fontSize="5.5" fill="rgba(255,255,255,0.8)" textAnchor="middle">SG90</text>
      {/* wire pigtail */}
      <line x1={1 * MM} y1={12 * MM} x2={3 * MM} y2={12 * MM} stroke="#7a5230" strokeWidth="1.6" />
      <line x1={1 * MM} y1={15 * MM} x2={3 * MM} y2={15 * MM} stroke="#b33a3a" strokeWidth="1.6" />
      <line x1={1 * MM} y1={18 * MM} x2={3 * MM} y2={18 * MM} stroke="#d0812c" strokeWidth="1.6" />
    </g>
  );
}

const SEG_SHAPES: Record<string, string> = {
  a: 'M4,2 h6 l1,1 -1,1 h-6 l-1,-1 z',
  b: 'M11,3 l1,1 v5 l-1,1 -1,-1 v-5 z',
  c: 'M11,11 l1,1 v5 l-1,1 -1,-1 v-5 z',
  d: 'M4,17 h6 l1,1 -1,1 h-6 l-1,-1 z',
  e: 'M3,11 l1,1 v5 l-1,1 -1,-1 v-5 z',
  f: 'M3,3 l1,1 v5 l-1,1 -1,-1 v-5 z',
  g: 'M4,9.5 h6 l1,1 -1,1 h-6 l-1,-1 z',
};

function SevenSegArt({ def, visual }: ArtProps) {
  const segs = visual?.segments ?? {};
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const scale = Math.min(W / 14, H / 21);
  return (
    <g>
      {/* The same body as the multi-digit modules next to it in the library:
          against the canvas the old near-black slab had almost no presence, so
          a single digit and a four-digit module did not look like the same
          family of part. */}
      <rect x="1" y="1.5" width={W} height={H} rx="3" fill="rgba(0,0,0,0.35)" />
      <rect width={W} height={H} rx="3" fill="#1a1210" stroke="#2e2320" />
      <g transform={`translate(${W / 2 - 7 * scale} ${H / 2 - 10.5 * scale}) scale(${scale})`}>
        {Object.entries(SEG_SHAPES).map(([k, d]) => (
          <path key={k} d={d} fill={segs[k] ? '#ff4b3e' : '#2a1614'} opacity={segs[k] ? 1 : 1} />
        ))}
        <circle cx="13" cy="18.5" r="0.9" fill={segs.dp ? '#ff4b3e' : '#2a1614'} />
      </g>
      {segs && Object.values(segs).some(Boolean) && (
        <rect width={W} height={H} rx="3" fill="#ff4b3e" opacity="0.05" />
      )}
    </g>
  );
}

function UltrasonicArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return (
    <g>
      <rect width={W} height={H - 2 * MM} rx="4" fill="#2660a4" stroke="#17406f" />
      {[12, 33].map((x, i) => (
        <g key={i}>
          <circle cx={x * MM} cy={8.5 * MM} r={7.5 * MM} fill="#b9c1c9" stroke="#79828b" />
          <circle cx={x * MM} cy={8.5 * MM} r={6 * MM} fill="#3a434d" />
          <circle cx={x * MM} cy={8.5 * MM} r={5.9 * MM} fill="none" stroke="rgba(255,255,255,0.15)" />
          <circle cx={x * MM} cy={8.5 * MM} r={2.5 * MM} fill="#20262d" />
        </g>
      ))}
      <rect x={19 * MM} y={2 * MM} width={7 * MM} height={3.4 * MM} rx="1" fill="#b9c1c9" stroke="#79828b" />
      <text x={22.5 * MM} y={13 * MM} fontSize="5.5" fill="rgba(255,255,255,0.85)" textAnchor="middle" fontFamily="monospace">
        HC-SR04
      </text>
      {visual?.value !== undefined && (
        <text x={22.5 * MM} y={16.5 * MM} fontSize="5" fill="#8fd0ff" textAnchor="middle" fontFamily="monospace">
          {Number(visual.value).toFixed(0)} cm
        </text>
      )}
    </g>
  );
}

function BreadboardArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const withRails = def.id.includes('half');
  return (
    <g>
      <rect x="1.5" y="2" width={W} height={H} rx="6" fill="rgba(0,0,0,0.3)" />
      <rect width={W} height={H} rx="6" fill="#e8eaec" stroke="#c3c8cd" />
      <rect x="1" y="1" width={W - 2} height={H / 2} rx="5" fill="rgba(255,255,255,0.5)" />
      {/* center divider */}
      <rect x={0} y={H / 2 - 1.4 * MM} width={W} height={2.8 * MM} fill="#d5d9dd" />
      <line x1={0} y1={H / 2 - 1.4 * MM} x2={W} y2={H / 2 - 1.4 * MM} stroke="#b7bdc3" strokeWidth="0.8" />
      <line x1={0} y1={H / 2 + 1.4 * MM} x2={W} y2={H / 2 + 1.4 * MM} stroke="#b7bdc3" strokeWidth="0.8" />
      {withRails && (
        <g>
          <line x1={4 * MM} y1={1.8 * MM} x2={W - 4 * MM} y2={1.8 * MM} stroke="#d0342c" strokeWidth="1.4" />
          <line x1={4 * MM} y1={6.8 * MM} x2={W - 4 * MM} y2={6.8 * MM} stroke="#2d5fbd" strokeWidth="1.4" />
          <line x1={4 * MM} y1={H - 6.8 * MM} x2={W - 4 * MM} y2={H - 6.8 * MM} stroke="#d0342c" strokeWidth="1.4" />
          <line x1={4 * MM} y1={H - 1.8 * MM} x2={W - 4 * MM} y2={H - 1.8 * MM} stroke="#2d5fbd" strokeWidth="1.4" />
          <text x={2 * MM} y={2.6 * MM} fontSize="6" fill="#d0342c">+</text>
          <text x={2 * MM} y={7.6 * MM} fontSize="6" fill="#2d5fbd">−</text>
        </g>
      )}
      {/* holes are drawn by the interactive pin layer; row/col labels here */}
      {['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((r, i) => {
        const topBankY = (withRails ? 14.2 : 5.2) + (i < 5 ? i * 2.54 : 4 * 2.54 + 7.62 + (i - 5) * 2.54);
        return (
          <text key={r} x={1.2 * MM} y={topBankY * MM + 2} fontSize="4.6" fill="#9aa2aa" fontFamily="monospace">
            {r}
          </text>
        );
      })}
    </g>
  );
}

function GenericBoxArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const palette: Record<string, string> = {
    Sensors: '#2660a4',
    Modules: '#0b3d2e',
    Motors: '#3a434d',
    Displays: '#15304d',
    Power: '#3d2f16',
    ICs: '#15181c',
    Connectors: '#20262d',
    Basic: '#3a434d',
    Output: '#3a434d',
  };
  const fill = palette[def.category] ?? '#2c333b';
  return (
    <g>
      <rect x="1" y="1.5" width={W} height={H} rx="4" fill="rgba(0,0,0,0.3)" />
      <rect width={W} height={H} rx="4" fill={fill} stroke="rgba(0,0,0,0.5)" />
      <rect x="1" y="1" width={W - 2} height={Math.max(4, H / 2 - 2)} rx="3" fill="rgba(255,255,255,0.07)" />
      <text
        x={W / 2}
        y={H / 2 + 2.5}
        fontSize={Math.min(7, W / 8)}
        fill="rgba(255,255,255,0.85)"
        textAnchor="middle"
        fontFamily="monospace"
      >
        {(def.name.match(/\(([^)]+)\)/)?.[1] ?? def.name).slice(0, 12)}
      </text>
      {visual?.coilOn && <circle cx={W - 3 * MM} cy={3 * MM} r={1.4 * MM} fill="#ff5f52" opacity="0.9" />}
      {/* Live values read out of a simulated device model (I2C sensors). */}
      {visual?.readout?.map((line, i) => (
        <text
          key={i}
          className="device-readout"
          x={W / 2}
          y={H / 2 + 2.5 + (i + 1) * Math.min(7, W / 8)}
          fontSize={Math.min(5.5, W / 11)}
          fill="#8fd0ff"
          textAnchor="middle"
          fontFamily="monospace"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function CapacitorArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  return (
    <g>
      <line x1={1.5 * MM} y1={7 * MM} x2={1.5 * MM} y2={9.6 * MM} stroke="#9aa4ad" strokeWidth="2" />
      <line x1={4.5 * MM} y1={7 * MM} x2={4.5 * MM} y2={9.6 * MM} stroke="#9aa4ad" strokeWidth="2" />
      <circle cx={W / 2} cy={3.6 * MM} r={3.4 * MM} fill="#1c2a52" stroke="#101a36" />
      <rect x={W / 2 - 1 * MM} y={0.4 * MM} width={2 * MM} height={6.4 * MM} rx="1" fill="rgba(255,255,255,0.1)" />
      <rect x={W / 2 - 3.4 * MM} y={1.4 * MM} width={1.6 * MM} height={4.4 * MM} fill="#c8cdd2" opacity="0.85" />
      <text x={W / 2 - 2.6 * MM} y={4.6 * MM} fontSize="5" fill="#0a0f1e" textAnchor="middle">−</text>
    </g>
  );
}

function Tmp36Art({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  return (
    <g>
      {[0.9, 3.0, 5.1].map((x, i) => (
        <line key={i} x1={x * MM} y1={4.5 * MM} x2={x * MM} y2={6.6 * MM} stroke="#9aa4ad" strokeWidth="1.6" />
      ))}
      <path d={`M ${0.4 * MM} ${4.5 * MM} v -2 a ${W / 2 - 1.6} ${W / 2 - 1.6} 0 0 1 ${W - 0.8 * MM} 0 v 2 z`} fill="#15181c" stroke="#000" />
      <text x={W / 2} y={3.4 * MM} fontSize="4" fill="#8b949e" textAnchor="middle" fontFamily="monospace">TMP36</text>
      {visual?.value !== undefined && (
        <text x={W / 2} y={-2} fontSize="5" fill="#8fd0ff" textAnchor="middle" fontFamily="monospace">
          {Number(visual.value).toFixed(0)}°C
        </text>
      )}
    </g>
  );
}

function LdrArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  return (
    <g>
      <line x1={2 * MM} y1={7 * MM} x2={2 * MM} y2={9.6 * MM} stroke="#9aa4ad" strokeWidth="1.8" />
      <line x1={6 * MM} y1={7 * MM} x2={6 * MM} y2={9.6 * MM} stroke="#9aa4ad" strokeWidth="1.8" />
      <circle cx={W / 2} cy={4 * MM} r={3.6 * MM} fill="#c9622e" stroke="#8f4520" />
      <path
        d={`M ${W / 2 - 2.6 * MM} ${2.6 * MM} h ${5.2 * MM} M ${W / 2 - 2.6 * MM} ${4 * MM} h ${5.2 * MM} M ${W / 2 - 2.6 * MM} ${5.4 * MM} h ${5.2 * MM}`}
        stroke="#5c2c12"
        strokeWidth="1"
      />
      {visual?.value !== undefined && (
        <text x={W / 2} y={-2} fontSize="5" fill="#e8c35a" textAnchor="middle" fontFamily="monospace">
          {Math.round(Number(visual.value) * 100)}%
        </text>
      )}
    </g>
  );
}

function BatteryArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const is9v = def.id.includes('9v');
  return (
    <g>
      <rect x="1" y="1.5" width={W} height={H} rx="5" fill="rgba(0,0,0,0.3)" />
      <rect width={W} height={H} rx="5" fill={is9v ? '#20262d' : '#2c333b'} stroke="#0d1117" />
      <rect x="0" y={H * 0.42} width={W} height={H * 0.34} fill={is9v ? '#c9a227' : '#3a7bd5'} opacity="0.9" />
      <circle cx={8 * MM} cy={2 * MM} r={2.2 * MM} fill="#b9c1c9" stroke="#79828b" />
      <circle cx={(is9v ? 18 : 27) * MM} cy={2 * MM} r={2.8 * MM} fill="#b9c1c9" stroke="#79828b" />
      <text x={W / 2} y={H * 0.58 + 4} fontSize="8" fontWeight="700" fill="#10151b" textAnchor="middle">
        {is9v ? '9V' : '2×AA'}
      </text>
    </g>
  );
}


/**
 * SSD1306 panel drawn straight from the device's display RAM — one rect per
 * lit pixel, nothing pre-rendered. A dark panel means firmware wrote nothing.
 */
/**
 * The SSD1306 module: dark glass, lit pixels, and nothing competing with them.
 *
 * Two things were wrong before. The glass was 90×54 units for a 128×64 panel,
 * so every pixel was stretched 1.67:1 and a circle came out an ellipse; and a
 * full frame emitted up to 8192 individual rects, one per lit pixel, which is a
 * lot of DOM for a part 27 mm across. The glass is now exactly 2:1 and each row
 * of adjacent lit pixels is drawn as one rect, which is the same picture out of
 * far fewer nodes.
 *
 * The pixels themselves still come from the simulated SSD1306's GDDRAM. Nothing
 * here draws a picture the firmware did not put there.
 */
/**
 * A WS2812 part, drawn from the latched frame.
 *
 * One shape per pixel in the layout the part actually has, filled with the
 * colour that pixel's twenty-four bits decoded to. An unlit pixel is drawn as
 * dark plastic rather than omitted, because an eight-pixel strip with two lit
 * is a strip with six dark pixels — hiding them would make a half-written
 * frame look like a shorter strip.
 */
function NeoPixelArt({ def, visual, layout }: ArtProps & { layout: 'single' | 'ring' | 'strip' | 'matrix' }) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const colors = visual?.pixelColors ?? [];
  const count = Math.max(1, Math.floor(Number(def.properties.find((p) => p.key === 'pixelCount')?.default ?? 1)));

  const fill = (i: number) => {
    const c = colors[i];
    if (!c || (!c.r && !c.g && !c.b)) return '#2a2f36';
    return `rgb(${c.r},${c.g},${c.b})`;
  };
  const glow = (i: number) => {
    const c = colors[i];
    return c && (c.r || c.g || c.b) ? 0.55 : 0;
  };

  const dots: JSX.Element[] = [];
  if (layout === 'ring') {
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.36;
    const dr = Math.min(w, h) * 0.07;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      dots.push(<circle key={i} cx={cx + r * Math.cos(a)} cy={cy + r * Math.sin(a)} r={dr} fill={fill(i)} />);
    }
  } else if (layout === 'matrix') {
    const side = Math.round(Math.sqrt(count)) || 1;
    const pad = w * 0.08;
    const cell = Math.min((w - pad * 2) / side, (h * 0.82 - pad * 2) / side);
    for (let i = 0; i < count; i++) {
      const col = i % side;
      const row = Math.floor(i / side);
      dots.push(
        <rect
          key={i}
          x={pad + col * cell + cell * 0.12}
          y={pad + row * cell + cell * 0.12}
          width={cell * 0.76}
          height={cell * 0.76}
          rx={cell * 0.16}
          fill={fill(i)}
        />,
      );
    }
  } else {
    // A strip, and a single pixel, are the same row at two lengths.
    const cell = w / Math.max(count, 1);
    const size = Math.min(cell * 0.7, h * 0.5);
    for (let i = 0; i < count; i++) {
      dots.push(
        <rect
          key={i}
          x={(i + 0.5) * cell - size / 2}
          y={h * 0.34 - size / 2}
          width={size}
          height={size}
          rx={size * 0.18}
          fill={fill(i)}
        />,
      );
    }
  }

  const halos = Array.from({ length: count }, (_, i) => glow(i)).some((g) => g > 0);

  return (
    <g>
      <rect x="1" y="1.5" width={w} height={h} rx="3" fill="rgba(0,0,0,0.35)" />
      <rect width={w} height={h} rx="3" fill="#101318" stroke="#333c46" />
      {layout === 'ring' && (
        <circle cx={w / 2} cy={h / 2} r={Math.min(w, h) * 0.2} fill="#0b0e12" stroke="#262c33" />
      )}
      {halos && (
        <g opacity="0.5" filter="url(#cd-pixel-glow)">
          {dots}
        </g>
      )}
      {dots}
      <defs>
        <filter id="cd-pixel-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
    </g>
  );
}

/**
 * A colour panel, rasterised once per frame rather than drawn as nodes.
 *
 * A 240x320 TFT is 76,800 pixels. One SVG rect each would be 76,800 DOM nodes
 * on a part 50 mm across, rebuilt on every publish — the editor would stop
 * responding the moment one appeared on the canvas. So the framebuffer is
 * painted into an offscreen canvas and emitted as a single <image>, which is
 * one node whatever the resolution, and the paint only happens when the
 * device's revision counter changes.
 *
 * The pixels come from the simulated controller's own framebuffer. Nothing
 * here draws anything firmware did not write: a panel that is asleep, off, or
 * unreachable hands over null and gets dark glass.
 */
function RasterPanelArt({ def, visual, round }: ArtProps & { round?: boolean }) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const raster = visual?.raster ?? null;

  const [href, setHref] = useState<string | null>(null);
  const lastRevision = useRef(-1);

  useEffect(() => {
    if (!raster) {
      lastRevision.current = -1;
      setHref(null);
      return;
    }
    if (raster.revision === lastRevision.current) return;
    lastRevision.current = raster.revision;

    // Guarded because this runs in test and SSR environments too, where there
    // is no document to make a canvas from.
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(raster.width, raster.height);
    const src = raster.pixels;
    const out = image.data;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      // RGB565 unpacked with the low bits replicated, so full scale stays full
      // scale — a plain shift turns white into 248,252,248.
      const r5 = (v >> 11) & 0x1f;
      const g6 = (v >> 5) & 0x3f;
      const b5 = v & 0x1f;
      let r = (r5 << 3) | (r5 >> 2);
      let g = (g6 << 2) | (g6 >> 4);
      let b = (b5 << 3) | (b5 >> 2);
      if (raster.inverted) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }
      const o = i * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    setHref(canvas.toDataURL('image/png'));
  }, [raster]);

  // The glass keeps the panel's aspect ratio inside the module outline, above
  // the header band the footprint's pads sit in.
  const edge = headerEdge(def);
  const headerH = Math.max(6, h * 0.085);
  const frame = Math.max(3, Math.min(w, h) * 0.045);
  const availW = w - frame * 2;
  const availH = h - headerH - frame * 2;
  // The panel's native aspect, from the controller's own framebuffer where one
  // has been published and from the part's declared geometry otherwise, so an
  // idle panel is the same shape as a running one.
  const aspect = raster ? raster.width / raster.height : round ? 1 : nativeAspect(def.id);
  let gw = availW;
  let gh = gw / aspect;
  if (gh > availH) {
    gh = availH;
    gw = gh * aspect;
  }
  if (round) {
    const d = Math.min(gw, gh);
    gw = d;
    gh = d;
  }
  const gx = (w - gw) / 2;
  const gy = (edge === 'top' ? headerH : 0) + frame + (availH - gh) / 2;
  const cx = gx + gw / 2;
  const cy = gy + gh / 2;
  const clipId = `cd-round-${def.id}`;

  return (
    <g>
      <rect x="1" y="1.5" width={w} height={h} rx="4" fill="rgba(0,0,0,0.35)" />
      {/* A round panel gets a round board. Nobody mounts a 1.28" circular
          display in a square outline, and at 1:1 the outline is most of what
          tells you which display this is before you read anything. */}
      {round ? (
        <>
          <circle cx={w / 2} cy={cy} r={Math.min(w, h * 0.94) / 2} fill="#12161b" stroke="#333c46" />
          <circle cx={w / 2} cy={cy} r={Math.min(w, h * 0.94) / 2 - 3} fill="none" stroke="rgba(255,255,255,0.05)" />
        </>
      ) : (
        <rect width={w} height={h} rx="4" fill="#12161b" stroke="#333c46" />
      )}
      {/* Bezel: the frame that makes the glass read as a screen set into a
          module rather than a dark patch painted on the board. */}
      {round ? (
        <>
          <circle cx={cx} cy={cy} r={gw / 2 + frame * 0.7} fill="#39424c" stroke="#1c2228" />
          <path
            d={`M ${cx - gw / 2 - frame * 0.7} ${cy} A ${gw / 2 + frame * 0.7} ${gw / 2 + frame * 0.7} 0 0 1 ${cx + gw / 2 + frame * 0.7} ${cy}`}
            fill="none"
            stroke="rgba(255,255,255,0.16)"
            strokeWidth={frame * 0.5}
          />
        </>
      ) : (
        <>
          <rect
            x={gx - frame * 0.7}
            y={gy - frame * 0.7}
            width={gw + frame * 1.4}
            height={gh + frame * 1.4}
            rx={frame * 0.5}
            fill="#39424c"
            stroke="#1c2228"
          />
          <rect
            x={gx - frame * 0.7}
            y={gy - frame * 0.7}
            width={gw + frame * 1.4}
            height={frame * 0.6}
            rx={frame * 0.3}
            fill="rgba(255,255,255,0.16)"
          />
        </>
      )}
      {round ? (
        <>
          <defs>
            <clipPath id={clipId}>
              <circle cx={cx} cy={cy} r={gw / 2} />
            </clipPath>
          </defs>
          <circle cx={cx} cy={cy} r={gw / 2} fill="#04060a" />
          {href && (
            <image
              href={href}
              x={gx}
              y={gy}
              width={gw}
              height={gh}
              clipPath={`url(#${clipId})`}
              style={{ imageRendering: 'pixelated' }}
            />
          )}
          <circle cx={cx} cy={cy} r={gw / 2} fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="1.2" />
        </>
      ) : (
        <>
          <rect x={gx} y={gy} width={gw} height={gh} fill="#04060a" />
          {href && (
            <image href={href} x={gx} y={gy} width={gw} height={gh} style={{ imageRendering: 'pixelated' }} />
          )}
        </>
      )}
      {/* The sheet of glass over the panel, which is what stops a colour TFT
          looking like a coloured rectangle. */}
      {round ? (
        <path
          d={`M ${cx - gw / 2} ${cy} A ${gw / 2} ${gw / 2} 0 0 1 ${cx + gw / 2} ${cy} Z`}
          fill="rgba(255,255,255,0.05)"
          pointerEvents="none"
        />
      ) : (
        <rect x={gx} y={gy} width={gw} height={gh * 0.28} fill="rgba(255,255,255,0.05)" pointerEvents="none" />
      )}
      <PinHeader def={def} w={w} h={h} edge={edge} thickness={headerH} />
      {!raster && (
        <text
          x={cx}
          y={cy + gh * 0.05}
          fontSize={Math.min(gh * 0.14, gw * 0.15)}
          fill="#2b333d"
          textAnchor="middle"
          fontFamily="'DejaVu Sans Mono', 'Courier New', monospace"
        >
          {controllerName(def)}
        </text>
      )}
    </g>
  );
}

/**
 * The controller a panel is built on, taken from the part's own name.
 *
 * Three different TFTs all reading "TFT" while dark meant they were only
 * distinguishable once firmware had drawn something, which is exactly when you
 * least need the label. The names carry the controller in brackets already.
 */
function controllerName(def: ComponentDefinition): string {
  const bracketed = /\(([^)]+)\)\s*$/.exec(def.name);
  return bracketed ? bracketed[1] : def.name.split(' ')[0];
}

/** A colour panel's native aspect, for drawing it before firmware has written. */
function nativeAspect(id: string): number {
  switch (id) {
    case 'comp.ili9341':
    case 'comp.st7789':
      return 240 / 320;
    case 'comp.st7735':
      return 128 / 160;
    case 'comp.ssd1331':
      return 96 / 64;
    default:
      return 1;
  }
}

/** The Nokia 5110's 84x48 glass, on the shared monochrome renderer. */
function Nokia5110Art(props: ArtProps) {
  return <MonoPanelArt {...props} cols={84} rows={48} idleLabel="5110" />;
}

/** Segment polygons for one digit, in a box of the given size. */
function segmentShapes(x: number, y: number, w: number, h: number): Record<string, string> {
  const t = Math.min(w, h) * 0.13; // segment thickness
  const midY = y + h / 2;
  const bar = (cx: number, cy: number, len: number, horizontal: boolean) =>
    horizontal
      ? `${cx - len / 2 + t / 2},${cy - t / 2} ${cx + len / 2 - t / 2},${cy - t / 2} ${cx + len / 2},${cy} ${cx + len / 2 - t / 2},${cy + t / 2} ${cx - len / 2 + t / 2},${cy + t / 2} ${cx - len / 2},${cy}`
      : `${cx - t / 2},${cy - len / 2 + t / 2} ${cx},${cy - len / 2} ${cx + t / 2},${cy - len / 2 + t / 2} ${cx + t / 2},${cy + len / 2 - t / 2} ${cx},${cy + len / 2} ${cx - t / 2},${cy + len / 2 - t / 2}`;
  const vLen = h / 2 - t;
  return {
    a: bar(x + w / 2, y + t / 2, w, true),
    b: bar(x + w - t / 2, y + h / 4 + t / 4, vLen, false),
    c: bar(x + w - t / 2, y + (3 * h) / 4 - t / 4, vLen, false),
    d: bar(x + w / 2, y + h - t / 2, w, true),
    e: bar(x + t / 2, y + (3 * h) / 4 - t / 4, vLen, false),
    f: bar(x + t / 2, y + h / 4 + t / 4, vLen, false),
    g: bar(x + w / 2, midY, w, true),
  };
}

/**
 * A multiplexed seven-segment module, drawn from perceived brightness.
 *
 * Each segment's opacity is the level the persistence model reports, so a
 * properly scanned four-digit display shows four digits at roughly a quarter
 * brightness each — which is what the hardware looks like — and a digit that is
 * never enabled stays black.
 */
function SevenSegMultiArt({ def, visual, digits: fixedDigits }: ArtProps & { digits?: number }) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  // A bare module has one common pin per digit; a driven one (TM1637) has two
  // wires and its digit count is a property of the chip, so it is passed in.
  const digits = fixedDigits ?? def.pins.filter((p) => /^d\d+$/.test(p.id)).length;
  const brightness = visual?.elementBrightness ?? {};

  const pad = w * 0.05;
  const cellW = (w - pad * 2) / digits;
  const digitW = cellW * 0.72;
  const digitH = h * 0.6;
  const top = h * 0.14;

  const parts: JSX.Element[] = [];
  for (let d = 0; d < digits; d++) {
    const x = pad + d * cellW + (cellW - digitW) / 2;
    const shapes = segmentShapes(x, top, digitW, digitH);
    for (const [seg, points] of Object.entries(shapes)) {
      const level = brightness[`${d}.${seg}`] ?? 0;
      parts.push(
        <polygon
          key={`${d}-${seg}`}
          points={points}
          fill={level > 0.01 ? '#ff4b3e' : '#2a1614'}
          opacity={level > 0.01 ? 0.35 + level * 0.65 : 1}
        />,
      );
    }
    const dp = brightness[`${d}.dp`] ?? 0;
    parts.push(
      <circle
        key={`${d}-dp`}
        cx={x + digitW + cellW * 0.08}
        cy={top + digitH}
        r={Math.min(w, h) * 0.022}
        fill={dp > 0.01 ? '#ff4b3e' : '#2a1614'}
        opacity={dp > 0.01 ? 0.35 + dp * 0.65 : 1}
      />,
    );
  }

  return (
    <g>
      <rect x="1" y="1.5" width={w} height={h} rx="3" fill="rgba(0,0,0,0.35)" />
      <rect width={w} height={h} rx="3" fill="#1a1210" stroke="#2e2320" />
      {parts}
    </g>
  );
}

/**
 * A bare 8x8 matrix, drawn from perceived brightness.
 *
 * Distinct from the MAX7219 panel below it: that one reads the driver's own row
 * registers, which hold a whole frame at once. This one has no driver, so every
 * pixel it shows is a scan the firmware is running right now.
 */
function BareLedMatrixArt({ def, visual }: ArtProps) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const brightness = visual?.elementBrightness ?? {};
  const pad = Math.min(w, h) * 0.12;
  const cell = (Math.min(w, h) - pad * 2) / 8;

  const dots: JSX.Element[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const level = brightness[`${row}.c${col + 1}`] ?? 0;
      dots.push(
        <circle
          key={`${row}-${col}`}
          cx={pad + (col + 0.5) * cell}
          cy={pad + (row + 0.5) * cell}
          r={cell * 0.34}
          fill={level > 0.01 ? '#ff4b3e' : '#241a18'}
          opacity={level > 0.01 ? 0.3 + level * 0.7 : 1}
        />,
      );
    }
  }

  return (
    <g>
      <rect x="1" y="1.5" width={w} height={h} rx="3" fill="rgba(0,0,0,0.35)" />
      <rect width={w} height={h} rx="3" fill="#141010" stroke="#2e2320" />
      {dots}
    </g>
  );
}

function OledArt(props: ArtProps) {
  return <MonoPanelArt {...props} cols={128} rows={64} idleLabel="OLED" />;
}

/** The SH1107's square 128×128 glass, drawn from the same RAM machinery. */
function Sh1107Art(props: ArtProps) {
  return <MonoPanelArt {...props} cols={128} rows={128} idleLabel="SH1107" />;
}

/**
 * A monochrome dot-matrix panel of any geometry, drawn from device RAM.
 *
 * Split out of the SSD1306 renderer when the SH1107 arrived, because the two
 * differ only in how many dots there are. Everything that made the OLED look
 * right is geometry-driven rather than hard-coded: the glass takes the panel's
 * own aspect ratio, so a 2:1 128×64 and a square 128×128 are both drawn with
 * square pixels, and each run of adjacent lit dots becomes one rect instead of
 * one rect per dot — 8192 nodes a frame was a lot of DOM for a part 27 mm wide,
 * and a 128×128 panel would have been twice that.
 */
function MonoPanelArt({
  def,
  visual,
  cols,
  rows,
  idleLabel,
  ink = '#a9e6ff',
  glass: glassFill = '#04060a',
  reflective = false,
}: ArtProps & {
  cols: number;
  rows: number;
  idleLabel: string;
  ink?: string;
  glass?: string;
  /** Paper rather than emitter: matte glass, no glow, no backlight bleed. */
  reflective?: boolean;
}) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const display = visual?.display;
  const header = headerEdge(def);

  // As large as the module allows, at the panel's true aspect ratio — and
  // inside it in BOTH directions. Fitting on width alone is what made the
  // 128x296 e-paper draw a panel a third taller than the module it is on,
  // spilling white over whatever was next to it on the canvas.
  const band = h * 0.11; // reserved for the pin header, at the edge the pins are on
  const availW = w * 0.9;
  const availH = h - band - h * 0.06;
  let glassW = availW;
  let glassH = (glassW * rows) / cols;
  if (glassH > availH) {
    glassH = availH;
    glassW = (glassH * cols) / rows;
  }
  const glass = {
    x: (w - glassW) / 2,
    y: header === 'top' ? band + (availH - glassH) / 2 : h * 0.05 + (availH - glassH) / 2,
    w: glassW,
    h: glassH,
  };
  const px = glass.w / cols;
  const py = glass.h / rows;

  const lit: JSX.Element[] = [];
  if (display?.on && display.pixels) {
    const ram = display.pixels;
    for (let row = 0; row < rows; row++) {
      const page = row >> 3;
      const bit = row & 7;
      let runStart = -1;
      for (let x = 0; x <= cols; x++) {
        const on = x < cols && ((ram[page * cols + x] >> bit) & 1) === 1;
        if (on && runStart < 0) runStart = x;
        if (!on && runStart >= 0) {
          lit.push(
            <rect
              key={`${row}-${runStart}`}
              x={glass.x + runStart * px}
              y={glass.y + row * py}
              width={(x - runStart) * px}
              height={Math.max(py, 0.5)}
              fill={ink}
            />,
          );
          runStart = -1;
        }
      }
    }
  }

  const bezel = Math.max(2.5, Math.min(w, h) * 0.035);

  return (
    <g>
      <rect x="1" y="1.5" width={w} height={h} rx="4" fill="rgba(0,0,0,0.35)" />
      <rect width={w} height={h} rx="4" fill={reflective ? '#1b1e22' : '#101318'} stroke="#333c46" />
      <PinHeader def={def} w={w} h={h} edge={header} />
      {/* A metal bezel around a recessed panel: the frame is what makes the
          glass read as glass rather than as a dark rectangle painted on. */}
      <rect
        x={glass.x - bezel}
        y={glass.y - bezel}
        width={glass.w + bezel * 2}
        height={glass.h + bezel * 2}
        rx={bezel * 0.6}
        fill="#39424c"
        stroke="#1c2228"
      />
      <rect
        x={glass.x - bezel}
        y={glass.y - bezel}
        width={glass.w + bezel * 2}
        height={bezel * 0.9}
        rx={bezel * 0.4}
        fill="rgba(255,255,255,0.16)"
      />
      <rect x={glass.x} y={glass.y} width={glass.w} height={glass.h} fill={glassFill} />
      {lit}
      {/* An emissive panel has a glass sheet over it and catches the light.
          Paper does not, which is the whole difference between the two. */}
      {!reflective && (
        <rect
          x={glass.x}
          y={glass.y}
          width={glass.w}
          height={glass.h * 0.3}
          fill="rgba(255,255,255,0.055)"
          pointerEvents="none"
        />
      )}
      {!display?.on && (
        <text
          x={w / 2}
          y={glass.y + glass.h * 0.55}
          fontSize={Math.min(glass.h * 0.22, glass.w * 0.16)}
          fill={reflective ? 'rgba(90,88,82,0.55)' : '#2b333d'}
          textAnchor="middle"
          fontFamily="'DejaVu Sans Mono', 'Courier New', monospace"
        >
          {idleLabel}
        </text>
      )}
    </g>
  );
}

/**
 * Which edge of a module its pins are on.
 *
 * Read from the footprint rather than passed in, so a renderer shared by
 * several parts draws the connector where that part's wires actually land.
 */
function headerEdge(def: ComponentDefinition): 'top' | 'bottom' {
  if (def.pins.length === 0) return 'top';
  const mean = def.pins.reduce((a, p) => a + p.y, 0) / def.pins.length;
  return mean < (def.heightMm * MM) / 2 ? 'top' : 'bottom';
}

/**
 * The pin header strip, drawn over the pads the footprint already places.
 *
 * Nothing here moves a pin: the strip is sized from the outermost pads and the
 * gold pins are drawn at each pad's own x.
 */
function PinHeader({
  def,
  w,
  h,
  edge,
  thickness,
}: {
  def: ComponentDefinition;
  w: number;
  h: number;
  edge: 'top' | 'bottom';
  thickness?: number;
}) {
  if (def.pins.length === 0) return null;
  const t = thickness ?? Math.max(5, h * 0.09);
  const xs = def.pins.map((p) => p.x);
  const pad = Math.max(3, Math.min(w, h) * 0.03);
  const x0 = Math.max(0, Math.min(...xs) - pad);
  const x1 = Math.min(w, Math.max(...xs) + pad);
  const y = edge === 'top' ? 0 : h - t;
  return (
    <g>
      <rect x={x0} y={y} width={x1 - x0} height={t} rx={1.5} fill="#15181c" stroke="#0b0e12" strokeWidth="0.6" />
      {def.pins.map((p) => (
        <rect key={p.id} x={p.x - 1.4} y={y + t * 0.18} width="2.8" height={t * 0.64} rx="1" fill="#d8b25c" />
      ))}
    </g>
  );
}

// ------------------------------------------------------------- the LCD panel
//
// This part had no renderer of its own and fell through to the generic box,
// which drew the sixteen characters at a fixed 5.5 units — about 1.4 mm on a
// part 80 mm wide. It read as small print on a plastic rectangle rather than as
// a lit display, which is the opposite of what a display is for.
//
// The module is drawn the way one looks on a bench: a dark PCB, a metal bezel
// around a recessed panel, and an illuminated character area that dominates
// everything else on the part. What is drawn *in* that area is the HD44780's
// own DDRAM, unchanged — the artwork is the glass, not the content.
//
// The geometry is purely inside the part's existing box. No pin moves.

/**
 * Backlight colours of the two character modules people actually buy.
 *
 * The I2C 1602/2004 boards ship with a blue-and-white STN panel; the bare
 * parallel modules are the classic yellow-green. Same controller, same glass
 * construction, different filter — so it is one renderer with a colour, not
 * two drawings.
 */
const LCD_BACKLIGHTS = {
  blue: { on: '#1f5fd0', off: '#101c30', ink: '#eaf4ff', dim: '#2b3c55' },
  green: { on: '#7ea52a', off: '#2c3a1a', ink: '#12200c', dim: '#48562f' },
} as const;

/**
 * Every character LCD in the library, at any geometry.
 *
 * There used to be two of these: the I2C 1602 got a metal bezel and a lit
 * panel, and the parallel modules got a flat green rectangle with small text on
 * it. Standing side by side on one sheet they did not look like the same class
 * of hardware, which they are — a 20x4 is a 16x2 with more of it, and the I2C
 * board is the same panel with a backpack soldered on the back.
 *
 * What is drawn in the character area is the controller's own DDRAM. The
 * artwork is the glass, not the content.
 */
function CharacterLcdArt({
  def,
  visual,
  columns,
  rows,
  tint = 'blue',
}: ArtProps & { columns: number; rows: number; tint?: keyof typeof LCD_BACKLIGHTS }) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const lines = visual?.readout ?? [];
  // Backlight follows the real backlight bit. An unlit panel is dark and its
  // characters are barely legible, which is true of the hardware.
  const lit = visual?.ledOn !== false && lines.length > 0 && !/not initialised/i.test(lines[0] ?? '');
  const colours = LCD_BACKLIGHTS[tint];

  const edge = headerEdge(def);
  const headerH = Math.max(6, h * 0.1);
  // The panel takes everything the header does not, which is what makes the
  // display the part rather than a detail on it.
  const top = edge === 'top' ? headerH + h * 0.035 : h * 0.045;
  const bezelH = h - headerH - h * 0.08;
  const bezel = { x: w * 0.035, y: top, w: w * 0.93, h: bezelH };
  const inset = Math.max(3, Math.min(w, h) * 0.028);
  const glass = { x: bezel.x + inset, y: bezel.y + inset, w: bezel.w - inset * 2, h: bezel.h - inset * 2 };
  // Characters live inside a small margin so the outermost column is not flush
  // against the bezel, as on a real panel.
  const area = { x: glass.x + glass.w * 0.03, y: glass.y + glass.h * 0.08, w: glass.w * 0.94, h: glass.h * 0.84 };
  const cellW = area.w / columns;
  const rowH = area.h / rows;
  const fontSize = Math.min(rowH * 0.82, cellW * 1.5);

  const backlight = lit ? colours.on : colours.off;
  const character = lit ? colours.ink : colours.dim;

  const cells: JSX.Element[] = [];
  for (let row = 0; row < rows; row++) {
    const text = (lines[row] ?? '').slice(0, columns);
    for (let col = 0; col < columns; col++) {
      const ch = text[col];
      if (!ch || ch === ' ') continue;
      cells.push(
        <text
          key={`${row}-${col}`}
          className="device-readout"
          x={area.x + (col + 0.5) * cellW}
          y={area.y + (row + 0.5) * rowH + fontSize * 0.35}
          fontSize={fontSize}
          fill={character}
          textAnchor="middle"
          fontFamily="'DejaVu Sans Mono', 'Courier New', monospace"
        >
          {ch}
        </text>,
      );
    }
  }

  return (
    <g>
      {/* PCB */}
      <rect x="1" y="1.5" width={w} height={h} rx="5" fill="rgba(0,0,0,0.35)" />
      <rect width={w} height={h} rx="5" fill="#123a2c" stroke="#0a241b" />
      <PinHeader def={def} w={w} h={h} edge={edge} thickness={headerH} />
      {/* Bezel: a metal frame with a lit edge, so the panel reads as recessed. */}
      <rect x={bezel.x} y={bezel.y} width={bezel.w} height={bezel.h} rx="3" fill="#39424c" stroke="#1c2228" />
      <rect x={bezel.x} y={bezel.y} width={bezel.w} height={bezel.h * 0.1} rx="3" fill="rgba(255,255,255,0.14)" />
      {/* The panel itself. */}
      <rect x={glass.x} y={glass.y} width={glass.w} height={glass.h} fill={backlight} stroke="#0c1420" />
      {lit && (
        <rect
          x={glass.x}
          y={glass.y}
          width={glass.w}
          height={glass.h * 0.42}
          fill="rgba(255,255,255,0.10)"
        />
      )}
      {/* Character cells, faintly, the way a dot-matrix panel shows them. */}
      {Array.from({ length: columns - 1 }, (_, i) => (
        <line
          key={`c${i}`}
          x1={area.x + (i + 1) * cellW}
          y1={area.y}
          x2={area.x + (i + 1) * cellW}
          y2={area.y + area.h}
          stroke="rgba(0,0,0,0.10)"
          strokeWidth="0.6"
        />
      ))}
      {Array.from({ length: rows - 1 }, (_, i) => (
        <line
          key={`r${i}`}
          x1={area.x}
          y1={area.y + (i + 1) * rowH}
          x2={area.x + area.w}
          y2={area.y + (i + 1) * rowH}
          stroke="rgba(0,0,0,0.10)"
          strokeWidth="0.6"
        />
      ))}
      {cells}
    </g>
  );
}

// ---------- Batch 1: contact inputs ----------
//
// These all read `visual.contacts`, which is a map from contact key to whether
// it is engaged — so a keypad with four keys down draws four keys down, rather
// than the single "pressed" boolean a one-contact part gets away with.

const engagedIn = (visual: ComponentVisualState | undefined, key: string): boolean =>
  Boolean(visual?.contacts?.[key]);

function PushButton6mmArt({ def, visual }: ArtProps) {
  const pressed = Boolean(visual?.contacts?.[''] ?? visual?.pressed);
  const W = def.widthMm * MM;
  return (
    <g>
      {[[0.6, 0.6], [5.9, 0.6], [0.6, 5.9], [5.9, 5.9]].map(([x, y], i) => (
        <circle key={i} cx={x * MM} cy={y * MM} r={0.55 * MM} fill="#9aa4ad" stroke="#6b747d" strokeWidth="0.5" />
      ))}
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={W - 1 * MM} rx="2.5" fill="#20262d" stroke="#0d1117" />
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={(W - 1 * MM) / 2} rx="2.5" fill="rgba(255,255,255,0.06)" />
      <TactileCap cx={W / 2} cy={W / 2} r={1.9 * MM} pressed={pressed} />
    </g>
  );
}

function SlideSwitchArt({ def, visual }: ArtProps) {
  // The actuator sits over NO when the changeover contact is engaged.
  const toNo = engagedIn(visual, '');
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return (
    <g>
      <rect x={0.4 * MM} y={0.8 * MM} width={W - 0.8 * MM} height={H - 2.4 * MM} rx="2" fill="#c9ccd1" stroke="#8b9199" />
      <rect x={1.6 * MM} y={1.8 * MM} width={W - 3.2 * MM} height={H - 4.4 * MM} rx="1" fill="#2a3037" />
      <rect
        x={(toNo ? 1.9 : W / MM - 4.3) * MM}
        y={2.1 * MM}
        width={2.4 * MM}
        height={H - 5 * MM}
        rx="0.8"
        fill="#e8e9ea"
        stroke="#9aa1a8"
        strokeWidth="0.6"
      />
      {[2.5, 5.5, 8.5].map((x, i) => (
        <line key={i} x1={x * MM} y1={H - 1.6 * MM} x2={x * MM} y2={H} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

function LimitSwitchArt({ def, visual }: ArtProps) {
  const pressed = engagedIn(visual, '');
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return (
    <g>
      <rect x={0.4 * MM} y={2.4 * MM} width={W - 0.8 * MM} height={H - 4 * MM} rx="1.5" fill="#1d232a" stroke="#0d1117" />
      <rect x={1.2 * MM} y={3.2 * MM} width={W - 2.4 * MM} height={2 * MM} rx="0.8" fill="rgba(255,255,255,0.06)" />
      {/* The plunger under the lever, which is the part the lever presses and
          the thing that tells you this is a microswitch and not a lever. */}
      <rect
        x={W * 0.5 - 0.7 * MM}
        y={(pressed ? 2.5 : 1.9) * MM}
        width={1.4 * MM}
        height={(pressed ? 0.9 : 1.5) * MM}
        rx="0.4"
        fill={pressed ? '#4b545d' : '#b9c1c9'}
        stroke="#6b747d"
        strokeWidth="0.5"
      />
      {/* The lever: hinged at the left, deflected onto the body when actuated. */}
      <path
        d={`M ${1.6 * MM} ${3.0 * MM} L ${(W - 2 * MM)} ${(pressed ? 2.9 : 0.9) * MM}`}
        stroke="#d3d7db"
        strokeWidth={0.9 * MM}
        strokeLinecap="round"
        fill="none"
      />
      <circle cx={1.6 * MM} cy={3.0 * MM} r={0.7 * MM} fill="#9aa4ad" />
      {/* The roller on the tip. */}
      <circle
        cx={W - 2 * MM}
        cy={(pressed ? 2.9 : 0.9) * MM}
        r={0.9 * MM}
        fill="#c9ccd1"
        stroke="#6b747d"
        strokeWidth="0.5"
      />
      <text
        x={W / 2}
        y={H - 3.2 * MM}
        textAnchor="middle"
        fontSize={2.1 * MM}
        fill={pressed ? '#7fb2e8' : '#7c858e'}
        fontFamily="sans-serif"
      >
        {pressed ? 'NO' : 'NC'}
      </text>
      {[3.0, 8.0, 13.0].map((x, i) => (
        <line key={i} x1={x * MM} y1={H - 1.6 * MM} x2={x * MM} y2={H} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

function DipSwitchArt({ def, instance, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  // Poles come from the same hotspots the canvas hit-tests, so the actuator is
  // always centred in the slot the pointer is aimed at.
  const poles = interactiveHotspots(def, instance);
  // The window the actuators travel in, with the pole numbers printed on the
  // case below it. The part is 9.5 mm tall, so the numbers only fit because the
  // window stops short of the bottom edge — and they matter: a bank of white
  // nubs tells you the pattern but not which pole is which.
  const win = { x: 1.1 * MM, y: 2.0 * MM, w: W - 2.2 * MM, h: H - 5.6 * MM };
  return (
    <g>
      <rect x="0.8" y="1" width={W - 1.2 * MM} height={H - 2 * MM} rx="1.2" fill="rgba(0,0,0,0.35)" transform={`translate(${0.6 * MM} ${1.0 * MM})`} />
      <rect x={0.6 * MM} y={1.0 * MM} width={W - 1.2 * MM} height={H - 2 * MM} rx="1.2" fill="#2f6ba8" stroke="#1d4670" />
      <rect x={win.x} y={win.y} width={win.w} height={win.h} rx="0.8" fill="#1e2833" />
      {/* The ON end of the travel, marked on the window the way the case marks
          it — the nub positions only mean something once you know which end is
          which. */}
      <rect x={win.x} y={win.y} width={win.w} height={1.1} fill="rgba(255,255,255,0.5)" />
      {poles.map((spot) => {
        const on = engagedIn(visual, spot.key);
        const nub = dipActuatorRect(spot, on, win);
        return (
          <g key={spot.key}>
            <rect
              x={nub.x}
              y={nub.y}
              width={nub.w}
              height={nub.h}
              rx="0.4"
              fill={on ? '#f6f8fa' : '#98a1a9'}
              stroke="#5f676e"
              strokeWidth="0.5"
            />
            {on && <rect x={nub.x} y={nub.y} width={nub.w} height={nub.h * 0.35} rx="0.4" fill="rgba(255,255,255,0.55)" />}
            <text
              x={spot.x + spot.w / 2}
              y={H - 1.55 * MM}
              textAnchor="middle"
              fontSize={2.4 * MM}
              fill={on ? '#ffffff' : '#c6d2dd'}
              fontFamily="sans-serif"
              fontWeight={600}
            >
              {spot.cap}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function RotaryEncoderArt({ def, visual }: ArtProps) {
  const clicked = engagedIn(visual, 'sw');
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cx = W / 2;
  const cy = 11 * MM;
  return (
    <g>
      <rect x={0.6 * MM} y={0.6 * MM} width={W - 1.2 * MM} height={H - 3 * MM} rx="1.5" fill="#1c5aa8" stroke="#123f78" />
      <rect x={2.4 * MM} y={4.5 * MM} width={W - 4.8 * MM} height={13 * MM} rx="1" fill="#c9ccd1" stroke="#8b9199" />
      {/* The plated can the shaft comes out of, then the shaft itself. Without
          the can the encoder was a dark disc on a blue board, which is also
          what a dozen other modules look like at 1:1. */}
      <circle cx={cx} cy={cy} r={6.0 * MM} fill="#20262d" stroke="#12171c" strokeWidth="1" />
      <circle cx={cx} cy={cy} r={5.2 * MM} fill="#3f4750" stroke="#12171c" strokeWidth="1" />
      <circle cx={cx - 1.3 * MM} cy={cy - 1.6 * MM} r={3.2 * MM} fill="rgba(255,255,255,0.07)" />
      {/* Pressed reads as the shaft sinking: a smaller, darker cap with a
          highlight ring around it, which is legible at 1:1 in a way that a
          two-tenths-of-a-millimetre radius change is not. */}
      {clicked && <circle cx={cx} cy={cy} r={5.9 * MM} fill="none" stroke="#7fb2e8" strokeWidth="1.6" />}
      {/* Knurling on the flank of the shaft, drawn as flutes rather than
          spokes — a real D-shaft is ridged all the way round its edge. */}
      {Array.from({ length: 16 }, (_, i) => {
        const angle = (i / 16) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={cx + Math.cos(angle) * 3.6 * MM}
            y1={cy + Math.sin(angle) * 3.6 * MM}
            x2={cx + Math.cos(angle) * 5.1 * MM}
            y2={cy + Math.sin(angle) * 5.1 * MM}
            stroke="rgba(0,0,0,0.45)"
            strokeWidth="1.1"
          />
        );
      })}
      <circle cx={cx} cy={cy} r={(clicked ? 2.7 : 3.6) * MM} fill={clicked ? '#12171c' : '#2a3037'} stroke="#12171c" />
      {/* The flat of the D-shaft, so the knob has an orientation you can see. */}
      <rect
        x={cx - 2.4 * MM}
        y={cy - (clicked ? 2.7 : 3.6) * MM}
        width={4.8 * MM}
        height={1.1 * MM}
        fill="rgba(255,255,255,0.16)"
      />
      <text x={cx} y={H - 3.6 * MM} textAnchor="middle" fontSize={2.2 * MM} fill="#cfe0f4" fontFamily="sans-serif">KY-040</text>
      {[3.0, 7.5, 12.0, 16.5].map((x, i) => (
        <line key={i} x1={x * MM} y1={H - 2 * MM} x2={x * MM} y2={H} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

function JoystickArt({ def, visual }: ArtProps) {
  const clicked = engagedIn(visual, 'sw');
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const gimbalX = W / 2;
  const gimbalY = 13 * MM;
  // The stick sits where the wipers say it does. These are the same two numbers
  // the module imposes on its VRx/VRy pins, so a stick drawn hard over is a
  // stick the firmware is reading as hard over — there is no separate animation
  // and nothing moves that the ADC would not see move. A part with no published
  // axes (unpowered, or not yet simulated) draws centred, which is where a real
  // stick's springs hold it.
  const axes = visual?.axes;
  const throwR = 4.6 * MM;
  const dx = ((axes?.x ?? 0.5) - 0.5) * 2 * throwR;
  const dy = ((axes?.y ?? 0.5) - 0.5) * 2 * throwR;
  const cx = gimbalX + dx;
  const cy = gimbalY + dy;
  const deflected = Math.hypot(dx, dy) > 0.5;
  return (
    <g>
      <rect x={0.6 * MM} y={0.6 * MM} width={W - 1.2 * MM} height={H - 3 * MM} rx="1.5" fill="#1c5aa8" stroke="#123f78" />
      {/* Gimbal housing */}
      <rect x={4 * MM} y={2.5 * MM} width={W - 8 * MM} height={21 * MM} rx="2" fill="#2a3037" stroke="#12171c" />
      <circle cx={gimbalX} cy={gimbalY} r={9.5 * MM} fill="#20262d" stroke="#12171c" strokeWidth="1.2" />
      {/* The opening the shaft moves in, so the offset reads as travel rather
          than as a cap drawn slightly off centre. */}
      <circle cx={gimbalX} cy={gimbalY} r={throwR + 1.4 * MM} fill="#0e1319" stroke="#12171c" />
      {/* Clicked reads as the cap pushed in: smaller, darker, ringed. */}
      {clicked && <circle cx={cx} cy={cy} r={9.5 * MM} fill="none" stroke="#7fb2e8" strokeWidth="1.8" />}
      {/* The shaft, leaning out of the gimbal towards the cap. */}
      {deflected && (
        <line
          x1={gimbalX}
          y1={gimbalY}
          x2={cx}
          y2={cy}
          stroke="#12171c"
          strokeWidth={3.2 * MM}
          strokeLinecap="round"
        />
      )}
      <circle cx={cx} cy={cy} r={(clicked ? 5.4 : 6.8) * MM} fill={clicked ? '#0b0f13' : '#171d23'} stroke="#0b0f13" />
      <ellipse cx={cx} cy={cy - 1.5 * MM} rx={(clicked ? 3.4 : 4.6) * MM} ry={(clicked ? 2.2 : 3.2) * MM} fill="rgba(255,255,255,0.09)" />
      <text x={W / 2} y={H - 3.4 * MM} textAnchor="middle" fontSize={2.2 * MM} fill="#cfe0f4" fontFamily="sans-serif">JOYSTICK</text>
      {[6, 11, 16, 21, 26].map((x, i) => (
        <line key={i} x1={x * MM} y1={H - 2 * MM} x2={x * MM} y2={H} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

/**
 * Keypads and the mini keyboard, drawn from the same key grid the contacts
 * come from — so a key that lights up is exactly the contact that closed.
 */
function KeyMatrixArt({ def, instance, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  // The same rects the canvas hit-tests against, so the key that lights up is
  // always the key the pointer was actually over.
  const keys = interactiveHotspots(def, instance);
  if (keys.length === 0) return <GenericBoxArt def={def} instance={instance} visual={visual} />;

  // The membrane sheet the keys are embossed in: everything above the header
  // band. Drawn from the keys' own extent so it fits whatever grid the part is.
  const top = Math.min(...keys.map((k) => k.y));
  const bottom = Math.max(...keys.map((k) => k.y + k.h));
  const left = Math.min(...keys.map((k) => k.x));
  const right = Math.max(...keys.map((k) => k.x + k.w));
  const margin = Math.min(2.2 * MM, (W - (right - left)) / 2);
  const sheet = {
    x: left - margin,
    y: top - margin,
    w: right - left + margin * 2,
    h: bottom - top + margin * 2,
  };
  // Where the flat tail leaves the sheet on a real membrane keypad: at the pin
  // edge, over the pads the footprint already places.
  const tailY = sheet.y + sheet.h;

  return (
    <g>
      {/* Backing plate */}
      <rect x="1" y="1.5" width={W} height={H} rx="3" fill="rgba(0,0,0,0.35)" />
      <rect width={W} height={H} rx="3" fill="#171c22" stroke="#0d1117" />
      {/* The membrane itself: a slightly proud sheet with a printed border, so
          the keys sit in something rather than floating on the body. */}
      <rect x={sheet.x} y={sheet.y} width={sheet.w} height={sheet.h} rx={1.5 * MM} fill="#2b323a" stroke="#3d4650" />
      <rect
        x={sheet.x + 0.8 * MM}
        y={sheet.y + 0.8 * MM}
        width={sheet.w - 1.6 * MM}
        height={sheet.h - 1.6 * MM}
        rx={1.2 * MM}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="0.8"
      />
      {/* The flat flex tail down to the header. */}
      <rect
        x={W / 2 - sheet.w * 0.22}
        y={tailY - 0.4 * MM}
        width={sheet.w * 0.44}
        height={Math.max(2 * MM, H - tailY - 1.6 * MM)}
        rx="1"
        fill="#3a3223"
        stroke="#241f14"
      />
      {keys.map((k) => {
        const down = engagedIn(visual, k.key);
        // A pressed membrane key goes down into its well: it loses the raised
        // highlight, gains an inner shadow and shifts a fraction. At 1:1 that
        // reads instantly, where a border colour change did not.
        const dy = down ? k.h * 0.06 : 0;
        return (
          <g key={k.key}>
            {/* The well the key is embossed out of. */}
            <rect
              x={k.x - k.w * 0.04}
              y={k.y - k.h * 0.04}
              width={k.w * 1.08}
              height={k.h * 1.08}
              rx={k.radius * 1.2}
              fill="rgba(0,0,0,0.35)"
            />
            <rect
              x={k.x}
              y={k.y + dy}
              width={k.w}
              height={k.h}
              rx={k.radius}
              fill={down ? '#1f262e' : '#39424c'}
              stroke={down ? '#7fb2e8' : '#1a1f25'}
              strokeWidth={down ? 1.6 : 0.8}
            />
            {down ? (
              <rect
                x={k.x}
                y={k.y + dy}
                width={k.w}
                height={k.h * 0.4}
                rx={k.radius}
                fill="rgba(0,0,0,0.55)"
              />
            ) : (
              <rect x={k.x} y={k.y} width={k.w} height={k.h * 0.42} rx={k.radius} fill="rgba(255,255,255,0.09)" />
            )}
            <text
              x={k.x + k.w / 2}
              y={k.y + dy + k.h * 0.68}
              textAnchor="middle"
              fontSize={k.h * 0.5}
              fill={down ? '#eaf3ff' : '#d5dde5'}
              fontFamily="sans-serif"
              fontWeight={600}
            >
              {k.cap.trim()}
            </text>
          </g>
        );
      })}
      {def.pins.map((p) => (
        <line key={p.id} x1={p.x} y1={H - 3.5 * MM} x2={p.x} y2={H} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

/**
 * The TSOP module: a black epoxy lump with a domed lens and three legs.
 *
 * The dome is the recognisable part — it is what tells you at a glance that
 * this is a receiver and not a transistor, which is otherwise the same shape.
 */
function IrReceiverArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const lit = visual?.on === true;
  return (
    <g>
      <rect x={W * 0.1} y={H * 0.12} width={W * 0.8} height={H * 0.56} rx={W * 0.12} fill="#14181d" stroke="#04070a" />
      <path
        d={`M ${W * 0.24} ${H * 0.5} A ${W * 0.26} ${H * 0.24} 0 1 1 ${W * 0.76} ${H * 0.5} Z`}
        fill={lit ? '#3a2f22' : '#20262d'}
        stroke="#0a0d11"
        strokeWidth="0.8"
      />
      <ellipse cx={W * 0.42} cy={H * 0.3} rx={W * 0.08} ry={H * 0.05} fill="rgba(255,255,255,0.16)" />
      {def.pins.map((p) => (
        <line key={p.id} x1={p.x} y1={H * 0.66} x2={p.x} y2={H} stroke="#a8b0b8" strokeWidth="1.6" />
      ))}
    </g>
  );
}

/**
 * The nRF24 module: a blue board with the chip antenna's meander at the top
 * and the 2x4 header at the bottom. The meander is the recognisable part.
 */
function Nrf24Art({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const busy = visual?.on === true;
  const trace = `M ${W * 0.18} ${H * 0.1} ` +
    [0, 1, 2, 3].map((i) => `L ${W * (0.18 + i * 0.21)} ${H * (i % 2 ? 0.1 : 0.22)} L ${W * (0.28 + i * 0.21)} ${H * (i % 2 ? 0.1 : 0.22)}`).join(' ');
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 1 * MM} rx="2" fill="#12356b" stroke="#0a1f42" />
      <path d={trace} fill="none" stroke="#c9a227" strokeWidth={W * 0.05} strokeLinejoin="miter" />
      <rect x={W * 0.24} y={H * 0.34} width={W * 0.52} height={H * 0.24} rx="1.5" fill="#14181d" stroke="#000" strokeWidth="0.6" />
      <circle cx={W * 0.3} cy={H * 0.4} r={W * 0.035} fill="#2b323a" />
      <rect
        x={W * 0.2} y={H * 0.63} width={W * 0.16} height={H * 0.05} rx="1"
        fill={busy ? '#ff8a5f' : '#1d2b45'}
      />
      {def.pins.map((p) => (
        <rect key={p.id} x={p.x - 1.1} y={p.y - 1.1} width="2.2" height="2.2" rx="0.5" fill="#d8b24a" />
      ))}
    </g>
  );
}

/**
 * The SX1278 breakout: a dark board dominated by the shielded module can, with
 * the antenna pad at one corner. The can is what makes it recognisable.
 */
function LoraArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const active = visual?.on === true;
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 1 * MM} rx="2" fill="#1b2a24" stroke="#0c1512" />
      <rect x={W * 0.12} y={H * 0.1} width={W * 0.76} height={H * 0.44} rx="1.5" fill="#9aa4ad" stroke="#5d666e" strokeWidth="0.8" />
      <rect x={W * 0.18} y={H * 0.16} width={W * 0.64} height={H * 0.32} rx="1" fill="none" stroke="#7d868e" strokeWidth="0.6" />
      <text x={W / 2} y={H * 0.36} textAnchor="middle" fontSize={H * 0.09} fill="#4a5259" fontFamily="sans-serif">SX1278</text>
      <circle cx={W * 0.86} cy={H * 0.62} r={W * 0.07} fill={active ? '#8fdc6a' : '#2f4038'} stroke="#101a16" strokeWidth="0.6" />
      {def.pins.map((p) => (
        <rect key={p.id} x={p.x - 1.1} y={p.y - 1.1} width="2.2" height="2.2" rx="0.5" fill="#d8b24a" />
      ))}
    </g>
  );
}

/** The MCP2515 board: a wide DIP-18, a can crystal, and a screw terminal. */
function Mcp2515Art({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const busy = visual?.on === true;
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 1 * MM} rx="1.5" fill="#1d4a2a" stroke="#0c2415" />
      <rect x={W * 0.06} y={H * 0.3} width={W * 0.42} height={H * 0.36} rx="1" fill="#14181d" stroke="#000" strokeWidth="0.6" />
      <circle cx={W * 0.11} cy={H * 0.37} r={W * 0.012} fill="#3a424a" />
      <text x={W * 0.27} y={H * 0.52} textAnchor="middle" fontSize={H * 0.11} fill="#7d868e" fontFamily="sans-serif">MCP2515</text>
      <rect x={W * 0.53} y={H * 0.34} width={W * 0.16} height={H * 0.28} rx="1" fill="#2b3a45" stroke="#101a20" strokeWidth="0.6" />
      <text x={W * 0.61} y={H * 0.51} textAnchor="middle" fontSize={H * 0.08} fill="#93a0a8" fontFamily="sans-serif">TJA</text>
      <rect x={W * 0.72} y={H * 0.36} width={W * 0.1} height={H * 0.16} rx={W * 0.03} fill="#8a9299" stroke="#4a5259" strokeWidth="0.5" />
      <rect x={W * 0.76} y={H * 0.06} width={W * 0.2} height={H * 0.18} rx="1" fill="#2b3a45" stroke="#101a20" strokeWidth="0.6" />
      <circle cx={W * 0.81} cy={H * 0.15} r={W * 0.018} fill="#4a5259" />
      <circle cx={W * 0.9} cy={H * 0.15} r={W * 0.018} fill="#4a5259" />
      <rect x={W * 0.86} y={H * 0.56} width={W * 0.06} height={H * 0.06} rx="0.6" fill={busy ? '#ff8a5f' : '#123020'} />
      {def.pins.map((p) => (
        <rect key={p.id} x={p.x - 1.1} y={p.y - 1.1} width="2.2" height="2.2" rx="0.5" fill="#d8b24a" />
      ))}
    </g>
  );
}

/** The little RS-485 breakout: a DIP-8 on a green board with a screw terminal. */
function Max485Art({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const driving = visual?.on === true;
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 1 * MM} rx="1.5" fill="#1d4a2a" stroke="#0c2415" />
      <rect x={W * 0.1} y={H * 0.06} width={W * 0.42} height={H * 0.2} rx="1" fill="#2b3a45" stroke="#101a20" strokeWidth="0.6" />
      <circle cx={W * 0.19} cy={H * 0.16} r={W * 0.02} fill="#4a5259" />
      <circle cx={W * 0.42} cy={H * 0.16} r={W * 0.02} fill="#4a5259" />
      <rect x={W * 0.28} y={H * 0.36} width={W * 0.44} height={H * 0.3} rx="1" fill="#14181d" stroke="#000" strokeWidth="0.6" />
      <circle cx={W * 0.34} cy={H * 0.43} r={W * 0.02} fill="#3a424a" />
      <text x={W * 0.5} y={H * 0.56} textAnchor="middle" fontSize={H * 0.11} fill="#7d868e" fontFamily="sans-serif">485</text>
      <rect x={W * 0.76} y={H * 0.4} width={W * 0.1} height={H * 0.08} rx="0.6" fill={driving ? '#ff8a5f' : '#123020'} />
      {def.pins.map((p) => (
        <rect key={p.id} x={p.x - 1.1} y={p.y - 1.1} width="2.2" height="2.2" rx="0.5" fill="#d8b24a" />
      ))}
    </g>
  );
}

/** The little square transmitter: a SAW resonator and a coil on bare board. */
function Rf433TxArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const keyed = visual?.on === true;
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 1 * MM} rx="1.5" fill="#1f3a52" stroke="#0c1c2b" />
      <rect x={W * 0.12} y={H * 0.14} width={W * 0.34} height={H * 0.3} rx="1" fill={keyed ? '#c86a3a' : '#8a9299'} stroke="#4a5259" strokeWidth="0.6" />
      <path
        d={`M ${W * 0.56} ${H * 0.18} q ${W * 0.06} ${H * 0.08} 0 ${H * 0.16} q ${W * -0.06} ${H * 0.08} 0 ${H * 0.16}`}
        fill="none" stroke="#c9a227" strokeWidth={W * 0.05}
      />
      <rect x={W * 0.12} y={H * 0.54} width={W * 0.2} height={H * 0.12} rx="0.8" fill="#12232f" />
      {def.pins.map((p) => (
        <rect key={p.id} x={p.x - 1.1} y={p.y - 1.1} width="2.2" height="2.2" rx="0.5" fill="#d8b24a" />
      ))}
    </g>
  );
}

/** The wider receiver board, with its coil and the tuning can. */
function Rf433RxArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const hearing = visual?.on === true;
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 1 * MM} rx="1.5" fill="#1f3a52" stroke="#0c1c2b" />
      <rect x={W * 0.08} y={H * 0.16} width={W * 0.22} height={H * 0.4} rx="1" fill="#8a9299" stroke="#4a5259" strokeWidth="0.6" />
      <rect x={W * 0.36} y={H * 0.2} width={W * 0.14} height={H * 0.3} rx="0.8" fill={hearing ? '#c86a3a' : '#12232f'} />
      <path
        d={`M ${W * 0.58} ${H * 0.2} q ${W * 0.04} ${H * 0.1} 0 ${H * 0.2} q ${W * -0.04} ${H * 0.1} 0 ${H * 0.18}`}
        fill="none" stroke="#c9a227" strokeWidth={W * 0.03}
      />
      <circle cx={W * 0.82} cy={H * 0.34} r={W * 0.05} fill="#2b3a45" stroke="#101a20" strokeWidth="0.5" />
      {def.pins.map((p) => (
        <rect key={p.id} x={p.x - 1.1} y={p.y - 1.1} width="2.2" height="2.2" rx="0.5" fill="#d8b24a" />
      ))}
    </g>
  );
}

/** A 5 mm LED in clear or smoked epoxy, with the flat on the cathode side. */
function IrLedArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const lit = visual?.on === true;
  return (
    <g>
      <path
        d={`M ${W * 0.16} ${H * 0.52} L ${W * 0.16} ${H * 0.3} A ${W * 0.34} ${H * 0.26} 0 1 1 ${W * 0.84} ${H * 0.3} L ${W * 0.84} ${H * 0.52} Z`}
        fill={lit ? '#6a3a55' : '#3a3550'}
        stroke="#241f36"
        strokeWidth="0.8"
      />
      <rect x={W * 0.12} y={H * 0.5} width={W * 0.76} height={H * 0.07} rx={W * 0.03} fill="#2b2740" />
      <ellipse cx={W * 0.38} cy={H * 0.24} rx={W * 0.09} ry={H * 0.06} fill="rgba(255,255,255,0.28)" />
      {def.pins.map((p) => (
        <line key={p.id} x1={p.x} y1={H * 0.56} x2={p.x} y2={H} stroke="#a8b0b8" strokeWidth="1.4" />
      ))}
    </g>
  );
}

/**
 * The virtual remote: a body of round keys, drawn from the same rects the
 * canvas hit-tests, with an emitter window at the top that lights while a key
 * is held.
 */
function IrRemoteArt({ def, instance, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const keys = interactiveHotspots(def, instance);
  const anyDown = keys.some((k) => engagedIn(visual, k.key));
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 1 * MM} rx={3 * MM} fill="#1b1f24" stroke="#0a0d11" />
      <rect x={1.8 * MM} y={1.8 * MM} width={W - 3.6 * MM} height={H - 3.6 * MM} rx={2.4 * MM} fill="#262c33" />
      <rect
        x={W / 2 - 5 * MM}
        y={1.4 * MM}
        width={10 * MM}
        height={2.4 * MM}
        rx={1.2 * MM}
        fill={anyDown ? '#7a2f24' : '#12161a'}
        stroke={anyDown ? '#ff7a5f' : '#0a0d11'}
        strokeWidth="0.8"
      />
      {keys.map((k) => {
        const down = engagedIn(visual, k.key);
        return (
          <g key={k.key}>
            <circle
              cx={k.x + k.w / 2}
              cy={k.y + k.h / 2}
              r={k.w / 2}
              fill={down ? '#4d5a68' : '#333b44'}
              stroke={down ? '#7fb2e8' : '#171c22'}
              strokeWidth={down ? 1.4 : 0.8}
            />
            <text
              x={k.x + k.w / 2}
              y={k.y + k.h * 0.64}
              textAnchor="middle"
              fontSize={k.h * (k.cap.length > 2 ? 0.34 : 0.5)}
              fill={down ? '#eaf3ff' : '#c3ccd5'}
              fontFamily="sans-serif"
            >
              {k.cap}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// ===================================================== shared part primitives
//
// Seven separate drawings would be seven separate styles. These are the pieces
// the hardware parts have in common — a lead, a metal can, a moulded body —
// factored out so the library reads as one thing rather than as a collection.
// Deliberately small: enough for a consistent language, not a framework.

/** A tinned lead running from a body edge out to where the pin actually is. */
function Lead({ x1, y1, x2, y2, width = 2.2 }: { x1: number; y1: number; x2: number; y2: number; width?: number }) {
  return (
    <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#6f7982" strokeWidth={width + 0.8} strokeLinecap="round" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#c3cbd3" strokeWidth={width} strokeLinecap="round" />
    </>
  );
}

/**
 * A moulded plastic body: base colour, a lit upper half and a dark lower edge.
 *
 * The three-band treatment is what makes a rectangle read as an object with
 * depth rather than as a filled shape, and it is the same treatment on every
 * part here so they look related.
 */
function MouldedBody({
  x, y, w, h, r = 3, fill, stroke,
}: { x: number; y: number; w: number; h: number; r?: number; fill: string; stroke: string }) {
  return (
    <>
      <rect x={x + 1} y={y + 1.5} width={w} height={h} rx={r} fill="rgba(0,0,0,0.32)" />
      <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} stroke={stroke} />
      <rect x={x + 1} y={y + 1} width={w - 2} height={h * 0.38} rx={r * 0.7} fill="rgba(255,255,255,0.10)" />
      <rect x={x} y={y + h * 0.82} width={w} height={h * 0.18} rx={r * 0.7} fill="rgba(0,0,0,0.18)" />
    </>
  );
}

/** A drawn-metal cylinder seen from the side, for motor cans and coils. */
function MetalCan({
  x, y, w, h, r = 3, base = '#8d959d',
}: { x: number; y: number; w: number; h: number; r?: number; base?: string }) {
  return (
    <>
      <rect x={x + 1} y={y + 1.5} width={w} height={h} rx={r} fill="rgba(0,0,0,0.32)" />
      <rect x={x} y={y} width={w} height={h} rx={r} fill={base} stroke="#4d545b" />
      <rect x={x} y={y + h * 0.06} width={w} height={h * 0.22} rx={r * 0.6} fill="rgba(255,255,255,0.34)" />
      <rect x={x} y={y + h * 0.72} width={w} height={h * 0.2} rx={r * 0.6} fill="rgba(0,0,0,0.22)" />
    </>
  );
}

/** Small supporting marking. Never the thing that identifies the part. */
function Marking({ x, y, text, size = 5, fill = 'rgba(255,255,255,0.78)' }: { x: number; y: number; text: string; size?: number; fill?: string }) {
  return (
    <text x={x} y={y} fontSize={size} fill={fill} textAnchor="middle" fontFamily="'DejaVu Sans', sans-serif">
      {text}
    </text>
  );
}

// ------------------------------------------------------------------- diode
//
// An axial glass/epoxy body with a cathode band, leads running out to the two
// pins. The band is on the cathode side and stays there: the definition puts
// the anode at the left and the cathode at the right, and the artwork has to
// agree with the electrical model rather than the other way round.
function DiodeArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cy = 1.8 * MM;
  const body = { x: 2.4 * MM, w: W - 4.8 * MM };
  const bandW = body.w * 0.16;
  return (
    <g>
      <Lead x1={0.4 * MM} y1={cy} x2={body.x + 1} y2={cy} />
      <Lead x1={body.x + body.w - 1} y1={cy} x2={W - 0.4 * MM} y2={cy} />
      <rect x={body.x + 1} y={cy - H * 0.34 + 1.5} width={body.w} height={H * 0.68} rx={H * 0.2} fill="rgba(0,0,0,0.3)" />
      <rect x={body.x} y={cy - H * 0.34} width={body.w} height={H * 0.68} rx={H * 0.2} fill="#2a2320" stroke="#141110" />
      <rect x={body.x} y={cy - H * 0.34} width={body.w} height={H * 0.26} rx={H * 0.13} fill="rgba(255,255,255,0.16)" />
      {/* The cathode band, at the cathode end, which is the right-hand pin. */}
      <rect x={body.x + body.w - bandW - body.w * 0.1} y={cy - H * 0.34} width={bandW} height={H * 0.68} fill="#e6e9ec" />
    </g>
  );
}

// -------------------------------------------------------------- transistor
//
// A TO-92: a half-round moulded body with a flat face and three leads fanning
// out to the pins the definition already places. E/B/C stay in the order the
// definition gives them; the letters are small because the silhouette is what
// is supposed to identify it.
function TransistorArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const pins = [0.8, 3.0, 5.2].map((mm) => mm * MM);
  const legY = 5.6 * MM;
  const bodyBottom = H * 0.56;
  const cx = W / 2;
  const rx = W * 0.4;
  return (
    <g>
      {pins.map((x, i) => (
        <Lead key={i} x1={cx + (x - cx) * 0.55} y1={bodyBottom - 1} x2={x} y2={legY} width={1.8} />
      ))}
      {/* TO-92: round back, flat front. */}
      <path
        d={`M ${cx - rx} ${bodyBottom} A ${rx} ${rx} 0 0 1 ${cx + rx} ${bodyBottom} Z`}
        fill="rgba(0,0,0,0.3)"
        transform="translate(1 1.5)"
      />
      <path
        d={`M ${cx - rx} ${bodyBottom} A ${rx} ${rx} 0 0 1 ${cx + rx} ${bodyBottom} Z`}
        fill="#20242a"
        stroke="#0c0f12"
      />
      <path
        d={`M ${cx - rx * 0.8} ${bodyBottom * 0.55} A ${rx * 0.8} ${rx * 0.8} 0 0 1 ${cx + rx * 0.8} ${bodyBottom * 0.55} Z`}
        fill="rgba(255,255,255,0.09)"
      />
      {/* The flat face, which is how a TO-92 is oriented by eye. */}
      <line x1={cx - rx} y1={bodyBottom} x2={cx + rx} y2={bodyBottom} stroke="#454e57" strokeWidth="1.4" />
      {/*
        No E/B/C lettering here. The part is 6 mm across: a letter large enough
        to read would sit on top of the lead it names, and the canvas already
        draws "Emitter"/"Base"/"Collector" above each pin. The silhouette and
        the flat face are what identify it.
      */}
    </g>
  );
}

// ------------------------------------------------------------------ MOSFET
//
// A TO-220: a moulded body with a metal tab and a mounting hole above it, which
// is the silhouette that distinguishes a power device from the little TO-92
// next to it in the library. G/D/S keep the definition's order.
function MosfetArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const pins = [1.7, 5.0, 8.3].map((mm) => mm * MM);
  const legY = 8.6 * MM;
  const tab = { x: W * 0.12, y: H * 0.06, w: W * 0.76, h: H * 0.26 };
  const body = { x: W * 0.12, y: tab.y + tab.h, w: W * 0.76, h: H * 0.36 };
  return (
    <g>
      {pins.map((x, i) => (
        <Lead key={i} x1={x} y1={body.y + body.h - 1} x2={x} y2={legY} width={2} />
      ))}
      {/* Metal mounting tab with its hole. */}
      <rect x={tab.x} y={tab.y} width={tab.w} height={tab.h} rx="1.5" fill="#9aa3ab" stroke="#5b636b" />
      <rect x={tab.x} y={tab.y} width={tab.w} height={tab.h * 0.4} rx="1.5" fill="rgba(255,255,255,0.3)" />
      <circle cx={W / 2} cy={tab.y + tab.h * 0.5} r={Math.min(tab.h, tab.w) * 0.28} fill="#3c434a" stroke="#20262d" />
      <MouldedBody x={body.x} y={body.y} w={body.w} h={body.h} r={2} fill="#1b1f24" stroke="#0a0d10" />
      {/*
        G/D/S go on the body, not next to the leads: the canvas draws its own
        pin labels there and two sets of names in the same place is worse than
        one. On the body they read as package marking, which is where a real
        TO-220 carries its printing.
      */}
      {['G', 'D', 'S'].map((label, i) => (
        <Marking key={label} x={pins[i]} y={body.y + body.h * 0.78} text={label} size={6} fill="rgba(196,208,220,0.9)" />
      ))}
    </g>
  );
}

// ----------------------------------------------------------------- speaker
//
// A cone driver seen face on: outer rim, surround, cone, dust cap, and two
// terminals at the pins. No state — the speaker is a validation-level part and
// nothing in the simulation reports whether it is sounding, so nothing here
// pretends it does.
function SpeakerArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cx = W / 2;
  const cy = H * 0.46;
  const r = Math.min(W, H) * 0.44;
  return (
    <g>
      <Lead x1={7 * MM} y1={cy + r * 0.7} x2={7 * MM} y2={19.6 * MM} width={1.8} />
      <Lead x1={13 * MM} y1={cy + r * 0.7} x2={13 * MM} y2={19.6 * MM} width={1.8} />
      <circle cx={cx + 1} cy={cy + 1.5} r={r} fill="rgba(0,0,0,0.32)" />
      {/* Pressed-steel basket. */}
      <circle cx={cx} cy={cy} r={r} fill="#2b3138" stroke="#12161a" />
      <circle cx={cx} cy={cy} r={r} fill="rgba(255,255,255,0.07)" clipPath="inset(0 0 55% 0)" />
      {/* Surround and cone. */}
      <circle cx={cx} cy={cy} r={r * 0.82} fill="#3a424a" stroke="#1b2026" />
      <circle cx={cx} cy={cy} r={r * 0.7} fill="#1d2228" stroke="#0e1215" />
      <circle cx={cx} cy={cy} r={r * 0.44} fill="#262c33" />
      {/* Dust cap, which is the thing that says "speaker" at a glance. */}
      <circle cx={cx} cy={cy} r={r * 0.26} fill="#39414a" stroke="#191d22" />
      <circle cx={cx - r * 0.1} cy={cy - r * 0.11} r={r * 0.11} fill="rgba(255,255,255,0.16)" />
      <Marking x={7 * MM} y={cy + r * 0.98} text="+" size={5} fill="rgba(255,255,255,0.6)" />
    </g>
  );
}

// ------------------------------------------------------------------- relay
//
// A relay breakout: a PCB with the sealed relay can on it, the coil/contact
// terminal block on the load side, and the three logic pins along the bottom
// edge where the definition puts them.
//
// The one stateful thing here is real. `coilOn` comes from the voltage on the
// IN net, which the circuit binding already computes, so the armature and the
// COM→NO/NC path move because the input is genuinely driven — not on a timer.
function RelayArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const energised = Boolean(visual?.coilOn);
  const can = { x: W * 0.14, y: H * 0.3, w: W * 0.72, h: H * 0.34 };
  const block = { x: W * 0.1, y: H * 0.06, w: W * 0.8, h: H * 0.17 };
  const comX = 6 * MM;
  const noX = 13 * MM;
  const ncX = 20 * MM;
  const armFrom = energised ? noX : ncX;
  return (
    <g>
      {/* PCB */}
      <rect x="1" y="1.5" width={W} height={H} rx="4" fill="rgba(0,0,0,0.34)" />
      <rect width={W} height={H} rx="4" fill="#123a2c" stroke="#0a241b" />
      {/* Screw terminal block on the load side, above COM/NO/NC. */}
      <rect x={block.x} y={block.y} width={block.w} height={block.h} rx="2" fill="#1a5fa8" stroke="#0d3766" />
      <rect x={block.x} y={block.y} width={block.w} height={block.h * 0.34} rx="2" fill="rgba(255,255,255,0.16)" />
      {[comX, noX, ncX].map((x) => (
        <circle key={x} cx={x} cy={block.y + block.h * 0.55} r={block.h * 0.3} fill="#2b3138" stroke="#0d1114" />
      ))}
      {/* The switched path, drawn between the terminals it actually joins. */}
      <line
        x1={comX}
        y1={block.y + block.h + 3}
        x2={armFrom}
        y2={block.y + block.h + 3}
        stroke={energised ? '#ffb454' : '#5d6a76'}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      {/* Sealed relay can. */}
      <MouldedBody x={can.x} y={can.y} w={can.w} h={can.h} r={2} fill="#1e2a36" stroke="#0b1017" />
      <Marking x={W / 2} y={can.y + can.h * 0.46} text="10A 250VAC" size={4.4} fill="rgba(255,255,255,0.62)" />
      <Marking x={W / 2} y={can.y + can.h * 0.78} text={energised ? 'COM–NO' : 'COM–NC'} size={4.4} fill={energised ? '#ffb454' : 'rgba(255,255,255,0.45)'} />
      {/* Coil state indicator. Abstract, and only ever driven by coilOn. */}
      <circle cx={W * 0.82} cy={H * 0.74} r={2.1 * MM} fill={energised ? '#ff5f52' : '#3a2626'} stroke="#1a1414" />
      {energised && <circle cx={W * 0.82} cy={H * 0.74} r={3.4 * MM} fill="#ff5f52" opacity="0.28" />}
      <Marking x={W * 0.3} y={H * 0.78} text="IN" size={4.6} fill="rgba(255,255,255,0.5)" />
    </g>
  );
}

// ---------------------------------------------------------------- DC motor
//
// A brushed can motor seen from the side: steel can, moulded end bell, output
// shaft, and the two terminals at the pins on the left edge.
//
// The shaft now carries real state, which it did not when this drawing was
// first made. `motor.angleDegrees` is an INTEGRATED position — the binding
// works it out from the voltage across the terminals — so the keyway turns
// because current is genuinely flowing, and a motor with a lead disconnected
// reports `connected: false` and does not move however hard the firmware
// drives it. Nothing here spins on a timer.
function DcMotorArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const can = { x: W * 0.16, y: H * 0.14, w: W * 0.6, h: H * 0.72 };
  const cy = H / 2;
  const motor = visual?.motor;
  const turning = motor !== undefined && motor.connected && motor.direction !== 'stopped';
  return (
    <g>
      <Lead x1={0.6 * MM} y1={8 * MM} x2={can.x + 2} y2={8 * MM} width={1.8} />
      <Lead x1={0.6 * MM} y1={12 * MM} x2={can.x + 2} y2={12 * MM} width={1.8} />
      {/* End bell, on the terminal side. */}
      <MouldedBody x={can.x - W * 0.06} y={can.y} w={W * 0.1} h={can.h} r={2} fill="#20262d" stroke="#0c1014" />
      <MetalCan x={can.x} y={can.y} w={can.w} h={can.h} r={4} />
      {/* Crimp lines down the can, which is what a real one looks like. */}
      {[0.3, 0.5, 0.7].map((f) => (
        <line
          key={f}
          x1={can.x + can.w * f}
          y1={can.y + 2}
          x2={can.x + can.w * f}
          y2={can.y + can.h - 2}
          stroke="rgba(0,0,0,0.18)"
          strokeWidth="1"
        />
      ))}
      {/* Front bearing boss and output shaft. */}
      <rect x={can.x + can.w} y={cy - H * 0.16} width={W * 0.07} height={H * 0.32} rx="2" fill="#6f7982" stroke="#454c53" />
      <rect x={can.x + can.w + W * 0.07} y={cy - 1.6} width={W * 0.13} height="3.2" rx="1.6" fill="#c3cbd3" stroke="#7b848c" />
      {/* A keyway on the shaft end, at the angle the model actually reports.
          Without a mark there is nothing on a round shaft to see turning. */}
      <g transform={`rotate(${motor?.angleDegrees ?? 0} ${can.x + can.w + W * 0.035} ${cy})`}>
        <circle cx={can.x + can.w + W * 0.035} cy={cy} r="2.4" fill="#3c434a" />
        <rect x={can.x + can.w + W * 0.035 - 0.6} y={cy - 2.4} width="1.2" height="2.4" fill={turning ? '#ffb454' : '#7b848c'} />
      </g>
      {/* Direction, from the terminals. Absent when the motor is stopped or a
          lead is not connected, because then there is nothing to report. */}
      {turning && (
        <path
          d={motor?.direction === 'forward'
            ? `M ${can.x + can.w * 0.34} ${can.y - 2} l 6 0 l -3 -4 Z`
            : `M ${can.x + can.w * 0.34} ${can.y - 2} l 6 0 l 3 -4 Z`}
          fill="#ffb454"
          opacity={0.35 + 0.65 * Math.min(1, motor?.magnitude ?? 0)}
        />
      )}
    </g>
  );
}

// ----------------------------------------------------------- stepper motor
//
// Deliberately unlike the DC motor next to it: a squat round stator with a
// stamped, segmented body and a visible mounting flange, plus the four winding
// leads coming out of one side as a ribbon rather than two terminals.
//
// The shaft carries the real step position, which is integrated from the coil
// pattern on the four windings rather than counted from what the firmware
// meant. A stepper missing a coil connection stays where it is.
function StepperArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cx = W * 0.62;
  const cy = H * 0.5;
  const r = Math.min(W, H) * 0.32;
  const leadYs = [9, 13, 17, 21].map((mm) => mm * MM);
  return (
    <g>
      {/* Mounting flange behind the body. */}
      <rect x={cx - r * 1.4} y={cy - r * 0.28} width={r * 2.8} height={r * 0.56} rx="2" fill="#79828b" stroke="#474e55" />
      <circle cx={cx - r * 1.2} cy={cy} r="2.4" fill="#2b3138" />
      <circle cx={cx + r * 1.2} cy={cy} r="2.4" fill="#2b3138" />
      {/* Stator can. */}
      <circle cx={cx + 1} cy={cy + 1.5} r={r} fill="rgba(0,0,0,0.32)" />
      <circle cx={cx} cy={cy} r={r} fill="#8d959d" stroke="#4d545b" />
      <circle cx={cx} cy={cy} r={r} fill="rgba(255,255,255,0.28)" clipPath="inset(0 0 62% 0)" />
      {/* Stamped segments, which read as laminations rather than as decoration. */}
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={cx + Math.cos(a) * r * 0.55}
            y1={cy + Math.sin(a) * r * 0.55}
            x2={cx + Math.cos(a) * r * 0.95}
            y2={cy + Math.sin(a) * r * 0.95}
            stroke="rgba(0,0,0,0.22)"
            strokeWidth="1.4"
          />
        );
      })}
      {/* Gearbox boss and shaft, on the front face, at the position the model
          integrated from the coil pattern. The flat is what makes the rotation
          visible; a plain circle would turn and look identical. */}
      <circle cx={cx} cy={cy} r={r * 0.46} fill="#6f7982" stroke="#454c53" />
      <g transform={`rotate(${visual?.motor?.angleDegrees ?? 0} ${cx} ${cy})`}>
        <circle cx={cx} cy={cy} r={r * 0.2} fill="#c3cbd3" stroke="#7b848c" />
        <rect x={cx - r * 0.2} y={cy - r * 0.06} width={r * 0.4} height={r * 0.12} fill="#7b848c" />
      </g>
      {/* The winding leads, as a ribbon out of one side. */}
      <rect x={2.2 * MM} y={leadYs[0] - 2.4 * MM} width={W * 0.12} height={leadYs[3] - leadYs[0] + 4.8 * MM} rx="2" fill="#20262d" stroke="#0c1014" />
      {leadYs.map((y, i) => (
        <line
          key={y}
          x1={0.6 * MM}
          y1={y}
          x2={2.2 * MM + W * 0.12}
          y2={y}
          stroke={['#c04a4a', '#c9a227', '#d0812c', '#4a7fc0'][i]}
          strokeWidth="2"
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

// ------------------------------------------------------------- motor driver
//
// The definition is specifically a dual H-bridge module: a 12 V rail, a 5 V
// rail, ENA/IN1..IN4/ENB along the bottom edge, and two motor outputs on each
// side. So the drawing says the same thing the pinout does, and reads in the
// direction the signal travels:
//
//     control header (bottom)  ->  power stage (middle)  ->  motor terminals
//
// The finned heatsink over the bridge is the feature that makes one of these
// recognisable across a bench, and it is what separates this from a relay
// module or a bare IC at a glance.
//
// No state. The part is validation-level: nothing reports enable, direction or
// PWM to the renderer, so nothing here moves.
function MotorDriverArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const heat = { x: W * 0.3, y: H * 0.24, w: W * 0.4, h: H * 0.38 };
  const term = (y: number) => ({ y: y * MM - 3.6 * MM, h: 7.2 * MM });
  const left = term(11);
  const right = term(11);
  return (
    <g>
      {/* PCB */}
      <rect x="1" y="1.5" width={W} height={H} rx="4" fill="rgba(0,0,0,0.34)" />
      <rect width={W} height={H} rx="4" fill="#123a2c" stroke="#0a241b" />
      {/* Motor output terminal blocks, over OUT1/OUT2 and OUT3/OUT4. */}
      {[{ x: 0, side: 'l' }, { x: W - W * 0.14, side: 'r' }].map(({ x, side }) => (
        <g key={side}>
          <rect x={x} y={side === 'l' ? left.y : right.y} width={W * 0.14} height={left.h} rx="2" fill="#1a5fa8" stroke="#0d3766" />
          <rect x={x} y={side === 'l' ? left.y : right.y} width={W * 0.14} height={left.h * 0.3} rx="2" fill="rgba(255,255,255,0.16)" />
          {[8, 14].map((mm) => (
            <circle key={mm} cx={x + W * 0.07} cy={mm * MM} r={W * 0.035} fill="#2b3138" stroke="#0d1114" />
          ))}
        </g>
      ))}
      {/* Power stage: the bridge under a finned heatsink. */}
      <MouldedBody x={heat.x} y={heat.y + heat.h * 0.62} w={heat.w} h={heat.h * 0.38} r={2} fill="#15181c" stroke="#080a0c" />
      <rect x={heat.x} y={heat.y} width={heat.w} height={heat.h * 0.66} rx="2" fill="#6f7982" stroke="#3f464d" />
      <rect x={heat.x} y={heat.y} width={heat.w} height={heat.h * 0.2} rx="2" fill="rgba(255,255,255,0.26)" />
      {Array.from({ length: 6 }, (_, i) => (
        <line
          key={i}
          x1={heat.x + ((i + 0.5) / 6) * heat.w}
          y1={heat.y + 2}
          x2={heat.x + ((i + 0.5) / 6) * heat.w}
          y2={heat.y + heat.h * 0.66 - 2}
          stroke="rgba(0,0,0,0.35)"
          strokeWidth="2"
        />
      ))}
      {/* Reservoir capacitor on the 12 V rail — the other thing that says
          "this drives motors" rather than "this is a logic board". */}
      <circle cx={W * 0.15} cy={H * 0.54} r={W * 0.095} fill="#20262d" stroke="#0b0e11" />
      <circle cx={W * 0.15} cy={H * 0.54} r={W * 0.095} fill="rgba(255,255,255,0.08)" clipPath="inset(0 0 55% 0)" />
      <path d={`M ${W * 0.085} ${H * 0.54} h ${W * 0.13}`} stroke="rgba(255,255,255,0.35)" strokeWidth="1.4" />
      {/* Control header along the bottom edge, over the logic pins. */}
      <rect x={W * 0.02} y={H - H * 0.12} width={W * 0.86} height={H * 0.085} rx="1.5" fill="#15181c" />
      {[2, 6, 10, 15, 19, 23, 27, 31, 35].map((mm) => (
        <rect key={mm} x={mm * MM - 1.5} y={H - H * 0.113} width="3" height={H * 0.07} rx="1" fill="#d8b25c" />
      ))}
      {/* Enable jumpers, which sit over ENA/ENB on a board like this. */}
      {[15, 35].map((mm) => (
        <rect key={mm} x={mm * MM - 3} y={H - H * 0.175} width="6" height={H * 0.05} rx="1.5" fill="#2d5fbd" stroke="#16306a" />
      ))}
      <Marking x={W / 2} y={H * 0.2} text="DUAL H-BRIDGE" size={6} fill="rgba(255,255,255,0.5)" />
      {/* Which terminal block is which channel, beside the pins themselves. */}
      <Marking x={W * 0.17} y={H * 0.42} text="OUT A" size={5.4} fill="rgba(255,255,255,0.42)" />
      <Marking x={W * 0.83} y={H * 0.42} text="OUT B" size={5.4} fill="rgba(255,255,255,0.42)" />
      {/* Silkscreen line between the power stage and the control header, so the
          board reads as two halves rather than one empty rectangle. */}
      <line x1={W * 0.06} y1={H * 0.7} x2={W * 0.94} y2={H * 0.7} stroke="rgba(255,255,255,0.13)" strokeWidth="1.2" />
      <Marking x={W / 2} y={H * 0.78} text="CONTROL" size={5.4} fill="rgba(255,255,255,0.38)" />
    </g>
  );
}

// ----------------------------------------------------------------- regulator
//
// The definition is a three-terminal LDO in the shape those come in: a moulded
// body with a wide metal tab behind it and three leads at the bottom, VIN, GND
// and VOUT left to right. The drawing keeps that order, so what a reader sees
// matches which pin the wire lands on.
//
// No state. Nothing reports whether it is powered, and a lit part that is not
// actually powered would be worse than a plain one.
function RegulatorArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const pins = [1.7, 5.0, 8.3].map((mm) => mm * MM);
  const legY = 8.6 * MM;
  const tab = { x: W * 0.1, y: H * 0.08, w: W * 0.8, h: H * 0.2 };
  const body = { x: W * 0.1, y: tab.y + tab.h, w: W * 0.8, h: H * 0.42 };
  return (
    <g>
      {pins.map((x, i) => (
        <Lead key={i} x1={x} y1={body.y + body.h - 1} x2={x} y2={legY} width={2} />
      ))}
      {/* The tab. On a package like this it is the output-side thermal pad, and
          it is most of what makes the silhouette recognisable. */}
      <rect x={tab.x} y={tab.y} width={tab.w} height={tab.h} rx="1.5" fill="#9aa3ab" stroke="#5b636b" />
      <rect x={tab.x} y={tab.y} width={tab.w} height={tab.h * 0.42} rx="1.5" fill="rgba(255,255,255,0.3)" />
      <MouldedBody x={body.x} y={body.y} w={body.w} h={body.h} r={2} fill="#1b1f24" stroke="#0a0d10" />
      {/* Reads left to right in the direction the energy goes, which is also
          the order the pins are in. */}
      <Marking x={W / 2} y={body.y + body.h * 0.48} text="VIN→VOUT" size={5.2} fill="rgba(196,208,220,0.85)" />
      <Marking x={W / 2} y={body.y + body.h * 0.92} text="3V3" size={5.6} fill="rgba(150,205,255,0.9)" />
    </g>
  );
}

// ----------------------------------------------------------- level converter
//
// Two voltage domains and the channels between them. The whole point of the
// part is that its two sides are at different voltages, so the drawing is
// built around that: a warm band along the high side, a cool band along the
// low side, and the channel devices in the gap between them.
//
// No arrows. The part is bidirectional — the simulation models each channel as
// an undirected edge — and an arrow would state something untrue about it.
//
// No state. Nothing reports channel activity or domain voltage to the renderer.
function LevelConverterArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const bandH = H * 0.17;
  const hv = { y: H * 0.06 };
  const lv = { y: H - H * 0.06 - bandH };
  const channelXs = [6, 10].map((mm) => mm * MM);
  return (
    <g>
      <rect x="1" y="1.5" width={W} height={H} rx="3" fill="rgba(0,0,0,0.34)" />
      <rect width={W} height={H} rx="3" fill="#123a2c" stroke="#0a241b" />
      {/* The two domains, as bands the eye separates before it reads anything. */}
      <rect x={W * 0.03} y={hv.y} width={W * 0.94} height={bandH} rx="2" fill="#7a3a1e" stroke="#4a2211" />
      <rect x={W * 0.03} y={hv.y} width={W * 0.94} height={bandH * 0.35} rx="2" fill="rgba(255,255,255,0.14)" />
      <rect x={W * 0.03} y={lv.y} width={W * 0.94} height={bandH} rx="2" fill="#1a4a7a" stroke="#0d2a47" />
      <rect x={W * 0.03} y={lv.y} width={W * 0.94} height={bandH * 0.35} rx="2" fill="rgba(255,255,255,0.14)" />
      <Marking x={W * 0.13} y={hv.y + bandH * 0.78} text="HV" size={6.2} fill="rgba(255,224,200,0.95)" />
      <Marking x={W * 0.13} y={lv.y + bandH * 0.78} text="LV" size={6.2} fill="rgba(200,228,255,0.95)" />
      {/* Header pads on both edges, over the pins the definition places. */}
      {[2, 6, 10, 14].map((mm) => (
        <rect key={`h${mm}`} x={mm * MM - 1.5} y={hv.y - 3} width="3" height={bandH * 0.45} rx="1" fill="#d8b25c" />
      ))}
      {[2, 6, 10, 14].map((mm) => (
        <rect key={`l${mm}`} x={mm * MM - 1.5} y={lv.y + bandH * 0.6} width="3" height={bandH * 0.45} rx="1" fill="#d8b25c" />
      ))}
      {/* One channel device per shifted pair, drawn between the pads it joins.
          Undirected, because the part is. */}
      {channelXs.map((x) => (
        <g key={x}>
          <line x1={x} y1={hv.y + bandH} x2={x} y2={lv.y} stroke="rgba(216,178,92,0.55)" strokeWidth="1.6" />
          <MouldedBody x={x - W * 0.07} y={H * 0.42} w={W * 0.14} h={H * 0.16} r={1.5} fill="#15181c" stroke="#080a0c" />
        </g>
      ))}
      {/* The ground both domains share, which is why the part works at all. */}
      <line x1={14 * MM} y1={hv.y + bandH} x2={14 * MM} y2={lv.y} stroke="rgba(255,255,255,0.22)" strokeWidth="1.4" strokeDasharray="3 3" />
    </g>
  );
}


// ======================================================= storage and clocks
//
// Checkpoint G. Nine parts were falling through to the generic box, and they
// split into two families: through-hole chips, which are all the same object
// with a different number printed on it, and breakout modules, which are only
// distinguishable by what is actually ON the board.
//
// The chips reuse the DIP renderer the logic ICs already use. That is the
// point of having it: a 74HC595 and a 24C256 ARE the same package, and drawing
// two of them by hand would produce two subtly different packages for no
// reason. What separates them at a glance is the marking, which is what
// separates them on a bench too.

/** A small PCB, the common ground of every breakout below. */
function Breakout({
  W, H, fill = '#14314a', stroke = '#081726',
}: { W: number; H: number; fill?: string; stroke?: string }) {
  return (
    <>
      <rect x="1" y="1.5" width={W} height={H} rx="3" fill="rgba(0,0,0,0.34)" />
      <rect width={W} height={H} rx="3" fill={fill} stroke={stroke} />
      <rect x={W * 0.04} y={H * 0.05} width={W * 0.92} height={H * 0.18} rx="2" fill="rgba(255,255,255,0.045)" />
    </>
  );
}

/** Gold pads under the pins a definition declares. Never invented positions. */
function PinPads({ def, r = 1.1 }: { def: ComponentDefinition; r?: number }) {
  return (
    <>
      {def.pins.map((p) => (
        <g key={p.id}>
          <circle cx={p.x} cy={p.y} r={r * 1.5} fill="#c8a53f" />
          <circle cx={p.x} cy={p.y} r={r * 0.62} fill="#1a1d21" />
        </g>
      ))}
    </>
  );
}

/** A surface-mount body, for the ICs that sit on a breakout. */
function SmdBody({
  x, y, w, h, label, size = 4,
}: { x: number; y: number; w: number; h: number; label?: string; size?: number }) {
  return (
    <>
      <rect x={x + 0.6} y={y + 0.8} width={w} height={h} rx="1.4" fill="rgba(0,0,0,0.3)" />
      <rect x={x} y={y} width={w} height={h} rx="1.4" fill="#20252b" stroke="#0a0d11" strokeWidth="0.6" />
      <rect x={x} y={y} width={w} height={h * 0.34} rx="1.2" fill="rgba(255,255,255,0.07)" />
      <circle cx={x + w * 0.16} cy={y + h * 0.24} r={Math.min(w, h) * 0.09} fill="#39424c" />
      {label && (
        <text x={x + w / 2} y={y + h * 0.66} textAnchor="middle" fontSize={size} fill="#98a4b0" fontFamily="sans-serif">
          {label}
        </text>
      )}
    </>
  );
}

/**
 * The microSD module: the socket is the whole identity of this part.
 *
 * A hinged metal cage with the card slot facing out, a card sitting in it, and
 * the level-shifter and regulator that every one of these boards carries. The
 * slot mouth is what you recognise across a desk; the word "SD" is not.
 */
function SdCardArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cage = { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: H * 0.46 };
  return (
    <g>
      <Breakout W={W} H={H} fill="#12354a" />
      {/* The card, sitting proud of the socket mouth. */}
      <path
        d={`M ${cage.x + cage.w * 0.14} ${cage.y - H * 0.05}
            h ${cage.w * 0.6} l ${cage.w * 0.1} ${H * 0.05}
            v ${cage.h * 0.5} h ${-cage.w * 0.7} z`}
        fill="#2a3138"
        stroke="#12161a"
        strokeWidth="0.7"
      />
      {/* Metal cage over it, which is the recognisable part. */}
      <rect x={cage.x} y={cage.y} width={cage.w} height={cage.h} rx="2" fill="#9aa4ad" stroke="#5b646c" />
      <rect x={cage.x} y={cage.y} width={cage.w} height={cage.h * 0.3} rx="2" fill="rgba(255,255,255,0.3)" />
      {/* Slot mouth. */}
      <rect x={cage.x + cage.w * 0.1} y={cage.y + cage.h * 0.62} width={cage.w * 0.8} height={cage.h * 0.22} rx="1" fill="#0d1114" />
      {/* Spring latch and the hinge pips a real cage has. */}
      <circle cx={cage.x + cage.w * 0.06} cy={cage.y + cage.h * 0.5} r="1.4" fill="#6f7982" />
      <circle cx={cage.x + cage.w * 0.94} cy={cage.y + cage.h * 0.5} r="1.4" fill="#6f7982" />
      {/* Level shifter and regulator, which is why these boards are this size. */}
      <SmdBody x={W * 0.1} y={H * 0.63} w={W * 0.34} h={H * 0.16} />
      <SmdBody x={W * 0.52} y={H * 0.63} w={W * 0.2} h={H * 0.14} />
      <PinPads def={def} />
    </g>
  );
}

/**
 * The DS3231 module: an RTC is recognisable by its battery, not its chip.
 *
 * The coin cell holder takes up a third of a real board and is the one feature
 * that tells you at a glance this thing keeps time when the power is off.
 */
function RtcModuleArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cellR = H * 0.3;
  return (
    <g>
      <Breakout W={W} H={H} fill="#123a2c" stroke="#0a241b" />
      {/* Coin cell in its holder. */}
      <circle cx={W * 0.7} cy={H * 0.46} r={cellR * 1.16} fill="#8d959d" stroke="#4d545b" />
      <circle cx={W * 0.7} cy={H * 0.46} r={cellR} fill="#c3cbd3" stroke="#7b848c" />
      <circle cx={W * 0.7} cy={H * 0.46} r={cellR * 0.55} fill="rgba(255,255,255,0.35)" />
      <path d={`M ${W * 0.7 - cellR * 1.3} ${H * 0.46} a ${cellR * 1.3} ${cellR * 1.3} 0 0 1 ${cellR * 0.7} ${-cellR * 1.1}`}
        fill="none" stroke="#6f7982" strokeWidth="2" />
      {/* The RTC itself and the crystal beside it. */}
      <SmdBody x={W * 0.08} y={H * 0.3} w={W * 0.3} h={H * 0.3} label="DS3231" size={3.4} />
      <rect x={W * 0.09} y={H * 0.66} width={W * 0.16} height={H * 0.12} rx={H * 0.06} fill="#9aa4ad" stroke="#5b646c" strokeWidth="0.5" />
      <PinPads def={def} />
    </g>
  );
}

/**
 * The MCP4725 breakout: small, one chip, and deliberately unlike the RTC.
 *
 * There is no battery and no crystal, so what is left is a tiny board with a
 * single package and an address-select jumper — which is what one is.
 */
function DacModuleArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return (
    <g>
      <Breakout W={W} H={H} fill="#3a2145" stroke="#1e0f26" />
      <SmdBody x={W * 0.22} y={H * 0.24} w={W * 0.4} h={H * 0.34} label="4725" size={3.6} />
      {/* Address jumper: two pads and a bridge, which is how you set A0. */}
      <rect x={W * 0.7} y={H * 0.28} width={W * 0.16} height={H * 0.1} rx="1" fill="#c8a53f" />
      <rect x={W * 0.7} y={H * 0.44} width={W * 0.16} height={H * 0.1} rx="1" fill="#c8a53f" />
      <rect x={W * 0.75} y={H * 0.3} width={W * 0.06} height={H * 0.22} fill="#e6e9ec" opacity="0.5" />
      <SmdBody x={W * 0.1} y={H * 0.66} w={W * 0.12} h={H * 0.1} />
      <PinPads def={def} />
    </g>
  );
}

/**
 * A pin header seen from above: plastic strip with square pins in it.
 *
 * Small, and it has to stay small — a header is 2.54 mm per pin and drawing it
 * bigger would make a connector look like a module.
 */
function HeaderArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return (
    <g>
      <rect x="0.8" y="1.2" width={W - 1.6} height={H - 1.6} rx="1.5" fill="rgba(0,0,0,0.3)" />
      <rect x="0" y="0.4" width={W} height={H - 1.6} rx="1.5" fill="#1a1d21" stroke="#0a0c0e" />
      <rect x="0" y="0.4" width={W} height={(H - 1.6) * 0.3} rx="1.5" fill="rgba(255,255,255,0.08)" />
      {def.pins.map((p) => (
        <g key={p.id}>
          <rect x={p.x - 1.2} y={(H - 1.6) * 0.28} width="2.4" height={(H - 1.6) * 0.5} fill="#0d1013" />
          <rect x={p.x - 0.9} y={(H - 1.6) * 0.32} width="1.8" height={(H - 1.6) * 0.42} fill="#d8b24a" />
        </g>
      ))}
    </g>
  );
}


// ================================================== communication modules ==
//
// Checkpoint F. Four of these were still generic boxes, and the test for each
// is the same: at normal zoom, before reading anything, can you tell which one
// it is? That means drawing the feature that identifies the module physically
// — a ceramic patch antenna, a metal can, a PCB antenna meander, a card slot —
// rather than putting its name in the middle of a rectangle.
//
// None of them animates. There is no fake radio blinking and no fake playback,
// because none of these parts exposes state a renderer could honestly read.

/** The zig-zag PCB antenna every 2.4 GHz module carries, as a real trace. */
function PcbAntenna({ x, y, w, h, stroke = '#c9a227' }: { x: number; y: number; w: number; h: number; stroke?: string }) {
  const segments = 5;
  let d = `M ${x} ${y + h}`;
  for (let i = 0; i < segments; i++) {
    const x0 = x + (w / segments) * i;
    const x1 = x + (w / segments) * (i + 1);
    d += ` L ${x0} ${y} L ${x1} ${y} L ${x1} ${y + h} L ${x1} ${y + h}`;
  }
  return <path d={d} fill="none" stroke={stroke} strokeWidth={Math.max(1.2, h * 0.16)} strokeLinejoin="miter" />;
}

/**
 * NEO-6M: the ceramic patch antenna IS the part.
 *
 * A real one is a 25 mm square of white ceramic with a gold feed dot, sitting
 * on top of a board barely bigger than it is. Nothing else about a GPS module
 * is distinctive, and nothing else needs to be.
 */
function GpsArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const patch = { x: W * 0.1, y: H * 0.06, w: W * 0.8, h: H * 0.55 };
  return (
    <g>
      <Breakout W={W} H={H} fill="#123a2c" stroke="#0a241b" />
      {/* Ceramic patch: pale, slightly domed, with the feed pin off centre. */}
      <rect x={patch.x + 1} y={patch.y + 1.5} width={patch.w} height={patch.h} rx="2" fill="rgba(0,0,0,0.3)" />
      <rect x={patch.x} y={patch.y} width={patch.w} height={patch.h} rx="2" fill="#e8e4d8" stroke="#a49c88" />
      <rect x={patch.x} y={patch.y} width={patch.w} height={patch.h * 0.34} rx="2" fill="rgba(255,255,255,0.5)" />
      <circle cx={patch.x + patch.w * 0.5} cy={patch.y + patch.h * 0.62} r={Math.min(patch.w, patch.h) * 0.07} fill="#c8a53f" />
      {/* The receiver and the backup cell that keeps the almanac. */}
      <SmdBody x={W * 0.12} y={H * 0.68} w={W * 0.36} h={H * 0.18} label="NEO-6M" size={3.2} />
      <circle cx={W * 0.72} cy={H * 0.76} r={H * 0.08} fill="#9aa4ad" stroke="#5b646c" strokeWidth="0.5" />
      <PinPads def={def} />
    </g>
  );
}

/**
 * HC-05: a small daughterboard soldered onto a carrier.
 *
 * That two-level construction is the give-away — the radio module is a
 * separate castellated board with its own meander antenna, sitting on a larger
 * one that carries the regulator, the button and the header.
 */
function Hc05Art({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const daughter = { x: W * 0.1, y: H * 0.06, w: W * 0.8, h: H * 0.52 };
  return (
    <g>
      <Breakout W={W} H={H} fill="#12354a" />
      {/* The daughterboard, raised off the carrier. */}
      <rect x={daughter.x + 1} y={daughter.y + 1.5} width={daughter.w} height={daughter.h} rx="2" fill="rgba(0,0,0,0.34)" />
      <rect x={daughter.x} y={daughter.y} width={daughter.w} height={daughter.h} rx="2" fill="#1c4a68" stroke="#0a2536" />
      {/* Castellated edge pads, which is how these are made. */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x={daughter.x} y={daughter.y + daughter.h * (0.12 + i * 0.14)} width={W * 0.05} height={H * 0.03} fill="#c8a53f" />
      ))}
      <PcbAntenna x={daughter.x + daughter.w * 0.18} y={daughter.y + daughter.h * 0.12} w={daughter.w * 0.64} h={daughter.h * 0.2} />
      <SmdBody x={daughter.x + daughter.w * 0.2} y={daughter.y + daughter.h * 0.46} w={daughter.w * 0.6} h={daughter.h * 0.38} label="BC417" size={3.2} />
      {/* Carrier: regulator, the little button, and an indicator position. */}
      <SmdBody x={W * 0.12} y={H * 0.64} w={W * 0.22} h={H * 0.1} />
      <rect x={W * 0.62} y={H * 0.63} width={W * 0.2} height={H * 0.11} rx="1.5" fill="#2b3138" stroke="#12161a" />
      <circle cx={W * 0.46} cy={H * 0.69} r={H * 0.022} fill="#3a2626" />
      <PinPads def={def} />
    </g>
  );
}

/**
 * ESP-01: unmistakable because of its shape.
 *
 * A stubby blue board with the shielded module at one end, the fat meander
 * antenna at the other, and the 2x4 header underneath — the header being the
 * reason everyone complains it does not fit a breadboard.
 */
function Esp01Art({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return (
    <g>
      <Breakout W={W} H={H} fill="#123a52" stroke="#08202e" />
      {/* Meander antenna at the top, wide and blunt as the real one. */}
      <PcbAntenna x={W * 0.12} y={H * 0.06} w={W * 0.76} h={H * 0.13} />
      {/* Shield can over the ESP8266 and its flash. */}
      <rect x={W * 0.14} y={H * 0.26} width={W * 0.72} height={H * 0.3} rx="1.6" fill="#9aa4ad" stroke="#5b646c" />
      <rect x={W * 0.14} y={H * 0.26} width={W * 0.72} height={H * 0.1} rx="1.6" fill="rgba(255,255,255,0.32)" />
      <text x={W / 2} y={H * 0.45} textAnchor="middle" fontSize={H * 0.055} fill="#5b646c" fontFamily="sans-serif">ESP-01</text>
      <SmdBody x={W * 0.2} y={H * 0.62} w={W * 0.24} h={H * 0.09} />
      <circle cx={W * 0.66} cy={H * 0.66} r={H * 0.02} fill="#2b3a45" />
      <PinPads def={def} />
    </g>
  );
}

/**
 * DFPlayer Mini: a card slot on a square board.
 *
 * The socket is nearly the whole part, which is exactly why it reads as
 * storage-and-audio rather than as another radio. Nothing here shows playback:
 * the model knows whether it is playing, but a drawn speaker cone that moved
 * would be inventing sound this simulator does not produce.
 */
function DfPlayerArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const slot = { x: W * 0.08, y: H * 0.1, w: W * 0.84, h: H * 0.44 };
  return (
    <g>
      <Breakout W={W} H={H} fill="#123a2c" stroke="#0a241b" />
      <rect x={slot.x} y={slot.y} width={slot.w} height={slot.h} rx="2" fill="#9aa4ad" stroke="#5b646c" />
      <rect x={slot.x} y={slot.y} width={slot.w} height={slot.h * 0.28} rx="2" fill="rgba(255,255,255,0.3)" />
      {/* The mouth, facing out, with the card's chamfer visible in it. */}
      <path
        d={`M ${slot.x + slot.w * 0.12} ${slot.y + slot.h * 0.62}
            h ${slot.w * 0.68} v ${slot.h * 0.26} h ${-slot.w * 0.76} z`}
        fill="#0d1114"
      />
      <path
        d={`M ${slot.x + slot.w * 0.18} ${slot.y + slot.h * 0.66} h ${slot.w * 0.5}
            l ${slot.w * 0.06} ${slot.h * 0.06} v ${slot.h * 0.12} h ${-slot.w * 0.56} z`}
        fill="#2a3138"
      />
      {/* The decoder, and the two capacitors on the audio output. */}
      <SmdBody x={W * 0.14} y={H * 0.62} w={W * 0.4} h={H * 0.2} label="YX5200" size={3.2} />
      <circle cx={W * 0.68} cy={H * 0.7} r={H * 0.07} fill="#20252b" stroke="#0a0d11" strokeWidth="0.6" />
      <circle cx={W * 0.84} cy={H * 0.7} r={H * 0.07} fill="#20252b" stroke="#0a0d11" strokeWidth="0.6" />
      <PinPads def={def} />
    </g>
  );
}


// ============================== sensors, actuators, power: the last boxes ==
//
// Checkpoints C, E and H. The eight parts still falling through to the generic
// renderer, each drawn from the thing that makes it recognisable in the hand.

/**
 * BMP280: a small breakout whose whole identity is the metal sensor can.
 *
 * The pressure sensor has a vent hole in a shiny lid, and that lid is the one
 * feature separating it from every other four-pin I2C board on the shelf.
 */
function Bmp280Art({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return (
    <g>
      <Breakout W={W} H={H} fill="#2a1a45" stroke="#150c26" />
      {/* The metal-lidded sensor, with its vent. */}
      <rect x={W * 0.3} y={H * 0.26} width={W * 0.28} height={H * 0.32} rx="1.2" fill="#b8c0c8" stroke="#6f7982" strokeWidth="0.6" />
      <rect x={W * 0.3} y={H * 0.26} width={W * 0.28} height={H * 0.12} rx="1.2" fill="rgba(255,255,255,0.5)" />
      <circle cx={W * 0.44} cy={H * 0.44} r={Math.min(W, H) * 0.045} fill="#2b3138" />
      {/* Regulator and the decoupling that every one of these carries. */}
      <SmdBody x={W * 0.66} y={H * 0.28} w={W * 0.16} h={H * 0.16} />
      <rect x={W * 0.66} y={H * 0.5} width={W * 0.1} height={H * 0.08} rx="0.8" fill="#3a3020" />
      <PinPads def={def} />
    </g>
  );
}

/**
 * MPU-6050: deliberately unlike the BMP280 beside it.
 *
 * Wider board, one big square QFN in the middle instead of a small can, and
 * the crystal and pull-ups around it. The proportions do most of the work.
 */
function Mpu6050Art({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const chip = { x: W * 0.36, y: H * 0.28, w: W * 0.3, h: H * 0.38 };
  return (
    <g>
      <Breakout W={W} H={H} fill="#12354a" />
      {/* The IMU itself: a square package with its corner dot. */}
      <rect x={chip.x + 0.6} y={chip.y + 0.8} width={chip.w} height={chip.h} rx="1.2" fill="rgba(0,0,0,0.3)" />
      <rect x={chip.x} y={chip.y} width={chip.w} height={chip.h} rx="1.2" fill="#1a1e23" stroke="#080a0d" strokeWidth="0.6" />
      <rect x={chip.x} y={chip.y} width={chip.w} height={chip.h * 0.3} rx="1.2" fill="rgba(255,255,255,0.06)" />
      <circle cx={chip.x + chip.w * 0.18} cy={chip.y + chip.h * 0.22} r={Math.min(chip.w, chip.h) * 0.1} fill="#39424c" />
      {/* Lead frame down two edges, which a QFN shows. */}
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x={chip.x - 1.2} y={chip.y + chip.h * (0.16 + i * 0.22)} width="1.2" height={chip.h * 0.1} fill="#8b9199" />
          <rect x={chip.x + chip.w} y={chip.y + chip.h * (0.16 + i * 0.22)} width="1.2" height={chip.h * 0.1} fill="#8b9199" />
        </g>
      ))}
      <SmdBody x={W * 0.1} y={H * 0.3} w={W * 0.14} h={H * 0.12} />
      <rect x={W * 0.76} y={H * 0.32} width={W * 0.1} height={H * 0.1} rx="0.8" fill="#3a3020" />
      <PinPads def={def} />
    </g>
  );
}

/**
 * Pulse sensor: a round pad you put a finger on, not a rectangle.
 *
 * The green LED and the photodiode sit side by side under a clear dome on the
 * sensing face, with the heart silkscreen around them. The round outline is
 * the whole point — this is the one part in the library you press against
 * skin, and it should not look like another breakout.
 *
 * No waveform is drawn. The model does not expose a beat, and an animated
 * pulse would be inventing a reading.
 */
function PulseSensorArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cx = W / 2;
  const cy = H * 0.46;
  const r = Math.min(W, H) * 0.38;
  return (
    <g>
      <circle cx={cx + 1} cy={cy + 1.5} r={r} fill="rgba(0,0,0,0.32)" />
      <circle cx={cx} cy={cy} r={r} fill="#0f3a2a" stroke="#08241a" />
      <circle cx={cx} cy={cy} r={r * 0.86} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      {/* Heart outline, as it is silkscreened on the real board. */}
      <path
        d={`M ${cx} ${cy + r * 0.42}
            C ${cx - r * 0.62} ${cy - r * 0.02} ${cx - r * 0.3} ${cy - r * 0.6} ${cx} ${cy - r * 0.22}
            C ${cx + r * 0.3} ${cy - r * 0.6} ${cx + r * 0.62} ${cy - r * 0.02} ${cx} ${cy + r * 0.42} Z`}
        fill="none"
        stroke="rgba(255,255,255,0.24)"
        strokeWidth="1.2"
      />
      {/* Emitter and detector under the dome, side by side as on the part. */}
      <circle cx={cx - r * 0.2} cy={cy} r={r * 0.16} fill="#5fd08a" stroke="#2a6b45" strokeWidth="0.6" />
      <circle cx={cx + r * 0.2} cy={cy} r={r * 0.14} fill="#1a1e23" stroke="#0a0d11" strokeWidth="0.6" />
      <circle cx={cx} cy={cy} r={r * 0.42} fill="rgba(255,255,255,0.10)" />
      <PinPads def={def} />
    </g>
  );
}

/**
 * Solenoid: a coil bobbin with a plunger sticking out of it.
 *
 * The plunger position follows the coil state the binding computes from the
 * voltage across the terminals — pulled in when energised, extended when not.
 * It does not oscillate and it does not move on a timer.
 */
function SolenoidArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const energised = Boolean(visual?.coilOn);
  const body = { x: W * 0.16, y: H * 0.2, w: W * 0.68, h: H * 0.5 };
  // Two positions, both real: in when the coil is driven, out when it is not.
  const travel = energised ? H * 0.1 : H * 0.24;
  return (
    <g>
      {/* Frame and end plates. */}
      <rect x={W * 0.1} y={body.y - H * 0.05} width={W * 0.8} height={H * 0.06} rx="1.5" fill="#5b646c" />
      <rect x={W * 0.1} y={body.y + body.h} width={W * 0.8} height={H * 0.06} rx="1.5" fill="#5b646c" />
      {/* Coil: a wound bobbin, drawn as windings rather than a filled block. */}
      <MouldedBody x={body.x} y={body.y} w={body.w} h={body.h} r={2} fill="#3a2a1e" stroke="#1b1310" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <line
          key={i}
          x1={body.x + 1}
          y1={body.y + body.h * (0.1 + i * 0.13)}
          x2={body.x + body.w - 1}
          y2={body.y + body.h * (0.1 + i * 0.13)}
          stroke="rgba(198,140,80,0.5)"
          strokeWidth="1.3"
        />
      ))}
      {/* Plunger, at the position the coil state puts it. */}
      <rect x={W / 2 - W * 0.09} y={travel} width={W * 0.18} height={body.y - travel + body.h * 0.5} rx={W * 0.05}
        fill="#b8c0c8" stroke="#6f7982" />
      <rect x={W / 2 - W * 0.13} y={travel} width={W * 0.26} height={H * 0.05} rx={H * 0.02} fill="#8d959d" stroke="#5b646c" />
      {energised && <circle cx={W * 0.84} cy={body.y + body.h * 0.5} r={H * 0.035} fill="#ffb454" />}
      <PinPads def={def} />
    </g>
  );
}

/** A CR2032 in its holder: round, thick, and obviously a coin. */
function CoinCellArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const cx = W / 2;
  const cy = H * 0.48;
  const r = Math.min(W, H) * 0.4;
  return (
    <g>
      {/* Retaining clip behind the cell. */}
      <path d={`M ${cx - r * 1.24} ${cy + r * 0.2} a ${r * 1.24} ${r * 1.24} 0 0 1 ${r * 2.48} 0`}
        fill="none" stroke="#6f7982" strokeWidth={r * 0.28} strokeLinecap="round" />
      <circle cx={cx + 1} cy={cy + 1.5} r={r} fill="rgba(0,0,0,0.32)" />
      <circle cx={cx} cy={cy} r={r} fill="#c3cbd3" stroke="#7b848c" />
      {/* The rim a button cell has, and the lit upper edge. */}
      <circle cx={cx} cy={cy} r={r * 0.82} fill="#d8dee4" stroke="#a8b0b8" strokeWidth="0.8" />
      <path d={`M ${cx - r * 0.82} ${cy} a ${r * 0.82} ${r * 0.82} 0 0 1 ${r * 1.64} 0`}
        fill="rgba(255,255,255,0.45)" />
      <text x={cx} y={cy + r * 0.16} textAnchor="middle" fontSize={r * 0.42} fill="#5b646c" fontFamily="sans-serif">CR2032</text>
      <text x={cx} y={cy + r * 0.6} textAnchor="middle" fontSize={r * 0.4} fill="#7b848c" fontFamily="sans-serif">3V</text>
      <PinPads def={def} />
    </g>
  );
}

/**
 * The adjustable supply: a small bench instrument.
 *
 * The readout shows the voltage the source is actually CONFIGURED for, read
 * off the instance property that the simulation imposes on the terminals. It
 * is not animated and it does not drift — if the digits change it is because
 * somebody changed the setting.
 */
function DcSupplyArt({ def, instance }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const volts = Number(instance?.properties?.voltage ?? 5);
  const shown = `${volts.toFixed(volts % 1 === 0 ? 1 : 2)}V`;
  return (
    <g>
      <rect x="1" y="1.5" width={W} height={H} rx="4" fill="rgba(0,0,0,0.34)" />
      <rect width={W} height={H} rx="4" fill="#2b3138" stroke="#12161a" />
      <rect x={W * 0.03} y={H * 0.04} width={W * 0.94} height={H * 0.2} rx="3" fill="rgba(255,255,255,0.07)" />
      {/* Readout: dark glass with the configured value on it. */}
      <rect x={W * 0.08} y={H * 0.14} width={W * 0.54} height={H * 0.36} rx="2" fill="#0a1410" stroke="#050a08" />
      <text
        x={W * 0.35}
        y={H * 0.41}
        textAnchor="middle"
        fontSize={H * 0.26}
        fill="#5fd08a"
        fontFamily="'DejaVu Sans Mono', monospace"
      >
        {shown}
      </text>
      {/* Coarse and fine knobs. */}
      <circle cx={W * 0.78} cy={H * 0.3} r={H * 0.13} fill="#4a525a" stroke="#20262d" />
      <line x1={W * 0.78} y1={H * 0.3} x2={W * 0.78} y2={H * 0.19} stroke="#c3cbd3" strokeWidth="1.4" />
      <circle cx={W * 0.78} cy={H * 0.62} r={H * 0.09} fill="#4a525a" stroke="#20262d" />
      {/* Binding posts under the pins the definition declares. */}
      {def.pins.map((p, i) => (
        <g key={p.id}>
          <circle cx={p.x} cy={p.y} r="3.2" fill={i === 0 ? '#a33232' : '#20262d'} stroke="#0d1114" />
          <circle cx={p.x} cy={p.y} r="1.3" fill="#c8a53f" />
        </g>
      ))}
    </g>
  );
}

/**
 * Buck and boost, which must not be the same board with a different label.
 *
 * They differ in the way the real modules do: a buck has its inductor after
 * the controller with the input capacitor dominating one end, and a boost has
 * the inductor first with the big output capacitor at the other. The trim pot
 * sits opposite in each. Both come off one renderer because they ARE the same
 * class of module — what changes is the layout, which is the thing you would
 * actually use to tell them apart on a bench.
 */
function ConverterArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const boost = def.id === 'comp.boost-converter';
  // The inductor is early on a boost and late on a buck.
  const coilX = boost ? W * 0.24 : W * 0.56;
  const bigCapX = boost ? W * 0.66 : W * 0.1;
  const potX = boost ? W * 0.1 : W * 0.82;
  return (
    <g>
      <Breakout W={W} H={H} fill={boost ? '#123a2c' : '#12354a'} stroke={boost ? '#0a241b' : '#081726'} />
      {/* Toroid or drum inductor: the biggest thing on either board. */}
      <circle cx={coilX} cy={H * 0.44} r={H * 0.2} fill="#2b2119" stroke="#12100c" />
      <circle cx={coilX} cy={H * 0.44} r={H * 0.09} fill="#0d0b08" />
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={coilX + Math.cos(a) * H * 0.08}
            y1={H * 0.44 + Math.sin(a) * H * 0.08}
            x2={coilX + Math.cos(a) * H * 0.21}
            y2={H * 0.44 + Math.sin(a) * H * 0.21}
            stroke="#b07a3a"
            strokeWidth="1.6"
          />
        );
      })}
      {/* Electrolytic can, at the end the topology puts it. */}
      <circle cx={bigCapX + W * 0.07} cy={H * 0.42} r={H * 0.17} fill="#1a2a3a" stroke="#0a1420" />
      <path d={`M ${bigCapX + W * 0.07 - H * 0.17} ${H * 0.42} a ${H * 0.17} ${H * 0.17} 0 0 1 ${H * 0.34} 0`}
        fill="rgba(255,255,255,0.12)" />
      <line x1={bigCapX + W * 0.07} y1={H * 0.28} x2={bigCapX + W * 0.07} y2={H * 0.56} stroke="#7b848c" strokeWidth="1.2" />
      {/* Controller, and the multiturn trim pot that sets the output. */}
      <SmdBody x={W * 0.4} y={H * 0.68} w={W * 0.2} h={H * 0.14} label={boost ? 'XL6009' : 'LM2596'} size={3} />
      <rect x={potX} y={H * 0.64} width={W * 0.13} height={H * 0.2} rx="1.4" fill="#1a4a8a" stroke="#0b2648" />
      <circle cx={potX + W * 0.065} cy={H * 0.74} r={H * 0.05} fill="#c8a53f" />
      <line x1={potX + W * 0.065} y1={H * 0.7} x2={potX + W * 0.065} y2={H * 0.78} stroke="#2b3138" strokeWidth="1" />
      <PinPads def={def} />
    </g>
  );
}

// ---------- Batch 2: logic ----------

/**
 * A DIP package, drawn from the part's own pin list.
 *
 * One renderer for every 74xx and CD4xxx: they really are the same black
 * plastic body with a notch at one end and a part number silkscreened on it,
 * and drawing them individually would be work with no payoff. Pin 1 is marked
 * with the notch and a dot, because that is how you orient a real one.
 */
function DipIcArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const legs = def.pins.filter((p) => p.id !== 'vcc' || true);
  // The part number, without the descriptive tail in brackets.
  const marking = def.name.replace(/\s*\(.*\)\s*$/, '');
  const outputs = visual?.contacts ?? {};
  const anyDriven = Object.values(outputs).some(Boolean);
  return (
    <g>
      {legs.map((p) => {
        const left = p.x < W / 2;
        return (
          <rect
            key={p.id}
            x={left ? 0 : W - 1.1 * MM}
            y={p.y - 0.5 * MM}
            width={1.1 * MM}
            height={1.0 * MM}
            fill="#c3c9cf"
            stroke="#8b9199"
            strokeWidth="0.4"
          />
        );
      })}
      <rect x={1.1 * MM} y={0.4 * MM} width={W - 2.2 * MM} height={H - 0.8 * MM} rx={0.8 * MM} fill="#23272c" stroke="#0d1117" />
      <rect x={1.1 * MM} y={0.4 * MM} width={W - 2.2 * MM} height={(H - 0.8 * MM) * 0.32} rx={0.8 * MM} fill="rgba(255,255,255,0.05)" />
      {/* Pin-1 notch at the top, and the dot beside pin 1 itself. */}
      <path
        d={`M ${W / 2 - 1.6 * MM} ${0.4 * MM} a ${1.6 * MM} ${1.6 * MM} 0 0 0 ${3.2 * MM} 0 z`}
        fill="#12161a"
      />
      <circle cx={2.6 * MM} cy={2.0 * MM} r={0.55 * MM} fill="#3b434c" />
      {/* Part number, running along the package as the silkscreen does. */}
      <text
        x={W / 2}
        y={H / 2}
        textAnchor="middle"
        fontSize={Math.min(2.6 * MM, (H - 4 * MM) / Math.max(1, marking.length) * 1.6)}
        fill="#c9d2db"
        fontFamily="sans-serif"
        transform={`rotate(90 ${W / 2} ${H / 2})`}
      >
        {marking}
      </text>
      {anyDriven && <circle cx={W - 2.6 * MM} cy={H - 2.0 * MM} r={0.6 * MM} fill="#3fb950" />}
    </g>
  );
}

/** Schematic gate bodies, by shape. Drawn as symbols, not packages. */
function GateArt({ def, shape }: ArtProps & { shape: string }) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const bodyX = 3.2 * MM;
  const bodyW = W - 7.4 * MM;
  const cy = H / 2;
  const inverted = shape === 'not' || shape === 'nand' || shape === 'nor' || shape === 'xnor' || shape === 'schmitt';
  const curved = shape === 'or' || shape === 'nor' || shape === 'xor' || shape === 'xnor';
  const pointed = shape === 'not' || shape === 'schmitt' || shape === 'tristate';

  const body = pointed
    ? `M ${bodyX} ${1.2 * MM} L ${bodyX + bodyW} ${cy} L ${bodyX} ${H - 1.2 * MM} Z`
    : curved
      ? `M ${bodyX} ${1.2 * MM} Q ${bodyX + bodyW * 0.55} ${1.2 * MM} ${bodyX + bodyW} ${cy}
         Q ${bodyX + bodyW * 0.55} ${H - 1.2 * MM} ${bodyX} ${H - 1.2 * MM}
         Q ${bodyX + bodyW * 0.3} ${cy} ${bodyX} ${1.2 * MM} Z`
      : `M ${bodyX} ${1.2 * MM} H ${bodyX + bodyW * 0.45}
         A ${bodyW * 0.55} ${(H - 2.4 * MM) / 2} 0 0 1 ${bodyX + bodyW * 0.45} ${H - 1.2 * MM}
         H ${bodyX} Z`;

  return (
    <g>
      {def.pins
        .filter((p) => p.id !== 'vcc' && p.id !== 'gnd')
        .map((p) => (
          <line
            key={p.id}
            x1={p.x}
            y1={p.y}
            x2={p.id === 'y' ? bodyX + bodyW + (inverted ? 1.6 * MM : 0) : p.id === 'oe' ? p.x : bodyX}
            y2={p.id === 'oe' ? cy : p.y}
            stroke="#9aa4ad"
            strokeWidth="1.8"
          />
        ))}
      <path d={body} fill="#2b333c" stroke="#cfd6dd" strokeWidth="1.6" strokeLinejoin="round" />
      {/* The XOR family's extra leading arc. */}
      {(shape === 'xor' || shape === 'xnor') && (
        <path
          d={`M ${bodyX - 1.2 * MM} ${1.2 * MM} Q ${bodyX + bodyW * 0.18} ${cy} ${bodyX - 1.2 * MM} ${H - 1.2 * MM}`}
          fill="none"
          stroke="#cfd6dd"
          strokeWidth="1.6"
        />
      )}
      {inverted && (
        <circle cx={bodyX + bodyW + 0.8 * MM} cy={cy} r={0.8 * MM} fill="#2b333c" stroke="#cfd6dd" strokeWidth="1.4" />
      )}
      {/* The Schmitt trigger's hysteresis glyph, as it is printed on schematics. */}
      {shape === 'schmitt' && (
        <path
          d={`M ${bodyX + bodyW * 0.18} ${cy + 1.4 * MM} h ${bodyW * 0.18} v ${-2.8 * MM} h ${bodyW * 0.18}
              M ${bodyX + bodyW * 0.2} ${cy - 1.4 * MM} h ${bodyW * 0.18} v ${2.8 * MM} h ${bodyW * 0.18}`}
          fill="none"
          stroke="#8fd6a0"
          strokeWidth="1.1"
        />
      )}
      {shape === 'tristate' && (
        <text x={bodyX + bodyW * 0.3} y={cy + 0.9 * MM} fontSize={2.2 * MM} fill="#8fd6a0" fontFamily="sans-serif">Z</text>
      )}
    </g>
  );
}

/** A plain labelled block for latches and flip-flops, drawn as a schematic box. */
function LogicBlockArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  return (
    <g>
      {def.pins.map((p) => (
        <line
          key={p.id}
          x1={p.x}
          y1={p.y}
          x2={p.x < 1.5 * MM ? 2.4 * MM : p.x > W - 1.5 * MM ? W - 2.4 * MM : p.x}
          y2={p.y < 1.5 * MM ? 2.4 * MM : p.y > H - 1.5 * MM ? H - 2.4 * MM : p.y}
          stroke="#9aa4ad"
          strokeWidth="1.8"
        />
      ))}
      <rect x={2.4 * MM} y={2.4 * MM} width={W - 4.8 * MM} height={H - 4.8 * MM} rx={0.6 * MM} fill="#2b333c" stroke="#cfd6dd" strokeWidth="1.6" />
      <text x={W / 2} y={H / 2 + 1 * MM} textAnchor="middle" fontSize={2.6 * MM} fill="#cfd6dd" fontFamily="sans-serif">
        {def.name.split(' ')[0]}
      </text>
    </g>
  );
}

// ---------- Batch 4: displays ----------

/** An 8×8 LED matrix panel, lit from the driver's own row registers. */
function LedMatrixArt({ def, visual }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const pixels = visual?.display?.pixels ?? null;
  const on = visual?.display?.on ?? false;
  const pad = 3 * MM;
  const size = Math.min(W, H - 4 * MM) - pad * 2;
  const cell = size / 8;
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 3 * MM} rx={1 * MM} fill="#1a1e23" stroke="#0d1117" />
      <rect x={pad - 0.6 * MM} y={pad - 0.6 * MM} width={size + 1.2 * MM} height={size + 1.2 * MM} fill="#0f1216" />
      {Array.from({ length: 8 }, (_, row) =>
        Array.from({ length: 8 }, (_, col) => {
          const litPixel = on && pixels ? ((pixels[row] >> (7 - col)) & 1) === 1 : false;
          return (
            <circle
              key={`${row}-${col}`}
              cx={pad + (col + 0.5) * cell}
              cy={pad + (row + 0.5) * cell}
              r={cell * 0.34}
              fill={litPixel ? '#ff4d3d' : '#2a1a18'}
              opacity={litPixel ? 1 : 0.9}
            />
          );
        }),
      )}
      {def.pins.map((p) => (
        <line key={p.id} x1={p.x} y1={H - 3 * MM} x2={p.x} y2={H} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

// ---------- Batch 3: sensor modules ----------
//
// Baseline hardware art: a recognisable board or package with the part's
// distinguishing feature on it, plus the live value it is reporting. The full
// visual pass comes later; these have to be identifiable and usable now.

/** A breakout board with a labelled sensing element and a live readout. */
function SensorModuleArt({ def, visual, tint, element }: ArtProps & { tint: string; element: JSX.Element }) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const value = visual?.value;
  const readout = visual?.readout;
  return (
    <g>
      <rect x={0.4 * MM} y={0.4 * MM} width={W - 0.8 * MM} height={H - 2.4 * MM} rx={1.2 * MM} fill={tint} stroke="rgba(0,0,0,0.45)" />
      <rect x={1.2 * MM} y={1.2 * MM} width={W - 2.4 * MM} height={H - 4 * MM} rx={0.8 * MM} fill="rgba(255,255,255,0.05)" />
      {element}
      {readout && (
        <text x={W / 2} y={H - 4.2 * MM} textAnchor="middle" fontSize={1.9 * MM} fill="#dfe8f2" fontFamily="sans-serif">
          {readout[0]}
        </text>
      )}
      {readout === undefined && value !== undefined && (
        <text x={W / 2} y={H - 4.2 * MM} textAnchor="middle" fontSize={1.9 * MM} fill="#dfe8f2" fontFamily="sans-serif">
          {typeof value === 'number' ? (Number.isInteger(value) ? value : value.toFixed(1)) : String(value)}
        </text>
      )}
      {def.pins.map((p) => (
        <line key={p.id} x1={p.x} y1={H - 2.4 * MM} x2={p.x} y2={H} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

const sensorArt = (tint: string, element: (W: number, H: number) => JSX.Element) => (p: ArtProps) =>
  <SensorModuleArt {...p} tint={tint} element={element(p.def.widthMm * MM, p.def.heightMm * MM)} />;

const REGISTRY: Record<string, (p: ArtProps) => JSX.Element> = {
  // Restored from the parked visual branch and reconciled against the current
  // simulation: the motors now carry real shaft state, which they did not when
  // these were first drawn.
  // The through-hole chips share the DIP renderer the logic ICs use, because
  // a 74HC595 and a 24C256 genuinely ARE the same package: drawing each by
  // hand would give two subtly different packages for no reason, and what
  // tells them apart on a bench is the marking, which is what the renderer
  // already prints.
  hc595: (p) => <DipIcArt {...p} />,
  hc165: (p) => <DipIcArt {...p} />,
  eeprom: (p) => <DipIcArt {...p} />,
  'spi-flash': (p) => <DipIcArt {...p} />,
  'generic-ic': (p) => <DipIcArt {...p} />,
  // Modules, which are only distinguishable by what is actually on the board.
  'sd-card': (p) => <SdCardArt {...p} />,
  rtc: (p) => <RtcModuleArt {...p} />,
  dac: (p) => <DacModuleArt {...p} />,
  header: (p) => <HeaderArt {...p} />,
  bmp280: (p) => <Bmp280Art {...p} />,
  mpu6050: (p) => <Mpu6050Art {...p} />,
  'pulse-sensor': (p) => <PulseSensorArt {...p} />,
  solenoid: (p) => <SolenoidArt {...p} />,
  'battery-coin': (p) => <CoinCellArt {...p} />,
  'dc-supply': (p) => <DcSupplyArt {...p} />,
  converter: (p) => <ConverterArt {...p} />,
  gps: (p) => <GpsArt {...p} />,
  hc05: (p) => <Hc05Art {...p} />,
  esp01: (p) => <Esp01Art {...p} />,
  dfplayer: (p) => <DfPlayerArt {...p} />,
  diode: (p) => <DiodeArt {...p} />,
  transistor: (p) => <TransistorArt {...p} />,
  mosfet: (p) => <MosfetArt {...p} />,
  speaker: (p) => <SpeakerArt {...p} />,
  relay: (p) => <RelayArt {...p} />,
  'dc-motor': (p) => <DcMotorArt {...p} />,
  stepper: (p) => <StepperArt {...p} />,
  'motor-driver': (p) => <MotorDriverArt {...p} />,
  regulator: (p) => <RegulatorArt {...p} />,
  'level-converter': (p) => <LevelConverterArt {...p} />,
  // A TO-92 package: the flat-faced black blob every analog sensor comes in.
  'to92-sensor': sensorArt('#1d232a', (W, H) => (
    <g>
      <path d={`M ${W * 0.2} ${H * 0.55} A ${W * 0.3} ${H * 0.3} 0 1 1 ${W * 0.8} ${H * 0.55} Z`} fill="#15191e" />
      <rect x={W * 0.2} y={H * 0.5} width={W * 0.6} height={H * 0.12} fill="#0f1216" />
    </g>
  )),
  thermistor: sensorArt('#1d232a', (W, H) => (
    <g>
      <ellipse cx={W / 2} cy={H * 0.4} rx={W * 0.28} ry={H * 0.24} fill="#2b1e14" stroke="#54402c" />
      <text x={W / 2} y={H * 0.46} textAnchor="middle" fontSize={H * 0.16} fill="#c9a06a" fontFamily="sans-serif">t°</text>
    </g>
  )),
  'flex-sensor': sensorArt('#2a2118', (W, H) => (
    <g>
      <rect x={W * 0.25} y={H * 0.1} width={W * 0.5} height={H * 0.62} rx={W * 0.1} fill="#3d3120" stroke="#5c4a2e" />
      <path d={`M ${W * 0.35} ${H * 0.16} L ${W * 0.35} ${H * 0.66} M ${W * 0.65} ${H * 0.16} L ${W * 0.65} ${H * 0.66}`} stroke="#8a6f3f" strokeWidth="1.2" />
    </g>
  )),
  fsr: sensorArt('#1b1f24', (W, H) => (
    <g>
      <circle cx={W / 2} cy={H * 0.38} r={Math.min(W, H) * 0.26} fill="#2a3038" stroke="#4b555f" strokeWidth="1.2" />
      <circle cx={W / 2} cy={H * 0.38} r={Math.min(W, H) * 0.14} fill="#39424c" />
    </g>
  )),
  'soil-moisture': sensorArt('#123020', (W, H) => (
    <g>
      <rect x={W * 0.3} y={H * 0.1} width={W * 0.16} height={H * 0.68} fill="#c9a227" />
      <rect x={W * 0.56} y={H * 0.1} width={W * 0.16} height={H * 0.68} fill="#c9a227" />
    </g>
  )),
  'gas-sensor': sensorArt('#1a2029', (W, H) => (
    <g>
      <circle cx={W / 2} cy={H * 0.38} r={Math.min(W, H) * 0.3} fill="#5a5f66" stroke="#3a3f46" strokeWidth="1.4" />
      {[0, 1, 2, 3, 4].map((i) => (
        <line key={i} x1={W * 0.28} y1={H * (0.26 + i * 0.06)} x2={W * 0.72} y2={H * (0.26 + i * 0.06)} stroke="#3a3f46" strokeWidth="1" />
      ))}
    </g>
  )),
  'rain-sensor': sensorArt('#14212e', (W, H) => (
    <g>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x={W * 0.16} y={H * (0.12 + i * 0.09)} width={W * 0.68} height={H * 0.04} fill="#b08d3a" />
      ))}
    </g>
  )),
  photodiode: sensorArt('#1d232a', (W, H) => (
    <g>
      <circle cx={W / 2} cy={H * 0.36} r={Math.min(W, H) * 0.3} fill="#2b3a4a" stroke="#4a6076" />
      <circle cx={W * 0.42} cy={H * 0.28} r={Math.min(W, H) * 0.09} fill="rgba(255,255,255,0.35)" />
    </g>
  )),
  pir: sensorArt('#20303f', (W, H) => (
    <g>
      <circle cx={W / 2} cy={H * 0.36} r={Math.min(W, H) * 0.32} fill="#e8ebee" stroke="#9aa4ad" strokeWidth="1.2" />
      {[0.2, 0.36, 0.52].map((r, i) => (
        <circle key={i} cx={W / 2} cy={H * 0.36} r={Math.min(W, H) * 0.32 * r * 1.6} fill="none" stroke="#b8c0c8" strokeWidth="0.8" />
      ))}
    </g>
  )),
  'tilt-switch': sensorArt('#1d232a', (W, H) => (
    <g>
      <rect x={W * 0.3} y={H * 0.14} width={W * 0.4} height={H * 0.5} rx={W * 0.18} fill="#3a434d" stroke="#20262d" />
      <circle cx={W / 2} cy={H * 0.5} r={W * 0.13} fill="#c9ccd1" />
    </g>
  )),
  vibration: sensorArt('#20303f', (W, H) => (
    <g>
      <rect x={W * 0.22} y={H * 0.2} width={W * 0.56} height={H * 0.34} rx={W * 0.08} fill="#2a3038" stroke="#4b555f" />
      <path d={`M ${W * 0.28} ${H * 0.37} l ${W * 0.1} ${-H * 0.1} l ${W * 0.12} ${H * 0.2} l ${W * 0.12} ${-H * 0.16} l ${W * 0.1} ${H * 0.06}`} fill="none" stroke="#7fb2e8" strokeWidth="1.3" />
    </g>
  )),
  hall: sensorArt('#1d232a', (W, H) => (
    <g>
      <path d={`M ${W * 0.24} ${H * 0.52} A ${W * 0.26} ${H * 0.26} 0 1 1 ${W * 0.76} ${H * 0.52} Z`} fill="#15191e" />
      <text x={W / 2} y={H * 0.44} textAnchor="middle" fontSize={H * 0.16} fill="#8fd6a0" fontFamily="sans-serif">H</text>
    </g>
  )),
  bme280: sensorArt('#2b3b52', (W, H) => (
    <g>
      <rect x={W * 0.36} y={H * 0.2} width={W * 0.28} height={H * 0.34} rx={W * 0.04} fill="#c3c9cf" stroke="#8b9199" />
      <circle cx={W * 0.5} cy={H * 0.37} r={W * 0.05} fill="#4a5560" />
    </g>
  )),
  sht31: sensorArt('#2b3b52', (W, H) => (
    <g>
      <rect x={W * 0.38} y={H * 0.22} width={W * 0.24} height={H * 0.3} rx={W * 0.03} fill="#d5d9dd" stroke="#8b9199" />
      <line x1={W * 0.42} y1={H * 0.3} x2={W * 0.58} y2={H * 0.3} stroke="#7c858e" strokeWidth="0.9" />
      <line x1={W * 0.42} y1={H * 0.4} x2={W * 0.58} y2={H * 0.4} stroke="#7c858e" strokeWidth="0.9" />
    </g>
  )),
  // The I2C boards: the same panel with a backpack on the back, so they take
  // the blue-and-white glass those modules ship with.
  lcd2004: (p) => <CharacterLcdArt {...p} columns={20} rows={4} />,
  // Both parallel panels share one renderer; the geometry comes from the part's
  // own footprint, so a 16x2 and a 20x4 are the same drawing at two sizes. The
  // bare modules are the classic yellow-green STN rather than blue.
  'lcd-parallel': (p) =>
    p.def.id === 'comp.lcd2004-parallel' ? (
      <CharacterLcdArt {...p} columns={20} rows={4} tint="green" />
    ) : (
      <CharacterLcdArt {...p} columns={16} rows={2} tint="green" />
    ),
  max7219: (p) => <LedMatrixArt {...p} />,
  'dip-ic': (p) => <DipIcArt {...p} />,
  'logic-block': (p) => <LogicBlockArt {...p} />,
  'gate-and': (p) => <GateArt {...p} shape="and" />,
  'gate-or': (p) => <GateArt {...p} shape="or" />,
  'gate-not': (p) => <GateArt {...p} shape="not" />,
  'gate-nand': (p) => <GateArt {...p} shape="nand" />,
  'gate-nor': (p) => <GateArt {...p} shape="nor" />,
  'gate-xor': (p) => <GateArt {...p} shape="xor" />,
  'gate-xnor': (p) => <GateArt {...p} shape="xnor" />,
  'gate-tristate': (p) => <GateArt {...p} shape="tristate" />,
  'gate-schmitt': (p) => <GateArt {...p} shape="schmitt" />,
  'push-button-6mm': (p) => <PushButton6mmArt {...p} />,
  'slide-switch': (p) => <SlideSwitchArt {...p} />,
  'limit-switch': (p) => <LimitSwitchArt {...p} />,
  'dip-switch': (p) => <DipSwitchArt {...p} />,
  'rotary-encoder': (p) => <RotaryEncoderArt {...p} />,
  joystick: (p) => <JoystickArt {...p} />,
  keypad: (p) => <KeyMatrixArt {...p} />,
  'mini-keyboard': (p) => <KeyMatrixArt {...p} />,
  lcd1602: (p) => <CharacterLcdArt {...p} columns={16} rows={2} />,
  oled: (p) => <OledArt {...p} />,
  sh1107: (p) => <Sh1107Art {...p} />,
  'seven-segment-multi': (p) => <SevenSegMultiArt {...p} />,
  tm1637: (p) => <SevenSegMultiArt {...p} digits={4} />,
  'led-matrix': (p) => <BareLedMatrixArt {...p} />,
  nokia5110: (p) => <Nokia5110Art {...p} />,
  // The e-paper's glass is white paper with dark ink, not a lit panel — the
  // one display in the library that is legible with the power off, and the one
  // that must not pick up the specular highlight the emitters get.
  epaper: (p) => (
    <MonoPanelArt {...p} cols={128} rows={296} idleLabel="E-Paper" ink="#232323" glass="#e9e6df" reflective />
  ),
  tft: (p) => <RasterPanelArt {...p} />,
  'tft-round': (p) => <RasterPanelArt {...p} round />,
  neopixel: (p) => <NeoPixelArt {...p} layout="single" />,
  'neopixel-ring': (p) => <NeoPixelArt {...p} layout="ring" />,
  'neopixel-strip': (p) => <NeoPixelArt {...p} layout="strip" />,
  'neopixel-matrix': (p) => <NeoPixelArt {...p} layout="matrix" />,
  led: (p) => <LedArt {...p} />,
  'rgb-led': (p) => <RgbLedArt {...p} />,
  resistor: (p) => <ResistorArt {...p} />,
  'push-button': (p) => <ButtonArt {...p} />,
  'toggle-switch': (p) => <ToggleArt {...p} />,
  potentiometer: (p) => <PotArt {...p} />,
  buzzer: (p) => <BuzzerArt {...p} />,
  servo: (p) => <ServoArt {...p} />,
  'seven-segment': (p) => <SevenSegArt {...p} />,
  ultrasonic: (p) => <UltrasonicArt {...p} />,
  breadboard: (p) => <BreadboardArt {...p} />,
  'breadboard-mini': (p) => <BreadboardArt {...p} />,
  capacitor: (p) => <CapacitorArt {...p} />,
  tmp36: (p) => <Tmp36Art {...p} />,
  ldr: (p) => <LdrArt {...p} />,
  nrf24: (p) => <Nrf24Art {...p} />,
  lora: (p) => <LoraArt {...p} />,
  max485: (p) => <Max485Art {...p} />,
  mcp2515: (p) => <Mcp2515Art {...p} />,
  'rf433-tx': (p) => <Rf433TxArt {...p} />,
  'rf433-rx': (p) => <Rf433RxArt {...p} />,
  'ir-receiver': (p) => <IrReceiverArt {...p} />,
  'ir-led': (p) => <IrLedArt {...p} />,
  'ir-remote': (p) => <IrRemoteArt {...p} />,
  'battery-9v': (p) => <BatteryArt {...p} />,
  'battery-aa': (p) => <BatteryArt {...p} />,
};

/**
 * Builtin ids that have a renderer of their own.
 *
 * Anything not in here falls back to the generic box, which is a legitimate
 * placeholder and also how the LCD ended up drawing 1.4 mm characters — so the
 * list is exported and the artwork tests report what is still on it.
 */
export const BUILTIN_ARTWORK_IDS: readonly string[] = Object.keys(REGISTRY);

export const ComponentArtwork = memo(function ComponentArtwork(props: ArtProps) {
  const { def } = props;
  if (def.artwork.kind === 'builtin' && def.artwork.builtinId && REGISTRY[def.artwork.builtinId]) {
    return REGISTRY[def.artwork.builtinId](props);
  }
  if (def.artwork.kind === 'svg' && def.artwork.svg) {
    const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(def.artwork.svg)))}`;
    return <image href={dataUrl} width={def.widthMm * MM} height={def.heightMm * MM} preserveAspectRatio="xMidYMid meet" />;
  }
  if (def.artwork.kind === 'image' && def.artwork.imageDataUrl) {
    return (
      <image href={def.artwork.imageDataUrl} width={def.widthMm * MM} height={def.heightMm * MM} preserveAspectRatio="xMidYMid meet" />
    );
  }
  return <GenericBoxArt {...props} />;
});
