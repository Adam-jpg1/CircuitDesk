// Device-expansion suite: the five parts added on top of the existing I2C and
// SPI buses (LCD1602, 24C256 EEPROM, DS3231 RTC, MCP4725 DAC, 74HC165).
//
// Part A exercises each device's protocol directly. Part B compiles real
// sketches and runs them on the AVR emulator, so the bytes asserted there were
// clocked out by executed firmware over the shared buses.

import { AVRRunner, F_CPU } from '../src/simulation/avrRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { AVR_BOARD_PROFILES } from '../src/boards/pinMaps';
import { Lcd1602Device } from '../src/simulation/devices/lcd1602';
import { Eeprom24cDevice, EEPROM_PAGE_SIZE } from '../src/simulation/devices/eeprom24c';
import { Ds3231Device } from '../src/simulation/devices/ds3231';
import { Mcp4725Device } from '../src/simulation/devices/mcp4725';
import { Sn74hc165Device } from '../src/simulation/devices/sn74hc165';
import { emptyProject } from '../src/project/templates';
import { uid, type CircuitProject } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const UNO = AVR_BOARD_PROFILES['board.arduino-uno'];

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

async function compileUno(source: string): Promise<string> {
  const res = await fetch(`${BASE}/api/compiler/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      boardId: 'board.arduino-uno',
      fqbn: 'arduino:avr:uno',
      files: [{ name: 'sketch.ino', content: source }],
    }),
  });
  const j = (await res.json()) as { success: boolean; firmware?: { data: string }; error?: string; stderr?: string };
  if (!j.success || !j.firmware) throw new Error('compile failed: ' + (j.error ?? '') + (j.stderr ?? '').slice(0, 400));
  return j.firmware.data;
}

const inst = (definitionId: string, properties: Record<string, unknown> = {}) => ({
  id: uid('i'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});
const wire = (a: { id: string }, ap: string, b: { id: string }, bp: string) => ({
  id: uid('w'), sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b.id, targetPinId: bp,
  netId: '', color: '#000', points: [], routing: 'smooth' as const,
});

function run(runner: AVRRunner, binding: CircuitBinding, ms: number) {
  const controls = emptyControls();
  const target = runner.cpu.cycles + (ms / 1000) * F_CPU;
  while (runner.cpu.cycles < target) {
    runner.runToCycles(Math.min(target, runner.cpu.cycles + F_CPU / 1000));
    binding.update(controls);
  }
}

// ======================= A. protocol unit checks =======================

// ---------- 1. LCD1602: PCF8574 expander + HD44780 controller ----------
{
  const lcd = new Lcd1602Device('lcd', 0x27);
  check(lcd.matchesAddress(0x27) && !lcd.matchesAddress(0x3f), 'LCD backpack address matching is exact');

  /** Writes a byte through the expander the way a driver library does. */
  const pulse = (value: number) => {
    lcd.start(0x27, true);
    lcd.writeByte(value | 0x04); // EN high
    lcd.writeByte(value & ~0x04); // EN falling edge latches
    lcd.stop();
  };
  const send = (byte: number, rs: number) => {
    pulse((byte & 0xf0) | rs | 0x08);
    pulse(((byte << 4) & 0xf0) | rs | 0x08);
  };

  // Before the 4-bit init dance nothing reaches the controller.
  send(0x01, 0);
  check(!lcd.isFourBitMode, 'the controller ignores 4-bit traffic before initialisation');

  pulse(0x20 | 0x08); // function set: switch to 4-bit mode
  check(lcd.isFourBitMode, 'the 0x2 function set switches the controller to 4-bit mode');
  check(lcd.isBacklit, 'the backlight bit on the expander lights the backlight');

  send(0x28, 0); // 2 lines, 5x8 font
  send(0x0c, 0); // display on, cursor off
  check(lcd.isDisplayOn, 'display-on control reaches the controller');

  send(0x01, 0); // clear
  for (const ch of 'HELLO') send(ch.charCodeAt(0), 1);
  check(lcd.row(0).startsWith('HELLO'), `characters land on line 1 ("${lcd.row(0).trim()}")`);
  check(lcd.row(1).trim() === '', 'line 2 is still blank');

  // Line 2 lives at DDRAM 0x40 — the classic gotcha.
  send(0x80 | 0x40, 0);
  for (const ch of 'WORLD') send(ch.charCodeAt(0), 1);
  check(lcd.row(1).startsWith('WORLD'), `DDRAM 0x40 addresses line 2 ("${lcd.row(1).trim()}")`);
  check(lcd.row(0).startsWith('HELLO'), 'writing line 2 leaves line 1 intact');

  // Writing past column 16 goes off-screen rather than wrapping to line 2.
  send(0x80 | 0x10, 0);
  send('X'.charCodeAt(0), 1);
  check(!lcd.row(1).includes('X'), 'a write past column 16 does not appear on line 2');

  send(0x08, 0); // display off
  check(lcd.row(0).trim() === '', 'a switched-off display shows nothing');

  const before = lcd.lines.join('');
  lcd.writeByte(0x00); // EN never pulsed
  check(lcd.lines.join('') === before, 'expander writes without an EN pulse change nothing');
}

// ---------- 2. 24C256 EEPROM: page wrap and the write cycle ----------
{
  let us = 0;
  const rom = new Eeprom24cDevice('rom', 0x50, () => us);

  const writeAt = (addr: number, bytes: number[]) => {
    rom.start(0x50, true);
    rom.writeByte((addr >> 8) & 0xff);
    rom.writeByte(addr & 0xff);
    for (const b of bytes) rom.writeByte(b);
    rom.stop();
  };
  const readAt = (addr: number, n: number) => {
    rom.start(0x50, true);
    rom.writeByte((addr >> 8) & 0xff);
    rom.writeByte(addr & 0xff);
    rom.start(0x50, false);
    const out = Array.from({ length: n }, () => rom.readByte());
    rom.stop();
    return out;
  };

  check(rom.readByteAt(0) === 0xff, 'an erased EEPROM reads back 0xFF');

  writeAt(0x0010, [0xde, 0xad, 0xbe, 0xef]);
  check(rom.busy, 'the write cycle starts as soon as STOP arrives');
  check(!rom.matchesAddress(0x50), 'a busy EEPROM NACKs its own address — this is what ACK polling detects');
  const nacks = rom.nackCount;
  check(nacks > 0, `the NACK is recorded (${nacks})`);

  us += 5000;
  check(!rom.busy && rom.matchesAddress(0x50), 'the part answers again once the write cycle completes');
  check(readAt(0x0010, 4).join(',') === '222,173,190,239', 'the written bytes read back');

  // A page write that runs past the 64-byte boundary wraps to the page start.
  const long = Array.from({ length: 8 }, (_, i) => 0xa0 + i);
  writeAt(EEPROM_PAGE_SIZE - 4, long);
  us += 5000;
  check(rom.readByteAt(EEPROM_PAGE_SIZE - 4) === 0xa0, 'the page write starts where it was addressed');
  check(rom.readByteAt(0x00) === 0xa4, `the write wraps to the start of the same page (0x${rom.readByteAt(0).toString(16)})`);
  check(rom.readByteAt(EEPROM_PAGE_SIZE) === 0xff, 'the write does not spill into the next page');

  const restored = new Eeprom24cDevice('rom2', 0x50, () => 0);
  restored.loadState(rom.saveState());
  check(restored.readByteAt(0x0010) === 0xde, 'EEPROM contents survive a save/load round trip');
}

// ---------- 3. DS3231: BCD registers that really advance ----------
{
  let us = 0;
  const rtc = new Ds3231Device('rtc', 0x68, () => us);
  const read = (reg: number, n: number) => {
    rtc.start(0x68, true);
    rtc.writeByte(reg);
    rtc.start(0x68, false);
    const out = Array.from({ length: n }, () => rtc.readByte());
    rtc.stop();
    return out;
  };
  const write = (reg: number, bytes: number[]) => {
    rtc.start(0x68, true);
    rtc.writeByte(reg);
    for (const b of bytes) rtc.writeByte(b);
    rtc.stop();
  };

  // Set 23:59:55 on 28 Feb 2028 (a leap year) in BCD.
  write(0x00, [0x55, 0x59, 0x23, 0x02, 0x28, 0x02, 0x28]);
  check(read(0x00, 1)[0] === 0x55, 'the seconds register reads back the BCD value written');

  us += 3_000_000; // three simulated seconds
  check(read(0x00, 1)[0] === 0x58, `the clock advances with simulated time (0x${read(0x00, 1)[0].toString(16)})`);

  us += 7_000_000; // roll past midnight: 23:59:55 + 10 s = 00:00:05
  const t = rtc.time;
  check(t.hour === 0 && t.minute === 0 && t.second === 5, `midnight rollover works (${t.hour}:${t.minute}:${t.second})`);
  check(t.date === 29 && t.month === 2, `29 February exists in a leap year (${t.year}-${t.month}-${t.date})`);

  // 12-hour mode puts the PM flag in bit 5 and the hours in 1..12.
  write(0x02, [0x40 | 0x20 | 0x03]); // 3 PM
  check(rtc.is12HourMode && rtc.time.hour === 15, `12-hour PM decodes to 15:00 (${rtc.time.hour})`);
  const h = read(0x02, 1)[0];
  check((h & 0x40) !== 0 && (h & 0x20) !== 0, 'the hours register reports 12-hour mode with the PM flag');

  rtc.temperatureC = 21.75;
  const [msb, lsb] = read(0x11, 2);
  check(msb === 21 && lsb >> 6 === 3, `the temperature registers report 21.75 °C (${msb} + ${lsb >> 6}/4)`);

  check(read(0x5a, 1)[0] === 0x00 && rtc.unhandledRegisters.reads.includes(0x5a), 'an unmapped register is recorded');
}

// ---------- 4. MCP4725: a DAC that drives a real voltage ----------
{
  const dac = new Mcp4725Device('dac', 0x60, 5);
  const send = (bytes: number[]) => {
    dac.start(0x60, true);
    for (const b of bytes) dac.writeByte(b);
    dac.stop();
  };

  check(dac.dacCode === 0 && dac.analogOut('vout') === 0, 'the DAC powers up at code 0');
  check(dac.analogOut('scl') === null, 'only VOUT is driven');

  send([0x0f, 0xff]); // fast mode, full scale
  check(dac.dacCode === 4095, `fast-mode write sets the code (${dac.dacCode})`);
  check(Math.abs(dac.analogOut('vout')! - 4.9988) < 0.01, `full scale is nearly the supply (${dac.analogOut('vout')?.toFixed(3)} V)`);

  send([0x40, 0x80, 0x00]); // register write, half scale
  check(dac.dacCode === 2048, `register write sets the code (${dac.dacCode})`);
  check(Math.abs(dac.analogOut('vout')! - 2.5) < 0.01, `half scale is half the supply (${dac.analogOut('vout')?.toFixed(3)} V)`);

  // Power-down disconnects the output entirely.
  send([0x40 | 0x02, 0x80, 0x00]);
  check(dac.powerDownMode === 1 && dac.analogOut('vout') === 0, 'a power-down mode stops driving the programmed voltage');
  check(dac.pullDownOhms === 1000, `the datasheet pull-down is presented (${dac.pullDownOhms} ohm)`);

  send([0x40, 0x80, 0x00]);
  check(dac.analogOut('vout')! > 2, 'clearing power-down restores the output');

  // The EEPROM form survives a power cycle; the plain form does not.
  send([0x60, 0x40, 0x00]); // store code 1024
  check(dac.storedCode === 1024, `the EEPROM form stores the code (${dac.storedCode})`);
  send([0x40, 0xff, 0xf0]);
  dac.reset();
  check(dac.dacCode === 1024, `after a reset the stored code is reloaded (${dac.dacCode})`);
}

// ---------- 5. 74HC165: parallel in, serial out ----------
{
  const sr = new Sn74hc165Device('sr');
  sr.setInputs(0b10110001);
  check(sr.shiftRegister === 0, 'inputs do not reach the register until PL is pulsed');

  sr.setParallelLoad(true);
  check(sr.shiftRegister === 0b10110001, 'holding PL low makes the register follow the inputs');
  sr.setInputs(0b11110000);
  check(sr.shiftRegister === 0b11110000, 'the parallel load is asynchronous while PL stays low');
  sr.setParallelLoad(false);
  sr.setInputs(0b00000000);
  check(sr.shiftRegister === 0b11110000, 'the value freezes when PL rises');
  check(sr.captureCount === 1, 'the capture is counted');

  check(sr.transfer(0) === 0b11110000, 'a byte clocks out MSB first');
  check(sr.transfer(0) === 0, 'a second byte reads empty with DS unwired');

  // CE high inhibits the clock entirely.
  sr.setParallelLoad(true);
  sr.setInputs(0b00001111);
  sr.setParallelLoad(false);
  sr.setClockEnable(false);
  check(sr.transfer(0) === null, 'CE high stops the register driving MISO at all');
  sr.setClockEnable(true);
  check(sr.transfer(0) === 0b00001111, 'the held value is still there once the clock is enabled');
}

// ======================= B. firmware-driven checks =======================

const I2C_PROLOGUE = `#include <Wire.h>
void setup() {
  Serial.begin(9600);
  Wire.begin();
`;

// ---------- 6. Firmware writes real text to the LCD ----------
{
  const hex = await compileUno(`${I2C_PROLOGUE}
  // Raw PCF8574 driving, so no external library is needed.
  init4bit();
  cmd(0x28); cmd(0x0C); cmd(0x01); delay(3);
  const char *msg = "CIRCUITDESK";
  for (const char *p = msg; *p; p++) data(*p);
  cmd(0x80 | 0x40);
  const char *msg2 = "LCD OK";
  for (const char *p = msg2; *p; p++) data(*p);
  Serial.println("done");
}
void expander(uint8_t v) { Wire.beginTransmission(0x27); Wire.write(v | 0x08); Wire.endTransmission(); }
void pulse(uint8_t v) { expander(v | 0x04); expander(v & ~0x04); }
void send(uint8_t b, uint8_t rs) { pulse((b & 0xF0) | rs); pulse((b << 4) | rs); }
void cmd(uint8_t b) { send(b, 0); }
void data(uint8_t b) { send(b, 1); }
void init4bit() { delay(50); pulse(0x30); delay(5); pulse(0x30); delay(1); pulse(0x30); pulse(0x20); }
void loop() {}`);
  const board = inst('board.arduino-uno');
  const lcd = inst('comp.lcd1602');
  const project: CircuitProject = {
    ...emptyProject('lcd'),
    boardInstances: [board],
    componentInstances: [lcd],
    connections: [
      wire(lcd, 'sda', board, 'A4'), wire(lcd, 'scl', board, 'A5'),
      wire(lcd, 'vcc', board, '5V'), wire(lcd, 'gnd', board, 'GND_PWR1'),
    ],
  };
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.i2cBus.attachedCount === 1, `a wired LCD attaches to the I2C bus (${runner.i2cBus.attachedCount})`);
  run(runner, binding, 500);
  const device = runner.i2cBus.deviceFor(lcd.id) as Lcd1602Device;
  check(device.isFourBitMode, 'firmware completed the 4-bit initialisation sequence');
  check(device.row(0).startsWith('CIRCUITDESK'), `firmware wrote line 1 ("${device.row(0).trim()}")`);
  check(device.row(1).startsWith('LCD OK'), `firmware wrote line 2 ("${device.row(1).trim()}")`);
  const vis = binding.update(emptyControls()).visuals.get(lcd.id);
  check(vis?.readout?.[0]?.startsWith('CIRCUITDESK') === true, 'the canvas readout shows the panel contents');
}

// ---------- 7. Firmware stores and reloads EEPROM bytes ----------
{
  const hex = await compileUno(`${I2C_PROLOGUE}
  Wire.beginTransmission(0x50);
  Wire.write((uint8_t)0x00); Wire.write((uint8_t)0x20);
  Wire.write(0x42); Wire.write(0x43);
  Serial.print("W "); Serial.println(Wire.endTransmission());

  // Immediately re-addressing the part must fail: it is still writing.
  Wire.beginTransmission(0x50);
  Serial.print("BUSY "); Serial.println(Wire.endTransmission());

  // ACK polling until the write cycle finishes.
  uint8_t tries = 0;
  while (tries < 50) { Wire.beginTransmission(0x50); if (Wire.endTransmission() == 0) break; tries++; delay(1); }
  Serial.print("POLLS "); Serial.println(tries);

  Wire.beginTransmission(0x50);
  Wire.write((uint8_t)0x00); Wire.write((uint8_t)0x20);
  Wire.endTransmission();
  Wire.requestFrom(0x50, 2);
  uint8_t a = Wire.read(), b = Wire.read();
  Serial.print("R "); Serial.print(a, HEX); Serial.print(' '); Serial.println(b, HEX);
}
void loop() {}`);
  const board = inst('board.arduino-uno');
  const rom = inst('comp.eeprom-24c');
  const project: CircuitProject = {
    ...emptyProject('rom'),
    boardInstances: [board],
    componentInstances: [rom],
    connections: [
      wire(rom, 'sda', board, 'A4'), wire(rom, 'scl', board, 'A5'),
      wire(rom, 'vcc', board, '5V'), wire(rom, 'gnd', board, 'GND_PWR1'),
    ],
  };
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, 900);
  check(/W 0\b/.test(out), `the page write was acknowledged (${out.match(/W \d/)?.[0] ?? 'none'})`);
  check(/BUSY 2\b/.test(out), `re-addressing during the write cycle genuinely fails (${out.match(/BUSY \d/)?.[0] ?? 'none'})`);
  check(/POLLS [1-9]/.test(out), `ACK polling took real time (${out.match(/POLLS \d+/)?.[0] ?? 'none'})`);
  check(/R 42 43/.test(out), `firmware read its own bytes back (${out.match(/R .*/)?.[0] ?? 'none'})`);
}

// ---------- 8. Firmware sets and reads a real clock ----------
{
  const hex = await compileUno(`${I2C_PROLOGUE}
  Wire.beginTransmission(0x68);
  Wire.write((uint8_t)0x00);
  Wire.write(0x30); Wire.write(0x45); Wire.write(0x09);   // 09:45:30
  Wire.write(0x03); Wire.write(0x15); Wire.write(0x06); Wire.write(0x26);
  Wire.endTransmission();
  print_time("T1");
  delay(2200);
  print_time("T2");
}
void print_time(const char *tag) {
  Wire.beginTransmission(0x68); Wire.write((uint8_t)0x00); Wire.endTransmission();
  Wire.requestFrom(0x68, 3);
  uint8_t s = Wire.read(), m = Wire.read(), h = Wire.read();
  Serial.print(tag); Serial.print(' ');
  Serial.print(h, HEX); Serial.print(':'); Serial.print(m, HEX); Serial.print(':'); Serial.println(s, HEX);
}
void loop() {}`);
  const board = inst('board.arduino-uno');
  const rtc = inst('comp.ds3231');
  const project: CircuitProject = {
    ...emptyProject('rtc'),
    boardInstances: [board],
    componentInstances: [rtc],
    connections: [
      wire(rtc, 'sda', board, 'A4'), wire(rtc, 'scl', board, 'A5'),
      wire(rtc, 'vcc', board, '5V'), wire(rtc, 'gnd', board, 'GND_PWR1'),
    ],
  };
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, 3500);
  check(/T1 9:45:30/.test(out), `firmware set and read back 09:45:30 (${out.match(/T1 .*/)?.[0] ?? 'none'})`);
  check(/T2 9:45:3[23]/.test(out), `the clock advanced over a real delay (${out.match(/T2 .*/)?.[0] ?? 'none'})`);
}

// ---------- 9. A DAC output really reaches an ADC input ----------
{
  const hex = await compileUno(`${I2C_PROLOGUE}
  // Half scale on the DAC, then read the voltage back through A0.
  Wire.beginTransmission(0x60);
  Wire.write(0x40); Wire.write(0x80); Wire.write(0x00);
  Wire.endTransmission();
  delay(50);
  Serial.print("ADC "); Serial.println(analogRead(A0));
  // Now full scale.
  Wire.beginTransmission(0x60);
  Wire.write(0x40); Wire.write(0xFF); Wire.write(0xF0);
  Wire.endTransmission();
  delay(50);
  Serial.print("ADC2 "); Serial.println(analogRead(A0));
}
void loop() {}`);
  const board = inst('board.arduino-uno');
  const dac = inst('comp.mcp4725');
  const project: CircuitProject = {
    ...emptyProject('dac'),
    boardInstances: [board],
    componentInstances: [dac],
    connections: [
      wire(dac, 'sda', board, 'A4'), wire(dac, 'scl', board, 'A5'),
      wire(dac, 'vcc', board, '5V'), wire(dac, 'gnd', board, 'GND_PWR1'),
      wire(dac, 'vout', board, 'A0'),
    ],
  };
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, 700);
  const half = Number(out.match(/ADC (\d+)/)?.[1] ?? '-1');
  const full = Number(out.match(/ADC2 (\d+)/)?.[1] ?? '-1');
  check(Math.abs(half - 512) < 25, `half-scale DAC output reads ~512 on the ADC (${half})`);
  check(full > 1000, `full-scale DAC output reads near 1023 on the ADC (${full})`);
  const device = runner.i2cBus.deviceFor(dac.id) as Mcp4725Device;
  check(device.dacCode === 4095, `the device model holds the last written code (${device.dacCode})`);
}

// ---------- 10. Firmware reads real button levels through a 74HC165 ----------
{
  const hex = await compileUno(`#include <SPI.h>
