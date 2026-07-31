import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCompilerHealth, compileProject } from './compiler/compilerService.js';
import { SUPPORTED_TARGETS, findTarget, type CompileRequest } from './compiler/types.js';
import { detectGccToolchain, ensureCoreArchive } from './compiler/gccToolchain.js';
import { rateLimit } from './rateLimit.js';

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

app.get('/api/compiler/boards', (_req, res) => {
  res.json({ targets: SUPPORTED_TARGETS });
});

// ---- compile endpoints (rate-limited; one build at a time) ----

const compileLimiter = rateLimit({ windowMs: 5 * 60_000, max: 60, name: 'compile' });

/** One compile at a time keeps resource usage bounded on small machines. */
let compileQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = compileQueue.then(fn, fn);
  compileQueue = next.catch(() => undefined);
  return next;
}

app.post('/api/compiler/compile', compileLimiter, async (req, res) => {
  const body = req.body as CompileRequest;
  if (!body || typeof body !== 'object' || typeof body.fqbn !== 'string') {
    res.status(400).json({ success: false, error: 'Malformed compile request.', errorCode: 'MALFORMED_PROJECT' });
    return;
  }
  const result = await enqueue(() => compileProject(body, false));
  res.status(result.errorCode === 'MALFORMED_PROJECT' ? 400 : 200).json(result);
});

app.post('/api/compiler/validate', compileLimiter, async (req, res) => {
  const body = req.body as CompileRequest;
  if (!body || typeof body !== 'object' || typeof body.fqbn !== 'string') {
    res.status(400).json({ success: false, error: 'Malformed validate request.', errorCode: 'MALFORMED_PROJECT' });
    return;
  }
  const result = await enqueue(() => compileProject(body, true));
  res.status(200).json(result);
});

// Serve the production build when present (optional single-host deployments).
const dist = path.resolve(__dirname, '../dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
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
      if (health.toolchain === 'avr-gcc') {
        const gcc = await detectGccToolchain();
        const uno = findTarget('arduino:avr:uno');
        if (gcc.coreRoot && uno) {
          await ensureCoreArchive(uno, gcc.coreRoot);
          console.log('[CircuitDesk] Arduino core archive ready.');
        }
      }
    } catch (err) {
      console.warn('[CircuitDesk] core warmup failed:', err);
    }
  })();
});
