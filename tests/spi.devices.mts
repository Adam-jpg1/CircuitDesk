// SPI layer suite — proves the bus and the three device models are driven by
// real firmware traffic.
//
// Part A is unit-level: the bus's chip-select routing, bit order, mode
// checking and contention handling, plus each device's command set exercised
// directly. Part B compiles raw SPI sketches through the backend and runs them
// on the AVR emulator, so every byte asserted there was clocked out by
// executed firmware.

import { AVRRunner, F_CPU } from '../src/simulation/avrRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { AVR_BOARD_PROFILES } from '../src/boards/pinMaps';
import { SpiBus, reverseBits, SPI_IDLE_BYTE } from '../src/simulation/devices/spiBus';
import { Sn74hc595Device } from '../src/simulation/devices/sn74hc595';
import { SdCardDevice, SD_BLOCK_SIZE, formattedBlock } from '../src/simulation/devices/sdCard';
import { SpiFlashDevice, FLASH_JEDEC_ID } from '../src/simulation/devices/spiFlash';
import { spiPinsFor } from '../src/simulation/avr/spiPins';
import { emptyProject } from '../src/project/templates';
import { uid, type CircuitProject } from '../src/types';
import type { SpiMode } from '../src/simulation/devices/types';

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

// ======================= A. bus unit checks =======================

// ---------- 1. Chip-select routing decides who hears the byte ----------
{
  const bus = new SpiBus();
  const a = new SpiFlashDevice('a', 'cs');
  const b = new SpiFlashDevice('b', 'cs');
  bus.sync([
    { instanceId: 'a', csPin: 10, create: () => a },
    { instanceId: 'b', csPin: 9, create: () => b },
  ]);
  check(bus.attachedCount === 2, `two devices attach to one bus (${bus.attachedCount})`);

  const ctrl = { mode: 0 as SpiMode, bitOrder: 'msbFirst' as const };
  const levels = new Map<number, 'high' | 'low' | 'input'>([[10, 'high'], [9, 'high']]);
  const read = (pin: number) => levels.get(pin);

  // Nobody selected: the bus reads back the idle (pulled-up) level.
  const idle = bus.transferByte(0x9f, ctrl, read);
  check(idle === SPI_IDLE_BYTE, `no device selected reads back 0x${idle.toString(16)} (idle bus)`);
  check(bus.unselectedByteCount === 1, `unselected bytes are counted (${bus.unselectedByteCount})`);

  // Select only device A and read its JEDEC id.
  levels.set(10, 'low');
  bus.transferByte(0x9f, ctrl, read);
  const idA = [bus.transferByte(0, ctrl, read), bus.transferByte(0, ctrl, read), bus.transferByte(0, ctrl, read)];
  check(
    idA.join(',') === FLASH_JEDEC_ID.join(','),
    `the selected device answers with its JEDEC id (${idA.map((v) => '0x' + v.toString(16)).join(' ')})`,
  );

  // Device B never saw the command because its CS stayed high.
  levels.set(10, 'high');
  levels.set(9, 'low');
  const stray = bus.transferByte(0x00, ctrl, read);
  check(stray === 0xff, `an unselected device did not advance its own state machine (${stray})`);

  // A CS pin left as an input is floating, which does not select anything.
  levels.set(9, 'input');
  bus.transferByte(0x9f, ctrl, read);
  check(bus.unselectedByteCount === 2, `a floating chip select selects nothing (${bus.unselectedByteCount})`);
}

