// The Licenses page, and the rule that CircuitDesk never rebrands other
// people's hardware.
//
// Two separate obligations meet here. The first is legal: notices that have to
// be shown must actually reach a user, and must not be a second copy that can
// drift from the file the repository maintains. The second is plain honesty:
// a board on the canvas is somebody's real product, and calling it something
// else — or implying CircuitDesk made it — misleads the person learning from
// it.

import { readFileSync, readdirSync } from 'node:fs';
import { parseNotices, CATEGORY_LABELS, INDEPENDENCE_NOTICE } from '../src/app/noticesData';
import { BOARD_DEFINITIONS, findBoardByIdOrAlias, getBoardDefinition } from '../src/boards/definitions';
import { MULTI_VENDOR_DESIGN } from '../src/boards/capabilities';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const NOTICES = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
const parsed = parseNotices(NOTICES);

// ---------- 1. the page is built from the notices file, not a copy ----------
{
  const page = readFileSync(new URL('../src/app/LicensesPage.tsx', import.meta.url), 'utf8');
  check(
    page.includes("THIRD_PARTY_NOTICES.md?raw"),
    'the page imports the notices file itself rather than restating it',
  );

  // Anything a maintainer adds to the file has to appear without a code change.
  const titles = parsed.entries.map((e) => e.title);
  check(titles.length >= 6, `every section of the file becomes an entry (${titles.length})`);
  check(
    titles.every((t) => NOTICES.includes(`## ${t}`)),
    'and every entry traces back to a heading in the file',
  );

  // Every entry lands in a group that the page renders, so none can be
  // silently dropped by not being recognised.
  const rendered = new Set(CATEGORY_LABELS.map((c) => c.key));
  check(
    parsed.entries.every((e) => rendered.has(e.category)),
    'every entry falls into a group the page displays',
  );
}

// ---------- 2. the entries that must be there ----------
{
  const titles = parsed.entries.map((e) => e.title.toLowerCase());
  const has = (needle: string) => titles.some((t) => t.includes(needle));

  check(has('avr8js'), 'avr8js is listed');
  check(has('rp2040js'), 'rp2040js is listed');
  check(has('arduino cores'), 'the Arduino board support packages are listed');
  check(has('raspberry pi boot rom'), 'the Raspberry Pi boot ROM position is stated');
  check(has('espressif rom'), 'the Espressif ROM position is stated');
  check(has('risc-v'), 'the RISC-V core is declared as original work');

  const avr8js = parsed.entries.find((e) => e.title.toLowerCase().includes('avr8js'))!;
  check(avr8js.license === 'MIT', `avr8js's licence is extracted (${avr8js.license})`);
  check(/Uri Shaked/.test(avr8js.copyright ?? ''), `and its copyright holder (${avr8js.copyright})`);
  check(avr8js.url === 'https://github.com/wokwi/avr8js', 'and its project URL');

  // The complete text has to survive, not just the summary line.
  const rp2040js = parsed.entries.find((e) => e.title === 'rp2040js')!;
  check(rp2040js.body.includes('loadBootrom()'), "an entry's full notice text is preserved verbatim");

  // Sections recording something deliberately not shipped are marked as such,
  // so they do not read as dependencies.
  const exclusions = parsed.entries.filter((e) => e.exclusion).map((e) => e.title);
  check(exclusions.length >= 2, `entries that record non-distribution are marked (${exclusions.join('; ')})`);
}

// ---------- 3. the independence statement ----------
{
  const text = INDEPENDENCE_NOTICE.join(' ');
  check(/independent simulation platform/i.test(text), 'the page states CircuitDesk is independent');
  check(/not affiliated with, sponsored by, or endorsed by/i.test(text), 'and disclaims affiliation');
  check(/identify the hardware being simulated/i.test(text), 'and explains why product names appear');
  check(/property of their respective owners/i.test(text), 'and that the marks remain their owners\'');
  check(!/must not|prohibited|shall not|violat/i.test(text), 'in factual language rather than legal threat');
}

// ---------- 4. the page belongs to home, not to the editor ----------
{
  const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  check(app.includes("route.startsWith('#/licenses')"), 'the app routes #/licenses');
  check(app.includes('<LicensesPage />'), 'to the licenses page');

  const dashboard = readFileSync(new URL('../src/dashboard/Dashboard.tsx', import.meta.url), 'utf8');
  check(dashboard.includes("navigate('#/licenses')"), 'and the home view links to it');

  // The editor's workspace tabs must not gain a licences tab: that space is
  // for the circuit, the code, the simulation and the project's own tools.
  const shell = readFileSync(new URL('../src/editor/EditorShell.tsx', import.meta.url), 'utf8');
  check(!/licen[sc]e/i.test(shell), 'and the editor shell has no licence tab of its own');
}

