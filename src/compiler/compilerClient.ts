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

export async function compileProjectCode(
  project: CircuitProject,
  target: { boardId: string; fqbn: string; files?: { name: string; content: string }[] },
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
    const res = await fetch(compilerApiUrl(syntaxOnly ? '/api/compiler/validate' : '/api/compiler/compile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
      error: raw.error ?? (res.ok ? undefined : `Compiler service returned HTTP ${res.status}.`),
      errorCode: raw.errorCode,
      // Stamped from the requested target so cached firmware always carries the
      // board it was built for; execution paths refuse a mismatch.
      boardId: target.boardId,
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
      boardId: target.boardId,
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