// ---------- 2. Bit order and SPI mode ----------
{
  check(reverseBits(0b10000001) === 0b10000001, 'reverseBits is symmetric for a palindrome');
  check(reverseBits(0b11000000) === 0b00000011, 'reverseBits puts the LSB first');

  const bus = new SpiBus();
  const flash = new SpiFlashDevice('f', 'cs');
  bus.sync([{ instanceId: 'f', csPin: 10, create: () => flash }]);
  const read = () => 'low' as const;

  // LSB-first traffic reaches an MSB-first part bit-reversed, so the command
  // byte is not the one the sketch intended.
  bus.transferByte(0x9f, { mode: 0, bitOrder: 'lsbFirst' }, read);
  const lsbReply = bus.transferByte(0, { mode: 0, bitOrder: 'lsbFirst' }, read);
  check(
    lsbReply !== FLASH_JEDEC_ID[0],
    `LSB-first traffic does not read a JEDEC id from an MSB-first part (got 0x${lsbReply.toString(16)})`,
  );

  // Modes 1 and 2 sample on the wrong edge for this part.
  const before = bus.modeMismatchCount;
  bus.transferByte(0x9f, { mode: 1, bitOrder: 'msbFirst' }, read);
  const wrongMode = bus.transferByte(0x00, { mode: 2, bitOrder: 'msbFirst' }, read);
  check(bus.modeMismatchCount === before + 2, `mode mismatches are counted (${bus.modeMismatchCount - before})`);
  check(wrongMode === SPI_IDLE_BYTE, 'a device in the wrong SPI mode reads back as an idle bus');

  // Mode 3 is electrically compatible and is accepted.
  const bus3 = new SpiBus();
  const f3 = new SpiFlashDevice('f3', 'cs');
  bus3.sync([{ instanceId: 'f3', csPin: 10, create: () => f3 }]);
  bus3.transferByte(0x9f, { mode: 3, bitOrder: 'msbFirst' }, read);
  check(bus3.transferByte(0, { mode: 3, bitOrder: 'msbFirst' }, read) === FLASH_JEDEC_ID[0], 'mode 3 is accepted');
  check(bus3.modeMismatchCount === 0, 'mode 3 raises no mismatch');
}

// ---------- 3. Two devices selected at once is contention ----------
{
  const bus = new SpiBus();
  bus.sync([
    { instanceId: 'a', csPin: 10, create: () => new SpiFlashDevice('a', 'cs') },
    { instanceId: 'b', csPin: 10, create: () => new SpiFlashDevice('b', 'cs') },
  ]);
  const read = () => 'low' as const;
  bus.transferByte(0x9f, { mode: 0, bitOrder: 'msbFirst' }, read);
  bus.transferByte(0x00, { mode: 0, bitOrder: 'msbFirst' }, read);
  check(bus.contentionCount > 0, `two devices driving MISO at once is recorded as contention (${bus.contentionCount})`);
}

// ---------- 4. 74HC595 unit behaviour ----------
{
  const d = new Sn74hc595Device('hc', 5);
  check(d.csPinId === null, '74HC595 declares that it has no chip select');
  d.transfer(0b10100101);
  check(d.shiftRegister === 0b10100101, 'bytes land in the shift register');
  check(d.outputs === 0, 'outputs do not change until RCLK rises');
  d.latch();
  check(d.outputs === 0b10100101, `RCLK publishes the shift register (${d.outputs?.toString(2)})`);
  check(d.analogOut('q0') === 5 && d.analogOut('q1') === 0, 'Q0 drives 5 V, Q1 drives 0 V');
  check(d.analogOut('vcc') === null, 'non-output pins are not driven');

  d.setOutputEnable(false);
  check(d.outputs === null && d.analogOut('q0') === null, 'OE high puts the outputs in high impedance');
  d.setOutputEnable(true);
  check(d.outputs === 0b10100101, 'OE low restores the latched value');

  // SRCLR clears the shift register but not the outputs, until the next latch.
  d.clearShiftRegister();
  check(d.shiftRegister === 0 && d.outputs === 0b10100101, 'SRCLR clears the shift register only');
  d.latch();
  check(d.outputs === 0, 'the cleared value reaches the outputs on the next RCLK');
  check(d.transfer(0x55) === null, '74HC595 never drives MISO');
}

