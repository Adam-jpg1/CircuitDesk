// Board-profile regression suite: canonical schema, honest badges, correct
// per-board metadata, and — critically — proof that nothing falls back to
// the Arduino Uno profile, pins, simulator or compiler.

import { BOARD_DEFINITIONS, getBoardDefinition, findBoardByIdOrAlias } from '../src/boards/definitions';
import { AVR_BOARD_PROFILES, avrProfileFor, arduinoPinNumber } from '../src/boards/pinMaps';
import { getSimulatorAdapter, runnableProcessorProfileIds } from '../src/simulation/adapters';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import { resolveDefinition } from '../src/project/partsRegistry';
import { resolveCompileTarget } from '../src/compiler/targets';
import { buildPinStatesModel, pinStateCell } from '../src/simulation/pinStatesModel';
import { describeSupport } from '../src/project/support';
import { CircuitBinding } from '../src/simulation/circuitSim';
import { emptyProject } from '../src/project/templates';
import { SUPPORTED_TARGETS, findTarget } from '../server/compiler/types';
import { uid, type CircuitProject } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

function projectWith(boardDefId: string): CircuitProject {
  const p = emptyProject('t');
  p.boardInstances = [{ id: uid('inst'), definitionId: boardDefId, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} }];
  return p;
}

// ---------- 1. Canonical schema on every board ----------
{
  const ids = new Set<string>();
  let allOk = true;
  for (const b of BOARD_DEFINITIONS) {
    if (ids.has(b.id)) { allOk = false; console.log('  duplicate id:', b.id); }
    ids.add(b.id);
    if (!b.architecture) { allOk = false; console.log('  missing architecture:', b.id); }
    if (!Array.isArray(b.aliases) || b.aliases.length === 0) { allOk = false; console.log('  missing aliases:', b.id); }
    if (!b.compiler) { allOk = false; console.log('  missing compiler info:', b.id); }
    if (!b.simulation) { allOk = false; console.log('  missing simulation info:', b.id); }
    if ((b as { compilerTarget?: unknown }).compilerTarget) { allOk = false; console.log('  stale compilerTarget:', b.id); }
    if ((b as { simulationAdapterId?: unknown }).simulationAdapterId) { allOk = false; console.log('  stale simulationAdapterId:', b.id); }
  }
  check(allOk, `all ${BOARD_DEFINITIONS.length} boards have unique id, architecture, aliases, compiler+simulation info, no stale fields`);
}

