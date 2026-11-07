// analogRead() on the ESP32-C3 and ESP32-C6, from compiled firmware.
//
// It used to hang the sketch: ESP-IDF's one-shot ADC driver starts a
// conversion and spins until the SAR ADC raises DONE, and nothing raised it —
// a potentiometer sketch froze before printing a line. On the C6 the same
// driver also takes a lock with RISC-V atomics, which the core did not
// execute. src/simulation/espRiscv/sarAdc.ts models the one-shot path; the C6
// core now has the A extension.
//
// Through the live simulation, a potentiometer on an ADC pin is read at
// three positions, against the attenuation analogRead() uses by default
// (the highest): full scale 2.5 V on the C3, 3.3 V on the C6, so the C3
// saturates above 2.5 V as the chip does.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, wire, code } from '../src/project/templates';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const boards = [
  // GPIO34 is ADC1 channel 6; analogRead() sets 11 dB, a 3.3 V full scale here.
  { id: 'board.esp32-devkit', pin: 'D34', gpio: 34, vcc: '3V3', gnd: 'GND1', fullScale: 3.3 },
  // GPIO4 is ADC2 channel 0.
  { id: 'board.esp32-devkit', pin: 'D4', gpio: 4, vcc: '3V3', gnd: 'GND1', fullScale: 3.3 },
  // The S3: GPIO1 is ADC1 channel 0, GPIO11 ADC2 channel 0.
  { id: 'board.esp32-s3', pin: 'GPIO1', gpio: 1, vcc: '3V3', gnd: 'GND1', fullScale: 3.3 },
  { id: 'board.esp32-s3', pin: 'GPIO11', gpio: 11, vcc: '3V3', gnd: 'GND1', fullScale: 3.3 },
  { id: 'board.esp32-c3', pin: 'IO1', gpio: 1, vcc: '3V3_1', gnd: 'GND1', fullScale: 2.5 },
  { id: 'board.esp32-c3-supermini', pin: 'IO0', gpio: 0, vcc: '3V3', gnd: 'GND1', fullScale: 2.5 },
  { id: 'board.esp32-c6-devkitc-1', pin: 'IO2', gpio: 2, vcc: '3V3_1', gnd: 'GND1', fullScale: 3.3 },
] as const;

for (const b of boards.filter((x) => !process.env.ONLY || x.id === process.env.ONLY)) {
  console.log(`\n--- ${b.id}`);
  const p = emptyProject(`adc ${b.id}`);
  const board = inst(b.id, 0, 0);
  const pot = inst('comp.potentiometer', 400, 40);
  p.boardInstances = [board];
  p.componentInstances = [pot];
  p.connections = [wire(pot, 't1', board, b.gnd), wire(pot, 't2', board, b.vcc), wire(pot, 'wiper', board, b.pin)];
  p.codeFiles = [code('sketch.ino', `void setup() { Serial.begin(115200); }
void loop() { Serial.print("adc "); Serial.println(analogRead(${b.gpio})); delay(50); }`)];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log(`SKIP: ${b.id} did not build or start here`);
    skipped++;
    continue;
  }
  simulationController.pause();
  const readAt = (position: number) => {
    useSimulationStore.getState().setPot(pot.id, position);
    useSimulationStore.getState().clearSerial();
    for (let t = 0; t < 300 && simulationController.advance(50); t += 50);
    simulationController.publishNow();
    const state = useSimulationStore.getState();
    const values = [...(state.serialText ?? '').matchAll(/adc (\d+)/g)].map((m) => Number(m[1]));
    return { value: values.at(-1), error: state.status === 'error' ? state.error : undefined };
  };
  for (const position of [0, 0.5, 1]) {
    const { value, error } = readAt(position);
    const want = Math.min(4095, Math.round(((3.3 * position) / b.fullScale) * 4095));
    check(
      value !== undefined && Math.abs(value - want) <= 2,
      `knob at ${position * 100}% (${(3.3 * position).toFixed(2)} V) reads ${want} (${value ?? error ?? 'nothing'})`,
    );
  }
  simulationController.stop();
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
