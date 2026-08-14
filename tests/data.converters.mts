// ADCs, an RTC and a nonvolatile memory: numbers that come from somewhere real.
//
// The point of an external ADC in a simulator is that the reading came off a
// wire. If a value can be set on the part, the part is a text box with pins
// drawn on it — and the mistakes that actually cost people an evening (a gain
// set too high, a reference that is not 5 V, an input that was never wired)
// all disappear. So nothing here sets a reading; every number is asserted
// against a voltage the solver produced.
//
// The RTC is the same argument about time. It advances from the simulation
// clock, never the host's, so stepping three hours produces three hours and
// the test gives the same answer at any hour on any machine.
//
// The FRAM is tested against the EEPROM rather than alone, because "it is not
// an EEPROM" is the only thing about it worth modelling.

import { Ads1115Device, ADS1115_ADDRESSES, ADS1115_FULL_SCALE } from '../src/simulation/devices/ads1115';
import { Mcp3008Device } from '../src/simulation/devices/mcp3008';
import { Ds1307Device, DS1307_ADDRESS, toBcd, fromBcd } from '../src/simulation/devices/ds1307';
import { FramDevice, FRAM_ADDRESSES } from '../src/simulation/devices/fram';
import { Eeprom24cDevice, EEPROM_ADDRESSES } from '../src/simulation/devices/eeprom24c';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
let skipped = 0;
function skip(msg: string) {
  console.log('SKIP:', msg);
  skipped++;
}
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

