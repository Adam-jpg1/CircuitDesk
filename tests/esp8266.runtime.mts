// The ESP8266 NodeMCU, running firmware from the ESP8266 Arduino core on the
// Xtensa LX106 model: Espressif's NONOS SDK starts (its radio calibration
// included), hands over to the ROM scheduler, and the core's loop runs as a
// task inside it.
//
// Each sketch is compiled by the same compiler service the app uses and run
// through the same adapter, then checked by what it does: what it prints, how
// fast time passes, and what its pins and the parts on its buses see.
//   * Serial, millis()/micros()/delay(), float, double and 64-bit arithmetic;
//   * the LED on D4 (GPIO2) blinks at the sketch's rate;
//   * analogWrite(64) is 25.1% (64/255) at the core's 1 kHz, tone(440/1000)
//     toggles at those rates, and Servo's write(0/90/180) gives the core's
//     1000/1500/2000 µs every 20 ms — all from the waveform generator on the
//     FRC1 timer's NMI;
//   * RISING and FALLING interrupts count exactly their edges;
//   * analogRead(A0) follows the pin's voltage through the board's divider;
//   * a BMP280 on the software I2C (D2/D1) answers its chip ID, an empty
//     address NACKs, and an SPI flash on HSPI returns its JEDEC ID.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';
import { runnerPinIndex, runnerAdcChannel } from '../src/simulation/boardRunner';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, wire, code } from '../src/project/templates';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const cli = await detectArduinoCli();
if (!cli.available) {
  console.log('SKIP: arduino-cli is not available here');
  process.exit(0);
}

