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

function ButtonArt({ def, visual }: ArtProps) {
  const pressed = Boolean(visual?.pressed);
  const W = def.widthMm * MM;
  return (
    <g>
      {[[1.5, 1.5], [10.5, 1.5], [1.5, 10.5], [10.5, 10.5]].map(([x, y], i) => (
        <circle key={i} cx={x * MM} cy={y * MM} r={1.1 * MM} fill="#9aa4ad" stroke="#6b747d" strokeWidth="0.7" />
      ))}
      <rect x={1.2 * MM} y={1.2 * MM} width={W - 2.4 * MM} height={W - 2.4 * MM} rx="4" fill="#20262d" stroke="#0d1117" />
      <rect x={1.2 * MM} y={1.2 * MM} width={W - 2.4 * MM} height={(W - 2.4 * MM) / 2} rx="4" fill="rgba(255,255,255,0.06)" />
      <circle cx={W / 2} cy={W / 2} r={(pressed ? 2.8 : 3.2) * MM} fill={pressed ? '#141a1f' : '#2c333b'} stroke="#0d1117" strokeWidth="1" />
      <circle cx={W / 2 - 0.8 * MM} cy={W / 2 - 0.8 * MM} r={0.9 * MM} fill="rgba(255,255,255,0.12)" />
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
      <rect width={W} height={H} rx="3" fill="#15181c" stroke="#000" />
      <g transform={`translate(${W / 2 - 7 * scale} ${H / 2 - 10.5 * scale}) scale(${scale})`}>
        {Object.entries(SEG_SHAPES).map(([k, d]) => (
          <path key={k} d={d} fill={segs[k] ? '#ff4136' : '#2a1210'} opacity={segs[k] ? 1 : 0.85} />
        ))}
        <circle cx="13" cy="18.5" r="0.9" fill={segs.dp ? '#ff4136' : '#2a1210'} />
      </g>
      {segs && Object.values(segs).some(Boolean) && (
        <rect width={W} height={H} rx="3" fill="#ff4136" opacity="0.05" />
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

  // The glass keeps the panel's aspect ratio inside the module outline.
  const bezel = Math.min(w, h) * 0.06;
  const availW = w - bezel * 2;
  const availH = h * 0.82 - bezel * 2;
  const aspect = raster ? raster.width / raster.height : 1;
  let gw = availW;
  let gh = gw / aspect;
  if (gh > availH) {
    gh = availH;
    gw = gh * aspect;
  }
  const gx = (w - gw) / 2;
  const gy = bezel;

  return (
    <g>
      <rect x="1" y="1.5" width={w} height={h} rx="4" fill="rgba(0,0,0,0.35)" />
      <rect width={w} height={h} rx="4" fill="#12161b" stroke="#333c46" />
      <rect
        x={gx - 1.5}
        y={gy - 1.5}
        width={gw + 3}
        height={gh + 3}
        rx={round ? (gw + 3) / 2 : 2}
        fill="#1b2028"
        stroke="#39424c"
      />
      {round ? (
        <>
          <defs>
            <clipPath id={`cd-round-${def.id}`}>
              <circle cx={gx + gw / 2} cy={gy + gh / 2} r={Math.min(gw, gh) / 2} />
            </clipPath>
          </defs>
          <circle cx={gx + gw / 2} cy={gy + gh / 2} r={Math.min(gw, gh) / 2} fill="#04060a" />
          {href && (
            <image
              href={href}
              x={gx}
              y={gy}
              width={gw}
              height={gh}
              clipPath={`url(#cd-round-${def.id})`}
              style={{ imageRendering: 'pixelated' }}
            />
          )}
        </>
      ) : (
        <>
          <rect x={gx} y={gy} width={gw} height={gh} fill="#04060a" />
          {href && (
            <image href={href} x={gx} y={gy} width={gw} height={gh} style={{ imageRendering: 'pixelated' }} />
          )}
        </>
      )}
      {/* Pin header along the bottom edge, over the pads the definition places. */}
      {def.pins.map((p) => (
        <rect key={p.id} x={p.x - 1.3} y={h - MM * 2.2} width="2.6" height={MM * 1.6} rx="1" fill="#d8b25c" />
      ))}
      {!raster && (
        <text
          x={w / 2}
          y={gy + gh * 0.55}
          fontSize={Math.min(gh * 0.16, gw * 0.16)}
          fill="#2b333d"
          textAnchor="middle"
          fontFamily="'DejaVu Sans Mono', 'Courier New', monospace"
        >
          {def.name.split(' ')[0]}
        </text>
      )}
    </g>
  );
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
}: ArtProps & { cols: number; rows: number; idleLabel: string; ink?: string; glass?: string }) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const display = visual?.display;

  // As large as the module allows, at the panel's true aspect ratio.
  const glassW = w * 0.92;
  const glassH = (glassW * rows) / cols;
  const glass = { x: (w - glassW) / 2, y: (h - glassH) / 2 + h * 0.04, w: glassW, h: glassH };
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

  return (
    <g>
      <rect x="1" y="1.5" width={w} height={h} rx="4" fill="rgba(0,0,0,0.35)" />
      <rect width={w} height={h} rx="4" fill="#101318" stroke="#333c46" />
      {/* Pin header, over the four pads along the top edge. */}
      <rect x={w * 0.22} y="0" width={w * 0.56} height={h * 0.1} rx="1.5" fill="#15181c" />
      {def.pins.slice(0, 4).map((p) => (
        <rect key={p.id} x={p.x - 1.4} y={h * 0.02} width="2.8" height={h * 0.06} rx="1" fill="#d8b25c" />
      ))}
      {/* The glass sits in a slightly raised frame so the panel reads as glass. */}
      <rect
        x={glass.x - 2}
        y={glass.y - 2}
        width={glass.w + 4}
        height={glass.h + 4}
        rx="1.5"
        fill="#1b2028"
        stroke="#39424c"
      />
      <rect x={glass.x} y={glass.y} width={glass.w} height={glass.h} fill={glassFill} />
      {lit}
      {!display?.on && (
        <text
          x={w / 2}
          y={glass.y + glass.h * 0.56}
          fontSize={Math.min(glass.h * 0.3, glass.w * 0.18)}
          fill="#2b333d"
          textAnchor="middle"
          fontFamily="'DejaVu Sans Mono', 'Courier New', monospace"
        >
          {idleLabel}
        </text>
      )}
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

/** Rows and columns of a 1602, which is what the name means. */
const LCD_COLS = 16;
const LCD_ROWS = 2;

function Lcd1602Art({ def, visual }: ArtProps) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const lines = visual?.readout ?? [];
  // Backlight follows the real PCF8574 backlight bit. An unlit panel is dark
  // and its characters are barely legible, which is true of the hardware.
  const lit = visual?.ledOn !== false && lines.length > 0;

  // The header sits over the four pins the definition already places along the
  // top-left edge, so the connector is drawn where the wires actually land.
  const headerH = h * 0.13;
  const bezel = { x: w * 0.045, y: headerH + h * 0.06, w: w * 0.91, h: h * 0.74 };
  const glass = { x: bezel.x + w * 0.025, y: bezel.y + h * 0.06, w: bezel.w - w * 0.05, h: bezel.h - h * 0.12 };
  // Characters live inside a small margin so the outermost column is not flush
  // against the bezel, as on a real panel.
  const area = { x: glass.x + glass.w * 0.03, y: glass.y + glass.h * 0.08, w: glass.w * 0.94, h: glass.h * 0.84 };
  const cellW = area.w / LCD_COLS;
  const rowH = area.h / LCD_ROWS;
  const fontSize = Math.min(rowH * 0.82, cellW * 1.5);

  const backlight = lit ? '#1f5fd0' : '#101c30';
  const character = lit ? '#eaf4ff' : '#2b3c55';

  const cells: JSX.Element[] = [];
  for (let row = 0; row < LCD_ROWS; row++) {
    const text = (lines[row] ?? '').slice(0, LCD_COLS);
    for (let col = 0; col < LCD_COLS; col++) {
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
      {/* Pin header, over the pads the definition places at 2/6/10/14 mm. */}
      <rect x={w * 0.01} y="0" width={w * 0.22} height={headerH} rx="2" fill="#15181c" />
      {[2, 6, 10, 14].map((mm) => (
        <rect key={mm} x={mm * MM - 1.6} y={headerH * 0.18} width="3.2" height={headerH * 0.64} rx="1" fill="#d8b25c" />
      ))}
      {/* Bezel: a metal frame with a lit edge, so the panel reads as recessed. */}
      <rect x={bezel.x} y={bezel.y} width={bezel.w} height={bezel.h} rx="3" fill="#39424c" stroke="#1c2228" />
      <rect x={bezel.x} y={bezel.y} width={bezel.w} height={bezel.h * 0.12} rx="3" fill="rgba(255,255,255,0.14)" />
      {/* The panel itself. */}
      <rect x={glass.x} y={glass.y} width={glass.w} height={glass.h} fill={backlight} stroke="#0c1420" />
      {lit && (
        <rect
          x={glass.x}
          y={glass.y}
          width={glass.w}
          height={glass.h * 0.45}
          fill="rgba(255,255,255,0.10)"
        />
      )}
      {/* Character cells, faintly, the way a dot-matrix panel shows them. */}
      {Array.from({ length: LCD_COLS - 1 }, (_, i) => (
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
      <line
        x1={area.x}
        y1={area.y + rowH}
        x2={area.x + area.w}
        y2={area.y + rowH}
        stroke="rgba(0,0,0,0.10)"
        strokeWidth="0.6"
      />
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
      <circle cx={W / 2} cy={W / 2} r={(pressed ? 1.5 : 1.8) * MM} fill={pressed ? '#141a1f' : '#2c333b'} stroke="#0d1117" strokeWidth="0.8" />
      <circle cx={W / 2 - 0.45 * MM} cy={W / 2 - 0.45 * MM} r={0.5 * MM} fill="rgba(255,255,255,0.12)" />
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
      {/* The lever: hinged at the left, deflected onto the body when actuated. */}
      <path
        d={`M ${1.6 * MM} ${3.0 * MM} L ${(W - 2 * MM)} ${(pressed ? 2.9 : 0.9) * MM}`}
        stroke="#d3d7db"
        strokeWidth={0.9 * MM}
        strokeLinecap="round"
        fill="none"
      />
      <circle cx={1.6 * MM} cy={3.0 * MM} r={0.7 * MM} fill="#9aa4ad" />
      <circle cx={W - 2 * MM} cy={(pressed ? 2.9 : 0.9) * MM} r={0.9 * MM} fill="#8b9199" />
      <text x={W / 2} y={H - 3.2 * MM} textAnchor="middle" fontSize={2.1 * MM} fill="#7c858e" fontFamily="sans-serif">
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
  return (
    <g>
      <rect x={0.6 * MM} y={1.0 * MM} width={W - 1.2 * MM} height={H - 2 * MM} rx="1.2" fill="#2f6ba8" stroke="#1d4670" />
      <rect x={1.1 * MM} y={1.9 * MM} width={W - 2.2 * MM} height={H - 3.8 * MM} rx="0.8" fill="#1e2833" />
      {poles.map((spot) => {
        const on = engagedIn(visual, spot.key);
        const nub = dipActuatorRect(spot, on);
        return (
          <g key={spot.key}>
            <rect
              x={nub.x}
              y={nub.y}
              width={nub.w}
              height={nub.h}
              rx="0.4"
              fill={on ? '#f2f4f6' : '#b3bac1'}
              stroke="#7d858d"
              strokeWidth="0.5"
            />
            <text
              x={spot.x + spot.w / 2}
              y={H - 0.9 * MM}
              textAnchor="middle"
              fontSize={1.7 * MM}
              fill="#cfd6dd"
              fontFamily="sans-serif"
            >
              {spot.cap}
            </text>
          </g>
        );
      })}
      <text x={2.0 * MM} y={1.75 * MM} fontSize={1.5 * MM} fill="rgba(255,255,255,0.75)" fontFamily="sans-serif">ON</text>
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
      <circle cx={cx} cy={cy} r={5.2 * MM} fill="#2a3037" stroke="#12171c" strokeWidth="1" />
      {/* Pressed reads as the shaft sinking: a smaller, darker cap with a
          highlight ring around it, which is legible at 1:1 in a way that a
          two-tenths-of-a-millimetre radius change is not. */}
      {clicked && <circle cx={cx} cy={cy} r={5.2 * MM} fill="none" stroke="#7fb2e8" strokeWidth="1.6" />}
      <circle cx={cx} cy={cy} r={(clicked ? 3.0 : 3.9) * MM} fill={clicked ? '#12171c' : '#3a434d'} />
      {/* Knurling, so it reads as a shaft rather than a dot. */}
      {Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={cx + Math.cos(angle) * 3.9 * MM}
            y1={cy + Math.sin(angle) * 3.9 * MM}
            x2={cx + Math.cos(angle) * 5.0 * MM}
            y2={cy + Math.sin(angle) * 5.0 * MM}
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="0.9"
          />
        );
      })}
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
  const cx = W / 2;
  const cy = 13 * MM;
  return (
    <g>
      <rect x={0.6 * MM} y={0.6 * MM} width={W - 1.2 * MM} height={H - 3 * MM} rx="1.5" fill="#1c5aa8" stroke="#123f78" />
      {/* Gimbal housing */}
      <rect x={4 * MM} y={2.5 * MM} width={W - 8 * MM} height={21 * MM} rx="2" fill="#2a3037" stroke="#12171c" />
      <circle cx={cx} cy={cy} r={9.5 * MM} fill="#20262d" stroke="#12171c" strokeWidth="1.2" />
      {/* Clicked reads as the cap pushed in: smaller, darker, ringed. */}
      {clicked && <circle cx={cx} cy={cy} r={9.5 * MM} fill="none" stroke="#7fb2e8" strokeWidth="1.8" />}
      <circle cx={cx} cy={cy} r={(clicked ? 5.4 : 6.8) * MM} fill={clicked ? '#0b0f13' : '#171d23'} stroke="#0b0f13" />
      <ellipse cx={cx} cy={cy - 1.5 * MM} rx={(clicked ? 3.4 : 4.6) * MM} ry={(clicked ? 2.2 : 3.2) * MM} fill="rgba(255,255,255,0.09)" />
      <text x={cx} y={H - 3.4 * MM} textAnchor="middle" fontSize={2.2 * MM} fill="#cfe0f4" fontFamily="sans-serif">JOYSTICK</text>
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

  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 1 * MM} rx="3" fill="#20262d" stroke="#0d1117" />
      <rect x={1.6 * MM} y={1.6 * MM} width={W - 3.2 * MM} height={H - 3.2 * MM} rx="2" fill="#2b323a" />
      {keys.map((k) => {
        const down = engagedIn(visual, k.key);
        return (
          <g key={k.key}>
            <rect
              x={k.x}
              y={k.y}
              width={k.w}
              height={k.h}
              rx={k.radius}
              fill={down ? '#4d5a68' : '#39424c'}
              stroke={down ? '#7fb2e8' : '#1a1f25'}
              strokeWidth={down ? 1.4 : 0.8}
            />
            <rect x={k.x} y={k.y} width={k.w} height={k.h * 0.42} rx={k.radius} fill="rgba(255,255,255,0.07)" />
            <text
              x={k.x + k.w / 2}
              y={k.y + k.h * 0.66}
              textAnchor="middle"
              fontSize={k.h * 0.46}
              fill={down ? '#eaf3ff' : '#c3ccd5'}
              fontFamily="sans-serif"
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

/**
 * A character LCD of any geometry.
 *
 * The glass, the bezel and a character cell per column — the text comes from
 * the controller's DDRAM, so what is drawn is what firmware wrote.
 */
function CharacterLcdArt({ def, visual, columns, rows }: ArtProps & { columns: number; rows: number }) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const lines = visual?.readout ?? [];
  const glassX = 5 * MM;
  const glassY = 6 * MM;
  const glassW = W - 10 * MM;
  const glassH = H - 18 * MM;
  const cellW = glassW / columns;
  const cellH = glassH / rows;
  const lit = lines.length > 0 && !/not initialised/.test(lines[0] ?? '');
  return (
    <g>
      <rect x={0.5 * MM} y={0.5 * MM} width={W - 1 * MM} height={H - 3 * MM} rx={1.5 * MM} fill="#14532d" stroke="#0b3319" />
      <rect x={glassX - 1.4 * MM} y={glassY - 1.4 * MM} width={glassW + 2.8 * MM} height={glassH + 2.8 * MM} rx={0.8 * MM} fill="#0d1a10" />
      <rect x={glassX} y={glassY} width={glassW} height={glassH} fill={lit ? '#2f7d4f' : '#1c3d29'} />
      {lines.slice(0, rows).map((line, r) =>
        [...line.padEnd(columns, ' ')].slice(0, columns).map((ch, c) =>
          ch === ' ' ? null : (
            <text
              key={`${r}-${c}`}
              x={glassX + (c + 0.5) * cellW}
              y={glassY + (r + 0.72) * cellH}
              textAnchor="middle"
              fontSize={cellH * 0.72}
              fill="#d9f5e2"
              fontFamily="monospace"
            >
              {ch}
            </text>
          ),
        ),
      )}
      {def.pins.map((p) => (
        <line key={p.id} x1={p.x} y1={H - 3 * MM} x2={p.x} y2={H} stroke="#9aa4ad" strokeWidth="2" />
      ))}
    </g>
  );
}

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
  lcd2004: (p) => <CharacterLcdArt {...p} columns={20} rows={4} />,
  // Both parallel panels share one renderer; the geometry comes from the part's
  // own footprint, so a 16x2 and a 20x4 are the same drawing at two sizes.
  'lcd-parallel': (p) =>
    p.def.id === 'comp.lcd2004-parallel' ? (
      <CharacterLcdArt {...p} columns={20} rows={4} />
    ) : (
      <CharacterLcdArt {...p} columns={16} rows={2} />
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
  lcd1602: (p) => <Lcd1602Art {...p} />,
  oled: (p) => <OledArt {...p} />,
  sh1107: (p) => <Sh1107Art {...p} />,
  'seven-segment-multi': (p) => <SevenSegMultiArt {...p} />,
  tm1637: (p) => <SevenSegMultiArt {...p} digits={4} />,
  'led-matrix': (p) => <BareLedMatrixArt {...p} />,
  nokia5110: (p) => <Nokia5110Art {...p} />,
  // The e-paper's glass is white paper with dark ink, not a lit panel — the
  // one display in the library that is legible with the power off.
  epaper: (p) => <MonoPanelArt {...p} cols={128} rows={296} idleLabel="E-Paper" ink="#1b1f24" glass="#e9e6df" />,
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
  'ir-receiver': (p) => <IrReceiverArt {...p} />,
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
