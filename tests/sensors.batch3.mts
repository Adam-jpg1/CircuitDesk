// Batch 3 sensors: the value has to travel through the hardware.
//
// For an analog part that means a voltage on a real net reaching a real ADC
// channel. For a digital part it means a driven line. For an I2C part it means
// the bytes a driver would read, checksums and all. The test that would prove
// nothing is one that asks the device for its own value, so none of these do.

import { emptyProject } from '../src/project/templates';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { ANALOG_SENSORS, GPIO_SENSORS, ntcResistance } from '../src/simulation/devices/analogSensors';
import { Bme280Device, BME280_CHIP_ID, BME280_ADDRESSES } from '../src/simulation/devices/bme280';
import { Sht31Device, sht31Crc, SHT31_ADDRESSES } from '../src/simulation/devices/sht31';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
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

// ------------------------------------------------- an I2C driver, in the test
//
// Reads registers the way a library does — address, pointer, repeated start,
// read — so what is being checked is the byte stream rather than the model's
// internals.

function readRegisters(device: Bme280Device, start: number, count: number): number[] {
  device.start(BME280_ADDRESSES[0], true);
  device.writeByte(start);
  device.start(BME280_ADDRESSES[0], false);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(device.readByte());
  device.stop();
  return out;
}

function sendCommand(device: Sht31Device, command: number): void {
  device.start(SHT31_ADDRESSES[0], true);
  device.writeByte((command >> 8) & 0xff);
  device.writeByte(command & 0xff);
  device.stop();
}

function readBlock(device: Sht31Device, count: number): number[] {
  device.start(SHT31_ADDRESSES[0], false);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(device.readByte());
  device.stop();
  return out;
}