// ---------- 5. SPI flash unit behaviour ----------
{
  let us = 0;
  const f = new SpiFlashDevice('f', 'cs', () => us);
  const xfer = (bytes: number[]) => {
    f.select(true);
    const out = bytes.map((b) => f.transfer(b));
    f.select(false);
    return out;
  };

  check(xfer([0x9f, 0, 0, 0]).slice(1).join(',') === FLASH_JEDEC_ID.join(','), 'JEDEC id 0x9F reads 0xEF 0x40 0x14');
  check(xfer([0x03, 0, 0, 0, 0])[4] === 0xff, 'an erased flash reads back 0xFF');

  // A page program without write enable is refused.
  xfer([0x02, 0, 0, 0, 0x12, 0x34]);
  check(f.readByteAt(0) === 0xff, 'page program without write enable changes nothing');
  check(f.refusedWriteCount === 1, `the refused write is recorded (${f.refusedWriteCount})`);

  xfer([0x06]);
  check(f.writeEnableLatch, 'write enable sets WEL');
  xfer([0x02, 0, 0, 0, 0x12, 0x34]);
  check(f.readByteAt(0) === 0x12 && f.readByteAt(1) === 0x34, 'page program writes the bytes');
  check(!f.writeEnableLatch, 'WEL clears once the program starts');
  check(f.busy, 'BUSY is set while the program completes');
  check((f.statusRegister1 & 0x01) === 1, 'status register 1 reports BUSY');
  us += 1000; // past the 700 us typical page program time
  check(!f.busy, 'BUSY clears after the datasheet program time');

  // Programming can only clear bits.
  xfer([0x06]);
  xfer([0x02, 0, 0, 0, 0xff]);
  us += 1000;
  check(f.readByteAt(0) === 0x12, `programming cannot set bits back to 1 (0x${f.readByteAt(0).toString(16)})`);

  // Erase restores 0xFF, and needs write enable too.
  xfer([0x20, 0, 0, 0]);
  check(f.readByteAt(0) === 0x12, 'sector erase without write enable does nothing');
  xfer([0x06]);
  xfer([0x20, 0, 0, 0]);
  check(f.busy, 'sector erase sets BUSY');
  us += 50_000;
  check(!f.busy && f.readByteAt(0) === 0xff, 'sector erase restores the erased state');

  // Unknown commands are recorded rather than guessed at.
  xfer([0x77]);
  check(f.unhandledCommands.includes(0x77), 'an unsupported instruction is recorded as unhandled');

  // Page program wraps inside its 256-byte page instead of spilling over.
  xfer([0x06]);
  f.select(true);
  f.transfer(0x02);
  f.transfer(0x00);
  f.transfer(0x00);
  f.transfer(0xfe); // start 2 bytes before the page boundary
  for (let i = 0; i < 4; i++) f.transfer(0xa0 + i);
  f.select(false);
  us += 1000;
  check(
    f.readByteAt(0xfe) === 0xa0 && f.readByteAt(0xff) === 0xa1 && f.readByteAt(0x00) === 0xa2,
    'page program wraps to the start of the same page',
  );
  check(f.readByteAt(0x100) === 0xff, 'page program does not spill into the next page');

  // Sparse persistence round-trips.
  const saved = f.saveState();
  const restored = new SpiFlashDevice('f2', 'cs', () => 0);
  restored.loadState(saved);
  check(restored.readByteAt(0xfe) === 0xa0, 'flash contents survive a save/load round trip');
}

