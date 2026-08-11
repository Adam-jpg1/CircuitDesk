// Centralized compiler backend base URL.
//
// Production (e.g. the Vercel-hosted frontend at https://circuitdesk.site):
//   set VITE_COMPILER_API_URL to the deployed backend URL at build time.
// Local development: falls back to the local compiler server on :3411.

/**
 * The Vite-injected value, when there is one.
 *
 * Vite replaces the whole `import.meta.env.VITE_COMPILER_API_URL` expression
 * with a literal at build time, so this stays a static read for the bundler.
 * Outside Vite — a Node test runner, or any tool that imports this module
 * directly — `import.meta.env` does not exist and reading through it throws;
 * the catch is what lets those callers load the module at all.
 */
function configuredBase(): string | undefined {
  try {
    return import.meta.env.VITE_COMPILER_API_URL as string | undefined;
  } catch {
    return undefined;
  }
}

function environmentBase(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env?.VITE_COMPILER_API_URL || process.env?.CIRCUITDESK_URL || undefined;
}

export const COMPILER_API_BASE: string = (
  configuredBase() ||
  environmentBase() ||
  'http://localhost:3411'
).replace(/\/+$/, '');

export function compilerApiUrl(path: string): string {
  return `${COMPILER_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
