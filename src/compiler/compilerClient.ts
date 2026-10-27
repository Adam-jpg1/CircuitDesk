import type { CircuitProject, CompileResult, CompilerHealth } from '../types';
import { compilerApiUrl } from './apiBase';

export async function fetchCompilerHealth(): Promise<CompilerHealth> {
  try {
    const res = await fetch(compilerApiUrl('/api/compiler/health'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as CompilerHealth;
  } catch (err) {
    console.error('[CircuitDesk] compiler health check failed:', err);
    return {
      available: false,
      toolchain: 'none',
      version: '',
      detail:
        'The CircuitDesk compiler service is not reachable. Locally, start it with "npm run dev"; in production, check VITE_COMPILER_API_URL and the backend deployment.',
    };
  }
}

/**
 * POSTs a compile request, retrying a dropped connection.
 *
 * A pooled keep-alive connection can be closed by the server (or anything in
 * between) between one request and the next, and the fetch that reuses it
 * fails at the transport layer before the compiler ever sees it. The failure
 * looks identical to "the compiler service is down", which is a bad thing to
 * tell someone whose service is running perfectly — so a transport-level
 * failure is retried on a fresh connection rather than reported.
 *
 * Only transport failures are retried. An HTTP response of any status is an
 * answer from the server and is returned untouched: a compile error must not
 * be attempted twice, and a rate limit must not be hammered.
 */
async function postWithRetry(url: string, body: string, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      lastError = err;
      // Back off a little so a genuinely unreachable service is not hammered
      // three times in a row before the user is told.
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function compileProjectCode(
  project: CircuitProject,
  target: {
    /** The target the compiler service is asked for. On its allowlist. */
    boardId: string;
    /**
     * The board the artifact belongs to, when that differs from the target.
     *
     * A custom board compiles as its pipeline's target but the firmware is
     * still its firmware, and the execution paths refuse a mismatch — so the
     * stamp has to be the board that will run it.
     */
    stampBoardId?: string;
    fqbn: string;
    files?: { name: string; content: string }[];
  },
  syntaxOnly = false,
): Promise<CompileResult> {
  const body = {
    projectId: project.id,
    boardId: target.boardId,
    fqbn: target.fqbn,
    // The caller says which files this build is. It matters once boards run
    // different sketches: the builder merges every .ino it is handed, so
    // sending the whole project would compile two boards' sketches together
    // and fail on a duplicate setup(). Callers with one source still send it
    // all, which is what they always did.
    files: (target.files ?? project.codeFiles).map((f) => ({ name: f.name, content: f.content })),
  };
  try {
    const res = await postWithRetry(
      compilerApiUrl(syntaxOnly ? '/api/compiler/validate' : '/api/compiler/compile'),
      JSON.stringify(body),
    );
    // Normalize so error responses (rate limits, proxies) can never produce a
    // result with missing fields that would break the UI.
    const raw = (await res.json()) as Partial<CompileResult>;
    return {
      success: raw.success === true,
      toolchain: raw.toolchain ?? 'none',
      toolchainVersion: raw.toolchainVersion ?? '',
      stdout: raw.stdout ?? '',
      stderr: raw.stderr ?? '',
      diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
      firmware: raw.firmware,
      memory: raw.memory,
      simulationNotes: Array.isArray(raw.simulationNotes) ? raw.simulationNotes : undefined,
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
      error: raw.error ?? (res.ok ? undefined : `Compiler service returned HTTP ${res.status}.`),
      errorCode: raw.errorCode,
      ...(raw.errorCode === 'BUSY' || res.status === 503
        ? { retryAfterSeconds: Math.min(30, Math.max(1, Number(res.headers.get('Retry-After')) || 3)) }
        : {}),
      // Stamped from the requested target so cached firmware always carries the
      // board it was built for; execution paths refuse a mismatch.
      boardId: target.stampBoardId ?? target.boardId,
      fqbn: target.fqbn,
    };
  } catch (err) {
    console.error('[CircuitDesk] compile request failed:', err);
    return {
      success: false,
      toolchain: 'none',
      toolchainVersion: '',
      stdout: '',
      stderr: '',
      diagnostics: [],
      durationMs: 0,
      error:
        'Could not reach the compiler server. Make sure the CircuitDesk backend is running (npm run dev starts both).',
      errorCode: 'TOOLCHAIN_MISSING',
      boardId: target.stampBoardId ?? target.boardId,
      fqbn: target.fqbn,
    };
  }
}

/**
 * What the compiler service can actually build right now.
 *
 * Separate from the health check on purpose: "the service answered" and "the
 * service can build for your board" are different facts, and treating them as
 * one is how a deployment ran for weeks unable to compile for the ESP32-C6
 * while reporting itself healthy. Everything here comes from the backend —
 * nothing in the UI may claim a core is installed without asking.
 */
export interface CompilerCoreStatus {
  id: string;
  expectedVersion: string;
  installedVersion: string | null;
  installed: boolean;
  matchesPin: boolean;
  required: boolean;
  fqbnFamilies: string[];
  reason?: string;
}

export interface CompilerTargetStatus {
  id: string;
  name: string;
  fqbn: string;
  core: string;
  coreVersion: string | null;
  expectedCoreVersion: string | null;
  installed: boolean;
  toolchain: string;
  reason?: string;
}

export interface CompilerCapabilities {
  /** 'unreachable' is this client's own verdict; the rest come from the service. */
  status: 'healthy' | 'degraded' | 'drifted' | 'error' | 'unreachable';
  arduinoCli?: { available: boolean; version: string };
  missingRequiredCores: string[];
  driftedCores: string[];
  cores: CompilerCoreStatus[];
  targets: CompilerTargetStatus[];
}

export async function fetchCompilerCapabilities(): Promise<CompilerCapabilities> {
  try {
    const res = await fetch(compilerApiUrl('/api/compiler/capabilities'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Partial<CompilerCapabilities>;
    return {
      status: raw.status ?? 'error',
      arduinoCli: raw.arduinoCli,
      missingRequiredCores: raw.missingRequiredCores ?? [],
      driftedCores: raw.driftedCores ?? [],
      cores: raw.cores ?? [],
      targets: raw.targets ?? [],
    };
  } catch (err) {
    console.error('[CircuitDesk] compiler capability check failed:', err);
    // Unreachable is not the same as "missing a core", and the caller has to be
    // able to tell them apart to say anything useful.
    return { status: 'unreachable', missingRequiredCores: [], driftedCores: [], cores: [], targets: [] };
  }
}