// ---------- 5. board names are the manufacturers' own ----------
{
  const expected: Record<string, string> = {
    'board.arduino-uno': 'Arduino Uno R3',
    'board.arduino-nano': 'Arduino Nano',
    'board.arduino-mega2560': 'Arduino Mega 2560',
    'board.arduino-leonardo': 'Arduino Leonardo',
    'board.raspberry-pi-pico': 'Raspberry Pi Pico',
    'board.raspberry-pi-pico-w': 'Raspberry Pi Pico W',
    'board.esp32-c3': 'ESP32-C3-DevKitM-1',
  };
  for (const [id, name] of Object.entries(expected)) {
    const board = getBoardDefinition(id);
    check(board?.name === name, `${id} is "${name}" (${board?.name})`);
  }
}

// ---------- 6. CircuitDesk never brands another company's hardware ----------
{
  const offenders = BOARD_DEFINITIONS.filter(
    (b) =>
      /circuitdesk/i.test(b.name) ||
      /circuitdesk/i.test(b.family) ||
      /circuitdesk/i.test(b.manufacturer ?? '') ||
      /circuitdesk/i.test(b.processor),
  );
  check(
    offenders.length === 0,
    `no board carries CircuitDesk branding (${offenders.map((b) => b.name).join(', ') || 'none'})`,
  );

  // The specific shapes that would be worst, named so a future edit trips here.
  const forbidden = /^CircuitDesk\s+(Uno|Nano|Mega|Leonardo|Pico|ESP32|Jetson|Feather|XIAO|Teensy)/i;
  check(
    !BOARD_DEFINITIONS.some((b) => forbidden.test(b.name)),
    'and none is renamed into a CircuitDesk-branded version of a real product',
  );

  // Every board says who makes it, or says plainly that many vendors do.
  const unattributed = BOARD_DEFINITIONS.filter((b) => !b.manufacturer);
  check(unattributed.length === 0, `every board names its maker (${unattributed.map((b) => b.id).join(', ') || 'all attributed'})`);
}

// ---------- 7. designs with many makers are not assigned to one company ----------
{
  const generic = ['board.esp32-devkit', 'board.esp8266-nodemcu', 'board.esp32-cam'];
  for (const id of generic) {
    const board = getBoardDefinition(id)!;
    check(
      board.manufacturer === MULTI_VENDOR_DESIGN,
      `${board.name} is not attributed to one company (${board.manufacturer})`,
    );
    check(
      typeof board.metadata.identityNote === 'string' && (board.metadata.identityNote as string).length > 40,
      `and records why (${String(board.metadata.identityNote).slice(0, 60)}…)`,
    );
  }

  // Espressif's own boards keep Espressif.
  check(getBoardDefinition('board.esp32-c3')?.manufacturer === 'Espressif', 'a genuine Espressif board says Espressif');
  check(getBoardDefinition('board.esp32-s3')?.manufacturer === 'Espressif', 'and so does the S3 DevKitC');

  // The micro:bit's brand and its maker genuinely differ.
  const microbit = getBoardDefinition('board.microbit')!;
  check(microbit.name === 'BBC micro:bit', 'the micro:bit keeps its brand name');
  check(
    microbit.manufacturer === 'Micro:bit Educational Foundation',
    `while naming its actual maker (${microbit.manufacturer})`,
  );
}

// ---------- 8. renamed boards still resolve for saved projects ----------
{
  const cases: [string, string][] = [
    ['esp32-s3 devkitc', 'board.esp32-s3'],
    ['esp32-s3-devkitc', 'board.esp32-s3'],
    ['adafruit qt py', 'board.adafruit-qtpy'],
    ['qt py', 'board.adafruit-qtpy'],
    ['seeed studio xiao', 'board.seeed-xiao'],
    ['xiao', 'board.seeed-xiao'],
    ['esp32-c3-devkitm', 'board.esp32-c3'],
    ['pico', 'board.raspberry-pi-pico'],
  ];
  for (const [legacy, id] of cases) {
    check(findBoardByIdOrAlias(legacy)?.id === id, `the earlier name "${legacy}" still resolves to ${id}`);
  }

  // Every board id itself must still resolve, since projects store ids.
  const unresolvable = BOARD_DEFINITIONS.filter((b) => findBoardByIdOrAlias(b.id)?.id !== b.id);
  check(unresolvable.length === 0, `every board id still resolves (${unresolvable.map((b) => b.id).join(', ') || 'all'})`);
}