// ---------- 6. SD card unit behaviour ----------
{
  const card = new SdCardDevice('sd', 'cs');
  card.select(true);
  /** Sends a command frame and returns the first response byte with bit 7 clear. */
  const cmd = (index: number, arg = 0): number => {
    for (const b of [0x40 | index, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff, 0x95]) {
      card.transfer(b);
    }
    for (let i = 0; i < 12; i++) {
      const r = card.transfer(0xff);
      if ((r & 0x80) === 0) return r;
    }
    return 0xff;
  };
  const drain = (n: number) => Array.from({ length: n }, () => card.transfer(0xff));

  check(cmd(0) === 0x01, 'CMD0 puts the card in the idle state (R1 = 0x01)');
  check(cmd(8, 0x1aa) === 0x01, 'CMD8 answers R7 with the idle bit');
  check(drain(4)[3] === 0xaa, 'CMD8 echoes the check pattern');
  check((cmd(17, 0) & 0x01) === 0x01, 'a data command before ACMD41 is refused — card still idle');

  // ACMD41 reports busy a few times, then the card comes ready.
  let polls = 0;
  let r = 0x01;
  while (r === 0x01 && polls < 10) {
    cmd(55);
    r = cmd(41, 0x40000000);
    polls++;
  }
  check(polls > 1, `ACMD41 reports "still initialising" before coming ready (${polls} polls)`);
  check(r === 0x00 && card.isInitialised, 'the card reports ready after ACMD41 completes');
  check(cmd(16, SD_BLOCK_SIZE) === 0x00, 'CMD16 accepts a 512-byte block length');

  // Block 0 is a real FAT16 boot sector.
  check(cmd(17, 0) === 0x00, 'CMD17 is accepted once the card is initialised');
  let token = 0xff;
  for (let i = 0; i < 8 && token !== 0xfe; i++) token = card.transfer(0xff);
  check(token === 0xfe, 'CMD17 sends the 0xFE data token');
  const block0 = drain(SD_BLOCK_SIZE);
  drain(2); // CRC
  check(block0[510] === 0x55 && block0[511] === 0xaa, 'block 0 carries the 0x55AA boot signature');
  check(String.fromCharCode(...block0.slice(54, 59)) === 'FAT16', 'block 0 declares FAT16');
  check(block0[11] === 0x00 && block0[12] === 0x02, 'block 0 declares 512-byte sectors');

  // Write a block, then read it back.
  check(cmd(24, 4096 * SD_BLOCK_SIZE) === 0x00, 'CMD24 is accepted');
  card.transfer(0xff);
  card.transfer(0xfe);
  for (let i = 0; i < SD_BLOCK_SIZE; i++) card.transfer(i & 0xff);
  card.transfer(0xff);
  const dataResponse = card.transfer(0xff);
  check((dataResponse & 0x1f) === 0x05, `the card accepts the block (data response 0x${dataResponse.toString(16)})`);
  let busyBytes = 0;
  while (card.transfer(0xff) === 0x00 && busyBytes < 32) busyBytes++;
  check(busyBytes > 0, `the card holds the line busy after a write (${busyBytes} bytes)`);
  check(card.readBlock(4096)[7] === 7, 'the written block reads back with the written data');

  check(cmd(25) === 0x04 || (cmd(25) & 0x04) === 0x04, 'CMD25 (multi-block write) is answered as illegal, not faked');
  check(card.unhandledCommands.includes(25), 'the unimplemented command is recorded');

  // Persistence round trip.
  const restored = new SdCardDevice('sd2', 'cs');
  restored.loadState(card.saveState());
  check(restored.readBlock(4096)[7] === 7, 'card contents survive a save/load round trip');
  check(formattedBlock(1)[0] === 0xf8, 'an unwritten FAT sector still reads as the formatted image');
}

// ---------- 7. Board SPI pin resolution ----------
{
  const uno = spiPinsFor(AVR_BOARD_PROFILES['board.arduino-uno']);
  check(uno.sck === 13 && uno.mosi === 11 && uno.miso === 12, `Uno SPI = D13/D11/D12 (${JSON.stringify(uno)})`);
  const mega = spiPinsFor(AVR_BOARD_PROFILES['board.arduino-mega2560']);
  check(mega.sck === 52 && mega.mosi === 51 && mega.miso === 50, `Mega SPI = D52/D51/D50 (${JSON.stringify(mega)})`);
  const leo = spiPinsFor(AVR_BOARD_PROFILES['board.arduino-leonardo']);
  check(leo.sck === 15 && leo.mosi === 16 && leo.miso === 14, `Leonardo SPI = D15/D16/D14 (${JSON.stringify(leo)})`);
}

// ======================= B. firmware-driven checks =======================

/** Uno + SPI parts wired to the hardware SPI pins. */
function spiProject(parts: { def: string; cs?: string; sck?: string; mosi?: string; miso?: string; power?: boolean; oe?: 'gnd' | 'd8' | null }[]) {
  const board = inst('board.arduino-uno');
  const instances = parts.map((p) => inst(p.def));
  const connections: ReturnType<typeof wire>[] = [];
  parts.forEach((p, i) => {
    const c = instances[i];
    const isHc595 = p.def === 'comp.hc595';
    connections.push(wire(c, isHc595 ? 'srclk' : 'sck', board, p.sck ?? 'D13'));
    connections.push(wire(c, isHc595 ? 'ser' : 'mosi', board, p.mosi ?? 'D11'));
    if (!isHc595) connections.push(wire(c, 'miso', board, p.miso ?? 'D12'));
    connections.push(wire(c, 'gnd', board, 'GND_PWR1'));
    if (p.power !== false) connections.push(wire(c, 'vcc', board, '5V'));
    if (isHc595) {
      connections.push(wire(c, 'rclk', board, 'D8'));
      if (p.oe === 'gnd') connections.push(wire(c, 'oe', board, 'GND_PWR2'));
      else if (p.oe === 'd8') connections.push(wire(c, 'oe', board, 'D7'));
    } else if (p.cs !== null) {
      connections.push(wire(c, 'cs', board, p.cs ?? 'D10'));
    }
  });
  const project: CircuitProject = {
    ...emptyProject('spi'),
    boardInstances: [board],
    componentInstances: instances,
    connections,
  };
  return { project, ids: instances.map((c) => c.id) };
}