void setup() {
  Serial.begin(9600);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  pinMode(9, OUTPUT);
  digitalWrite(9, HIGH);
  digitalWrite(9, LOW);          // capture the parallel inputs
  digitalWrite(9, HIGH);
  uint8_t v = SPI.transfer(0);
  Serial.print("IN "); Serial.println(v, HEX);
}
void loop() {}`);
  const board = inst('board.arduino-uno');
  const sr = inst('comp.hc165');
  // D7 and D0 tied high, the rest to ground: firmware should read 0x81.
  const project: CircuitProject = {
    ...emptyProject('hc165'),
    boardInstances: [board],
    componentInstances: [sr],
    connections: [
      wire(sr, 'cp', board, 'D13'), wire(sr, 'qh', board, 'D12'),
      wire(sr, 'pl', board, 'D9'), wire(sr, 'ce', board, 'GND_PWR2'),
      wire(sr, 'vcc', board, '5V'), wire(sr, 'gnd', board, 'GND_PWR1'),
      wire(sr, 'd7', board, '5V'), wire(sr, 'd0', board, '5V'),
      wire(sr, 'd1', board, 'GND_PWR1'), wire(sr, 'd2', board, 'GND_PWR1'),
    ],
  };
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.spiBus.attachedCount === 1, `a wired 74HC165 attaches to the SPI bus (${runner.spiBus.attachedCount})`);
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, 400);
  check(/IN 81\b/i.test(out), `firmware read the real input levels 0x81 (${out.match(/IN \w+/)?.[0] ?? 'none'})`);
  const device = runner.spiBus.deviceFor(sr.id) as Sn74hc165Device;
  check(device.parallelInputs === 0x81, `the device model sees the same inputs (0x${device.parallelInputs.toString(16)})`);
  check(device.captureCount >= 1, 'the PL pulse captured the inputs');
}

// ---------- 11. Four I2C devices coexist, and wiring faults still fail ----------
{
  const hex = await compileUno(`${I2C_PROLOGUE}
  for (uint8_t a = 0x08; a < 0x78; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.print("FOUND "); Serial.println(a, HEX); }
  }
  Serial.println("scan done");
}
void loop() {}`);
  const board = inst('board.arduino-uno');
  const lcd = inst('comp.lcd1602');
  const rom = inst('comp.eeprom-24c');
  const rtc = inst('comp.ds3231');
  const dac = inst('comp.mcp4725');
  const orphan = inst('comp.bmp280'); // wired to the wrong SDA pin
  const project: CircuitProject = {
    ...emptyProject('scan'),
    boardInstances: [board],
    componentInstances: [lcd, rom, rtc, dac, orphan],
    connections: [
      ...[lcd, rom, rtc, dac].flatMap((c) => [
        wire(c, 'sda', board, 'A4'), wire(c, 'scl', board, 'A5'),
        wire(c, 'vcc', board, '5V'), wire(c, 'gnd', board, 'GND_PWR1'),
      ]),
      wire(orphan, 'sda', board, 'D7'), wire(orphan, 'scl', board, 'A5'),
      wire(orphan, 'vcc', board, '5V'), wire(orphan, 'gnd', board, 'GND_PWR1'),
    ],
  };
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.i2cBus.attachedCount === 4, `only the correctly wired devices attach (${runner.i2cBus.attachedCount})`);
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, 2500);
  for (const [label, addr] of [['LCD', '27'], ['EEPROM', '50'], ['RTC', '68'], ['DAC', '60']] as const) {
    check(new RegExp(`FOUND ${addr}`, 'i').test(out), `an I2C scan finds the ${label} at 0x${addr}`);
  }
  check(!/FOUND 76/i.test(out), 'the sensor on the wrong SDA pin is not found by the scan');
}

console.log(failures === 0 ? '\nAll device expansion checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
