import { memo } from 'react';
import type { ComponentDefinition, ComponentInstance } from '../../types';
import type { ComponentVisualState } from '../../simulation/circuitSim';
import { MM } from '../../boards/pinHelpers';

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
function OledArt({ def, visual }: ArtProps) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const display = visual?.display;
  const glass = { x: w * 0.08, y: h * 0.3, w: w * 0.84, h: h * 0.5 };
  const px = glass.w / 128;
  const py = glass.h / 64;
  const lit: JSX.Element[] = [];
  if (display?.on && display.pixels) {
    const ram = display.pixels;
    for (let page = 0; page < 8; page++) {
      for (let x = 0; x < 128; x++) {
        const bits = ram[page * 128 + x];
        if (!bits) continue;
        for (let bit = 0; bit < 8; bit++) {
          if ((bits >> bit) & 1) {
            lit.push(
              <rect
                key={`${x}-${page}-${bit}`}
                x={glass.x + x * px}
                y={glass.y + (page * 8 + bit) * py}
                width={Math.max(px, 0.6)}
                height={Math.max(py, 0.6)}
                fill="#8bdcff"
              />,
            );
          }
        }
      }
    }
  }
  return (
    <g>
      <rect width={w} height={h} rx="3" fill="#12161b" stroke="#2b323a" />
      <rect x={glass.x} y={glass.y} width={glass.w} height={glass.h} fill="#05070a" stroke="#1d242c" />
      {lit}
      {!display?.on && (
        <text x={w / 2} y={h * 0.58} fontSize="5" fill="#3d454e" textAnchor="middle" fontFamily="monospace">
          OLED
        </text>
      )}
      <text x={w / 2} y={h * 0.94} fontSize="4" fill="#6d7681" textAnchor="middle" fontFamily="monospace">
        SSD1306 I2C
      </text>
    </g>
  );
}

const REGISTRY: Record<string, (p: ArtProps) => JSX.Element> = {
  oled: (p) => <OledArt {...p} />,
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
  'battery-9v': (p) => <BatteryArt {...p} />,
  'battery-aa': (p) => <BatteryArt {...p} />,
};

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