/** LED on a 74HC595 output, so a latched bit has something visible to drive. */
function hc595WithLed() {
  const board = inst('board.arduino-uno');
  const hc = inst('comp.hc595');
  const led = inst('comp.led');
  const res = inst('comp.resistor');
  const project: CircuitProject = {
    ...emptyProject('hc595'),
    boardInstances: [board],
    componentInstances: [hc, led, res],
    connections: [
      wire(hc, 'srclk', board, 'D13'),
      wire(hc, 'ser', board, 'D11'),
      wire(hc, 'rclk', board, 'D8'),
      wire(hc, 'oe', board, 'GND_PWR2'),
      wire(hc, 'vcc', board, '5V'),
      wire(hc, 'gnd', board, 'GND_PWR1'),
      wire(hc, 'q0', led, 'anode'),
      wire(led, 'cathode', res, 'p1'),
      wire(res, 'p2', board, 'GND_PWR1'),
    ],
  };
  return { project, hcId: hc.id, ledId: led.id };
}

const SPI_PROLOGUE = `#include <SPI.h>
void setup() {
  Serial.begin(9600);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
`;

// ---------- 8. Firmware shifts and latches real bits into a 74HC595 ----------
{
  const hex = await compileUno(`${SPI_PROLOGUE}
  pinMode(8, OUTPUT);
  digitalWrite(8, LOW);
  SPI.transfer(0b10110010);
  digitalWrite(8, HIGH);      // RCLK rising edge latches
  digitalWrite(8, LOW);
  Serial.println("shifted");
}
void loop() {}`);
  const { project, ids } = spiProject([{ def: 'comp.hc595', oe: 'gnd' }]);
  const hcId = ids[0];
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.spiBus.attachedCount === 1, `a correctly wired 74HC595 attaches (${runner.spiBus.attachedCount})`);
  run(runner, binding, 300);
  const d = runner.spiBus.deviceFor(hcId) as Sn74hc595Device;
  check(d.outputs === 0b10110010, `firmware shifted and latched 0b10110010 (got ${d.outputs?.toString(2)})`);
  check(d.latchCount >= 1, `the RCLK edge was seen (${d.latchCount} latch(es))`);
}

// ---------- 9. A latched bit lights a real LED ----------
{
  const hex = await compileUno(`${SPI_PROLOGUE}
  pinMode(8, OUTPUT);
  digitalWrite(8, LOW);
  SPI.transfer(0x01);         // Q0 only
  digitalWrite(8, HIGH);
  digitalWrite(8, LOW);
}
void loop() {}`);
  const { project, hcId, ledId } = hc595WithLed();
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  run(runner, binding, 300);
  const d = runner.spiBus.deviceFor(hcId) as Sn74hc595Device;
  check(d.outputHigh(0) && !d.outputHigh(1), 'Q0 is high and Q1 is low after the latch');
  const vis = binding.update(emptyControls()).visuals.get(ledId);
  check(vis?.ledOn === true, 'an LED on Q0 lights from the bit the firmware shifted');
}