// ---------- 2. Badge honesty is enforced by capabilities ----------
{
  let ok = true;
  for (const b of BOARD_DEFINITIONS) {
    if (b.supportLevel === 'simulated') {
      if (!b.simulation?.supported) { ok = false; console.log('  simulated badge without simulation support:', b.id); }
      // The adapter registry keys on the PROCESSOR now, so a board claiming
      // simulation has to name one that some emulator genuinely executes.
      if (!b.processorProfileId) { ok = false; console.log('  simulated badge without a processor profile:', b.id); }
      else if (!runnableProcessorProfileIds().includes(b.processorProfileId)) {
        ok = false; console.log('  simulated badge for a processor no adapter runs:', b.id, b.processorProfileId);
      }
      // An AVR board needs its own avr8js pin profile; an RP2040 board's pins
      // are the GP pads themselves, resolved through runnerPinIndex.
      // The machine profile the RUNNER would actually resolve, which is what
      // decides whether firmware can execute: a board's own variant where it
      // has one, and its processor's otherwise. A board that builds through
      // another board's variant — a Pro Mini through the Uno target — runs on
      // that variant's profile legitimately, and so does a board somebody
      // brought in themselves. Asking for a per-board entry instead would fail
      // boards that genuinely run.
      if (b.architecture === 'avr' && !avrProfileFor(b)) { ok = false; console.log('  simulated AVR badge with no machine profile the runner can resolve:', b.id); }
      if (b.architecture === 'rp2040' && runnerPinIndex(b, 'GP0') !== 0) { ok = false; console.log('  simulated RP2040 badge without GP pin resolution:', b.id); }
      if (!getSimulatorAdapter(b)) { ok = false; console.log('  adapter lookup failed:', b.id); }
    }
    if (b.supportLevel === 'compile' && !b.compiler?.supported) { ok = false; console.log('  compile badge without compiler support:', b.id); }
    if (!b.simulation?.supported && b.supportLevel === 'simulated') { ok = false; }
  }
  check(ok, 'every Simulated badge has adapter + pin profile; every Compile badge has a real toolchain target');
  const simulated = BOARD_DEFINITIONS.filter((b) => b.supportLevel === 'simulated').map((b) => b.id).sort();
  check(
    JSON.stringify(simulated) ===
      JSON.stringify([
        'board.arduino-leonardo',
        'board.arduino-mega2560',
        'board.arduino-nano',
        // Simulated on the strength of tests/boards.sameChip.mts: the Pro Mini
        // is an ATmega328P at 16 MHz, built through the Uno target because the
        // arduino:avr core has no entry of its own for it, and proven to reach
        // a toggling D13 on real compiled firmware.
        'board.arduino-pro-mini',
        'board.arduino-uno',
        // Simulated on the strength of tests/esp32c3.firmware.mts and
        // tests/esp32c3.integration.mts: real compiled firmware reaching
        // setup() and repeated loop(), GPIO out on two different pins, GPIO in
        // with a pull-up, and both proven on the canvas through the binding.
        'board.esp32-c3',
        // Simulated on the strength of tests/boards.sameChip.mts: the same
        // ESP32-C3 built through the same target, proven to execute its image
        // and drive the pin its silkscreen calls IO8.
        'board.esp32-c3-supermini',
        // Simulated on the strength of tests/esp32c6.{startup,gpio,interrupts,
        // multiboard}.mts: real compiled firmware reaching app_main,
        // initArduino, setup() and repeated loop() with a delivered FreeRTOS
        // tick; GPIO out on two independent pins and in with a pull-up; a
        // canvas button reaching digitalRead; the production runner through the
        // adapter; two instances proven independent; and firmware-to-firmware
        // communication with a Pico over a shared net, in both directions.
        'board.esp32-c6-devkitc-1',
        'board.raspberry-pi-pico',
        'board.raspberry-pi-pico-w',
        // Simulated on the strength of tests/boards.sameChip.mts: an RP2040
        // built through the Arduino-Pico generic target, with the XIAO's own
        // D0-D10 labels translated to GP pads by its pad map — the test drives
        // pad 26 and checks that the pin labelled D0 is the one that moved.
        'board.seeed-xiao-rp2040',
      ]),
    `only boards with passing runtime tests are Simulated (got: ${simulated.join(', ')})`,
  );
  // Nothing is compile-only any more: the RP2040 boards were the last two, and
  // they now execute real firmware. A board that compiles but cannot run must
  // still land in this tier, so the check is that the tier is honest rather
  // than that it is empty.
  const compileOnly = BOARD_DEFINITIONS.filter((b) => b.supportLevel === 'compile').map((b) => b.id).sort();
  check(
    compileOnly.every((boardId) => {
      const def = getBoardDefinition(boardId)!;
      return def.compiler?.supported === true && def.simulation?.supported !== true;
    }),
    `every Compile board compiles for real and claims no simulation (got: ${compileOnly.join(', ') || 'none'})`,
  );
}

