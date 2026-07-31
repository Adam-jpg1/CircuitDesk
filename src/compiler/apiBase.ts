// Centralized compiler backend base URL.
//
// Production (e.g. the Vercel-hosted frontend at https://circuitdesk.site):
//   set VITE_COMPILER_API_URL to the deployed backend URL at build time.
// Local development: falls back to the local compiler server on :3411.
export const COMPILER_API_BASE: string = (
  (import.meta.env.VITE_COMPILER_API_URL as string | undefined) || 'http://localhost:3411'
).replace(/\/+$/, '');

export function compilerApiUrl(path: string): string {
  return `${COMPILER_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