// ---------- 10. Wiring faults fail honestly ----------
{
  const hex = await compileUno(`${SPI_PROLOGUE}
  pinMode(8, OUTPUT);
  SPI.transfer(0xFF);
  digitalWrite(8, HIGH);
}
void loop() {}`);
  for (const [label, part] of [
    ['SCK on the wrong pin', { def: 'comp.hc595', sck: 'D6', oe: 'gnd' as const }],
    ['MOSI on the wrong pin', { def: 'comp.hc595', mosi: 'D5', oe: 'gnd' as const }],
    ['no power to VCC', { def: 'comp.hc595', power: false, oe: 'gnd' as const }],
  ] as const) {
    const { project } = spiProject([part]);
    const runner = new AVRRunner(hex, UNO);
    const binding = new CircuitBinding(project, runner);
    run(runner, binding, 200);
    check(runner.spiBus.attachedCount === 0, `74HC595 with ${label}: not attached to the bus`);
  }

  // OE left unwired is electrically undefined, so the outputs stay disabled.
  const { project, ids: oeIds } = spiProject([{ def: 'comp.hc595', oe: null }]);
  const hcId = oeIds[0];
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  run(runner, binding, 200);
  const d = runner.spiBus.deviceFor(hcId) as Sn74hc595Device;
  check(d !== undefined && d.outputs === null, 'a 74HC595 with OE unwired keeps its outputs in high impedance');
}

// ---------- 11. Firmware reads a real JEDEC id from the SPI flash ----------
{
  const hex = await compileUno(`${SPI_PROLOGUE}
  pinMode(10, OUTPUT);
  digitalWrite(10, HIGH);
  digitalWrite(10, LOW);
  SPI.transfer(0x9F);
  uint8_t a = SPI.transfer(0), b = SPI.transfer(0), c = SPI.transfer(0);
  digitalWrite(10, HIGH);
  Serial.print("ID "); Serial.print(a, HEX); Serial.print(' '); Serial.print(b, HEX); Serial.print(' '); Serial.println(c, HEX);

  // write enable -> page program -> read back
  digitalWrite(10, LOW); SPI.transfer(0x06); digitalWrite(10, HIGH);
  digitalWrite(10, LOW);
  SPI.transfer(0x02); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0);
  SPI.transfer(0xDE); SPI.transfer(0xAD);
  digitalWrite(10, HIGH);
  delay(5);
  digitalWrite(10, LOW);
  SPI.transfer(0x03); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0);
  uint8_t r0 = SPI.transfer(0), r1 = SPI.transfer(0);
  digitalWrite(10, HIGH);
  Serial.print("MEM "); Serial.print(r0, HEX); Serial.print(' '); Serial.println(r1, HEX);
}
void loop() {}`);
  const { project, ids } = spiProject([{ def: 'comp.spi-flash' }]);
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.spiBus.attachedCount === 1, `a correctly wired SPI flash attaches (${runner.spiBus.attachedCount})`);
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, 600);
  check(/ID EF 40 14/.test(out), `firmware read the JEDEC id off the bus (${out.split('\n')[0]?.trim()})`);
  check(/MEM DE AD/.test(out), `firmware programmed and read back its own bytes (${out.match(/MEM.*/)?.[0] ?? 'none'})`);
  const flash = runner.spiBus.deviceFor(ids[0]) as SpiFlashDevice;
  check(flash.readByteAt(0) === 0xde, 'the device model holds the programmed byte');
}