// ---------- 3. Raspberry Pi Pico correctness ----------
{
  const pico = getBoardDefinition('board.raspberry-pi-pico')!;
  check(pico.architecture === 'rp2040', 'Pico architecture is rp2040');
  const badPins = pico.pins.filter((p) => /^D\d+$/.test(p.id) || /^A[0-5]$/.test(p.id));
  check(badPins.length === 0, `Pico has NO D0-D13/A0-A5 pins (found: ${badPins.map((p) => p.id).join(',') || 'none'})`);
  const gpPins = pico.pins.filter((p) => /^GP\d+$/.test(p.id));
  check(gpPins.length === 26, `Pico exposes GP pins with canonical names (${gpPins.length} GP pins: GP0-GP22, GP26-28)`);
  const adcPins = pico.pins.filter((p) => p.capabilities.includes('analog-in')).map((p) => p.id).sort();
  check(
    JSON.stringify(adcPins) === JSON.stringify(['GP26', 'GP27', 'GP28']),
    `Pico ADC pins are exactly GP26/GP27/GP28 (got: ${adcPins.join(',')})`,
  );
  check(gpPins.every((p) => p.capabilities.includes('pwm')), 'every Pico GP pin is PWM-capable (RP2040 PWM slices)');
  check(pico.compiler?.fqbn === 'rp2040:rp2040:rpipico', `Pico FQBN is rp2040:rp2040:rpipico (got ${pico.compiler?.fqbn})`);
  check(pico.compiler?.requiredCore === 'rp2040:rp2040', `Pico requires the rp2040:rp2040 core (got ${pico.compiler?.requiredCore})`);
  check(!pico.compiler?.fqbn?.includes('avr'), 'Pico never compiles through arduino:avr');
  check(Number(pico.metadata.logicVoltage) === 3.3, 'Pico logic voltage is 3.3 V');
  check(
    pico.simulation?.supported === true && pico.supportLevel === 'simulated' && pico.simulation.engine === 'rp2040js',
    `Pico is Simulated through the RP2040 engine (${pico.supportLevel}/${pico.simulation?.engine})`,
  );
  // The badge must not be read as a claim about everything the chip can do.
  check(
    !pico.simulation?.supportedApis.some((a) => /analogWrite|wifi|usb\b/i.test(a)),
    'Pico claims no analogWrite, Wi-Fi or USB APIs',
  );
  check(
    // Word-bounded, so "GPIO pads" is not mistaken for a PIO claim.
    !pico.simulation?.supportedPeripherals.some((p) => /\bPIO\b|USB|Wi-?Fi|second core|PWM/i.test(p)),
    'Pico claims no PIO, USB, Wi-Fi, second core or PWM peripheral',
  );
  // Pico GP pins never resolve to Arduino pin numbers (no D0-D13 interpretation)
  check(arduinoPinNumber(pico, 'GP0') === undefined && arduinoPinNumber(pico, 'GP26') === undefined,
    'Pico GP pins never resolve to AVR Arduino pin numbers');
  // Pico project resolves to the RP2040 target, never AVR
  const res = resolveCompileTarget(projectWith('board.raspberry-pi-pico'));
  check(res.ok && res.fqbn === 'rp2040:rp2040:rpipico', `Pico project compile target is the Arduino-Pico core (got ${res.ok ? res.fqbn : res.reason})`);
  // and never binds to the AVR simulator
  const binding = new CircuitBinding(projectWith('board.raspberry-pi-pico'), null);
  check(binding.boardDef?.id === 'board.raspberry-pi-pico', 'Pico circuit binding attaches to the Pico itself');
  check(getSimulatorAdapter(pico)?.engine === 'rp2040js', 'the Pico resolves to the RP2040 adapter, never avr8js');
  check(!AVR_BOARD_PROFILES['board.raspberry-pi-pico'], 'the Pico has no AVR pin profile to fall back to');
}

// ---------- 4. Per-board metadata correctness ----------
{
  const uno = getBoardDefinition('board.arduino-uno')!;
  const nano = getBoardDefinition('board.arduino-nano')!;
  const mega = getBoardDefinition('board.arduino-mega2560')!;
  const leo = getBoardDefinition('board.arduino-leonardo')!;
  check(uno.architecture === 'avr' && Number(uno.metadata.logicVoltage) === 5 && uno.compiler?.fqbn === 'arduino:avr:uno', 'Uno: avr / 5V / arduino:avr:uno');
  check(nano.architecture === 'avr' && nano.compiler?.fqbn === 'arduino:avr:nano' && nano.supportLevel === 'simulated', 'Nano: avr / arduino:avr:nano / simulated');
  check(
    mega.compiler?.fqbn === 'arduino:avr:mega' && mega.supportLevel === 'simulated' && mega.simulation?.engine === 'avr8js',
    'Mega: arduino:avr:mega target and genuinely simulated on avr8js',
  );
  check(
    mega.simulation!.supportedPeripherals.some((p) => /Timer3\/4\/5/.test(p)) &&
      mega.metadata.limitation !== undefined &&
      /Serial1-Serial3 \(USART1-3\) are not emulated/.test(String(mega.metadata.limitation)),
    'Mega declares its Mega-only timers and states the Serial1-3 limitation',
  );
  check(leo.compiler?.fqbn === 'arduino:avr:leonardo' && Number(leo.metadata.analogPinBase) === 18, 'Leonardo: arduino:avr:leonardo, A0=18');
  check(arduinoPinNumber(mega, 'A0') === 54 && arduinoPinNumber(mega, 'D53') === 53, 'Mega pin numbering: A0=54, D53=53 (not Uno numbering)');
  check(arduinoPinNumber(uno, 'SDA') === 18 && arduinoPinNumber(uno, 'A5') === 19, 'Uno pin numbering: SDA=18, A5=19');
  // ESP variants are distinct
  const esp32 = getBoardDefinition('board.esp32-devkit')!;
  const s3 = getBoardDefinition('board.esp32-s3')!;
  const c3 = getBoardDefinition('board.esp32-c3')!;
  const nodemcu = getBoardDefinition('board.esp8266-nodemcu')!;
  check(esp32.metadata.variant === 'esp32' && s3.metadata.variant === 'esp32s3' && c3.metadata.variant === 'esp32c3', 'ESP32 variants are tracked distinctly (esp32/esp32s3/esp32c3)');
  check(nodemcu.architecture === 'esp8266' && Number(nodemcu.metadata.logicVoltage) === 3.3, 'ESP8266: own architecture, 3.3 V');
  check(!esp32.compiler?.supported && !esp32.simulation?.supported, 'ESP32 honestly reports no compile/simulation support');
  // Linux boards never claim simulation
  const rpi = getBoardDefinition('board.rpi4-gpio')!;
  check(rpi.architecture === 'linux' && !rpi.simulation?.supported && rpi.supportLevel !== 'simulated', 'Linux SBC header: never claimed simulated (no behavioral runtime implemented)');
}

