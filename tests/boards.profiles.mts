// Processor, compile and runtime profiles — three things, kept apart.
//
// The reason they are separate is a product one: a user should not have to wait
// for CircuitDesk to add their board. A board carrying an RP2040 should be able
// to use the RP2040 toolchain and the RP2040 emulator without pretending to be
// a Raspberry Pi Pico, and that is only possible if "which chip", "how it is
// compiled" and "what executes it" are three answers rather than one.
//
// So this file holds the profile system to four rules:
//
//   1. every board CircuitDesk runs names all three, and they agree with each
//      other and with what the board already claimed;
//   2. no profile names a board — the moment one does, custom boards are back
//      to borrowing an identity;
//   3. a profile does not claim a peripheral its runtime does not model;
//   4. incompatible combinations are refused with both halves named, before an
//      emulator is asked to run something it cannot.

import { BOARD_DEFINITIONS } from '../src/boards/definitions';
import {
  PROCESSOR_PROFILES, processorProfile, hasPad, padRoles,
} from '../src/boards/processorProfiles';
import {
  COMPILE_PROFILES, RUNTIME_PROFILES, compileProfile, runtimeProfile,
  compileProfilesFor, runtimeProfilesFor, checkPipeline,
} from '../src/boards/pipelineProfiles';
import { getSimulatorAdapter, runnableProcessorProfileIds } from '../src/simulation/adapters';
import { avrProfileForProcessor } from '../src/boards/pinMaps';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

// =================================== 1. every runnable board names all three =
section('1. the boards that run name a chip, a toolchain and an emulator');
{
  const runnable = BOARD_DEFINITIONS.filter((b) => b.simulation?.supported);
  check(runnable.length > 0, `there are boards that run (${runnable.length})`);
  for (const board of runnable) {
    const proc = board.processorProfileId ? processorProfile(board.processorProfileId) : undefined;
    const compile = board.compileProfileId ? compileProfile(board.compileProfileId) : undefined;
    const runtime = board.runtimeProfileId ? runtimeProfile(board.runtimeProfileId) : undefined;
    check(
      proc !== undefined && compile !== undefined && runtime !== undefined,
      `${board.id}: names a processor, a compile profile and a runtime`,
    );
    if (!proc || !compile || !runtime) continue;

    const problems = checkPipeline(proc.id, compile, runtime);
    check(problems.length === 0, `${board.id}: the three fit together${problems.length ? ` — ${problems[0].message}` : ''}`);

    // What the board already claimed must be what its profiles say.
    check(runtime.engine === board.simulation?.engine, `${board.id}: the runtime's engine is the board's (${runtime.engine})`);
    check(
      compile.requiredCore === board.compiler?.requiredCore,
      `${board.id}: the compile profile needs the same core the board does (${compile.requiredCore})`,
    );
    // The board family and the specific part are different granularities — an
    // "esp32" board carries specifically a C3 or a C6 — so the link is the
    // profile's own declared family rather than a string match.
    check(
      proc.boardArchitecture === board.architecture,
      `${board.id}: the processor belongs to the board's family (${proc.boardArchitecture} / ${board.architecture})`,
    );
  }
}

// ================================ 2. no profile knows about any board ========
section('2. a profile never names a board');
{
  const boardIds = new Set(BOARD_DEFINITIONS.map((b) => b.id));
  const offenders: string[] = [];
  for (const profile of [...COMPILE_PROFILES, ...RUNTIME_PROFILES]) {
    const json = JSON.stringify({ ...profile, description: '', name: '', fqbn: '', serverTargetId: '' });
    for (const id of boardIds) if (json.includes(id)) offenders.push(`${profile.id} names ${id}`);
  }
  check(offenders.length === 0, `no profile's identity fields name a board${offenders.length ? `: ${offenders.join('; ')}` : ''}`);

  // serverTargetId and fqbn are the two places a board id legitimately appears,
  // because the compiler service's allowlist is keyed that way. They are the
  // TARGET a pipeline compiles for, not the identity of the board using it.
  const rp = compileProfile('compile.rp2040-arduino')!;
  check(rp.serverTargetId === 'board.raspberry-pi-pico', 'the RP2040 profile compiles against the Pico target');
  check(
    !rp.name.toLowerCase().includes('pico') || rp.name.includes('RP2040'),
    `and is named for the processor, not the product (${rp.name})`,
  );

  // The adapters are the place this used to be hardcoded.
  const adapter = getSimulatorAdapter(BOARD_DEFINITIONS.find((b) => b.id === 'board.raspberry-pi-pico'));
  check(adapter !== null, 'the Pico resolves to an adapter');
  check(
    adapter?.processorProfileIds.includes('proc.rp2040') === true,
    'and the adapter matched on the processor, not on the board id',
  );
}

