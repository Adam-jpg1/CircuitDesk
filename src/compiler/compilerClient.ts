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

export async function compileProjectCode(project: CircuitProject, syntaxOnly = false): Promise<CompileResult> {
  const body = {
    projectId: project.id,
    fqbn: project.settings.boardFqbn ?? 'arduino:avr:uno',
    files: project.codeFiles.map((f) => ({ name: f.name, content: f.content })),
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
    };
  }
}
