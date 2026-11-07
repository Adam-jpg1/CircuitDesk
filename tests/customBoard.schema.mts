// A board file is untrusted input, and this is what stops it being a payload.
//
// A .cdboard.json arrives from another person. It can be malformed by accident,
// oversized by accident, or hostile on purpose, and the difference is not
// something the app can tell from the outside — so it is treated as hostile and
// checked field by field.
//
// Three groups of claim, and the third is the one that matters most:
//
//   1. a well-formed board is accepted and produces exactly the board it
//      describes — including the part that makes this feature worth having: the
//      canvas shows the board's own pin names and the runtime sees the pads;
//   2. an impossible board is refused with a message that names the pin and the
//      reason, because "Invalid board" helps nobody;
//   3. a hostile board cannot execute anything, reach anything, or grow without
//      bound. There is deliberately no field in the schema that can name a
//      program, a path or a build target of the file's choosing, and the tests
//      here try to use one anyway.

import { validateCustomBoard, isError } from '../src/custom-boards/validate';
import { resolveCustomBoard, capabilitySummary, describeLimits } from '../src/custom-boards/resolve';
import { CUSTOM_BOARD_LIMITS, CUSTOM_BOARD_SCHEMA_VERSION } from '../src/custom-boards/schema';
import { looksHostile } from '../src/custom-boards/svgSanitize';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

/** A board that is right, used as the base for every "one thing wrong" case. */
function goodBoard(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: 'custom.lab-board',
    revision: 1,
    identity: { name: 'RP2040 Lab Board', creator: 'A. Maker', description: 'A test rig.' },
    outline: { widthMm: 40, heightMm: 60, color: '#204060' },
    pins: [
      { id: 'VSYS', label: 'VSYS', pad: null, xMm: 2, yMm: 4, type: 'power-5v', capabilities: [] },
      { id: 'GND', label: 'GND', pad: null, xMm: 2, yMm: 10, type: 'ground', capabilities: [] },
      { id: 'STATUS_LED', label: 'STATUS', pad: 'GP15', xMm: 2, yMm: 16, type: 'digital', capabilities: [] },
      { id: 'BUTTON', label: 'BTN', pad: 'GP16', xMm: 2, yMm: 22, type: 'digital', capabilities: [] },
      { id: 'SENSOR_SDA', label: 'SDA', pad: 'GP4', xMm: 38, yMm: 16, type: 'digital', capabilities: [] },
      { id: 'SENSOR_SCL', label: 'SCL', pad: 'GP5', xMm: 38, yMm: 22, type: 'digital', capabilities: [] },
      { id: 'LIGHT', label: 'LIGHT', pad: 'GP26', xMm: 38, yMm: 28, type: 'analog', capabilities: [] },
    ],
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
    ...overrides,
  };
}

/** Errors only, which is what decides whether a board is accepted. */
const errorsOf = (raw: unknown) => validateCustomBoard(raw).problems.filter(isError);

// ================================================ 1. a good board is a board =
section('1. a well-formed board becomes a board');
{
  const { problems, board } = validateCustomBoard(goodBoard());
  check(problems.filter(isError).length === 0, `it is accepted${problems.filter(isError).map((p) => ` — ${p.message}`).join('')}`);
  check(board !== undefined, 'and a normalised definition comes back');
  if (!board) throw new Error('cannot continue without a board');

  const { board: resolved, padMap } = resolveCustomBoard(board);
  check(resolved.id === 'custom.lab-board', 'the resolved board keeps its own id');
  check(resolved.name === 'RP2040 Lab Board', 'and its own name');
  check(resolved.isBoard === true, 'and is a board as far as everything downstream is concerned');
  check(resolved.processor === 'RP2040', `whose processor is the chip, not a product (${resolved.processor})`);
  check(!JSON.stringify(resolved).includes('Raspberry Pi Pico'), 'and nothing about it claims to be a Pico');

  // The two identities, which is the whole point of the pin map.
  check(padMap.STATUS_LED === 'GP15', 'the pad map takes STATUS_LED to GP15');
  const status = resolved.pins.find((p) => p.id === 'STATUS_LED');
  check(status?.label === 'STATUS', 'the canvas shows the board\'s own label');
  check(status?.aliases?.includes('GP15') === true, 'and the pin also answers to the pad name');

  // Capabilities are derived from the pad, not from what the file claimed.
  const sda = resolved.pins.find((p) => p.id === 'SENSOR_SDA');
  check(sda?.capabilities.includes('i2c-sda') === true, 'SENSOR_SDA is an I2C SDA pin because GP4 is one');
  const light = resolved.pins.find((p) => p.id === 'LIGHT');
  check(light?.capabilities.includes('analog-in') === true, 'LIGHT is an analog input because GP26 is an ADC pad');
  check(status?.capabilities.includes('pwm') === true, 'STATUS_LED can PWM because every RP2040 GPIO can');

  check(resolved.compiler?.supported === true, 'it compiles');
  check(resolved.compiler?.fqbn === 'rp2040:rp2040:rpipico', `against the RP2040 target (${resolved.compiler?.fqbn})`);
  check(resolved.simulation?.supported === true, 'and runs');
  check(resolved.simulation?.engine === 'rp2040js', `on the RP2040 engine (${resolved.simulation?.engine})`);
  check(resolved.supportLevel === 'simulated', `so it is badged Simulated (${resolved.supportLevel})`);
}