// ================================= 3. profiles do not overclaim ==============
section('3. a profile claims only what its runtime models');
{
  const c6 = processorProfile('proc.esp32c6')!;
  // UART0 is modelled but fixed to Serial, so it is no muxable UART to declare;
  // the ADC is modelled on IO0-IO6 (tests/esp.adc.mts); the LED PWM controller
  // drives any pad through the GPIO matrix (tests/esp32.peripherals.mts).
  check(c6.uarts.length === 0, 'the C6 processor profile declares no muxable UART');
  check(Object.keys(c6.adcChannels).length === 7, `and its seven ADC1 channels (${Object.keys(c6.adcChannels).length})`);
  check(c6.pwmPads.length === c6.pads.length, `and PWM on every pad the matrix reaches (${c6.pwmPads.length})`);
  check(c6.notModelled.length > 0, `and says so in plain words (${c6.notModelled.length} entries)`);

  const c6runtime = runtimeProfile('runtime.esp32c6')!;
  // Claimed since tests/esp32.peripherals.mts measured each on this chip.
  check(
    ['analogwrite', 'wire', 'spi'].every((api) => c6runtime.supportedApis.some((s) => s.toLowerCase().includes(api))),
    `the C6 runtime claims analogWrite, Wire and SPI (${c6runtime.supportedApis.join(', ')})`,
  );

  // The RP2040 is the opposite case and must not be trimmed by accident.
  const rp = processorProfile('proc.rp2040')!;
  check(rp.uarts.length === 2, `the RP2040 has both UARTs (${rp.uarts.length})`);
  check(rp.i2c.length === 2 && rp.spi.length === 2, 'and both I2C and both SPI controllers');
  check(Object.keys(rp.adcChannels).length === 4, `and four ADC channels (${Object.keys(rp.adcChannels).length})`);

  // The 32U4's missing Timer4 has to show up as missing pads, not as a note.
  const u4 = processorProfile('proc.atmega32u4')!;
  check(u4.pwmPads.length === 5, `the 32U4 lists only the PWM pads Timer0/1/3 drive (${u4.pwmPads.length})`);
  check(u4.notModelled.some((n) => /USB/i.test(n)), 'and says native USB is not emulated');
}

// ===================================== 4. impossible combinations refused ====
section('4. a combination that cannot work is refused, with both halves named');
{
  const avrCompile = compileProfile('compile.avr-arduino')!;
  const rpRuntime = runtimeProfile('runtime.rp2040js')!;

  const wrongProcessor = checkPipeline('proc.rp2040', avrCompile, rpRuntime);
  check(
    wrongProcessor.some((p) => p.code === 'processor-not-compilable'),
    'an AVR toolchain will not build for an RP2040',
  );

  // The artifact-format mismatch is the one that would otherwise fail inside an
  // emulator: Intel HEX handed to a runtime that executes UF2.
  const formats = checkPipeline('proc.rp2040', { ...avrCompile, processorProfileIds: ['proc.rp2040'] }, rpRuntime);
  const format = formats.find((p) => p.code === 'artifact-format');
  check(format !== undefined, 'a HEX-emitting toolchain and a UF2 runtime do not go together');
  check(
    Boolean(format && /uf2/i.test(format.message) && /intel-hex/i.test(format.message)),
    `and the message names both formats ("${format?.message ?? ''}")`,
  );

  const ok = checkPipeline('proc.rp2040', compileProfile('compile.rp2040-arduino')!, rpRuntime);
  check(ok.length === 0, 'the matching combination is accepted');

  // Wiring-only is a real answer, not a failure.
  const none = checkPipeline('proc.rp2040', compileProfile('compile.none')!, runtimeProfile('runtime.none')!);
  check(none.length === 0, 'and a board that neither compiles nor runs is a valid board');
}

// =========================================== 5. the pad namespace is usable ==
section('5. a processor profile can answer the questions a pin map asks');
{
  const rp = processorProfile('proc.rp2040')!;
  check(hasPad(rp, 'GP15'), 'GP15 exists on the RP2040');
  check(!hasPad(rp, 'GP50'), 'GP50 does not');
  check(rp.pads.length === 30, `and there are thirty of them (${rp.pads.length})`);

  const roles = padRoles(rp, 'GP4');
  check(roles.some((r) => r.controller === 'i2c0' && r.signal === 'sda'), 'GP4 can be I2C0 SDA');
  check(roles.some((r) => r.controller === 'pwm'), 'and a PWM output');
  check(padRoles(rp, 'GP26').some((r) => r.controller === 'adc'), 'GP26 is an ADC channel');
  check(padRoles(rp, 'GP15').every((r) => r.controller !== 'adc'), 'GP15 is not');

  const avr = processorProfile('proc.atmega328p')!;
  check(hasPad(avr, 'PB5'), 'the 328P has PB5');
  check(!hasPad(avr, 'PE0'), 'and no port E');
  check(avr.i2c[0].defaults?.sda === 'PC4', 'its Wire SDA defaults to PC4');
}

// ============================= 6. every processor an adapter runs has a map ==
section('6. a runnable processor has everything the runner needs');
{
  for (const id of runnableProcessorProfileIds()) {
    const profile = processorProfile(id);
    check(profile !== undefined, `${id} is a real processor profile`);
    if (!profile) continue;
    check(compileProfilesFor(id).length > 0, `${id} has a compile profile`);
    check(runtimeProfilesFor(id).length > 0, `${id} has a runtime profile`);
    if (profile.architecture === 'avr') {
      check(avrProfileForProcessor(id) !== undefined, `${id} has an avr8js machine profile`);
    }
  }
  check(
    PROCESSOR_PROFILES.every((p) => p.pads.length > 0),
    'and every processor profile exposes at least one pad',
  );
}

console.log(
  failures === 0
    ? '\nProfile checks passed.'
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
