// End-to-end pipeline test (Node): compile Blink via the real backend,
// execute the HEX on the real AVRRunner, assert D13 toggling + serial output
// + timing follows the firmware (delay 500ms vs 100ms).

import { AVRRunner, F_CPU } from '../src/simulation/avrRunner';

async function compile(delayMs: number): Promise<string> {
  const code = `void setup() { pinMode(13, OUTPUT); Serial.begin(9600); }
void loop() { digitalWrite(13, HIGH); Serial.println("ON"); delay(${delayMs}); digitalWrite(13, LOW); Serial.println("OFF"); delay(${delayMs}); }`;
  const res = await fetch('http://localhost:3411/api/compiler/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fqbn: 'arduino:avr:uno', files: [{ name: 'sketch.ino', content: code }] }),
  });
  const json = (await res.json()) as { success: boolean; firmware?: { data: string }; error?: string };
  if (!json.success || !json.firmware) throw new Error('compile failed: ' + json.error);
  return json.firmware.data;
}

async function runFor(hex: string, simMs: number): Promise<{ toggles: { atMs: number; high: boolean }[]; serial: string }> {
  const runner = new AVRRunner(hex);
  const toggles: { atMs: number; high: boolean }[] = [];
  let serial = '';
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));
  runner.onPinChange = (pin, high) => {
    if (pin === 13) toggles.push({ atMs: runner.timeMs, high });
  };
  runner.runToCycles((simMs / 1000) * F_CPU);
  return { toggles, serial };
}

const hex500 = await compile(500);
const r500 = await runFor(hex500, 2600);
console.log('delay(500): toggles =', r500.toggles.map((t) => `${t.high ? 'H' : 'L'}@${t.atMs.toFixed(0)}ms`).join(' '));
console.log('serial:', JSON.stringify(r500.serial.slice(0, 60)));

const hex100 = await compile(100);
const r100 = await runFor(hex100, 2600);
console.log('delay(100): toggle count =', r100.toggles.length);

// assertions
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

assert(r500.toggles.length >= 4 && r500.toggles.length <= 7, `D13 toggled ~5 times in 2.6s with delay(500) (got ${r500.toggles.length})`);
assert(r500.toggles[0].high && r500.toggles[0].atMs < 50, 'D13 goes HIGH shortly after reset');
const gap = r500.toggles[1].atMs - r500.toggles[0].atMs;
assert(gap > 480 && gap < 540, `HIGH phase lasts ~500ms of simulated time (got ${gap.toFixed(1)}ms)`);
assert(r500.serial.includes('ON') && r500.serial.includes('OFF'), 'serial output contains ON and OFF from emulated USART');
assert(r100.toggles.length > 20, `delay(100) firmware toggles ~5x more often (got ${r100.toggles.length})`);
console.log('\nAll pipeline assertions passed: real compile → real AVR execution → real timing.');