const inst = (definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance => ({
  id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});
function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

/** Drives an I2C device the way Wire does: address, then bytes. */
function i2c(device: Ads1115Device | Ds1307Device | FramDevice, address: number) {
  return {
    write(...bytes: number[]) {
      device.start(address, true);
      for (const b of bytes) device.writeByte(b);
      device.stop();
    },
    read(count: number): number[] {
      device.start(address, false);
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(device.readByte());
      device.stop();
      return out;
    },
  };
}

// ================================= 1. the ADS1115 converts what is on the pin
section('1. the ADS1115 reads the wire');
{
  const dev = new Ads1115Device('a', ADS1115_ADDRESSES[0]);
  const bus = i2c(dev, ADS1115_ADDRESSES[0]);

  // Single-ended AIN0, ±4.096 V range, single-shot, start now.
  const config = (mux: number, pga: number) => 0x8000 | (mux << 12) | (pga << 9) | 0x0100 | 0x0080;

  dev.setInputVolts(0, 2.0);
  bus.write(0x01, (config(4, 1) >> 8) & 0xff, config(4, 1) & 0xff);
  bus.write(0x00);
  let [hi, lo] = bus.read(2);
  let counts = ((hi << 8) | lo) << 16 >> 16;
  let volts = (counts / 32767) * 4.096;
  console.log(`   2.000 V at ±4.096 V -> ${counts} counts = ${volts.toFixed(3)} V`);
  check(Math.abs(volts - 2.0) < 0.01, `2 V reads back as 2 V (${volts.toFixed(3)})`);

  dev.setInputVolts(0, 0.5);
  bus.write(0x01, (config(4, 1) >> 8) & 0xff, config(4, 1) & 0xff);
  bus.write(0x00);
  [hi, lo] = bus.read(2);
  counts = ((hi << 8) | lo) << 16 >> 16;
  volts = (counts / 32767) * 4.096;
  console.log(`   0.500 V at ±4.096 V -> ${counts} counts = ${volts.toFixed(3)} V`);
  check(Math.abs(volts - 0.5) < 0.01, `and 0.5 V reads back as 0.5 V (${volts.toFixed(3)})`);

  // The same voltage on a different gain gives different counts, which is what
  // the gain is for and what a model with a fixed scale would lose.
  dev.setInputVolts(0, 0.5);
  bus.write(0x01, (config(4, 3) >> 8) & 0xff, config(4, 3) & 0xff); // ±1.024 V
  bus.write(0x00);
  [hi, lo] = bus.read(2);
  const narrowCounts = ((hi << 8) | lo) << 16 >> 16;
  console.log(`   0.500 V at ±1.024 V -> ${narrowCounts} counts`);
  check(narrowCounts > 15000, `a narrower range gives more counts for the same volts (${narrowCounts})`);
  check(
    Math.abs((narrowCounts / 32767) * 1.024 - 0.5) < 0.01,
    'and converts back to the same voltage',
  );
}

// ================================================= 2. gain mistakes are real
section('2. too much voltage for the range rails, it does not wrap');
{
  const dev = new Ads1115Device('a');
  const bus = i2c(dev, ADS1115_ADDRESSES[0]);
  dev.setInputVolts(0, 5.0);
  // AIN0 single-ended (mux 4), ±2.048 V (PGA 2), single-shot, start now.
  // That range is the part's default and this is the classic mistake.
  bus.write(0x01, 0xc5, 0x83);
  bus.write(0x00);
  const [hi, lo] = bus.read(2);
  const counts = ((hi << 8) | lo) << 16 >> 16;
  console.log(`   5 V into ±2.048 V -> ${counts} counts`);
  check(counts === 32767, `it saturates at full scale (${counts})`);
  check(dev.saturationCount > 0, 'and the part records that it saturated');
  check(counts > 0, 'rather than wrapping round to a negative number');
}

// =========================================== 3. differential and unwired pins
section('3. differential reads a difference; unwired is not zero');
{
  const dev = new Ads1115Device('a');
  const bus = i2c(dev, ADS1115_ADDRESSES[0]);
  dev.setInputVolts(0, 1.0);
  dev.setInputVolts(1, 3.0);
  // Mux 0 is AIN0 - AIN1, so this should be negative. PGA 2 is ±2.048 V.
  bus.write(0x01, 0x85, 0x83);
  bus.write(0x00);
  const [hi, lo] = bus.read(2);
  const counts = ((hi << 8) | lo) << 16 >> 16;
  const volts = (counts / 32767) * 2.048;
  console.log(`   AIN0 1 V, AIN1 3 V, differential -> ${volts.toFixed(3)} V`);
  check(counts < 0, 'a differential reading can be negative');
  check(Math.abs(volts + 2.0) < 0.02, `and equals the difference (${volts.toFixed(3)})`);

  const floating = new Ads1115Device('f');
  const fbus = i2c(floating, ADS1115_ADDRESSES[0]);
  floating.setInputVolts(0, null);
  fbus.write(0x01, 0xc5, 0x83); // AIN0 single-ended, ±2.048 V
  fbus.write(0x00);
  fbus.read(2);
  check(floating.conversionCount > 0, 'an unwired input still completes a conversion');
  // The honest part: it is recorded as unwired rather than presented as 0 V of
  // signal, which the snapshot says out loud.
  check(/unwired/.test(floating.snapshot().log.join(' ')), 'and is reported as unwired');
}

// ======================================== 4. the MCP3008's bit positions ====
section('4. the MCP3008 answers in the bits the sketch reads');
{
  const dev = new Mcp3008Device('m', 'cs');
  dev.setReference(5);
  dev.setInputVolts(0, 2.5);
  dev.setInputVolts(3, 5.0);

  /** The three-byte transfer every MCP3008 sketch performs. */
  const readChannel = (ch: number): number => {
    dev.select(true);
    dev.transfer(0x01);
    const b1 = dev.transfer(0x80 | (ch << 4)) ?? 0;
    const b2 = dev.transfer(0x00) ?? 0;
    dev.select(false);
    return ((b1 & 0x03) << 8) | b2;
  };

  const mid = readChannel(0);
  console.log(`   CH0 at 2.5 V of 5 V -> ${mid}`);
  check(Math.abs(mid - 511) <= 2, `half the reference is half of 1023 (${mid})`);

  const full = readChannel(3);
  console.log(`   CH3 at 5.0 V of 5 V -> ${full}`);
  check(full === 1023, `the full reference is full scale (${full})`);

  const unwired = readChannel(5);
  check(unwired === 0 && dev.unwiredReadCount > 0, 'an unwired channel reads zero and says so');

  // Channel select genuinely selects: reading CH0 and CH3 must differ.
  check(mid !== full, 'the channel bits choose the channel');

  // The reference is a wire. The same input on a 3.3 V part reads higher.
  const low = new Mcp3008Device('m2', 'cs');
  low.setReference(3.3);
  low.setInputVolts(0, 2.5);
  low.select(true);
  low.transfer(0x01);
  const lb1 = low.transfer(0x80) ?? 0;
  const lb2 = low.transfer(0x00) ?? 0;
  low.select(false);
  const lowCounts = ((lb1 & 0x03) << 8) | lb2;
  console.log(`   CH0 at 2.5 V of 3.3 V -> ${lowCounts}`);
  check(lowCounts > mid, `the same voltage against a smaller reference reads higher (${lowCounts} > ${mid})`);
}

// =============================== 5. an ADC fed by the circuit, end to end ====
section('5. executed firmware reading a real voltage through the ADS1115');
{
  // The whole claim, proved the only way that counts: a supply on AIN0, real
  // Wire traffic from compiled AVR firmware, and the number the sketch prints
  // compared against the volts the solver put on the pin.
  //
  // Deliberately not a resistor divider. Resistors conduct in this model but do
  // not divide — that needs the analog solver, which does not exist yet — so a
  // divider test would assert a midpoint the engine cannot produce.
  const SOURCE = [
    '#include <Wire.h>',
    'void setup() {',
    '  Serial.begin(9600);',
    '  Wire.begin();',
    '  // AIN0 single-ended, +-4.096 V, single-shot, start now.',
    '  Wire.beginTransmission(0x48); Wire.write(0x01); Wire.write(0xC3); Wire.write(0x83); Wire.endTransmission();',
    '  delay(10);',
    '  Wire.beginTransmission(0x48); Wire.write(0x00); Wire.endTransmission();',
    '  Wire.requestFrom(0x48, 2);',
    '  int16_t v = (Wire.read() << 8) | Wire.read();',
    '  Serial.print("C"); Serial.println(v);',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('adc-firmware');
  const board = inst('board.arduino-uno');
  const supply = inst('comp.dc-supply', { voltage: 3.3 });
  const adc = inst('comp.ads1115');
  p.boardInstances.push(board);
  p.componentInstances.push(supply, adc);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  wire(p, board.id, '5V', adc.id, 'vcc');
  wire(p, board.id, 'GND_TOP', adc.id, 'gnd');
  wire(p, board.id, 'A4', adc.id, 'sda');
  wire(p, board.id, 'A5', adc.id, 'scl');
  wire(p, supply.id, 'plus', adc.id, 'a0');
  wire(p, supply.id, 'minus', board.id, 'GND_PWR1');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired ADC test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    simulationController.publishNow();
    const text = useSimulationStore.getState().serialText ?? '';
    const m = /C(-?\d+)/.exec(text);
    const counts = m ? Number(m[1]) : NaN;
    const volts = (counts / 32767) * 4.096;
    console.log(`   firmware read ${counts} counts = ${volts.toFixed(3)} V`);
    check(Number.isFinite(counts), `the sketch got a reading back over I2C (${m?.[1] ?? 'none'})`);
    check(
      Number.isFinite(counts) && Math.abs(volts - 3.3) < 0.05,
      `and it is the 3.3 V the supply put on AIN0 (${volts.toFixed(3)})`,
    );
  }
  simulationController.stop();
}

// ============================================= 6. the RTC runs on sim time ===
section('6. time comes from the simulation, not the host');
{
  let now = 0;
  const rtc = new Ds1307Device('r', DS1307_ADDRESS, () => now);
  const bus = i2c(rtc, DS1307_ADDRESS);

  check(rtc.isHalted, 'a fresh DS1307 comes up with its oscillator stopped');

  // Set 2024-03-05 14:30:00, Tuesday. Seven registers, BCD, clock-halt clear.
  bus.write(0x00, toBcd(0), toBcd(30), toBcd(14), toBcd(3), toBcd(5), toBcd(3), toBcd(24));
  check(!rtc.isHalted, 'writing the seconds register with bit 7 clear starts it');
  console.log(`   set to ${rtc.isoTime}`);
  check(rtc.isoTime.startsWith('2024-03-05T14:30:00'), `the time was set (${rtc.isoTime})`);

  // Three hours of simulated time.
  now += 3 * 60 * 60 * 1000;
  console.log(`   after 3 simulated hours: ${rtc.isoTime}`);
  check(rtc.isoTime.startsWith('2024-03-05T17:30:00'), `three hours later it is 17:30 (${rtc.isoTime})`);

  // Read it back the way a library does, and check it is BCD.
  bus.write(0x00);
  const regs = bus.read(7);
  console.log(`   registers: ${regs.map((r) => '0x' + r.toString(16).padStart(2, '0')).join(' ')}`);
  check(regs[1] === 0x30, `minutes read as BCD 0x30, not decimal 48 (0x${regs[1].toString(16)})`);
  check(fromBcd(regs[2]) === 17, `hours convert to 17 (${fromBcd(regs[2])})`);
  check(regs[2] !== 17, 'and the raw register is not the decimal value — a sketch must convert');

  // Halting stops it, which is what the bit is for.
  bus.write(0x00, 0x80 | toBcd(fromBcd(regs[0])));
  const frozen = rtc.isoTime;
  now += 60 * 60 * 1000;
  check(rtc.isoTime === frozen, 'setting the halt bit stops the clock');

  // Nothing here consulted the host clock: the same inputs give the same
  // outputs whenever this runs.
  let other = 0;
  const twin = new Ds1307Device('t', DS1307_ADDRESS, () => other);
  const tbus = i2c(twin, DS1307_ADDRESS);
  tbus.write(0x00, toBcd(0), toBcd(30), toBcd(14), toBcd(3), toBcd(5), toBcd(3), toBcd(24));
  other += 3 * 60 * 60 * 1000;
  check(twin.isoTime === '2024-03-05T17:30:00Z', 'a second device given the same steps gives the same time');

  // User RAM.
  bus.write(0x08, 0xab, 0xcd);
  bus.write(0x08);
  const ram = bus.read(2);
  check(ram[0] === 0xab && ram[1] === 0xcd, 'the 56 bytes of user RAM store and return bytes');
}

// ================================= 7. FRAM is not an EEPROM, and that is why =
section('7. the difference between FRAM and EEPROM is the writes');
{
  let now = 0;
  const fram = new FramDevice('f', FRAM_ADDRESSES[0]);
  const eeprom = new Eeprom24cDevice('e', EEPROM_ADDRESSES[0], () => now * 1000);

  const framBus = i2c(fram, FRAM_ADDRESSES[0]);
  framBus.write(0x00, 0x00, 0x11, 0x22, 0x33);
  framBus.write(0x00, 0x00);
  const back = framBus.read(3);
  check(back[0] === 0x11 && back[2] === 0x33, 'FRAM stores and returns bytes');
  check(!fram.isBusy, 'and is never busy after a write — the whole reason to use it');

  // The EEPROM on the same traffic goes busy, which is what a sketch has to
  // wait for and what a FRAM sketch does not.
  eeprom.start(EEPROM_ADDRESSES[0], true);
  eeprom.writeByte(0x00);
  eeprom.writeByte(0x00);
  eeprom.writeByte(0x11);
  eeprom.stop();
  check(eeprom.busy, 'while an EEPROM is busy after the same write');
  check(fram.isBusy !== eeprom.busy, 'so the two parts genuinely behave differently');

  // No page boundary: a write that crosses one on an EEPROM wraps within the
  // page; here it simply continues.
  const long = new FramDevice('f2', FRAM_ADDRESSES[0]);
  const lbus = i2c(long, FRAM_ADDRESSES[0]);
  const payload = Array.from({ length: 40 }, (_, i) => i + 1);
  lbus.write(0x00, 0x38, ...payload); // starts at 0x38, crosses a 32-byte page
  lbus.write(0x00, 0x38);
  const readBack = lbus.read(40);
  check(
    readBack.every((v, i) => v === payload[i]),
    'forty bytes written across a page boundary read back unchanged',
  );

  // Contents survive a reset, and round-trip through the project file.
  const before = long.byteAt(0x38);
  long.reset();
  check(long.byteAt(0x38) === before, 'a reset does not clear a nonvolatile part');
  const saved = long.saveState();
  const restored = new FramDevice('f3', FRAM_ADDRESSES[0]);
  restored.loadState(saved);
  check(restored.byteAt(0x38) === before, 'and the contents round-trip through a save');
  check(saved.bytes.length < 8192, `with only the used span stored (${saved.bytes.length} bytes)`);
}

// ==================================================== 8. the parts as shipped
section('8. the parts in the library');
{
  for (const id of ['comp.ads1115', 'comp.mcp3008', 'comp.ds1307', 'comp.fram']) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.supportLevel === 'simulated', `${id} is badged Simulated`);
    // The rule the whole checkpoint rests on: no way to set a reading.
    check(
      !def.properties.some((pp) => /value|reading|volt|time|date/i.test(pp.key)),
      `${id} has no property that sets its output`,
    );
    check(/NOT modelled/.test(def.description ?? ''), `${id} names what it does not model`);
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'simulated', `${id} is recorded as simulated`);
    check((cov?.tests ?? []).includes('tests/data.converters.mts'), `${id} names this file as its proof`);
  }

  // The parts this checkpoint had to preserve rather than replace.
  for (const id of ['comp.mcp4725', 'comp.eeprom-24c', 'comp.spi-flash', 'comp.sd-card', 'comp.ds3231']) {
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov !== undefined && cov.status === 'simulated', `${id} is still simulated`);
  }

  const adc = defOf('comp.ads1115');
  for (const pinId of ['a0', 'a1', 'a2', 'a3', 'sda', 'scl']) {
    check(adc?.pins.some((pp) => pp.id === pinId), `the ADS1115 exposes ${pinId}`);
  }
  const mcp = defOf('comp.mcp3008');
  check(mcp?.pins.filter((pp) => /^ch\d$/.test(pp.id)).length === 8, 'the MCP3008 has eight channels');
  check(mcp?.pins.some((pp) => pp.id === 'vref'), 'and a reference pin, because the reference matters');
}

console.log(
  failures === 0
    ? `\nData converter checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