// ---------- 5. No Uno fallbacks anywhere ----------
{
  check(resolveDefinition('board.does-not-exist', null) === undefined, 'unknown board id resolves to undefined, not a default profile');
  const emptyRes = resolveCompileTarget(emptyProject('t'));
  check(!emptyRes.ok, 'project without a board has NO default compile target');
  const espRes = resolveCompileTarget(projectWith('board.esp32-devkit'));
  check(!espRes.ok && espRes.reason.includes('never compiled as a different board'), 'ESP32 compile refused with explicit no-fallback message');
  const unknownRes = resolveCompileTarget(projectWith('board.does-not-exist'));
  check(!unknownRes.ok, 'unknown board compile refused');
  // server-side allowlist
  check(findTarget('unknown:fqbn') === undefined, 'server: unknown fqbn is rejected');
  check(findTarget('arduino:avr:uno', 'board.not-a-board') === undefined, 'server: unknown boardId never resolves via fqbn side-channel');
  check(findTarget('arduino:avr:uno', 'board.arduino-uno')?.id === 'board.arduino-uno', 'server: Uno resolves to Uno');
  check(findTarget('rp2040:rp2040:rpipico')?.arch === 'rp2040', 'server: Pico fqbn maps to the rp2040 arch, never avr');
  // The retired Mbed FQBN must not resolve any more: a target we no longer
  // install should be refused outright, never quietly built as something else.
  check(findTarget('arduino:mbed_rp2040:pico') === undefined, 'server: the retired Mbed Pico fqbn is refused, not silently remapped');
  const avrTargets = SUPPORTED_TARGETS.filter((t) => t.arch === 'avr');
  check(new Set(avrTargets.map((t) => `${t.mcu}/${t.variant}`)).size === avrTargets.length, 'server: every AVR target has its own mcu/variant (no shared Uno flags)');
  // alias lookup
  check(findBoardByIdOrAlias('pico')?.id === 'board.raspberry-pi-pico', 'alias lookup: "pico" → canonical Pico id');
  check(findBoardByIdOrAlias('uno')?.id === 'board.arduino-uno', 'alias lookup: "uno" → canonical Uno id');
}

