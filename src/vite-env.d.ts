/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the deployed compiler backend (e.g. https://compiler.example.com). */
  readonly VITE_COMPILER_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