// ============================== 2. capability is inherited, never declared ===
section('2. a board cannot declare itself simulated');
{
  // A custom C6 board inherits exactly the C6 runtime's capability — GPIO,
  // Serial on UART0 and the ADC — and cannot gain PWM by asking.
  const c6 = goodBoard({
    id: 'custom.c6-board',
    processorProfileId: 'proc.esp32c6',
    compileProfileId: 'compile.esp32c6-arduino',
    runtimeProfileId: 'runtime.esp32c6',
    pins: [
      { id: 'V3', label: '3V3', pad: null, xMm: 2, yMm: 4, type: 'power-3v3', capabilities: [] },
      { id: 'GND', label: 'GND', pad: null, xMm: 2, yMm: 10, type: 'ground', capabilities: [] },
      { id: 'LED', label: 'LED', pad: 'IO8', xMm: 2, yMm: 16, type: 'digital', capabilities: [] },
    ],
  });
  const { board } = validateCustomBoard(c6);
  check(board !== undefined, 'a custom C6 board is accepted');
  if (board) {
    const summary = capabilitySummary(board);
    check(summary.supportLevel === 'simulated', 'it is simulated, with the C6\'s own narrow capability');
    check(
      ['analogwrite', 'wire', 'spi'].every((api) => summary.supported.some((s) => s.toLowerCase().includes(api))),
      `and claims analogWrite, Wire and SPI, which the C6 runtime now runs (${summary.supported.join(', ')})`,
    );
    check(
      summary.notSimulated.some((n) => /Wi-Fi/i.test(n)),
      'and says the radios are not modelled, exactly as the native C6 does',
    );
    check(/Not modelled/.test(describeLimits(board)), 'the limitation sentence comes from the processor');
  }

  // An "analog" pin on a pad with no ADC channel is refused rather than
  // silently becoming a digital pin. The C6's ADC is on IO0-IO6; IO8 has none.
  const analogOnC6 = goodBoard({
    id: 'custom.c6-analog',
    processorProfileId: 'proc.esp32c6',
    compileProfileId: 'compile.esp32c6-arduino',
    runtimeProfileId: 'runtime.esp32c6',
    pins: [{ id: 'AIN', label: 'AIN', pad: 'IO8', xMm: 2, yMm: 4, type: 'analog', capabilities: [] }],
  });
  const errors = errorsOf(analogOnC6);
  check(errors.some((e) => e.code === 'pad-has-no-adc'), 'an analog pin on a pad with no ADC channel is refused');
  check(
    errors.some((e) => /ESP32-C6/.test(e.message) && /IO0, IO1/.test(e.message)),
    `and the message names the chip and the pads that are ADC inputs (${errors.find((e) => e.code === 'pad-has-no-adc')?.message ?? ''})`,
  );
}

// ================================ 3. wiring-only is a real, supported answer =
section('3. a board with no processor is still a board');
{
  const wiringOnly = goodBoard({
    id: 'custom.stm32-thing',
    processorProfileId: null,
    compileProfileId: 'compile.none',
    runtimeProfileId: 'runtime.none',
  });
  const { problems, board } = validateCustomBoard(wiringOnly);
  check(problems.filter(isError).length === 0, 'it is accepted');
  if (board) {
    const { board: resolved } = resolveCustomBoard(board);
    check(resolved.supportLevel === 'wiring', `and badged wiring-only (${resolved.supportLevel})`);
    check(resolved.compiler?.supported === false, 'nothing is compiled for it');
    check(resolved.simulation?.supported === false, 'and nothing is executed');
    check(
      /no processor/i.test(String(resolved.compiler?.note)),
      `with a note that says why (${resolved.compiler?.note})`,
    );
  }

  // The dangerous combination: no processor, but a real toolchain selected.
  const contradiction = goodBoard({ processorProfileId: null, runtimeProfileId: 'runtime.none' });
  check(
    errorsOf(contradiction).some((e) => e.code === 'no-processor-but-compiles'),
    'a board with no processor may not select a toolchain',
  );
}