// ---------- 6. Pin States panel model ----------
{
  const uno = getBoardDefinition('board.arduino-uno')!;
  const unoModel = buildPinStatesModel(uno);
  check(unoModel.kind === 'pins' && unoModel.rows.length === 20 && unoModel.rows[0].label === 'D0' && unoModel.rows[19].label === 'A5',
    'Pin States (Uno): its actual 20 pins D0..A5');
  const nano = getBoardDefinition('board.arduino-nano')!;
  const nanoModel = buildPinStatesModel(nano);
  const adcOnly = nanoModel.kind === 'pins' ? nanoModel.rows.filter((r) => r.adcOnly).map((r) => r.label).sort() : [];
  check(nanoModel.kind === 'pins' && JSON.stringify(adcOnly) === JSON.stringify(['A6', 'A7']),
    'Pin States (Nano): includes A6/A7 as ADC-only rows');
  const pico = getBoardDefinition('board.raspberry-pi-pico')!;
  const picoModel = buildPinStatesModel(pico);
  const picoLabels = picoModel.kind === 'pins' ? picoModel.rows.map((r) => r.label) : [];
  check(picoModel.kind === 'pins', 'Pin States (Pico): live rows, now that the Pico genuinely runs firmware');
  check(
    picoLabels.length === 26 && picoLabels.every((l) => /^GP\d+$/.test(l)),
    `Pin States (Pico): only GP pins (${picoLabels.length} rows)`,
  );
  check(
    !picoLabels.some((l) => /^D\d+$/.test(l) || /^A\d+$/.test(l)),
    'Pin States (Pico): never shows D0-D13 or A0-A5',
  );
  check(buildPinStatesModel(null).kind === 'no-board', 'Pin States: no board → no fake pins');
  const mega = getBoardDefinition('board.arduino-mega2560')!;
  const megaModel = buildPinStatesModel(mega);
  const megaLabels = megaModel.kind === 'pins' ? megaModel.rows.map((r) => r.label) : [];
  check(
    megaModel.kind === 'pins' && megaLabels.length === 70 && megaLabels[0] === 'D0' && megaLabels[69] === 'A15',
    `Pin States (Mega): its own 70 pins D0..A15 (got ${megaLabels.length})`,
  );
  check(
    megaLabels.includes('D53') && megaLabels.includes('A15') && !megaLabels.includes('A6') === false,
    'Pin States (Mega): includes Mega-only pins D53 and A8-A15',
  );
  const leo = getBoardDefinition('board.arduino-leonardo')!;
  const leoModel = buildPinStatesModel(leo);
  const leoLabels = leoModel.kind === 'pins' ? leoModel.rows.map((r) => r.label) : [];
  check(
    leoModel.kind === 'pins' && leoLabels.length === 23,
    `Pin States (Leonardo): its own 23 header pins D0-D16 + A0-A5 (got ${leoLabels.length})`,
  );
  check(
    leoLabels.includes('D16') && !leoLabels.includes('A6') && !leoLabels.includes('D53'),
    'Pin States (Leonardo): ICSP SPI pins present, no A6-A11 and no Mega pins',
  );
}

