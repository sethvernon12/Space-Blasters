import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Supabase URL + publishable key resolution — FAIL-CLOSED, never silently prod:
//   1. If VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY are set (an
//      UNCOMMITTED hub/.env.local, or the staging project's env), use them.
//      This is how a build is explicitly pointed at LOCAL / DEV / staging.
//   2. Otherwise default to the LOCAL disposable stack — NOT production. A build
//      with no target env therefore talks to localhost (an obvious, safe failure
//      if that stack isn't running), never to the live game's production project.
//      To target DEV/staging/prod you MUST set the env explicitly.
// Only the public browser (publishable/anon) values are ever used here; no
// service-role/admin key exists anywhere in this app.
const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const PROD_REF = 'oafovcrxdjoyaxsytyjg'
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, 'VITE_')
  let url = env.VITE_SUPABASE_URL || ''
  let key = env.VITE_SUPABASE_PUBLISHABLE_KEY || ''
  let source = 'env override (VITE_SUPABASE_*)'
  if (!url || !key) {
    url = url || LOCAL_URL
    key = key || LOCAL_ANON
    source = 'LOCAL default (no env override) — never production'
  }
  if (!url || !key) throw new Error('Could not resolve the Supabase URL/key')
  // Prod is reachable only by an EXPLICIT override, and it's loud when it happens.
  if (url.includes(PROD_REF)) console.warn(`\n[hub] WARNING: build targets the PRODUCTION Supabase project (${PROD_REF}) via an explicit override.\n`)
  console.log(`\n[hub] Supabase target: ${url}  (from ${source})\n`)

  return {
    base: '/',
    // Publish layout: the hub builds to the repo-root dist/; scripts/copy-game.mjs
    // then adds dist/play/index.html (a verbatim copy of the root game).
    build: { outDir: '../dist', emptyOutDir: true },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(here, 'src') } },
    define: {
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(key),
    },
  }
})
