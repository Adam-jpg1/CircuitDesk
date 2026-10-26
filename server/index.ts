import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCompilerHealth, compileProject } from './compiler/compilerService.js';
import { SUPPORTED_TARGETS, findTarget, type CompileRequest } from './compiler/types.js';
import { detectGccToolchain, ensureCoreArchive } from './compiler/gccToolchain.js';
import { detectArduinoCli } from './compiler/arduinoCli.js';
import { PINNED_CORES, pinnedCore } from './compiler/cores.js';
import { PINNED_LIBRARIES, headersForTarget } from './compiler/libraries.js';
import { rateLimit } from './rateLimit.js';
import { CompileGate, CompilerBusyError } from './compileGate.js';
import { cacheStats, evictBuildDirs } from './compiler/buildCache.js';
import { warmCoreCaches } from './compiler/warmup.js';
import { registerCommunityRoutes } from './community/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Render/other PaaS provide PORT; fall back to 3411 for local development.
const PORT = Number(process.env.PORT ?? 3411);
const HOST = process.env.HOST ?? '0.0.0.0';

// Running behind a reverse proxy in production (Render) — needed for correct req.ip.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// CORS: the public frontend origins plus local development, extendable via env
// (comma-separated) without hard-coding deployment URLs in source.
const ALLOWED_ORIGINS = new Set(
  [
    'https://circuitdesk.site',
    'https://www.circuitdesk.site',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3411',
    'http://127.0.0.1:3411',
    ...(process.env.CORS_EXTRA_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ],
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin/non-browser requests (no Origin header) and the allowlist.
      if (!origin || ALLOWED_ORIGINS.has(origin)) callback(null, true);
      else callback(null, false); // no CORS headers → browser blocks the response
    },
    maxAge: 86_400,
  }),
);

// Request-size limit (source-size limits are additionally enforced per-file in fileService).
app.use(express.json({ limit: '2mb' }));

// ---- health checks ----

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'circuitdesk-compiler' });
});

app.get('/api/compiler/health', async (_req, res) => {
  try {
    res.json(await getCompilerHealth());
  } catch (err) {
    console.error('[CircuitDesk] health check failed:', err);
    res.status(500).json({ available: false, toolchain: 'none', version: '', detail: 'Internal error.' });
  }
});

/**
 * What the build cache is holding.
 *
 * Reported rather than inferred, because "caching is working" is a claim about
 * hit rate and bounded size, and both are numbers this service already has.
 */
app.get('/api/compiler/cache', (_req, res) => {
  res.json(cacheStats());
});

app.get('/api/compiler/boards', (_req, res) => {
  res.json({ targets: SUPPORTED_TARGETS });
});

/**
 * What this compiler service can actually build, core by core and target by
 * target.
 *
 * "The service is up" and "the service can build for your board" are different
 * questions, and conflating them is how a deployment shipped without the ESP32
 * core and reported itself healthy. The answer here is machine-readable so the
 * app can tell "compiler unreachable" from "compiler reachable, that core is
 * missing" without parsing a sentence.
 */
