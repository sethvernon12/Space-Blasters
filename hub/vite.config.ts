import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Supabase URL + publishable key resolution:
//   1. If VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY are set (e.g. an
//      UNCOMMITTED hub/.env.local), use them. This is how a LOCAL preview is
//      pointed at the disposable DEV project so sign-in never creates rows in
//      production. .env.local is gitignored and must never be committed.
//   2. Otherwise fall back to the EXACT values already shipped in the live game
//      (root index.html) — the committed default. So any build without an env
//      override targets production, exactly as before.
// Only the public browser (publishable/anon) values are ever used here; no
// service-role/admin key exists anywhere in this app.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, 'VITE_')
  let url = env.VITE_SUPABASE_URL || ''
  let key = env.VITE_SUPABASE_PUBLISHABLE_KEY || ''
  let source = 'hub/.env.local (override)'
  if (!url || !key) {
    const game = fs.readFileSync(path.resolve(here, '..', 'index.html'), 'utf8')
    url = url || game.match(/const URL = '(https:\/\/[a-z0-9]+\.supabase\.co)'/)?.[1] || ''
    key = key || game.match(/const KEY = '(sb_publishable_[A-Za-z0-9_-]+)'/)?.[1] || ''
    source = '../index.html (live-game default — PRODUCTION)'
  }
  if (!url || !key) throw new Error('Could not resolve the Supabase URL/key (env override or ../index.html)')
  // Make the target loud at build time so no one is ever unsure which project a
  // preview talks to.
  console.log(`\n[hub] Supabase target: ${url}  (from ${source})\n`)

  return {
    base: '/',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(here, 'src') } },
    define: {
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(key),
    },
  }
})
