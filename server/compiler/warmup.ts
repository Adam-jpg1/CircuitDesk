// Compiling the core archives before anybody asks for them.
//
// arduino-cli keeps compiled core archives in a cache shared by every build,
// and every build after the first reuses them. The first one does not: it
// compiles the whole core. Measured on this machine with an empty cache, that
// is 23 s for the RP2040 and 21 s for an ESP32-C6, against 1.7 s and 4.0 s once
// the archive exists.
//
// A fresh container starts with an empty cache, so without this the cost lands
// on whichever user happens to press Run first after a deploy or a restart —
// twenty seconds, once, unpredictably, and looking exactly like a hang. Paying
// it here instead moves it to a moment when nobody is waiting.
//
// It runs through the same gate as real builds, so a warm-up can never compete
// with a user's compile for the memory COMPILE_JOBS=1 exists to protect: a
// request that arrives mid-warm-up simply queues behind the one core build in
// progress, and every later request finds the archive already there.

import { detectArduinoCli } from './arduinoCli.js';
import { SUPPORTED_TARGETS } from './types.js';
import type { CompileResult } from './types.js';

/** The smallest thing that still pulls in the whole core. */
const WARMUP_SKETCH = [
  '// CircuitDesk core warm-up. Compiled at startup so the first real build',
  '// does not have to compile the core archive.',
  'void setup() {}',
  'void loop() {}',
].join('\n');

export interface WarmupOutcome {
  fqbn: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

/**
 * Builds one trivial sketch per installed target, one at a time.
 *
 * One per CORE would be enough for the archive itself, but the targets of a
 * core differ in build properties — an ESP32-C3 and an ESP32-C6 are different
 * MCUs with different archives — so it is per target, skipping the ones whose
 * core is not installed rather than reporting a failure for them.
 */
export async function warmCoreCaches(
  compile: (req: { fqbn: string; boardId: string; files: { name: string; content: string }[] }) => Promise<CompileResult>,
  log: (message: string) => void = () => undefined,
): Promise<WarmupOutcome[]> {
  const cli = await detectArduinoCli();
  if (!cli.available) return [];

  // One target per core is what warms the archive; the rest of a core's targets
  // are cheap afterwards, but they are not free, so all of them are warmed. The
  // AVR ones come first because they are the fastest and the most used.
  const targets = SUPPORTED_TARGETS.filter((t) => cli.installedCores.includes(t.core));
  const outcomes: WarmupOutcome[] = [];
  for (const target of targets) {
    const started = Date.now();
    try {
      const result = await compile({
        fqbn: target.fqbn,
        boardId: target.id,
        files: [{ name: 'sketch.ino', content: WARMUP_SKETCH }],
      });
      const ms = Date.now() - started;
      outcomes.push({ fqbn: target.fqbn, ok: result.success, ms, detail: result.error });
      log(
        result.success
          ? `[CircuitDesk] warmed ${target.fqbn} in ${(ms / 1000).toFixed(1)}s`
          : `[CircuitDesk] warm-up for ${target.fqbn} failed: ${result.error ?? 'unknown'}`,
      );
    } catch (err) {
      const ms = Date.now() - started;
      outcomes.push({ fqbn: target.fqbn, ok: false, ms, detail: err instanceof Error ? err.message : String(err) });
      log(`[CircuitDesk] warm-up for ${target.fqbn} errored: ${String(err)}`);
    }
  }
  return outcomes;
}