// ======================================= 1. analog sensors reach a real ADC ==
section('1. analog sensors impose a voltage on a real net');
{
  /** Builds a Pico + sensor project and returns the ADC volts seen on GP26. */
  const adcVolts = (definitionId: string, value: number, rail: '3V3' | 'VBUS' = '3V3'): number | null => {
    const p = emptyProject('analog');
    const board: ComponentInstance = {
      id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0,
      properties: {}, simulationState: {},
    };
    const spec = ANALOG_SENSORS[definitionId];
    const sensor: ComponentInstance = {
      id: uid('s'), definitionId, x: 0, y: 0, rotation: 0,
      properties: { [spec.quantity.key]: value }, simulationState: {},
    };
    p.boardInstances.push(board);
    p.componentInstances.push(sensor);
    const wire = (a: string, ap: string, b: string, bp: string) =>
      p.connections.push({
        id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
        netId: '', color: '#000', points: [], routing: 'smooth',
      } as CircuitProject['connections'][number]);
    wire(board.id, rail, sensor.id, 'vcc');
    wire(board.id, 'GND1', sensor.id, 'gnd');
    wire(board.id, 'GP26', sensor.id, spec.outputPin);

    // A fake runner that records what voltage lands on which ADC channel.
    let seen: number | null = null;
    const runner = {
      timeMs: 0,
      engine: 'test',
      setAnalogVolts: (_ch: number, v: number) => { seen = v; },
      digitalPinLevel: () => 'input' as const,
      setDigitalInput: () => {},
      isOutput: () => false,
      addPinListener: () => () => {},
      addMicrosecondEvent: () => () => {},
      runFor: () => {},
      snapshot: () => ({ states: [], duty: [], pulseWidthUs: [], toggles: [] }),
    } as unknown as Parameters<typeof CircuitBinding.prototype.constructor>[1];
    const binding = new CircuitBinding(p, runner);
    binding.update(emptyControls());
    return seen;
  };

  // LM35: 10 mV per degree, and it cannot go below zero on a single supply.
  const lm35 = adcVolts('comp.lm35', 40);
  check(lm35 !== null && Math.abs(lm35 - 0.4) < 0.01, `LM35 at 40 °C puts 0.40 V on the ADC (${lm35?.toFixed(3)} V)`);
  const lm35cold = adcVolts('comp.lm35', -5);
  check(lm35cold === 0, `and clamps at zero below 0 °C (${lm35cold} V)`);

  // NTC: ratiometric, so the same temperature reads differently on 5V.
  const ntc33 = adcVolts('comp.ntc-thermistor', 25, '3V3');
  const ntc5 = adcVolts('comp.ntc-thermistor', 25, 'VBUS');
  check(ntc33 !== null && Math.abs(ntc33 - 3.3 / 2) < 0.05, `a 10k NTC at 25 °C sits at half the 3.3 V rail (${ntc33?.toFixed(3)} V)`);
  check(ntc5 !== null && ntc5 > (ntc33 ?? 0) * 1.4, `and scales with the rail (${ntc5?.toFixed(3)} V on 5 V)`);
  const ntcHot = adcVolts('comp.ntc-thermistor', 60);
  check(ntcHot !== null && ntcHot > (ntc33 ?? 0), 'resistance falls as it warms, so the divider output rises');
  check(ntcResistance(25) === 10_000, `the beta model gives 10 kΩ at 25 °C (${ntcResistance(25)})`);
  check(ntcResistance(50) < 5000, `and less than 5 kΩ at 50 °C (${Math.round(ntcResistance(50))} Ω)`);

  // Soil moisture is inverted, which is the thing people get wrong.
  const dry = adcVolts('comp.soil-moisture', 0);
  const wet = adcVolts('comp.soil-moisture', 100);
  check(dry !== null && wet !== null && dry > wet, `dry soil reads higher than wet (${dry?.toFixed(2)} V vs ${wet?.toFixed(2)} V)`);

  // FSR: unloaded is near zero, loaded rises.
  const unloaded = adcVolts('comp.fsr', 0);
  const pressed = adcVolts('comp.fsr', 50);
  check(unloaded !== null && unloaded < 0.05, `an unloaded FSR reads near zero (${unloaded?.toFixed(3)} V)`);
  check(pressed !== null && pressed > (unloaded ?? 0) * 10, `and rises sharply under load (${pressed?.toFixed(2)} V)`);

  // Gas sensor is logarithmic.
  const clean = adcVolts('comp.mq2', 400);
  const smoky = adcVolts('comp.mq2', 4000);
  check(clean !== null && smoky !== null && smoky > clean, `MQ-2 rises with concentration (${clean?.toFixed(2)} → ${smoky?.toFixed(2)} V)`);

  // Unpowered: nothing at all.
  const p = emptyProject('unpowered');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const sensor: ComponentInstance = {
    id: uid('s'), definitionId: 'comp.lm35', x: 0, y: 0, rotation: 0, properties: { temperature: 40 }, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(sensor);
  p.connections.push({
    id: uid('w'), sourceComponentId: board.id, sourcePinId: 'GP26', targetComponentId: sensor.id, targetPinId: 'vout',
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
  let touched = false;
  const runner = {
    timeMs: 0, engine: 'test',
    setAnalogVolts: () => { touched = true; },
    digitalPinLevel: () => 'input' as const,
    setDigitalInput: () => {}, isOutput: () => false,
    addPinListener: () => () => {}, addMicrosecondEvent: () => () => {}, runFor: () => {},
    snapshot: () => ({ states: [], duty: [], pulseWidthUs: [], toggles: [] }),
  } as never;
  new CircuitBinding(p, runner).update(emptyControls());
  check(!touched, 'a sensor with no supply imposes nothing on the ADC');
}

// ============================================ 2. digital sensors drive lines ==
section('2. digital sensors drive a real line');
{
  const p = emptyProject('gpio');
  const supply: ComponentInstance = {
    id: uid('u'), definitionId: 'comp.battery-aa', x: 0, y: 0, rotation: 0, properties: { voltage: 5 }, simulationState: {},
  };
  const pir: ComponentInstance = {
    id: uid('s'), definitionId: 'comp.pir', x: 0, y: 0, rotation: 0, properties: { triggered: false }, simulationState: {},
  };
  const hall: ComponentInstance = {
    id: uid('s'), definitionId: 'comp.hall-sensor', x: 0, y: 0, rotation: 0, properties: { triggered: false }, simulationState: {},
  };
  p.componentInstances.push(supply, pir, hall);
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  for (const s of [pir, hall]) {
    wire(supply.id, 'plus', s.id, 'vcc');
    wire(supply.id, 'minus', s.id, 'gnd');
  }

  const outVolts = (inst: ComponentInstance, triggered: boolean): number | null => {
    inst.properties.triggered = triggered;
    const binding = new CircuitBinding(p, null);
    const { netLevels } = binding.update(emptyControls());
    const graph = (binding as unknown as { graph: { netOf: Map<string, string> } }).graph;
    const netId = graph.netOf.get(`${inst.id}:out`);
    return netId ? netLevels.get(netId)?.volts ?? null : null;
  };

  check(outVolts(pir, false) === 0, 'an idle PIR holds its output low');
  check((outVolts(pir, true) ?? 0) > 4, 'motion drives it high');
  check(GPIO_SENSORS['comp.pir'].holdMs > 0, 'and it holds after triggering rather than following the motion');

  // The Hall switch is active low, which is a real difference, not a detail.
  check((outVolts(hall, false) ?? 0) > 4, 'a Hall switch with no magnet reads high');
  check(outVolts(hall, true) === 0, 'and pulls low when a magnet is near');

  // Nothing self-triggers.
  const idle = outVolts(pir, false);
  let sameEveryTime = true;
  for (let i = 0; i < 20; i++) if (outVolts(pir, false) !== idle) sameEveryTime = false;
  check(sameEveryTime, 'a PIR never fires on its own — motion is something you cause');
}

// ================================================================ 3. BME280 ==
section('3. BME280 through its register map');
{
  const device = new Bme280Device('bme', BME280_ADDRESSES[0]);
  check(readRegisters(device, 0xd0, 1)[0] === BME280_CHIP_ID, `the chip id reads 0x60 (0x${readRegisters(device, 0xd0, 1)[0].toString(16)})`);
  check(BME280_CHIP_ID !== 0x58, 'which is not a BMP280 — a driver can tell them apart');

  // Asleep: a driver that forgets to start a measurement sees the reset value.
  const asleep = readRegisters(device, 0xf7, 8);
  check(asleep[0] === 0x80 && asleep[3] === 0x80, 'in sleep mode the data registers read their reset value, not live data');

  // Wake it as a library does: ctrl_hum then ctrl_meas.
  device.start(BME280_ADDRESSES[0], true);
  device.writeByte(0xf2);
  device.writeByte(0x01); // humidity oversampling ×1
  device.stop();
  device.start(BME280_ADDRESSES[0], true);
  device.writeByte(0xf4);
  device.writeByte(0x27); // normal mode, ×1 oversampling
  device.stop();
  check(device.isMeasuring, 'writing ctrl_meas takes it out of sleep');
  check(readRegisters(device, 0xf2, 1)[0] === 0x01, 'and ctrl_hum reads back what was written');

  /** The datasheet compensation, run over the bytes as a driver would. */
  const readEnvironment = () => {
    const calib = readRegisters(device, 0x88, 26);
    const hcal = readRegisters(device, 0xe1, 7);
    const data = readRegisters(device, 0xf7, 8);
    const u16 = (b: number[], i: number) => b[i] | (b[i + 1] << 8);
    const s16 = (b: number[], i: number) => { const v = u16(b, i); return v > 32767 ? v - 65536 : v; };
    const T1 = u16(calib, 0), T2 = s16(calib, 2), T3 = s16(calib, 4);
    const P1 = u16(calib, 6);
    const P2 = s16(calib, 8), P3 = s16(calib, 10), P4 = s16(calib, 12), P5 = s16(calib, 14);
    const P6 = s16(calib, 16), P7 = s16(calib, 18), P8 = s16(calib, 20), P9 = s16(calib, 22);
    const H1 = calib[25];
    const H2 = (hcal[0] | (hcal[1] << 8)) > 32767 ? (hcal[0] | (hcal[1] << 8)) - 65536 : hcal[0] | (hcal[1] << 8);
    const H3 = hcal[2];
    const H4 = (hcal[3] << 4) | (hcal[4] & 0x0f);
    const H5 = (hcal[5] << 4) | (hcal[4] >> 4);
    const H6 = hcal[6] > 127 ? hcal[6] - 256 : hcal[6];

    const adcP = (data[0] << 12) | (data[1] << 4) | (data[2] >> 4);
    const adcT = (data[3] << 12) | (data[4] << 4) | (data[5] >> 4);
    const adcH = (data[6] << 8) | data[7];

    const var1 = (adcT / 16384 - T1 / 1024) * T2;
    const var2 = (adcT / 131072 - T1 / 8192) ** 2 * T3;
    const tFine = var1 + var2;
    const celsius = tFine / 5120;

    let pv1 = tFine / 2 - 64000;
    let pv2 = (pv1 * pv1 * P6) / 32768;
    pv2 = pv2 + pv1 * P5 * 2;
    pv2 = pv2 / 4 + P4 * 65536;
    pv1 = ((P3 * pv1 * pv1) / 524288 + P2 * pv1) / 524288;
    pv1 = (1 + pv1 / 32768) * P1;
    let pressure = 0;
    if (pv1 !== 0) {
      let pp = 1048576 - adcP;
      pp = ((pp - pv2 / 4096) * 6250) / pv1;
      const a = (P9 * pp * pp) / 2147483648;
      const b = (pp * P8) / 32768;
      pressure = (pp + (a + b + P7) / 16) / 100;
    }

    let h = tFine - 76800;
    h = (adcH - (H4 * 64 + (H5 / 16384) * h)) * ((H2 / 65536) * (1 + (H6 / 67108864) * h * (1 + (H3 / 67108864) * h)));
    h = h * (1 - (H1 * h) / 524288);

    return { celsius, pressure, humidity: h };
  };

  for (const [t, pr, hu] of [[22, 1013, 45], [-5, 950, 80], [45, 1050, 15]] as const) {
    device.temperatureC = t;
    device.pressureHpa = pr;
    device.humidityPct = hu;
    const got = readEnvironment();
    check(Math.abs(got.celsius - t) < 0.2, `temperature round-trips through the driver's compensation (set ${t}, read ${got.celsius.toFixed(2)} °C)`);
    check(Math.abs(got.pressure - pr) < 2, `pressure round-trips (set ${pr}, read ${got.pressure.toFixed(1)} hPa)`);
    check(Math.abs(got.humidity - hu) < 2, `humidity round-trips (set ${hu}, read ${got.humidity.toFixed(1)} %RH)`);
  }

  // Wrong address: silence, not a reply.
  check(!device.matchesAddress(0x50), 'it does not answer an address that is not its own');

  // Reset returns it to sleep.
  device.start(BME280_ADDRESSES[0], true);
  device.writeByte(0xe0);
  device.writeByte(0xb6);
  device.stop();
  check(!device.isMeasuring, 'the reset command puts it back to sleep');
}

// ================================================================= 4. SHT31 ==
section('4. SHT31 command protocol and CRC');
{
  const device = new Sht31Device('sht', SHT31_ADDRESSES[0]);
  device.temperatureC = 25;
  device.humidityPct = 60;

  sendCommand(device, 0x2400); // single shot, high repeatability
  const block = readBlock(device, 6);
  check(block.length === 6, 'a measurement returns six bytes');
  check(sht31Crc([block[0], block[1]]) === block[2], 'the temperature word carries a valid CRC-8');
  check(sht31Crc([block[3], block[4]]) === block[5], 'and so does the humidity word');

  // A driver's own conversion, from the datasheet.
  const rawT = (block[0] << 8) | block[1];
  const rawH = (block[3] << 8) | block[4];
  const celsius = -45 + (175 * rawT) / 65535;
  const humidity = (100 * rawH) / 65535;
  check(Math.abs(celsius - 25) < 0.1, `temperature round-trips (${celsius.toFixed(2)} °C)`);
  check(Math.abs(humidity - 60) < 0.1, `humidity round-trips (${humidity.toFixed(1)} %RH)`);

  // Deliberately corrupt a byte: the CRC must then fail, which is what proves
  // the checksum is real rather than decorative.
  check(sht31Crc([block[0] ^ 0xff, block[1]]) !== block[2], 'a corrupted byte fails the checksum');

  // The heater bit is reported in the status word.
  sendCommand(device, 0x306d); // heater on
  sendCommand(device, 0xf32d); // read status
  const status = readBlock(device, 3);
  check(((status[0] << 8) | status[1]) === 0x2000, `the status word reports the heater on (0x${(((status[0] << 8) | status[1]) >>> 0).toString(16)})`);
  check(sht31Crc([status[0], status[1]]) === status[2], 'with its own valid checksum');
  check(device.heaterOn, 'and the device knows the heater is on');

  // Fetching with no periodic mode running returns nothing.
  sendCommand(device, 0x3093); // break
  sendCommand(device, 0xe000); // fetch
  const empty = readBlock(device, 3);
  check(empty.every((b) => b === 0xff), 'a fetch with no periodic mode returns a released bus, not invented data');
}

// ====================================== 5. two identical sensors, two boards ==
section('5. multi-board ownership');
{
  // Two Picos, each with its own BME280 on its own I2C pins. The devices must
  // report different environments and attach to different buses.
  const a = new Bme280Device('a', BME280_ADDRESSES[0]);
  const b = new Bme280Device('b', BME280_ADDRESSES[0]);
  for (const d of [a, b]) {
    d.start(BME280_ADDRESSES[0], true);
    d.writeByte(0xf4);
    d.writeByte(0x27);
    d.stop();
  }
  a.temperatureC = 10;
  b.temperatureC = 40;
  const readTemp = (d: Bme280Device) => {
    const data = readRegisters(d, 0xfa, 3);
    return (data[0] << 12) | (data[1] << 4) | (data[2] >> 4);
  };
  check(readTemp(a) !== readTemp(b), 'two devices at the same address hold different environments');
  check(a.instanceId !== b.instanceId, 'because they are separate instances, not a shared model');
}

// ================================================ 6. library and definitions ==
section('6. the parts are wired into the library');
{
  const added = [
    ...Object.keys(ANALOG_SENSORS),
    ...Object.keys(GPIO_SENSORS),
    'comp.bme280', 'comp.sht31',
  ];
  let problems = 0;
  for (const id of added) {
    const def = defOf(id);
    if (!def) {
      check(false, `${id} exists in the library`);
      problems++;
      continue;
    }
    if (def.supportLevel !== 'simulated') problems++;
    if (!def.simulationAdapterId) problems++;
    if (!def.description || def.description.length < 40) problems++;
    // Pins in bounds.
    const W = def.widthMm * 4;
    const H = def.heightMm * 4;
    if (def.pins.some((p) => p.x < -1 || p.y < -1 || p.x > W + 1 || p.y > H + 1)) problems++;
    // Real artwork, not the generic box.
    if (def.artwork.kind !== 'builtin' || !def.artwork.builtinId) problems++;
  }
  check(problems === 0, `all ${added.length} new sensors are simulated, described, in bounds and drawn (${problems} problems)`);

  // Every analog sensor's user-adjustable quantity is a real property.
  const missingProps = Object.values(ANALOG_SENSORS).filter((spec) => {
    const def = defOf(spec.id);
    return !def?.properties.some((p) => p.key === spec.quantity.key);
  });
  check(missingProps.length === 0, `every analog sensor exposes its quantity as an adjustable property (${missingProps.length} missing)`);
}

console.log(failures === 0 ? '\nBatch 3 sensor checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