// ============================================= 4. impossible pin mappings ====
section('4. a pin cannot map to a pad that is not there');
{
  const offPad = goodBoard({
    pins: [{ id: 'SDA', label: 'SDA', pad: 'GP31', xMm: 2, yMm: 4, type: 'digital', capabilities: [] }],
  });
  const error = errorsOf(offPad).find((e) => e.code === 'pad-not-on-processor');
  check(error !== undefined, 'GP31 on an RP2040 is refused');
  check(
    Boolean(error && /SDA/.test(error.message) && /GP31/.test(error.message) && /GP0-GP29/.test(error.message)),
    `and the message names the pin, the pad and the range ("${error?.message ?? ''}")`,
  );

  const powerOnGpio = goodBoard({
    pins: [{ id: 'V5', label: '5V', pad: 'GP2', xMm: 2, yMm: 4, type: 'power-5v', capabilities: [] }],
  });
  check(
    errorsOf(powerOnGpio).some((e) => e.code === 'power-pin-mapped'),
    'a power pin may not map to a GPIO pad',
  );

  const duplicate = goodBoard({
    pins: [
      { id: 'A', label: 'A', pad: 'GP2', xMm: 2, yMm: 4, type: 'digital', capabilities: [] },
      { id: 'A', label: 'B', pad: 'GP3', xMm: 2, yMm: 8, type: 'digital', capabilities: [] },
    ],
  });
  check(errorsOf(duplicate).some((e) => e.code === 'duplicate-pin-id'), 'two pins may not share an id');

  const shared = goodBoard({
    pins: [
      { id: 'A', label: 'A', pad: 'GP2', xMm: 2, yMm: 4, type: 'digital', capabilities: [] },
      { id: 'B', label: 'B', pad: 'GP2', xMm: 2, yMm: 8, type: 'digital', capabilities: [] },
    ],
  });
  const sharedProblems = validateCustomBoard(shared).problems;
  check(sharedProblems.filter(isError).length === 0, 'two pins MAY share a pad — a header and a test point often do');
  check(
    sharedProblems.some((p) => p.code === 'pad-shared' && p.severity === 'warning'),
    'but it is warned about, because the usual cause is an import mistake',
  );

  // PD2 is a plain GPIO on the ATmega328P: no timer output reaches it.
  const pwmClaim = goodBoard({
    processorProfileId: 'proc.atmega328p',
    compileProfileId: 'compile.avr-arduino',
    runtimeProfileId: 'runtime.avr8js-328p',
    pins: [{ id: 'M', label: 'M', pad: 'PD2', xMm: 2, yMm: 4, type: 'digital', capabilities: ['pwm'] }],
  });
  check(errorsOf(pwmClaim).some((e) => e.code === 'pad-has-no-pwm'), 'a PWM claim on a pad with no modelled PWM is refused');
}

// ========================================== 5. bus assignment is checked =====
section('5. a bus signal must be on a pad that can carry it');
{
  const wrongBus = goodBoard({
    peripherals: [{ kind: 'i2c', controller: 'i2c0', pins: { sda: 'STATUS_LED', scl: 'SENSOR_SCL' } }],
  });
  const error = errorsOf(wrongBus).find((e) => e.code === 'signal-pad-not-allowed');
  check(error !== undefined, 'assigning I2C0 SDA to a pad that cannot be SDA is refused');
  check(
    Boolean(error && /STATUS/.test(error.message) && /GP15/.test(error.message)),
    `and names the board's pin and the pad it maps to ("${error?.message ?? ''}")`,
  );

  const rightBus = goodBoard({
    peripherals: [{ kind: 'i2c', controller: 'i2c0', pins: { sda: 'SENSOR_SDA', scl: 'SENSOR_SCL' } }],
  });
  check(errorsOf(rightBus).length === 0, 'and the correct assignment is accepted');

  const noSuchController = goodBoard({
    peripherals: [{ kind: 'i2c', controller: 'i2c9', pins: { sda: 'SENSOR_SDA' } }],
  });
  check(
    errorsOf(noSuchController).some((e) => e.code === 'unknown-controller'),
    'a controller the chip does not have is refused',
  );
}

