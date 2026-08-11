// The ESP32-C6-DevKitC-1 board definition.
//
// The pinout comes from Espressif's own user guide for this board, not from
// the Arduino core's generic C6 variant — the core carries the chip's pin
// capabilities but not this board's header arrangement, and the difference is
// exactly the kind of thing that gets invented when nobody checks.
//
// It cross-checks against independent sources where it can: the Arduino
// variant's own defaults name TX, RX, the I2C and SPI pins and the RGB LED,
// and the SoC headers say how many GPIOs and ADC channels exist. Agreement
// between the board document and the chip headers is what makes this
// trustworthy rather than merely written down.

import { getBoardDefinition, findBoardByIdOrAlias, BOARD_DEFINITIONS } from '../src/boards/definitions';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const board = getBoardDefinition('board.esp32-c6-devkitc-1');
if (!board) {
  console.log('FAIL: the ESP32-C6-DevKitC-1 is missing');
  process.exit(1);
}

// ---------- 1. identity ----------
{
  check(board.name === 'ESP32-C6-DevKitC-1', `it carries its official product name (${board.name})`);
  check(board.manufacturer === 'Espressif', `made by Espressif (${board.manufacturer})`);
  check(!/circuit\s*desk/i.test(`${board.name} ${board.family} ${board.description ?? ''}`), 'with no CircuitDesk branding');
  check(!/dev board|devkit c|c6 devkit\b/i.test(board.name), 'and no invented generic name');
  check(/ESP32-C6/.test(board.processor), `the processor names the part (${board.processor})`);
  check(/WROOM-1/.test(board.description ?? ''), 'the description names the module it carries');
  check(/8 MB/.test(board.description ?? ''), 'and its 8 MB flash, which is the board\'s not the toolchain default');
}

// ---------- 2. the GPIOs the board actually brings out ----------
{
  const io = board.pins.filter((p) => /^IO\d+$/.test(p.id)).map((p) => p.id);
  const expected = [
    'IO0', 'IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6', 'IO7', 'IO8', 'IO9',
    'IO10', 'IO11', 'IO12', 'IO13', 'IO15', 'IO16', 'IO17', 'IO18', 'IO19',
    'IO20', 'IO21', 'IO22', 'IO23',
  ];
  check(
    JSON.stringify([...io].sort()) === JSON.stringify([...expected].sort()),
    `the exposed GPIOs are exactly the ones on the headers (${io.length} of ${expected.length})`,
  );

  // The chip has 31 GPIOs; this board does not bring them all out, and the
  // ones it does not must not be invented.
  for (const absent of ['IO14', 'IO24', 'IO25', 'IO26', 'IO27', 'IO28', 'IO29', 'IO30']) {
    check(!io.includes(absent), `${absent} is not on the headers and is not listed`);
  }
  // Nor may a GPIO the chip does not have appear.
  check(!io.some((id) => Number(id.slice(2)) > 30), 'no GPIO above the chip\'s highest exists');
}

// ---------- 3. agreement with the Arduino variant's own defaults ----------
//
// pins_arduino.h for the esp32c6 variant names these. If the board document
// and the core disagreed, one of them would be wrong.
{
  const byId = new Map(board.pins.map((p) => [p.id, p]));
  check(byId.get('IO16')?.label === 'TX', 'GPIO16 is the pad the board silkscreens TX, as the core defines');
  check(byId.get('IO17')?.label === 'RX', 'and GPIO17 is RX');
  check(byId.get('IO16')?.capabilities.includes('uart-tx'), 'TX carries the UART capability');
  check(byId.get('IO17')?.capabilities.includes('uart-rx'), 'and RX likewise');

  for (const id of ['IO18', 'IO19', 'IO20', 'IO21', 'IO22', 'IO23']) {
    check(byId.has(id), `${id} is present, which the core uses for SPI or I2C`);
  }
  check(/RGB LED/i.test(byId.get('IO8')?.description ?? ''), 'GPIO8 is annotated as the RGB LED, as the core defines');
}

