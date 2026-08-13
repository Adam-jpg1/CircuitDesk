// Port expanders: pins that are actually pins.
//
// These are the first devices that drive nets rather than only answering the
// bus, so the assertions are about wires: a pin written low really pulls one
// down, a released pin really lets a button win, and an MCP23017 output really
// drives both ways where a PCF8574's does not.

import { emptyProject } from '../src/project/templates';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import {
  Pcf857xDevice,
  Mcp23017Device,
  MCP23017_REG,
  PCF8574_ADDRESSES,
  MCP23017_ADDRESSES,
} from '../src/simulation/devices/portExpanders';
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

// A driver, written the way a library writes one.
function writePcf(device: Pcf857xDevice, ...bytes: number[]): void {
  device.start(PCF8574_ADDRESSES[0], true);
  for (const b of bytes) device.writeByte(b);
  device.stop();
}
function readPcf(device: Pcf857xDevice, count = 1): number[] {
  device.start(PCF8574_ADDRESSES[0], false);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(device.readByte());
  device.stop();
  return out;
}
function writeMcp(device: Mcp23017Device, register: number, value: number): void {
  device.start(MCP23017_ADDRESSES[0], true);
  device.writeByte(register);
  device.writeByte(value);
  device.stop();
}
function readMcp(device: Mcp23017Device, register: number): number {
  device.start(MCP23017_ADDRESSES[0], true);
  device.writeByte(register);
  device.start(MCP23017_ADDRESSES[0], false);
  const value = device.readByte();
  device.stop();
  return value;
}

// ====================================== 1. the PCF8574 is quasi-bidirectional
section('1. PCF8574 — writing 1 releases, writing 0 drives');
{
  const device = new Pcf857xDevice('pcf', PCF8574_ADDRESSES[0], 8);
  check(device.latchValue === 0xff, 'every pin starts released, as it does at power-on');
  check(device.pinState(0) === 'weak-high', 'so a pin is a weak pull-up, not a driver');

  writePcf(device, 0b11110000);
  check(device.pinState(0) === 'drive-low', 'a bit written 0 pulls the pin firmly low');
  check(device.pinState(7) === 'weak-high', 'and a bit written 1 only releases it');

  // A pin held low by the latch reads low whatever is outside it.
  device.setInputLevel(0, true);
  check((readPcf(device)[0] & 1) === 0, 'a pin the latch holds low reads low even against an external high');

  // A released pin reads what the world is doing — that is the read protocol.
  device.setInputLevel(7, false);
  check(((readPcf(device)[0] >> 7) & 1) === 0, 'a released pin reads the external level');
  device.setInputLevel(7, null);
  check(((readPcf(device)[0] >> 7) & 1) === 1, 'and reads high through its pull-up when nothing holds it');

  // Which is exactly the write-1-then-read idiom.
  writePcf(device, 0xff);
  device.setInputLevel(3, false);
  check(((readPcf(device)[0] >> 3) & 1) === 0, 'writing 1 to a pin then reading it is how an input works here');
}

// ================================================= 2. the PCF8575 is 16 bits ==
section('2. PCF8575');
{
  const device = new Pcf857xDevice('pcf16', PCF8574_ADDRESSES[0], 16);
  check(device.pinCount === 16, 'sixteen pins');
  writePcf(device, 0x00, 0xff); // low byte first, as the part expects
  check(device.pinState(0) === 'drive-low', 'the low byte reached pins 0-7');
  check(device.pinState(8) === 'weak-high', 'and the high byte reached pins 8-15');
  const read = readPcf(device, 2);
  check(read.length === 2, 'a read returns two bytes');
  check((read[0] & 0xff) === 0x00, `the low byte reflects the pins held low (0x${read[0].toString(16)})`);
  check((read[1] & 0xff) === 0xff, `and the high byte the released ones (0x${read[1].toString(16)})`);
}

// ======================================== 3. the MCP23017 has real direction ==
section('3. MCP23017 — direction, pull-ups, latches and interrupts');
{
  const device = new Mcp23017Device('mcp', MCP23017_ADDRESSES[0]);
  check(device.directionRegister === 0xffff, 'every pin starts as an input, as the datasheet says');
  check(device.pinState(0) === 'high-z', 'so a pin is genuinely high impedance, not pulled up');

  // Port A as outputs.
  writeMcp(device, MCP23017_REG.IODIRA, 0x00);
  check(device.pinState(0) === 'drive-low', 'configured as an output it drives — low, since the latch is clear');
  writeMcp(device, MCP23017_REG.GPIOA, 0xff);
  check(device.pinState(0) === 'drive-high', 'and writing GPIOA drives high — a real push-pull output');
  check(device.outputLatch === 0x00ff, `writing GPIO writes the output latch (0x${device.outputLatch.toString(16)})`);
  check(readMcp(device, MCP23017_REG.OLATA) === 0xff, 'which reads back through OLAT');

  // Port B stays an input; a pull-up changes what it reads.
  check(device.pinState(8) === 'high-z', 'port B is still high impedance');
  writeMcp(device, MCP23017_REG.GPPUB, 0xff);
  check(device.pinState(8) === 'weak-high', 'enabling the pull-up changes that');
  check((readMcp(device, MCP23017_REG.GPIOB) & 1) === 1, 'and a floating pulled-up input reads high');
  device.setInputLevel(8, false);
  check((readMcp(device, MCP23017_REG.GPIOB) & 1) === 0, 'until something pulls it low');

  // Polarity inversion applies to inputs.
  writeMcp(device, MCP23017_REG.IPOLB, 0xff);
  check((readMcp(device, MCP23017_REG.GPIOB) & 1) === 1, 'polarity inversion flips what an input reads');
  writeMcp(device, MCP23017_REG.IPOLB, 0x00);

  // Interrupt on change.
  writeMcp(device, MCP23017_REG.GPINTENB, 0xff);
  check(!device.interruptAsserted, 'no interrupt while nothing changes');
  device.setInputLevel(9, true);
  check(device.interruptAsserted, 'a change on an enabled input asserts the interrupt');
  check((readMcp(device, MCP23017_REG.INTFB) & 0b10) !== 0, 'and the flag register names the pin');
  readMcp(device, MCP23017_REG.INTCAPB);
  check(!device.interruptAsserted, 'reading INTCAP clears it, as it does on hardware');

  // An interrupt is not raised for a pin that is an output.
  writeMcp(device, MCP23017_REG.GPINTENA, 0xff);
  device.setInputLevel(1, true);
  check(!device.interruptAsserted, 'an output pin does not raise interrupt-on-change');

  // Unknown register: recorded, not answered.
  readMcp(device, 0x7f);
  check(/unknown register/.test(device.snapshot().log.join(' ')), 'an unknown register is recorded as unhandled');
}

