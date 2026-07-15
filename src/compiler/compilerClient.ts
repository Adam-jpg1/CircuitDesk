import type { CircuitProject, CompileResult, CompilerHealth } from '../types';

export async function fetchCompilerHealth(): Promise<CompilerHealth> {
  try {
    const res = await fetch('/api/compiler/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as CompilerHealth;
  } catch {
    return {
      available: false,
      toolchain: 'none',
      version: '',
      detail:
        'The CircuitDesk compiler server is not reachable. Start it with "npm run dev" (it listens on port 3411).',
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
    const res = await fetch(syntaxOnly ? '/api/compiler/validate' : '/api/compiler/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as CompileResult;
  } catch (err) {
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