app.get('/api/compiler/capabilities', async (_req, res) => {
  try {
    const cli = await detectArduinoCli();
    const gcc = await detectGccToolchain();

    const cores = PINNED_CORES.map((core) => {
      const installedVersion = cli.coreVersions[core.id];
      const installed = Boolean(installedVersion);
      return {
        id: core.id,
        /** The version this service is built and validated against. */
        expectedVersion: core.version,
        installedVersion: installedVersion ?? null,
        installed,
        /** True only when the installed core is the pinned one. */
        matchesPin: installed && installedVersion === core.version,
        required: core.required,
        fqbnFamilies: core.targets,
        reason: installed
          ? installedVersion === core.version
            ? undefined
            : `Installed ${core.id} is ${installedVersion}, but this service is validated against ${core.version}.`
          : `The ${core.id} core is not installed on this compiler service.`,
      };
    });

    const targets = SUPPORTED_TARGETS.map((t) => {
      const cliHasCore = cli.available && cli.installedCores.includes(t.core);
      const installed = t.arch === 'avr' ? cliHasCore || gcc.available : cliHasCore;
      const toolchain = cliHasCore ? 'arduino-cli' : t.arch === 'avr' && gcc.available ? 'avr-gcc' : 'none';
      const pin = pinnedCore(t.core);
      return {
        id: t.id,
        name: t.name,
        fqbn: t.fqbn,
        arch: t.arch,
        core: t.core,
        coreVersion: cli.coreVersions[t.core] ?? null,
        expectedCoreVersion: pin?.version ?? null,
        installed,
        toolchain,
        // Which library headers this target can actually build. Measured, not
        // inferred from library metadata — see server/compiler/libraries.json.
        headers: headersForTarget(t.fqbn),
        reason: installed
          ? undefined
          : `The ${t.core} core is not installed on this compiler service (arduino-cli ${cli.available ? 'present' : 'missing'}).`,
      };
    });

    // A service missing a required core is reachable but degraded, and says so
    // rather than being reported as simply healthy.
    const missingRequired = cores.filter((c) => c.required && !c.installed).map((c) => c.id);
    const drifted = cores.filter((c) => c.installed && !c.matchesPin).map((c) => c.id);

    const libraries = PINNED_LIBRARIES.map((lib) => {
      const installedVersion = cli.libraryVersions[lib.id];
      const installed = Boolean(installedVersion);
      return {
        id: lib.id,
        expectedVersion: lib.version,
        installedVersion: installedVersion ?? null,
        installed,
        matchesPin: installed && installedVersion === lib.version,
        required: lib.required,
        provides: lib.provides,
        reason: installed
          ? installedVersion === lib.version
            ? undefined
            : `Installed ${lib.id} is ${installedVersion}, but this service is validated against ${lib.version}.`
          : `The ${lib.id} library is not installed on this compiler service.`,
      };
    });
    const missingLibraries = libraries.filter((l) => l.required && !l.installed).map((l) => l.id);
    const driftedLibraries = libraries.filter((l) => l.installed && !l.matchesPin).map((l) => l.id);

    // A missing library degrades the service in exactly the way a missing core
    // does — sketches that are supposed to build stop building — so it is
    // reported the same way rather than left for the user to discover.
    const degraded = missingRequired.length > 0 || missingLibraries.length > 0;
    const hasDrift = drifted.length > 0 || driftedLibraries.length > 0;
    res.json({
      status: degraded ? 'degraded' : hasDrift ? 'drifted' : 'healthy',
      arduinoCli: { available: cli.available, version: cli.version },
      missingRequiredCores: missingRequired,
      driftedCores: drifted,
      missingRequiredLibraries: missingLibraries,
      driftedLibraries,
      cores,
      libraries,
      targets,
    });
  } catch (err) {
    console.error('[CircuitDesk] capabilities check failed:', err);
    res.status(500).json({ status: 'error', cores: [], libraries: [], targets: [] });
  }
});

// ---- compile endpoints (rate-limited; one build at a time) ----

/**
 * Compile budget per client.
 *
 * Sixty builds in five minutes is a generous ceiling for a person and a low
 * one for a full regression run, which compiles dozens of sketches back to
 * back from one address. The limit is what ships; the override exists so a
 * developer running the whole suite locally is not throttled by a rule aimed
 * at public traffic. Deployments leave it unset.
 */
const COMPILE_RATE_MAX = Number(process.env.COMPILE_RATE_MAX ?? 60);
const compileLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: Number.isFinite(COMPILE_RATE_MAX) && COMPILE_RATE_MAX > 0 ? COMPILE_RATE_MAX : 60,
  name: 'compile',
});

/** One compile at a time, with a short queue; see server/compileGate.ts. */
const compileGate = new CompileGate();

/** Refuses a build cleanly when the queue is full instead of piling up. */
function rejectIfBusy(err: unknown, res: express.Response, what: string): boolean {
  if (!(err instanceof CompilerBusyError)) return false;
  res.set('Retry-After', String(err.retryAfterSeconds));
  res.status(503).json({
    success: false,
    toolchain: 'none',
    toolchainVersion: '',
    stdout: '',
    stderr: '',
    diagnostics: [],
    durationMs: 0,
    error: `${what} refused: ${err.message}`,
    errorCode: 'BUSY',
  });
  return true;
}