// ====================================== 4. expander pins reach the solver =====
section('4. expander pins are wired into real nets');
{
  const p = emptyProject('expander');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const exp: ComponentInstance = {
    id: uid('x'), definitionId: 'comp.mcp23017', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const led: ComponentInstance = {
    id: uid('l'), definitionId: 'comp.led', x: 0, y: 0, rotation: 0, properties: { color: 'red' }, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(exp, led);
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '3V3', exp.id, 'vcc');
  wire(board.id, 'GND1', exp.id, 'gnd');
  wire(board.id, 'GP4', exp.id, 'sda');
  wire(board.id, 'GP5', exp.id, 'scl');
  wire(exp.id, 'p0', led.id, 'anode');
  wire(board.id, 'GND2', led.id, 'cathode');

  const binding = new CircuitBinding(p, null);
  const graph = (binding as unknown as { graph: { netOf: Map<string, string> } }).graph;
  check(graph.netOf.get(`${exp.id}:p0`) === graph.netOf.get(`${led.id}:anode`), "the expander's P0 shares a net with the LED anode");
  const { netLevels } = binding.update(emptyControls());
  check(netLevels instanceof Map, 'the circuit solves with an expander present');

  // The device model only exists once a running board attaches it to a bus, so
  // the pin behaviour itself is covered by the protocol sections above.
  const def = defOf('comp.mcp23017')!;
  check(def.pins.filter((x) => /^p\d+$/.test(x.id)).length === 16, 'the part exposes sixteen IO pins');
  check(def.pins.some((x) => x.id === 'int'), 'and an interrupt output');
}

// ============================================ 5. two expanders, one address ==
section('5. two expanders are independent');
{
  const a = new Pcf857xDevice('a', PCF8574_ADDRESSES[0], 8);
  const b = new Pcf857xDevice('b', PCF8574_ADDRESSES[0], 8);
  writePcf(a, 0x0f);
  writePcf(b, 0xf0);
  // 0x0f releases pins 0-3 and drives 4-7 low; 0xf0 is the mirror image.
  check(a.pinState(0) === 'weak-high' && b.pinState(0) === 'drive-low', 'the same address on two instances holds different state');
  check(a.pinState(4) === 'drive-low' && b.pinState(4) === 'weak-high', 'and the mirror pattern on the other nibble');
  check(a.latchValue !== b.latchValue, `their latches differ (0x${a.latchValue.toString(16)} vs 0x${b.latchValue.toString(16)})`);

  // Addresses are strappable, which is how eight fit on one bus.
  const c = new Pcf857xDevice('c', 0x21, 8);
  check(!c.matchesAddress(0x20) && c.matchesAddress(0x21), 'a strapped expander answers only its own address');

  // And an MCP23017 at the same address as a PCF8574 is still its own device.
  const m = new Mcp23017Device('m', MCP23017_ADDRESSES[0]);
  writeMcp(m, MCP23017_REG.IODIRA, 0x00);
  check(a.pinState(4) === 'drive-low' && m.pinState(0) === 'drive-low', 'both parts can be configured independently');
  check(m.directionRegister !== 0xffff && a.latchValue === 0x0f, 'and neither one wrote through the other');
}

// ================================================ 6. library and definitions ==
section('6. the parts are in the library');
{
  for (const id of ['comp.pcf8574', 'comp.pcf8575', 'comp.mcp23017']) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.supportLevel === 'simulated', `${id} is badged Simulated`);
    check(def.simulationAdapterId === 'sim.expander', `${id} uses the expander adapter`);
    const W = def.widthMm * 4;
    const H = def.heightMm * 4;
    check(def.pins.every((x) => x.x >= -1 && x.y >= -1 && x.x <= W + 1 && x.y <= H + 1), `${id}: pins in bounds`);
    const ids = def.pins.map((x) => x.id);
    check(new Set(ids).size === ids.length, `${id}: pin ids are unique`);
    check((def.description ?? '').length > 80, `${id} explains how its pins behave`);
  }
  check(defOf('comp.pcf8574')!.pins.filter((x) => /^p\d+$/.test(x.id)).length === 8, 'the PCF8574 has eight IO pins');
  check(defOf('comp.pcf8575')!.pins.filter((x) => /^p\d+$/.test(x.id)).length === 16, 'the PCF8575 has sixteen');
}

console.log(failures === 0 ? '\nPort expander checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
