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
function OledArt({ def, visual }: ArtProps) {
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const display = visual?.display;

  // 128×64 at a true 2:1, as large as the module allows.
  const glassW = w * 0.92;
  const glassH = glassW / 2;
  const glass = { x: (w - glassW) / 2, y: h * 0.3, w: glassW, h: glassH };
  const px = glass.w / 128;
  const py = glass.h / 64;

  const lit: JSX.Element[] = [];
  if (display?.on && display.pixels) {
    const ram = display.pixels;
    for (let row = 0; row < 64; row++) {
      const page = row >> 3;
      const bit = row & 7;
      let runStart = -1;
      for (let x = 0; x <= 128; x++) {
        const on = x < 128 && ((ram[page * 128 + x] >> bit) & 1) === 1;
        if (on && runStart < 0) runStart = x;
        if (!on && runStart >= 0) {
          lit.push(
            <rect
              key={`${row}-${runStart}`}
              x={glass.x + runStart * px}
              y={glass.y + row * py}
              width={(x - runStart) * px}
              height={Math.max(py, 0.5)}
              fill="#a9e6ff"
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
      {[7.5, 11.5, 15.5, 19.5].map((mm) => (
        <rect key={mm} x={mm * MM - 1.4} y={h * 0.02} width="2.8" height={h * 0.06} rx="1" fill="#d8b25c" />
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
      <rect x={glass.x} y={glass.y} width={glass.w} height={glass.h} fill="#04060a" />
      {lit}
      {!display?.on && (
        <text
          x={w / 2}
          y={glass.y + glass.h * 0.62}
          fontSize={glass.h * 0.3}
          fill="#2b333d"
          textAnchor="middle"
          fontFamily="'DejaVu Sans Mono', 'Courier New', monospace"
        >
          OLED
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
// No state. Nothing in the simulation reports whether this motor is turning —
// it is a validation-level part — so the shaft is drawn stationary rather than
// given an invented spin.
function DcMotorArt({ def }: ArtProps) {
  const W = def.widthMm * MM;
  const H = def.heightMm * MM;
  const can = { x: W * 0.16, y: H * 0.14, w: W * 0.6, h: H * 0.72 };
  const cy = H / 2;
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
      <circle cx={can.x + can.w + W * 0.035} cy={cy} r="2.4" fill="#3c434a" />
    </g>
  );
}

// ----------------------------------------------------------- stepper motor
//
// Deliberately unlike the DC motor next to it: a squat round stator with a
// stamped, segmented body and a visible mounting flange, plus the four winding
// leads coming out of one side as a ribbon rather than two terminals.
//
// No state. Step position is not simulated, so nothing here suggests one.
function StepperArt({ def }: ArtProps) {
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
      {/* Gearbox boss and shaft, on the front face. */}
      <circle cx={cx} cy={cy} r={r * 0.46} fill="#6f7982" stroke="#454c53" />
      <circle cx={cx} cy={cy} r={r * 0.2} fill="#c3cbd3" stroke="#7b848c" />
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

const REGISTRY: Record<string, (p: ArtProps) => JSX.Element> = {
  'motor-driver': (p) => <MotorDriverArt {...p} />,
  regulator: (p) => <RegulatorArt {...p} />,
  'level-converter': (p) => <LevelConverterArt {...p} />,

  diode: (p) => <DiodeArt {...p} />,
  transistor: (p) => <TransistorArt {...p} />,
  mosfet: (p) => <MosfetArt {...p} />,
  speaker: (p) => <SpeakerArt {...p} />,
  relay: (p) => <RelayArt {...p} />,
  'dc-motor': (p) => <DcMotorArt {...p} />,
  stepper: (p) => <StepperArt {...p} />,
  lcd1602: (p) => <Lcd1602Art {...p} />,
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