// ---------- 7. Server capability endpoint + no-fallback compile responses ----------
{
  const base = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
  const caps = (await (await fetch(`${base}/api/compiler/capabilities`)).json()) as {
    targets: { id: string; arch: string; installed: boolean; toolchain: string; reason?: string }[];
  };
  const uno = caps.targets.find((t) => t.id === 'board.arduino-uno');
  const pico = caps.targets.find((t) => t.id === 'board.raspberry-pi-pico');
  check(Boolean(uno?.installed), 'capabilities: Uno target installed on this service');
  check(pico !== undefined && (pico.installed || Boolean(pico.reason)), `capabilities: Pico reports installed=${pico?.installed} with honest reason when missing`);

  const compileAs = async (boardId: string, fqbn: string) =>
    (await (
      await fetch(`${base}/api/compiler/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId, fqbn, files: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}\n' }] }),
      })
    ).json()) as { success: boolean; errorCode?: string; error?: string; toolchain?: string };

  const unknown = await compileAs('board.esp32-devkit', 'esp32:esp32:esp32');
  check(!unknown.success && unknown.errorCode === 'UNSUPPORTED_BOARD', 'server compile: ESP32 → UNSUPPORTED_BOARD (never compiled as Uno)');
  const picoCompile = await compileAs('board.raspberry-pi-pico', 'rp2040:rp2040:rpipico');
  check(
    !picoCompile.success
      ? ['CORE_MISSING', 'TOOLCHAIN_MISSING'].includes(picoCompile.errorCode ?? '')
      : picoCompile.toolchain === 'arduino-cli',
    `server compile: Pico → ${picoCompile.success ? 'real arduino-cli RP2040 build' : `clear ${picoCompile.errorCode} (no silent AVR fallback)`}`,
  );
  const mega = await compileAs('board.arduino-mega2560', 'arduino:avr:mega');
  check(mega.success === true, `server compile: Mega 2560 builds with its own atmega2560/mega variant (${mega.toolchain})`);
  const leo = await compileAs('board.arduino-leonardo', 'arduino:avr:leonardo');
  check(leo.success === true, `server compile: Leonardo builds with atmega32u4/leonardo variant (${leo.toolchain})`);
}

// ---------- 8. Interrupt support is claimed only where it is emulated ----------
{
  const mega = getBoardDefinition('board.arduino-mega2560')!;
  const uno = getBoardDefinition('board.arduino-uno')!;
  const nano = getBoardDefinition('board.arduino-nano')!;

  // avr8js models INT0/INT1 on PD2/PD3 and the 328P PCINT vectors, which is
  // correct for the Uno/Nano and wrong for the ATmega2560 — so the Mega must
  // not advertise interrupt APIs it cannot honestly emulate.
  check(
    !mega.simulation!.supportedApis.includes('external interrupts'),
    'Mega does not claim external interrupts among its simulated APIs',
  );
  check(
    uno.simulation!.supportedApis.includes('external interrupts') &&
      nano.simulation!.supportedApis.includes('external interrupts'),
    'Uno and Nano keep their (correct) external-interrupt support',
  );
  const megaLimitation = String(mega.metadata.limitation ?? '');
  check(
    /external interrupts/i.test(megaLimitation) && /pin-change interrupts/i.test(megaLimitation),
    'Mega limitation text names external and pin-change interrupts as unemulated',
  );
  check(
    describeSupport(mega).includes(megaLimitation),
    'the Mega badge tooltip states the limitation (not only the supported list)',
  );
  const megaProfile = AVR_BOARD_PROFILES['board.arduino-mega2560'];
  check(
    megaProfile.unsupported.some((u) => /INT0-INT7/.test(u)) && megaProfile.unsupported.some((u) => /PCINT/.test(u)),
    'Mega profile lists INT0-INT7 and PCINT0-2 as unsupported',
  );
  // The physical board really does have interrupt pins; keeping that metadata
  // is honest as long as the simulation claim above is not made.
  check(
    mega.pins.find((p) => p.id === 'D18')?.capabilities.includes('interrupt') === true,
    'D18-D21 keep their real hardware interrupt capability metadata',
  );

  // ---- Leonardo: native USB and Timer4 must never be claimed ----
  const leonardo = getBoardDefinition('board.arduino-leonardo')!;
  const leoApis = leonardo.simulation!.supportedApis;
  check(!leoApis.includes('external interrupts'), 'Leonardo does not claim external interrupts');
  check(
    !leoApis.some((a) => /^Serial \(/.test(a)) && leoApis.some((a) => /^Serial1 /.test(a)),
    'Leonardo claims Serial1 (USART1) and never the native-USB "Serial"',
  );
  check(
    leoApis.some((a) => /analogWrite \(PWM on D3, D5, D9, D10, D11\)/.test(a)),
    'Leonardo claims PWM only on the Timer0/1/3 pins, not on the Timer4 pins D6/D13',
  );
  check(
    leoApis.some((a) => /analogRead \(A0-A5\)/.test(a)),
    'Leonardo claims analogRead only on A0-A5',
  );
  const leoLimitation = String(leonardo.metadata.limitation ?? '');
  check(
    /native USB/i.test(leoLimitation) && /Timer4/.test(leoLimitation) && /while \(!Serial\)/.test(leoLimitation),
    'Leonardo limitation text names native USB, Timer4 and the "while (!Serial)" stall',
  );
  check(describeSupport(leonardo).includes(leoLimitation), 'the Leonardo badge tooltip states its limitations');
  const leoProfile = AVR_BOARD_PROFILES['board.arduino-leonardo'];
  check(leoProfile.mcu === 'atmega32u4' && leoProfile.ramEnd === 0x0aff, 'Leonardo runs its own ATmega32U4 profile');
  check(
    AVR_BOARD_PROFILES['board.arduino-uno'].mcu === 'atmega328p' &&
      AVR_BOARD_PROFILES['board.arduino-nano'].mcu === 'atmega328p' &&
      AVR_BOARD_PROFILES['board.arduino-mega2560'].mcu === 'atmega2560',
    'Uno, Nano and Mega keep their own MCU profiles',
  );
  // Physical PWM metadata still describes the real board (7 pins carry ~).
  check(
    (leonardo.metadata.pwmPins as string[]).includes('D13'),
    'Leonardo keeps D13 in its real hardware PWM pin metadata',
  );
}

// ---------- 9. Pin States cells never borrow another board's state ----------
{
  const megaModel = buildPinStatesModel(getBoardDefinition('board.arduino-mega2560'));
  const rows = megaModel.kind === 'pins' ? megaModel.rows : [];
  // A 20-entry (Uno-sized) snapshot against the Mega's 70 rows.
  const staleSnapshot = {
    states: Array(20).fill('high') as ('high' | 'low' | 'input' | 'input-pullup')[],
    duty: Array(20).fill(1),
    pulseWidthUs: Array(20).fill(0),
    toggles: Array(20).fill(3),
  };
  let threw = false;
  let cells: ReturnType<typeof pinStateCell>[] = [];
  try {
    cells = rows.map((r) => pinStateCell(r, staleSnapshot));
  } catch {
    threw = true;
  }
  check(!threw, 'pinStateCell never throws on a snapshot shorter than the row list');
  check(
    cells.slice(20).every((c) => c.level === 'unavailable' && c.text === '—'),
    'Mega rows outside a stale snapshot render "—" rather than an Uno pin state',
  );
  let emptyThrew = false;
  try {
    rows.map((r) => pinStateCell(r, { states: [], duty: [], pulseWidthUs: [], toggles: [] }));
    rows.map((r) => pinStateCell(r, null));
  } catch {
    emptyThrew = true;
  }
  check(!emptyThrew, 'pinStateCell handles an empty and a null snapshot (stopped simulation)');
}

// ---------- 10. RP2040 capability metadata matches the real build targets ----------
{
  const pico = getBoardDefinition('board.raspberry-pi-pico')!;
  const picow = getBoardDefinition('board.raspberry-pi-pico-w')!;

  check(pico.compiler?.fqbn === 'rp2040:rp2040:rpipico', `Pico reports rp2040:rp2040:rpipico (${pico.compiler?.fqbn})`);
  check(picow.compiler?.fqbn === 'rp2040:rp2040:rpipicow', `Pico W reports rp2040:rp2040:rpipicow (${picow.compiler?.fqbn})`);
  check(
    pico.compiler?.requiredCore === 'rp2040:rp2040' && picow.compiler?.requiredCore === 'rp2040:rp2040',
    'both RP2040 boards require the rp2040:rp2040 core',
  );
  check(pico.compiler?.fqbn !== picow.compiler?.fqbn, 'Pico and Pico W no longer share one FQBN');

  // The retired Mbed identifiers must not survive in anything a user reads.
  for (const [name, def] of [['Pico', pico], ['Pico W', picow]] as const) {
    const userFacing = [
      describeSupport(def),
      def.compiler?.note ?? '',
      String(def.metadata.limitation ?? ''),
      def.description ?? '',
    ].join('\n');
    check(!/mbed_rp2040/.test(userFacing), `${name} capability text never mentions arduino:mbed_rp2040`);
  }

  // The alias is a lookup key only, kept so projects imported while the Mbed
  // target was live still resolve to this board.
  check(
    findBoardByIdOrAlias('arduino:mbed_rp2040:pico')?.id === 'board.raspberry-pi-pico',
    'the retired Mbed identifier still resolves as a lookup alias (import compatibility)',
  );
  check(
    findBoardByIdOrAlias('rp2040:rp2040:rpipico')?.id === 'board.raspberry-pi-pico' &&
      findBoardByIdOrAlias('rp2040:rp2040:rpipicow')?.id === 'board.raspberry-pi-pico-w',
    'current FQBNs resolve to their own boards',
  );

  // Both RP2040 boards run real firmware on the RP2040 engine.
  for (const [name, def] of [['Pico', pico], ['Pico W', picow]] as const) {
    check(
      def.supportLevel === 'simulated' && def.simulation?.supported === true && def.simulation?.engine === 'rp2040js',
      `${name} is Simulated on the RP2040 engine (${def.supportLevel}/${def.simulation?.engine})`,
    );
  }
}

console.log(failures === 0 ? '\nAll board-profile checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
