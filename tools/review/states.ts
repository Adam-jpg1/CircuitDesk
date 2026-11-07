// Plausible live state for a review render.
//
// The review sheets exist to answer a question no automated renderer test can:
// at the zoom a user actually works at, is a part recognisable, is its text
// readable, and does "doing something" look different from "sitting there".
// The second half of that needs the parts to be doing something, so this file
// hands each one a state shaped exactly like the one the simulation publishes.
//
// It is a *fixture*, not a simulation, and it lives under tools/ rather than
// src/ for that reason: nothing here may ever be imported by the app. The
// artwork must keep drawing only what it is given — the point of feeding it
// realistic input is to see whether it does.

import type { ComponentVisualState } from '../../src/simulation/circuitSim';

/** Packs a bitmap drawn on a canvas into SSD1306-style page-major RAM. */
function packMono(cols: number, rows: number, draw: (ctx: CanvasRenderingContext2D) => void): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cols, rows);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  draw(ctx);
  const data = ctx.getImageData(0, 0, cols, rows).data;
  const pages = Math.ceil(rows / 8);
  const ram = new Uint8Array(pages * cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const lum = data[(y * cols + x) * 4];
      if (lum > 127) ram[(y >> 3) * cols + x] |= 1 << (y & 7);
    }
  }
  return ram;
}

/** Packs a canvas drawing into an RGB565 framebuffer, as a TFT controller holds it. */
function packRaster(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  draw(ctx);
  const data = ctx.getImageData(0, 0, w, h).data;
  const pixels = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4] >> 3;
    const g = data[i * 4 + 1] >> 2;
    const b = data[i * 4 + 2] >> 3;
    pixels[i] = (r << 11) | (g << 5) | b;
  }
  return { width: w, height: h, pixels, inverted: false, revision: 1 };
}