// ---------- 9. naming work changed no capability claim ----------
{
  const simulated = BOARD_DEFINITIONS.filter((b) => b.supportLevel === 'simulated').map((b) => b.id).sort();
  check(
    JSON.stringify(simulated) ===
      JSON.stringify([
        // The SAMD21 boards, earned in tests/samd21.runtime.mts.
        'board.adafruit-feather',
        'board.adafruit-qtpy',
        // Simulated on the strength of tests/due.runtime.mts: real compiled
        // firmware on the ARMv7-M core and SAM3X model — time, analogRead,
        // digital in and out, PWM, interrupts, Servo, Serial1 and Wire.
        'board.arduino-due',
        'board.arduino-leonardo',
        'board.arduino-mega2560',
        'board.arduino-nano',
        // The three boards added because they carry a chip CircuitDesk already
        // executes. The badge is justified in tests/boards.profile.mts and
        // earned in tests/boards.sameChip.mts, which compiles and runs each of
        // them; they are listed here so that renaming or re-licensing work
        // still has to notice if it changes a capability claim.
        'board.arduino-pro-mini',
        'board.arduino-uno',
        // Simulated on the strength of tests/r4.runtime.mts: Arduino Renesas core
        // firmware on the ARMv7-M core and RA4M1 model, with Serial over a
        // simulated USB host, Serial1, PWM, interrupts, Wire, Servo, tone and EEPROM.
        'board.arduino-uno-r4',
        'board.esp32-c3',
        'board.esp32-c3-supermini',
        'board.esp32-c6-devkitc-1',
        // Simulated on the strength of tests/esp32.runtime.mts, esp32.peripherals.mts
        // and esp.adc.mts: Arduino-ESP32 firmware on the Xtensa core and ESP32 model,
        // both CPUs under ESP-IDF's FreeRTOS — Serial, time, floating point, GPIO,
        // interrupts, analogRead, PWM, tone, servos, Wire and SPI. The CAM board is
        // the same chip, run by the same engine.
        'board.esp32-cam',
        'board.esp32-devkit',
        // Simulated on the strength of tests/microbit.runtime.mts: Arduino nRF5
        // core firmware on the ARMv7-M core and nRF52833 model — Serial, time,
        // analogRead, digital in, PWM, interrupts, the LED matrix, buttons A
        // and B, and Wire on the canvas.
        'board.microbit',
        // Simulated on the strength of tests/nano33ble.runtime.mts: Arduino mbed
        // core firmware (mbed OS) on the ARMv7-M core and nRF52840 model, with
        // Serial over a simulated USB host, Serial1, analogRead, PWM,
        // interrupts, Wire and SPI.
        'board.nano-33-ble',
        'board.raspberry-pi-pico',
        'board.raspberry-pi-pico-w',
        // Simulated on the strength of tests/pi.runtime.mts and
        // tests/python.interpreter.mts: main.py run by CircuitDesk's Python
        // interpreter with RPi.GPIO and gpiozero on the header's GPIO.
        'board.rpi-zero-gpio',
        'board.rpi4-gpio',
        'board.seeed-xiao',
        'board.seeed-xiao-rp2040',
        // Simulated on the strength of tests/stm32.runtime.mts: STM32duino
        // firmware on the ARMv7-M core and STM32F401 model — time, the FPU,
        // analogRead, digital in, PWM, interrupts, Servo, tone, a second
        // UART, EEPROM in flash, and Wire and an LED on the canvas.
        'board.stm32-nucleo',
        // Simulated on the strength of tests/teensy41.runtime.mts: Teensy 4 core
        // firmware on the ARMv7-M core (as a Cortex-M7) and the i.MX RT1062
        // model, with Serial over a simulated USB host, Serial1, analogRead,
        // FlexPWM and QuadTimer PWM, interrupts, Wire and SPI.
        'board.teensy41',
      ]),
    `the set of Simulated boards is unchanged (${simulated.join(', ')})`,
  );

  // The two Espressif RISC-V boards' claims must match what is measured on
  // them: GPIO, UART0 (tests/esp.uart.mts), the ADC, and since
  // tests/esp32.peripherals.mts the LED PWM controller, Wire, SPI, interrupts
  // and EEPROM — and never the radios, which are not modelled.
  const c6 = getBoardDefinition('board.esp32-c6-devkitc-1')!;
  const c6Apis = (c6.simulation?.supportedApis ?? []).join(' ').toLowerCase();
  check(/serial \(uart0 /.test(c6Apis), 'the ESP32-C6 claims Serial as UART0, and only as UART0');
  check(c6Apis.includes('analogread'), 'the ESP32-C6 claims analogRead, which tests/esp.adc.mts reads');
  for (const claimed of ['wire', 'spi', 'analogwrite', 'attachinterrupt', 'eeprom']) {
    check(c6Apis.includes(claimed), `the ESP32-C6 claims ${claimed}, which tests/esp32.peripherals.mts measures`);
  }
  // Whole words: "ble" is inside "double".
  for (const unclaimed of ['wifi', 'wi-fi', 'bluetooth', 'ble', 'zigbee', 'thread', 'usb']) {
    check(!new RegExp(`\\b${unclaimed}\\b`).test(c6Apis), `the ESP32-C6 does not claim ${unclaimed}`);
  }
  const c6Limitation = (c6.metadata?.limitation ?? '').toLowerCase();
  for (const named of ['wi-fi', 'bluetooth', 'zigbee', 'thread', 'usb']) {
    check(c6Limitation.includes(named), `and its limitation note names ${named} as unsupported`);
  }

  const c3 = getBoardDefinition('board.esp32-c3')!;
  const apis = (c3.simulation?.supportedApis ?? []).join(' ').toLowerCase();
  check(/serial \(uart0 /.test(apis), 'the ESP32-C3 claims Serial as UART0, and only as UART0');
  check(apis.includes('analogread'), 'the ESP32-C3 claims analogRead, which tests/esp.adc.mts reads');
  for (const unclaimed of ['wifi', 'wi-fi', 'bluetooth', 'ble']) {
    check(!new RegExp(`\\b${unclaimed}\\b`).test(apis), `the ESP32-C3 still does not claim ${unclaimed}`);
  }
  check(apis.includes('digitalwrite') && apis.includes('digitalread'), 'while keeping the claims it earned');
}

// ---------- 10. board artwork does not brand other people's hardware ----------
//
// The registry can say "Arduino Uno R3" while the silkscreen drawn on the
// canvas still says something else, and the silkscreen is what a learner
// actually looks at. This reads the artwork source directly, because that is
// where the label lives.
{
  const artworkDir = new URL('../src/boards/artwork/', import.meta.url);
  const files = readdirSync(artworkDir).filter((f) => f.endsWith('.tsx'));
  check(files.length > 0, `board artwork files were found (${files.length})`);

  const branded: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, artworkDir), 'utf8');
    // Only the rendered text matters, so comments are stripped first —
    // explaining the rule in a comment must not trip the rule.
    const rendered = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/circuit\s*desk/i.test(rendered)) branded.push(file);
  }
  check(branded.length === 0, `no board artwork carries CircuitDesk branding (${branded.join(', ') || 'none'})`);

  // The three Arduino boards that had it, named individually so a regression
  // on any one of them is unmistakable.
  const expectSilkscreen: [string, string][] = [
    ['UnoArtwork.tsx', 'ARDUINO UNO R3'],
    ['MegaArtwork.tsx', 'ARDUINO MEGA 2560'],
    ['LeonardoArtwork.tsx', 'ARDUINO LEONARDO'],
  ];
  for (const [file, silkscreen] of expectSilkscreen) {
    const source = readFileSync(new URL(file, artworkDir), 'utf8');
    const rendered = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(rendered.includes(silkscreen), `${file} silkscreens "${silkscreen}"`);
    check(!/CIRCUITDESK\s+(UNO|MEGA|LEONARDO)/i.test(rendered), `${file} no longer silkscreens a CircuitDesk name`);
  }
}

// ---------- 11. no user-visible surface calls a real product a clone ----------
{
  for (const [id, name] of [
    ['board.arduino-uno', 'Arduino Uno R3'],
    ['board.arduino-nano', 'Arduino Nano'],
  ] as const) {
    const board = getBoardDefinition(id)!;
    const text = `${board.name} ${board.description ?? ''}`;
    check(!/-compatible/i.test(text), `${name} is not described as merely compatible with itself`);
    check(!/circuit\s*desk/i.test(text), `and ${name}'s description carries no CircuitDesk branding`);
  }
}

console.log(failures === 0 ? '\nHome licensing and naming checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