// ---------- 12. Firmware initialises a real SD card ----------
{
  const hex = await compileUno(`${SPI_PROLOGUE}
  pinMode(10, OUTPUT);
  digitalWrite(10, HIGH);
  for (uint8_t i = 0; i < 10; i++) SPI.transfer(0xFF);   // 80 idle clocks
  digitalWrite(10, LOW);
  Serial.print("R0 "); Serial.println(cmd(0, 0), HEX);
  Serial.print("R8 "); Serial.println(cmd(8, 0x1AA), HEX);
  for (uint8_t i = 0; i < 4; i++) SPI.transfer(0xFF);
  uint8_t r = 1; uint8_t tries = 0;
  while (r != 0 && tries < 20) { cmd(55, 0); r = cmd(41, 0x40000000); tries++; }
  Serial.print("INIT "); Serial.print(r, HEX); Serial.print(" tries "); Serial.println(tries);
  Serial.print("R16 "); Serial.println(cmd(16, 512), HEX);
  Serial.print("R17 "); Serial.println(cmd(17, 0), HEX);
  uint8_t tok = 0xFF; for (uint8_t i = 0; i < 20 && tok != 0xFE; i++) tok = SPI.transfer(0xFF);
  Serial.print("TOKEN "); Serial.println(tok, HEX);
  uint8_t buf[512];
  for (int i = 0; i < 512; i++) buf[i] = SPI.transfer(0xFF);
  SPI.transfer(0xFF); SPI.transfer(0xFF);
  digitalWrite(10, HIGH);
  Serial.print("SIG "); Serial.print(buf[510], HEX); Serial.println(buf[511], HEX);
  Serial.print("FS "); for (int i = 54; i < 59; i++) Serial.print((char)buf[i]); Serial.println();
}
uint8_t cmd(uint8_t index, uint32_t arg) {
  SPI.transfer(0x40 | index);
  SPI.transfer(arg >> 24); SPI.transfer(arg >> 16); SPI.transfer(arg >> 8); SPI.transfer(arg);
  SPI.transfer(index == 0 ? 0x95 : 0x87);
  for (uint8_t i = 0; i < 12; i++) { uint8_t r = SPI.transfer(0xFF); if (!(r & 0x80)) return r; }
  return 0xFF;
}
void loop() {}`);
  const { project, ids } = spiProject([{ def: 'comp.sd-card' }]);
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.spiBus.attachedCount === 1, `a correctly wired SD card attaches (${runner.spiBus.attachedCount})`);
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, 1200);
  check(/R0 1\b/.test(out), `CMD0 returned the idle response to firmware (${out.match(/R0 \w+/)?.[0] ?? 'none'})`);
  check(/R8 1\b/.test(out), 'CMD8 returned R7 to firmware');
  check(/INIT 0 tries [2-9]/.test(out), `ACMD41 needed several polls before ready (${out.match(/INIT.*/)?.[0] ?? 'none'})`);
  check(/R17 0\b/.test(out), 'CMD17 was accepted after initialisation');
  check(/TOKEN FE/.test(out), 'firmware received the 0xFE data token');
  check(/SIG 55AA/.test(out), `firmware read the FAT16 boot signature (${out.match(/SIG.*/)?.[0] ?? 'none'})`);
  check(/FS FAT16/.test(out), 'firmware read the FAT16 file-system label out of the boot sector');
  const card = runner.spiBus.deviceFor(ids[0]) as SdCardDevice;
  check(card.isInitialised, 'the device model reports the card as initialised');
}

// ---------- 13. Two SPI devices share one bus on separate chip selects ----------
{
  const hex = await compileUno(`${SPI_PROLOGUE}
  pinMode(10, OUTPUT); pinMode(9, OUTPUT); pinMode(8, OUTPUT);
  digitalWrite(10, HIGH); digitalWrite(9, HIGH);

  // Talk to the flash on D10 only.
  digitalWrite(10, LOW);
  SPI.transfer(0x9F);
  uint8_t a = SPI.transfer(0);
  digitalWrite(10, HIGH);
  Serial.print("FLASH "); Serial.println(a, HEX);

  // Now the card on D9 only.
  digitalWrite(9, LOW);
  SPI.transfer(0x40); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0x95);
  uint8_t r = 0xFF;
  for (uint8_t i = 0; i < 12; i++) { uint8_t v = SPI.transfer(0xFF); if (!(v & 0x80)) { r = v; break; } }
  digitalWrite(9, HIGH);
  Serial.print("CARD "); Serial.println(r, HEX);

  // Shift a byte into the 74HC595 and latch it.
  SPI.transfer(0x81);
  digitalWrite(8, HIGH); digitalWrite(8, LOW);
}
void loop() {}`);
  const board = inst('board.arduino-uno');
  const flash = inst('comp.spi-flash');
  const card = inst('comp.sd-card');
  const hc = inst('comp.hc595');
  const project: CircuitProject = {
    ...emptyProject('shared'),
    boardInstances: [board],
    componentInstances: [flash, card, hc],
    connections: [
      wire(flash, 'sck', board, 'D13'), wire(flash, 'mosi', board, 'D11'), wire(flash, 'miso', board, 'D12'),
      wire(flash, 'cs', board, 'D10'), wire(flash, 'vcc', board, '5V'), wire(flash, 'gnd', board, 'GND_PWR1'),
      wire(card, 'sck', board, 'D13'), wire(card, 'mosi', board, 'D11'), wire(card, 'miso', board, 'D12'),
      wire(card, 'cs', board, 'D9'), wire(card, 'vcc', board, '5V'), wire(card, 'gnd', board, 'GND_PWR1'),
      wire(hc, 'srclk', board, 'D13'), wire(hc, 'ser', board, 'D11'), wire(hc, 'rclk', board, 'D8'),
      wire(hc, 'oe', board, 'GND_PWR2'), wire(hc, 'vcc', board, '5V'), wire(hc, 'gnd', board, 'GND_PWR1'),
    ],
  };
  const runner = new AVRRunner(hex, UNO);
  const binding = new CircuitBinding(project, runner);
  check(runner.spiBus.attachedCount === 3, `three devices share one bus (${runner.spiBus.attachedCount})`);
  let out = '';
  runner.onSerialByte = (b) => {
    out += String.fromCharCode(b);
  };
  run(runner, binding, 900);
  check(/FLASH EF/.test(out), `only the flash answered on D10 (${out.match(/FLASH \w+/)?.[0] ?? 'none'})`);
  check(/CARD 1\b/.test(out), `only the card answered on D9 (${out.match(/CARD \w+/)?.[0] ?? 'none'})`);
  check(runner.spiBus.contentionCount === 0, `no bus contention with separate chip selects (${runner.spiBus.contentionCount})`);
  const hcDev = runner.spiBus.deviceFor(hc.id) as Sn74hc595Device;
  check(hcDev.outputs === 0x81, `the CS-less 74HC595 latched the byte meant for it (${hcDev.outputs?.toString(16)})`);
  const flashDev = runner.spiBus.deviceFor(flash.id) as SpiFlashDevice;
  const cardDev = runner.spiBus.deviceFor(card.id) as SdCardDevice;
  check(flashDev.readByteAt(0) === 0xff, 'the flash was not modified by traffic meant for other devices');
  check(!cardDev.isInitialised, 'the card did not complete initialisation from stray traffic');
}

