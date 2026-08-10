/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the deployed compiler backend (e.g. https://compiler.example.com). */
  readonly VITE_COMPILER_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// The third-party notices file is imported as text so the Licenses page and
// the repository's own notices cannot drift apart.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