// ================================================= 6. hostile input =========
section('6. a board file cannot execute, reach or exhaust anything');
{
  // There is no field in the schema that names a program. A file that invents
  // one has it ignored, and nothing in the resolved board carries it.
  const withCommand = goodBoard({
    compileCommand: 'rm -rf /',
    toolchainPath: '/usr/bin/evil',
    metadata: { note: 'harmless' },
  });
  const { board } = validateCustomBoard(withCommand);
  check(board !== undefined, 'a file with invented fields still validates on the fields that exist');
  if (board) {
    const json = JSON.stringify(resolveCustomBoard(board).board);
    check(!json.includes('rm -rf'), 'and the invented command does not survive into the board');
    check(!json.includes('/usr/bin/evil'), 'nor the invented path');
  }

  // The FQBN is the one field that reaches the compiler, so it is bounded to
  // targets the chosen pipeline declares.
  const arbitraryTarget = goodBoard({ fqbnOverride: 'attacker:core:whatever' });
  const fqbnError = errorsOf(arbitraryTarget).find((e) => e.code === 'fqbn-not-in-profile');
  check(fqbnError !== undefined, 'a board may not name an arbitrary build target');
  check(
    Boolean(fqbnError && /That profile builds: /.test(fqbnError.message)),
    `and is told what the pipeline does build (${fqbnError?.message})`,
  );

  // Sizes.
  const tooManyPins = goodBoard({
    pins: Array.from({ length: CUSTOM_BOARD_LIMITS.maxPins + 50 }, (_, i) => ({
      id: `P${i}`, label: `P${i}`, pad: null, xMm: 1, yMm: 1, type: 'digital', capabilities: [],
    })),
  });
  check(errorsOf(tooManyPins).some((e) => e.code === 'too-many-pins'), 'a board with too many pins is refused');

  const hugeName = goodBoard({ identity: { name: 'x'.repeat(5000) } });
  check(errorsOf(hugeName).some((e) => e.code === 'too-long'), 'an oversized name is refused');

  const hugeArt = goodBoard({ outline: { widthMm: 40, heightMm: 60, artworkSvg: 'x'.repeat(2_000_000) } });
  check(errorsOf(hugeArt).some((e) => e.code === 'artwork-too-large'), 'oversized artwork is refused');

  const hugeBoard = goodBoard({ outline: { widthMm: 100000, heightMm: 5 } });
  check(errorsOf(hugeBoard).some((e) => e.code === 'out-of-range'), 'an absurdly large outline is refused');

  // Ids end up in DOM keys and cache keys.
  for (const [bad, why] of [
    ['custom.<script>', 'markup in an id'],
    ['custom../../etc/passwd', 'a path traversal in an id'],
    ['notcustom.board', 'an id that could collide with a built-in board'],
  ] as const) {
    check(errorsOf(goodBoard({ id: bad })).length > 0, `${why} is refused`);
  }
  check(
    errorsOf(goodBoard({ pins: [{ id: 'a b', label: 'x', pad: null, xMm: 1, yMm: 1, type: 'digital', capabilities: [] }] }))
      .some((e) => e.code === 'bad-pin-id'),
    'and a pin id with a space in it',
  );

  const controlChars = goodBoard({ identity: { name: `Board\u0000\u001bname` } });
  check(errorsOf(controlChars).some((e) => e.code === 'control-characters'), 'control characters in text are refused');

  // Metadata is bounded strings and is never interpreted.
  check(
    errorsOf(goodBoard({ metadata: { x: { nested: 'object' } } })).some((e) => e.code === 'bad-metadata'),
    'metadata may not hold structures',
  );
}

// ==================================================== 7. hostile artwork ====
section('7. artwork that carries code is recognised as such');
{
  const cases: [string, string][] = [
    ['<svg><script>fetch("//evil")</script></svg>', 'a <script> element'],
    ['<svg><rect onload="alert(1)" /></svg>', 'an event handler'],
    ['<svg><foreignObject><body>hi</body></foreignObject></svg>', 'a <foreignObject>'],
    ['<svg><a href="javascript:alert(1)"><rect/></a></svg>', 'a javascript: URL'],
    ['<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>', 'an external entity'],
  ];
  for (const [svg, what] of cases) {
    check(looksHostile(svg) !== null, `${what} is recognised`);
  }
  check(looksHostile('<svg><rect width="10" height="10" fill="#123456"/></svg>') === null, 'and an ordinary drawing is not');
}

console.log(
  failures === 0
    ? '\nCustom board schema checks passed.'
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