/** A little instrument face, the sort of thing a sketch actually draws. */
function drawPanel(ctx: CanvasRenderingContext2D, w: number, h: number, title: string) {
  ctx.fillStyle = '#06121f';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1b6fd0';
  ctx.fillRect(0, 0, w, Math.max(12, h * 0.11));
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.max(9, h * 0.075)}px sans-serif`;
  ctx.fillText(title, 5, Math.max(10, h * 0.085));
  ctx.fillStyle = '#8fe3a0';
  ctx.font = `bold ${Math.max(16, h * 0.16)}px monospace`;
  ctx.fillText('23.6 C', 8, h * 0.36);
  ctx.fillStyle = '#ffd166';
  ctx.font = `${Math.max(10, h * 0.08)}px monospace`;
  ctx.fillText('1013 hPa', 8, h * 0.5);
  // a plotted trace
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = Math.max(1, h * 0.008);
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const y = h * 0.78 + Math.sin(x / (w / 14)) * h * 0.11;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = '#2a3f55';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, h * (0.6 + i * 0.1));
    ctx.lineTo(w, h * (0.6 + i * 0.1));
    ctx.stroke();
  }
}

const monoDisplay = (cols: number, rows: number, draw: (ctx: CanvasRenderingContext2D) => void) => ({
  display: { pixels: packMono(cols, rows, draw), on: true, revision: 1 },
});

function drawMonoUi(ctx: CanvasRenderingContext2D, cols: number, rows: number) {
  ctx.font = `bold ${Math.round(rows * 0.2)}px monospace`;
  ctx.fillText('CircuitDesk', 2, Math.round(rows * 0.2));
  ctx.font = `${Math.round(rows * 0.16)}px monospace`;
  ctx.fillText('T 23.6C', 2, Math.round(rows * 0.45));
  ctx.fillText('H 41%', 2, Math.round(rows * 0.65));
  ctx.strokeRect(1.5, rows * 0.78, cols - 3, rows * 0.16);
  ctx.fillRect(3, rows * 0.8 + 1, (cols - 6) * 0.62, rows * 0.12 - 2);
}

const segmentsOf = (on: string) => Object.fromEntries([...on].map((s) => [s, true]));

/** Every element of a scanned display lit at the level an eye would see. */
function multiplexed(digits: number, text: string): Record<string, number> {
  const FONT: Record<string, string> = {
    '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
    '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
    '-': 'g', ' ': '',
  };
  const out: Record<string, number> = {};
  for (let d = 0; d < digits; d++) {
    for (const seg of FONT[text[d] ?? ' '] ?? '') out[`${d}.${seg}`] = 0.9;
  }
  return out;
}

const rgbRing = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return {
      r: Math.round(127 + 127 * Math.sin(a)),
      g: Math.round(127 + 127 * Math.sin(a + 2.1)),
      b: Math.round(127 + 127 * Math.sin(a + 4.2)),
    };
  });

/**
 * The active state each part is reviewed in.
 *
 * Missing means the part has no state worth showing and is reviewed once.
 */
export function activeState(id: string): ComponentVisualState | undefined {
  switch (id) {
    // ---- inputs
    case 'comp.push-button':
    case 'comp.push-button-6mm':
      return { pressed: true, contacts: { '': true } };
    case 'comp.toggle-switch':
    case 'comp.slide-switch':
      return { toggledOn: true, contacts: { '': true } };
    case 'comp.limit-switch':
      return { contacts: { '': true } };
    case 'comp.potentiometer':
      return { potPosition: 0.72, value: 3.6 };
    case 'comp.dip-switch-4':
      return { contacts: { sw1: true, sw3: true } };
    case 'comp.dip-switch-6':
      return { contacts: { sw1: true, sw2: true, sw5: true } };
    case 'comp.dip-switch-8':
      return { contacts: { sw2: true, sw3: true, sw7: true, sw8: true } };
    case 'comp.rotary-encoder':
      return { value: 37, contacts: { sw: true } };
    case 'comp.joystick':
      return { value: 0.86, axes: { x: 0.86, y: 0.22 }, contacts: { sw: true } };
    case 'comp.keypad-3x4':
      return { contacts: { 'r1c2': true } };
    case 'comp.keypad-4x4':
      return { contacts: { 'r2c3': true } };
    case 'comp.keypad-matrix':
      return { contacts: { 'r0c0': true } };
    case 'comp.mini-keyboard':
      return { contacts: { 'r2c4': true, 'r3c1': true } };

    // ---- displays
    case 'comp.lcd1602':
      return { readout: ['CircuitDesk  1.0', 'T 23.6C  H 41%'], ledOn: true };
    case 'comp.lcd2004':
    case 'comp.lcd2004-parallel':
      return { readout: ['CircuitDesk   v1.0', 'Temp 23.6 C', 'Press 1013 hPa', 'Uptime 00:04:12'], ledOn: true };
    case 'comp.lcd1602-parallel':
      return { readout: ['Hello, world!', 'Count = 1234'], ledOn: true };
    case 'comp.oled':
      return monoDisplay(128, 64, (c) => drawMonoUi(c, 128, 64));
    case 'comp.sh1107':
      return monoDisplay(128, 128, (c) => drawMonoUi(c, 128, 128));
    case 'comp.nokia5110':
      return monoDisplay(84, 48, (c) => drawMonoUi(c, 84, 48));
    case 'comp.epaper29':
      return monoDisplay(128, 296, (c) => {
        c.font = 'bold 18px serif';
        c.fillText('Weather', 6, 24);
        c.font = '14px serif';
        c.fillText('23.6 C', 6, 52);
        c.fillText('1013 hPa', 6, 72);
        c.fillRect(6, 88, 116, 2);
        for (let i = 0; i < 8; i++) c.fillRect(6, 100 + i * 22, 40 + i * 9, 12);
      });
    case 'comp.ili9341':
      return { raster: packRaster(240, 320, (c) => drawPanel(c, 240, 320, 'ILI9341')) };
    case 'comp.st7735':
      return { raster: packRaster(128, 160, (c) => drawPanel(c, 128, 160, 'ST7735')) };
    case 'comp.st7789':
      return { raster: packRaster(240, 320, (c) => drawPanel(c, 240, 320, 'ST7789')) };
    case 'comp.ssd1331':
      return { raster: packRaster(96, 64, (c) => drawPanel(c, 96, 64, 'SSD1331')) };
    case 'comp.gc9a01':
      return {
        raster: packRaster(240, 240, (c) => {
          c.fillStyle = '#05080e';
          c.fillRect(0, 0, 240, 240);
          c.strokeStyle = '#3fb0ff';
          c.lineWidth = 4;
          c.beginPath();
          c.arc(120, 120, 108, 0, Math.PI * 2);
          c.stroke();
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            c.beginPath();
            c.moveTo(120 + Math.cos(a) * 92, 120 + Math.sin(a) * 92);
            c.lineTo(120 + Math.cos(a) * 104, 120 + Math.sin(a) * 104);
            c.stroke();
          }
          c.strokeStyle = '#ffd166';
          c.lineWidth = 6;
          c.beginPath();
          c.moveTo(120, 120);
          c.lineTo(120 + Math.cos(-0.9) * 70, 120 + Math.sin(-0.9) * 70);
          c.stroke();
          c.fillStyle = '#ffffff';
          c.font = 'bold 26px sans-serif';
          c.fillText('72', 100, 175);
        }),
      };
    case 'comp.seven-segment':
    case 'comp.seven-segment-ca':
      return { segments: segmentsOf('acdfg') };
    case 'comp.seven-segment-2':
      return { elementBrightness: multiplexed(2, '42') };
    case 'comp.seven-segment-4':
      return { elementBrightness: multiplexed(4, '1234') };
    case 'comp.tm1637':
      return { elementBrightness: multiplexed(4, '1236') };
    case 'comp.led-matrix':
      return {
        elementBrightness: Object.fromEntries(
          [[0, 3], [0, 4], [1, 2], [1, 5], [2, 1], [2, 6], [3, 0], [3, 7], [4, 0], [4, 7], [5, 1], [5, 6], [6, 2], [6, 5], [7, 3], [7, 4]]
            .map(([r, c]) => [`${r}.c${c + 1}`, 0.85]),
        ),
      };
    case 'comp.max7219':
      return { display: { pixels: new Uint8Array([0x18, 0x3c, 0x7e, 0xff, 0xdb, 0x18, 0x24, 0x42]), on: true, revision: 1 } };
    case 'comp.neopixel':
      return { pixelColors: [{ r: 255, g: 60, b: 0 }] };
    case 'comp.neopixel-ring':
      return { pixelColors: rgbRing(16) };
    case 'comp.neopixel-strip':
      return { pixelColors: rgbRing(30) };
    case 'comp.neopixel-matrix':
      return { pixelColors: rgbRing(64) };

    // ---- outputs
    case 'comp.led':
      return { ledOn: true, brightness: 1 };
    case 'comp.rgb-led':
      return { rgb: [30, 220, 140] };
    case 'comp.buzzer':
      return { buzzerOn: true, value: 2000 };
    case 'comp.speaker':
      return { buzzerOn: true };

    // ---- motors
    case 'comp.servo':
      return { servoAngle: 120 };
    case 'comp.dc-motor':
    case 'comp.gearmotor':
    case 'comp.vibration-motor':
    case 'comp.dc-motor-encoder':
      return { motor: { direction: 'forward', magnitude: 0.8, angleDegrees: 37, connected: true } };
    case 'comp.stepper':
    case 'comp.stepper-28byj':
      return { motor: { direction: 'forward', magnitude: 0.5, angleDegrees: 63, connected: true } };
    case 'comp.solenoid':
      return { coilOn: true };
    case 'comp.relay':
    case 'comp.relay-dpdt':
      return { coilOn: true, on: true };

    // ---- sensors
    case 'comp.ultrasonic':
      return { value: 42 };
    case 'comp.tmp36':
    case 'comp.lm35':
      return { value: 23.6 };
    case 'comp.ldr':
      return { value: 0.62 };
    case 'comp.bmp280':
      return { readout: ['23.6C 1013hPa'] };
    case 'comp.bme280':
      return { readout: ['23.6C 41% 1013'] };
    case 'comp.sht31':
      return { readout: ['23.6C 41%'] };
    case 'comp.mpu6050':
      return { readout: ['ax 0.02 g'] };
    case 'comp.pulse-sensor':
      return { readout: ['72 bpm'], on: true };
    case 'comp.pir':
      return { value: 1, on: true, readout: ['motion'] };
    case 'comp.mq2':
      return { readout: ['312 ppm'] };
    case 'comp.soil-moisture':
      return { readout: ['48 %'] };
    case 'comp.ntc-thermistor':
      return { value: 23.6 };
    case 'comp.flex-sensor':
      return { value: 0.4 };
    case 'comp.fsr':
      return { value: 0.6 };
    case 'comp.rain-sensor':
      return { readout: ['wet'] };
    case 'comp.photodiode':
      return { value: 0.55 };
    case 'comp.tilt-switch':
      return { on: true, contacts: { '': true } };
    case 'comp.vibration-sensor':
      return { on: true };
    case 'comp.hall-sensor':
      return { on: true, value: 1 };

    // ---- comms
    case 'comp.ir-receiver':
      return { on: true, readout: ['NEC 0x20DF'] };
    case 'comp.ir-led':
      return { on: true, ledOn: true };
    case 'comp.ir-remote':
      return { contacts: { play: true } };
    case 'comp.nrf24l01':
    case 'comp.lora-sx1278':
    case 'comp.rf433-tx':
    case 'comp.rf433-rx':
    case 'comp.max485':
    case 'comp.mcp2515':
      return { on: true };
    case 'comp.gps':
      return { readout: ['3D fix  8 sats'] };

    // ---- logic / power
    case 'comp.hc595':
    case 'comp.74hc595':
      return { value: 0xa5 };
    default:
      return undefined;
  }
}
