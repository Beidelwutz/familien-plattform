/// <reference path="../.astro/types.d.ts" />

/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Backend API base URL. Set in Vercel/Production to your API (e.g. https://api.kiezling.com). Default: http://localhost:4000 */
  readonly PUBLIC_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}