// ---------- 14. The SPI_STC vector is right on every supported MCU ----------
//
// The Arduino SPI library polls SPIF, so a wrong vector would stay invisible
// until a sketch enables SPIE. This dispatches a real SPI completion interrupt
// and counts how many times the handler ran: with the wrong vector the ISR is
// never entered and the count stays 0.
{
  // The Leonardo's `Serial` is USB CDC, which this simulator does not emulate,
  // so its report has to go out over the hardware UART (Serial1) instead.
  const sourceFor = (port: string) => `#include <SPI.h>
volatile uint8_t hits = 0;
ISR(SPI_STC_vect) { hits++; SPDR; }
void setup() {
  ${port}.begin(9600);
  SPI.begin();
  SPCR |= (1 << SPIE);
  sei();
  SPDR = 0x55;
  delay(20);
  ${port}.print("HITS "); ${port}.println(hits);
}
void loop() {}`;

  for (const [boardId, fqbn, label, port] of [
    ['board.arduino-uno', 'arduino:avr:uno', 'ATmega328P', 'Serial'],
    ['board.arduino-mega2560', 'arduino:avr:mega', 'ATmega2560', 'Serial'],
    ['board.arduino-leonardo', 'arduino:avr:leonardo', 'ATmega32U4', 'Serial1'],
  ] as const) {
    const source = sourceFor(port);
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardId, fqbn, files: [{ name: 'sketch.ino', content: source }] }),
    });
    const j = (await res.json()) as { success: boolean; firmware?: { data: string }; error?: string };
    if (!j.success || !j.firmware) {
      check(false, `${label}: SPI interrupt firmware failed to compile (${j.error ?? '?'})`);
      continue;
    }
    const runner = new AVRRunner(j.firmware.data, AVR_BOARD_PROFILES[boardId]);
    const binding = new CircuitBinding({ ...emptyProject('vec'), boardInstances: [], componentInstances: [], connections: [] }, runner);
    let out = '';
    runner.onSerialByte = (b) => {
      out += String.fromCharCode(b);
    };
    run(runner, binding, 400);
    const hits = Number(out.match(/HITS (\d+)/)?.[1] ?? '0');
    check(hits > 0, `${label}: the SPI_STC vector dispatches a real completion interrupt (${hits} hit(s))`);
  }
}

console.log(failures === 0 ? '\nAll SPI checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