app.post('/api/compiler/compile', compileLimiter, async (req, res) => {
  const body = req.body as CompileRequest;
  if (!body || typeof body !== 'object' || typeof body.fqbn !== 'string') {
    res.status(400).json({ success: false, error: 'Malformed compile request.', errorCode: 'MALFORMED_PROJECT' });
    return;
  }
  let result;
  try {
    result = await compileGate.run(() => compileProject(body, false));
  } catch (err) {
    if (rejectIfBusy(err, res, 'Compile')) return;
    throw err;
  }
  res.status(result.errorCode === 'MALFORMED_PROJECT' ? 400 : 200).json(result);
});

app.post('/api/compiler/validate', compileLimiter, async (req, res) => {
  const body = req.body as CompileRequest;
  if (!body || typeof body !== 'object' || typeof body.fqbn !== 'string') {
    res.status(400).json({ success: false, error: 'Malformed validate request.', errorCode: 'MALFORMED_PROJECT' });
    return;
  }
  let result;
  try {
    result = await compileGate.run(() => compileProject(body, true));
  } catch (err) {
    if (rejectIfBusy(err, res, 'Validate')) return;
    throw err;
  }
  res.status(200).json(result);
});

// ---- community: shared projects and likes; see server/community ----
const community = await registerCommunityRoutes(app);
console.log(`[CircuitDesk] community: ${community.size} project(s)`);

// Serve the production build when present (optional single-host deployments).
const dist = path.resolve(__dirname, '../dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  // Vercel Analytics only exists on Vercel hosting; answer with a no-op script
  // instead of letting the SPA fallback return HTML for a .js request.
  app.get(/^\/_vercel\/.*/, (_req, res) => {
    res.type('application/javascript').send('/* analytics disabled on this host */');
  });
  app.get(/^\/(?!api\/|health$).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`[CircuitDesk] compiler server listening on http://${HOST}:${PORT}`);
  // Warm the Arduino core cache in the background so the first user compile is fast.
  void (async () => {
    try {
      const health = await getCompilerHealth();
      console.log(`[CircuitDesk] toolchain: ${health.toolchain} ${health.version} — ${health.detail}`);
      // A restart inherits whatever the previous process left on disk, which is
      // the point of the cache surviving one — but it must not inherit a tree
      // that has already outgrown its limits.
      const trimmed = await evictBuildDirs(true);
      const stats = cacheStats();
      console.log(
        `[CircuitDesk] build cache at ${stats.root} (max ${stats.maxDirs} dirs / ` +
        `${Math.round(stats.maxDirBytes / 1024 / 1024)} MB)` +
        (trimmed.removed > 0 ? `, trimmed ${trimmed.removed} on startup` : ''),
      );
      if (health.toolchain === 'avr-gcc') {
        const gcc = await detectGccToolchain();
        const uno = findTarget('arduino:avr:uno');
        if (gcc.coreRoot && uno) {
          await ensureCoreArchive(uno, gcc.coreRoot);
          console.log('[CircuitDesk] Arduino core archive ready.');
        }
      }
      if (health.toolchain === 'arduino-cli' && process.env.COMPILE_WARMUP !== 'off') {
        // Through the gate, so a user who arrives mid-warm-up queues behind one
        // build rather than running a second one alongside it.
        const started = Date.now();
        const outcomes = await warmCoreCaches(
          (req) => compileGate.run(() => compileProject(req, false)),
          (line) => console.log(line),
        );
        const failed = outcomes.filter((o) => !o.ok);
        console.log(
          `[CircuitDesk] core caches warm for ${outcomes.length - failed.length}/${outcomes.length} targets ` +
          `in ${((Date.now() - started) / 1000).toFixed(1)}s` +
          (failed.length > 0 ? ` — not warmed: ${failed.map((f) => f.fqbn).join(', ')}` : ''),
        );
      }
    } catch (err) {
      console.warn('[CircuitDesk] core warmup failed:', err);
    }
  })();
});