const ID = 'board.esp8266-nodemcu';
const FQBN = 'esp8266:esp8266:nodemcuv2';
const def = getBoardDefinition(ID)!;
check(def.supportLevel === 'simulated' && def.simulation?.engine === 'esp8266', `${def.name} is a simulated board on the esp8266 engine`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;

async function boot(sketch: string): Promise<{ r: Runner; out: () => string } | null> {
  const built = await compileProject({ fqbn: FQBN, boardId: def.serverTargetId ?? def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: the ESP8266 sketch did not build here (${built.errors?.[0]?.message ?? built.error ?? built.stderr?.slice(0, 200)})`);
    skipped++;
    return null;
  }
  check(built.firmware.format === 'esp-image', 'the artifact is an ESP8266 flash image');
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  let text = '';
  r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
  return { r, out: () => text };
}
const run = (r: Runner, ms: number, slice = 10) => {
  for (let t = 0; t < ms; t += slice) r.runFor(slice);
};
const pin = (label: string) => runnerPinIndex(def, label)!;
const last = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]).at(-1);
function edges(r: Runner, pad: number) {
  const rises: number[] = [];
  const falls: number[] = [];
  r.addPinListener((p: number, high: boolean) => {
    if (p === pad) (high ? rises : falls).push(r.timeMs);
  });
  return { rises, falls };
}
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

check(pin('D4') === 2 && pin('D0') === 16 && pin('D1') === 5 && pin('TX') === 1, 'the NodeMCU labels reach their GPIOs (D4 = GPIO2, D0 = GPIO16, D1 = GPIO5, TX = GPIO1)');
check(runnerAdcChannel(def, 'A0') === 0 && runnerAdcChannel(def, 'D1') === undefined, 'A0 is the one ADC input');

section('boot, Serial, time and arithmetic');
{
  const b = await boot(`void setup() { Serial.begin(115200); Serial.println("esp8266 ready");
  Serial.print("mhz "); Serial.println(ESP.getCpuFreqMHz());
  unsigned long u0 = micros(); delayMicroseconds(500); unsigned long du = micros() - u0;
  unsigned long t0 = millis(); delay(1000); Serial.print("ms "); Serial.println(millis() - t0);
  Serial.print("us "); Serial.println(du);
  float f = 1.5f; for (int i = 0; i < 10; i++) f = f * 1.25f + 0.5f; Serial.print("f "); Serial.println(f, 3);
  volatile double d = 2.0; d = sqrt(d) * 3.0 / 7.0; Serial.print("d "); Serial.println(d, 9);
  volatile long long big = 123456789012LL; big = big / 7 + big % 13; Serial.print("ll "); Serial.println((long)(big % 1000000)); }
void loop() { if (Serial.available()) { int c = Serial.read(); Serial.print("got "); Serial.println((char)c); } }`);
  if (b) {
    const t0 = performance.now();
    run(b.r, 1400);
    const wall = performance.now() - t0;
    check(b.out().includes('esp8266 ready'), `the SDK starts, hands over to the core and Serial prints (${JSON.stringify(b.out().slice(0, 40))})`);
    check(last(b.out(), /mhz (\d+)/g) === '80', `the CPU runs at the core's default 80 MHz (${last(b.out(), /mhz (\d+)/g)})`);
    const ms = Number(last(b.out(), /ms (\d+)/g));
    check(ms >= 999 && ms <= 1001, `delay(1000) takes 1000 ms of simulated time (${ms})`);
    const us = Number(last(b.out(), /us (\d+)/g));
    check(us >= 499 && us <= 505, `delayMicroseconds(500) takes 500 µs (${us})`);
    let f = Math.fround(1.5);
    for (let i = 0; i < 10; i++) f = Math.fround(Math.fround(f * 1.25) + 0.5);
    check(last(b.out(), /f ([\d.]+)/g) === f.toFixed(3), `float arithmetic matches IEEE single precision (${last(b.out(), /f ([\d.]+)/g)})`);
    check(last(b.out(), /d ([\d.]+)/g) === ((Math.sqrt(2) * 3) / 7).toFixed(9), `double arithmetic, through the ROM's soft-float routines (${last(b.out(), /d ([\d.]+)/g)})`);
    const big = 123456789012n;
    check(last(b.out(), /ll (\d+)/g) === String((big / 7n + (big % 13n)) % 1000000n), '64-bit division and remainder');
    b.r.queueSerialInput('z');
    run(b.r, 50);
    check(b.out().includes('got z'), 'Serial reads what arrives on RX');
    check(b.r.uartBaudRate !== undefined && Math.abs(b.r.uartBaudRate - 115200) / 115200 < 0.001, `UART0 runs at the 115200 baud the sketch asked for (${b.r.uartBaudRate?.toFixed(0)})`);
    console.log(`  (1.4 s simulated in ${wall.toFixed(0)} ms)`);
  }
}

section('the on-board LED blinks');
{
  const b = await boot(`void setup() { pinMode(LED_BUILTIN, OUTPUT); }
void loop() { digitalWrite(LED_BUILTIN, LOW); delay(100); digitalWrite(LED_BUILTIN, HIGH); delay(100); }`);
  if (b) {
    const e = edges(b.r, pin('D4'));
    run(b.r, 1500);
    const recent = e.rises.filter((t) => t > 500);
    const period = (recent.at(-1)! - recent[0]) / (recent.length - 1);
    check(Math.abs(period - 200) < 1, `LED_BUILTIN (D4, GPIO2) toggles every 100 ms (period ${period.toFixed(2)} ms)`);
    check(b.r.isOutput(pin('D4')), 'and the pad is an output');
  }
}

section('analogWrite, tone and Servo (the waveform generator on FRC1\'s NMI)');
{
  const b = await boot(`void setup() { analogWrite(D1, 64); } void loop() {}`);
  if (b) {
    const e = edges(b.r, pin('D1'));
    run(b.r, 900);
    const recent = e.rises.filter((t) => t > b.r.timeMs - 100);
    const hz = 1000 / ((recent.at(-1)! - recent[0]) / (recent.length - 1));
    const highs = recent.slice(0, -1).map((rise) => e.falls.find((f) => f > rise)! - rise);
    const duty = median(highs) / (1000 / hz);
    check(Math.abs(hz - 1000) < 5, `analogWrite() runs D1 at ${hz.toFixed(1)} Hz (the core's 1 kHz)`);
    check(Math.abs(duty - 64 / 255) < 0.01, `with the 25.1% duty 64/255 asks for (${(duty * 100).toFixed(1)}%)`);
  }
  const t = await boot(`void setup() { Serial.begin(115200); }
void loop() {
  if (!Serial.available()) return;
  int c = Serial.read();
  if (c == 'a') tone(D1, 440);
  if (c == 'b') tone(D1, 1000);
  if (c == 'x') noTone(D1);
}`);
  if (t) {
    const e = edges(t.r, pin('D1'));
    run(t.r, 900);
    for (const [key, hz] of [['a', 440], ['b', 1000]] as const) {
      t.r.queueSerialInput(key);
      run(t.r, 300);
      const recent = e.rises.filter((x) => x > t.r.timeMs - 150);
      const f = 1000 / ((recent.at(-1)! - recent[0]) / (recent.length - 1));
      check(Math.abs(f - hz) / hz < 0.01, `tone(${hz}) toggles at ${f.toFixed(1)} Hz`);
    }
    t.r.queueSerialInput('x');
    run(t.r, 100);
    const at = e.rises.length;
    run(t.r, 100);
    check(e.rises.length === at, 'noTone() stops it');
  }
  const s = await boot(`#include <Servo.h>
Servo sv;
void setup() { Serial.begin(115200); sv.attach(D1); sv.write(0); }
void loop() { if (Serial.available()) { int a = Serial.parseInt(); while (Serial.available()) Serial.read(); sv.write(a); } }`);
  if (s) {
    const e = edges(s.r, pin('D1'));
    const widths = (from: number) =>
      median(e.rises.filter((x) => x > from).map((rise) => ((e.falls.find((f) => f > rise) ?? NaN) - rise) * 1000).filter((w) => !Number.isNaN(w)));
    run(s.r, 1000);
    const recent = e.rises.filter((x) => x > s.r.timeMs - 200);
    const period = (recent.at(-1)! - recent[0]) / (recent.length - 1);
    check(Math.abs(period - 20) < 0.3, `Servo pulses every ${period.toFixed(2)} ms (50 Hz)`);
    check(Math.abs(widths(s.r.timeMs - 200) - 1000) < 3, `write(0) is ${widths(s.r.timeMs - 200).toFixed(1)} µs (the core's 1000 µs minimum)`);
    for (const [angle, us] of [[90, 1500], [180, 2000]] as const) {
      s.r.queueSerialInput(`${angle}\n`);
      run(s.r, 1200);
      const w = widths(s.r.timeMs - 150);
      check(Math.abs(w - us) < 3, `write(${angle}) moves it to ${w.toFixed(1)} µs (${us})`);
    }
  }
}

section('attachInterrupt');
{
  const b = await boot(`volatile int rises = 0, falls = 0;
void IRAM_ATTR onRise() { rises++; }
void IRAM_ATTR onFall() { falls++; }
void setup() {
  Serial.begin(115200);
  pinMode(D5, INPUT_PULLUP);
  pinMode(D6, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(D5), onRise, RISING);
  attachInterrupt(digitalPinToInterrupt(D6), onFall, FALLING);
}
void loop() { Serial.print("n "); Serial.print(rises); Serial.print(' '); Serial.println(falls); delay(20); }`);
  if (b) {
    run(b.r, 900);
    const pulse = (pad: number, n: number) => {
      for (let k = 0; k < n; k++) {
        b.r.setDigitalInput(pad, false);
        run(b.r, 2, 1);
        b.r.setDigitalInput(pad, true);
        run(b.r, 2, 1);
      }
    };
    pulse(pin('D5'), 4);
    pulse(pin('D6'), 3);
    run(b.r, 100);
    const n = [...b.out().matchAll(/n (\d+) (\d+)/g)].at(-1);
    check(n?.[1] === '4', `RISING on D5 counts its 4 rising edges (${n?.[1]})`);
    check(n?.[2] === '3', `FALLING on D6 counts its 3 falling edges (${n?.[2]})`);
  }
}

section('analogRead(A0)');
{
  const b = await boot(`void setup() { Serial.begin(115200); }
void loop() { Serial.print("a "); Serial.println(analogRead(A0)); delay(50); }`);
  if (b) {
    const channel = b.r.adcChannelForPin(pin('A0'));
    check(channel === 0, 'the runner gives A0 its ADC channel');
    for (const [volts, expect] of [[0, 0], [1.65, 512], [3.3, 1024]] as const) {
      b.r.setAnalogVolts(channel, volts);
      run(b.r, 200);
      const got = Number(last(b.out(), /a (\d+)/g));
      check(Math.abs(got - expect) <= 1, `${volts} V on A0 reads ${got} (${expect}, through the NodeMCU's divider)`);
    }
  }
}

section('Wire (software I2C on D2/D1) and SPI (HSPI) parts on the canvas');
{
  const p = emptyProject('nodemcu buses');
  const board = inst(ID, 0, 0);
  const bmp = inst('comp.bmp280', 400, 40);
  const flash = inst('comp.spi-flash', 400, 200);
  p.boardInstances = [board];
  p.componentInstances = [bmp, flash];
  p.connections = [
    wire(bmp, 'sda', board, 'D2'), wire(bmp, 'scl', board, 'D1'), wire(bmp, 'vcc', board, '3V3_1'), wire(bmp, 'gnd', board, 'GND1'),
    wire(flash, 'sck', board, 'D5'), wire(flash, 'mosi', board, 'D7'), wire(flash, 'miso', board, 'D6'),
    wire(flash, 'cs', board, 'D8'), wire(flash, 'vcc', board, '3V3_1'), wire(flash, 'gnd', board, 'GND2'),
  ];
  p.codeFiles = [code('sketch.ino', `#include <Wire.h>
#include <SPI.h>
uint8_t reg(uint8_t addr, uint8_t r) {
  Wire.beginTransmission(addr);
  Wire.write(r);
  if (Wire.endTransmission(false) != 0) return 0xEE;
  Wire.requestFrom(addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xEF;
}
void setup() {
  Serial.begin(115200);
  Wire.begin();
  Serial.print("ID "); Serial.println(reg(0x76, 0xD0), HEX);
  Wire.beginTransmission(0x50);
  Serial.print("NOBODY "); Serial.println(Wire.endTransmission());
  pinMode(D8, OUTPUT);
  digitalWrite(D8, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(D8, LOW);
  SPI.transfer(0x9F);
  uint8_t a = SPI.transfer(0), m = SPI.transfer(0), c = SPI.transfer(0);
  digitalWrite(D8, HIGH);
  Serial.print("JEDEC "); Serial.print(a, HEX); Serial.print(' '); Serial.print(m, HEX); Serial.print(' '); Serial.println(c, HEX);
}
void loop() {}
`)];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log('SKIP: the bus sketch did not build or start here');
    skipped++;
  } else {
    simulationController.pause();
    for (let t = 0; t < 1500 && simulationController.advance(50); t += 50);
    simulationController.publishNow();
    const state = useSimulationStore.getState();
    const text = state.serialText ?? '';
    check(state.status !== 'error', `the bus sketch runs (${state.error ?? 'no error'})`);
    check(/ID 58/.test(text), `a BMP280 on D2/D1 answers its chip ID (${text.match(/ID \w+/)?.[0] ?? 'nothing'})`);
    check(/NOBODY 2/.test(text), `an address nobody answers NACKs (${text.match(/NOBODY \d+/)?.[0] ?? 'nothing'})`);
    check(/JEDEC EF 40 14/.test(text), `an SPI flash on D5/D7/D6 returns its JEDEC ID (${text.match(/JEDEC[ \w]*/)?.[0] ?? 'nothing'})`);
    simulationController.stop();
  }
}

section('restarts and crashes, as the board goes through them');
// ESP.restart() and the core's crash handler both end in a jump to the ROM's
// reset vector. The chip reboots, keeping its flash and RTC memory, and the
// sketch starts again; the crash report the core prints goes straight out of
// UART0 through the ROM, as on the board.
{
  const b = await boot(`#include <EEPROM.h>
void setup() { Serial.begin(115200); EEPROM.begin(16);
  int n = EEPROM.read(0) == 0xff ? 1 : EEPROM.read(0) + 1; EEPROM.write(0, n); EEPROM.commit();
  Serial.printf("boot %d: %s\\n", n, ESP.getResetReason().c_str()); delay(200); if (n < 3) ESP.restart(); }
void loop() { delay(100); }`);
  if (b) {
    run(b.r, 1500);
    check(b.r.fault == null, `a restart is carried out, not reported as a fault (${b.r.fault ?? 'no fault'})`);
    check(/boot 1: Power On[\s\S]*boot 2: Software\/System restart[\s\S]*boot 3: Software\/System restart/.test(b.out()), `ESP.restart() reboots it, flash and the reset reason kept (${JSON.stringify(b.out().match(/boot \d: [^\r\n]*/g))})`);
    b.r.reset();
    run(b.r, 600);
    check(/boot 4: /.test(b.out()), `the board's Reset button reboots it too, flash kept (${last(b.out(), /(boot 4: [^\r\n]*)/g) ?? 'nothing'})`);
  }
  const fresh = await boot(`void setup() { Serial.begin(115200); Serial.printf("reason: %s\\n", ESP.getResetReason().c_str()); }
void loop() { delay(100); }`);
  if (fresh) {
    run(fresh.r, 400);
    fresh.r.reset();
    run(fresh.r, 400);
    check(/reason: Power On[\s\S]*reason: External System/.test(fresh.out()), `power-up, then the Reset button, report as the board does (${JSON.stringify(fresh.out().match(/reason: [^\r\n]*/g))})`);
  }
  const c = await boot(`void isr() {}
void setup() { Serial.begin(115200); Serial.println("up"); delay(100); attachInterrupt(digitalPinToInterrupt(D6), isr, FALLING); }
void loop() { delay(100); }`);
  if (c) {
    run(c.r, 800);
    check(/ISR not in IRAM![\s\S]*Abort called/.test(c.out()), 'an interrupt handler without IRAM_ATTR stops with the core\'s own message, as on the board');
    check((c.out().match(/\bup\b/g) ?? []).length >= 2, 'and the board reboots after it, and runs the sketch again');
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
