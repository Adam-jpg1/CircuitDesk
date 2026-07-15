import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCompilerHealth, compileProject } from './compiler/compilerService.js';
import { SUPPORTED_TARGETS, type CompileRequest } from './compiler/types.js';
import { detectGccToolchain, ensureCoreArchive } from './compiler/gccToolchain.js';
import { findTarget } from './compiler/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 3411);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/compiler/health', async (_req, res) => {
  try {
    res.json(await getCompilerHealth());
  } catch (err) {
    res.status(500).json({ available: false, toolchain: 'none', version: '', detail: String(err) });
  }
});

app.get('/api/compiler/boards', (_req, res) => {
  res.json({ targets: SUPPORTED_TARGETS });
});

/** One compile at a time keeps resource usage bounded on small machines. */
let compileQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = compileQueue.then(fn, fn);
  compileQueue = next.catch(() => undefined);
  return next;
}

app.post('/api/compiler/compile', async (req, res) => {
  const body = req.body as CompileRequest;
  if (!body || typeof body !== 'object' || typeof body.fqbn !== 'string') {
    res.status(400).json({ success: false, error: 'Malformed compile request.', errorCode: 'MALFORMED_PROJECT' });
    return;
  }
  const result = await enqueue(() => compileProject(body, false));
  res.status(result.errorCode === 'MALFORMED_PROJECT' ? 400 : 200).json(result);
});

app.post('/api/compiler/validate', async (req, res) => {
  const body = req.body as CompileRequest;
  if (!body || typeof body !== 'object' || typeof body.fqbn !== 'string') {
    res.status(400).json({ success: false, error: 'Malformed validate request.', errorCode: 'MALFORMED_PROJECT' });
    return;
  }
  const result = await enqueue(() => compileProject(body, true));
  res.status(200).json(result);
});

// Serve the production build when present.
const dist = path.resolve(__dirname, '../dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[CircuitDesk] compiler server listening on http://localhost:${PORT}`);
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