// ---------- 4. ADC and strapping pins ----------
{
  const byId = new Map(board.pins.map((p) => [p.id, p]));
  // ADC1 reaches GPIO0-GPIO6, which is seven channels — the number the SoC
  // headers give.
  const analog = ['IO0', 'IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6'];
  for (const id of analog) {
    check(byId.get(id)?.capabilities.includes('analog-in'), `${id} is ADC-capable`);
  }
  check(
    !byId.get('IO7')?.capabilities.includes('analog-in'),
    'and GPIO7, which is past the last ADC channel, is not',
  );

  // Strapping pins are annotated so a learner is not surprised by a board that
  // will not boot because of what they wired.
  for (const id of ['IO4', 'IO5', 'IO8', 'IO9', 'IO15']) {
    check(/strapping/i.test(byId.get(id)?.description ?? ''), `${id} is annotated as a strapping pin`);
  }
  check(/USB D\+/.test(byId.get('IO13')?.description ?? ''), 'GPIO13 is annotated as native USB D+');
  check(/USB D-/.test(byId.get('IO12')?.description ?? ''), 'and GPIO12 as D-');
}

// ---------- 5. power, ground and the headers ----------
{
  const kinds = (type: string) => board.pins.filter((p) => p.type === type).map((p) => p.id);
  check(kinds('ground').length >= 4, `the board's grounds are present (${kinds('ground').join(' ')})`);
  check(kinds('power-3v3').length >= 1, 'the 3V3 rail is present');
  check(kinds('power-5v').length >= 1, 'and the 5V rail');
  check(board.pins.some((p) => p.type === 'reset'), 'as is the reset pin');
}

// ---------- 6. it claims a runtime, and only the runtime it has ----------
//
// This section used to assert the opposite, because the runtime did not exist.
// It does now — real firmware reaches setup() and loop(), GPIO works in both
// directions, and the board talks to a Pico over a shared net — so the badge is
// earned. What has to stay true is that the claim is no wider than the runtime.
{
  check(board.compiler?.supported === true, 'the board compiles for the real target');
  check(board.compiler?.fqbn === 'esp32:esp32:esp32c6', `through the C6 target (${board.compiler?.fqbn})`);
  check(board.simulation?.supported === true, 'and executes that firmware');
  check(board.simulation?.engine === 'esp32c6', `on its own engine (${board.simulation?.engine})`);
  check(board.supportLevel === 'simulated', `so its badge is Simulated (${board.supportLevel})`);

  // Narrow and truthful. Everything absent here is absent from the runtime.
  const apis = (board.simulation?.supportedApis ?? []).join(' ').toLowerCase();
  for (const claim of ['pinmode', 'digitalwrite', 'digitalread', 'delay', 'setup']) {
    check(apis.includes(claim), `the API list names ${claim}, which really works`);
  }
  for (const absent of ['wifi', 'bluetooth', 'ble', 'zigbee', 'thread', 'usb', 'uart', 'serial', 'adc', 'analogread', 'pwm', 'analogwrite', 'i2c', 'wire', 'spi']) {
    check(!apis.includes(absent), `and does not name ${absent}, which does not`);
  }
  const limitationText = (board.metadata?.limitation ?? '').toLowerCase();
  for (const named of ['wi-fi', 'bluetooth', 'zigbee', 'thread', 'usb', 'adc', 'pwm', 'i2c', 'spi', 'uart']) {
    check(limitationText.includes(named), `and the limitation note says ${named} is not simulated`);
  }

  const limitation = String(board.metadata.limitation ?? '');
  for (const feature of ['Wi-Fi', 'Bluetooth', 'Zigbee', 'Thread']) {
    check(limitation.includes(feature), `${feature} is named as not simulated`);
  }
}

// ---------- 7. it does not disturb anything else ----------
{
  check(findBoardByIdOrAlias('esp32-c6')?.id === 'board.esp32-c6-devkitc-1', 'a short alias resolves to it');
  // The C3 must not be shadowed by the newcomer's aliases.
  check(findBoardByIdOrAlias('esp32c3')?.id === 'board.esp32-c3', 'and the ESP32-C3 still resolves to itself');
  check(findBoardByIdOrAlias('esp32-c3-devkitm-1')?.id === 'board.esp32-c3', 'by its own names too');

  const ids = BOARD_DEFINITIONS.map((b) => b.id);
  check(new Set(ids).size === ids.length, 'no board id is duplicated');
  const simulated = BOARD_DEFINITIONS.filter((b) => b.supportLevel === 'simulated').map((b) => b.id);
  check(simulated.includes('board.esp32-c6-devkitc-1'), 'the C6 is among the Simulated boards');
  check(simulated.includes('board.esp32-c3'), 'and has not displaced the C3');
  check(simulated.length === 8, `and the Simulated set has grown by exactly one, to ${simulated.length}`);
}

console.log(failures === 0 ? '\nESP32-C6 board checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
