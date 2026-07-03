import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Reuse the EXACT Supabase URL + publishable key already shipped in the live
// game (root index.html). Read at build time so there is ONE source of truth
// and no new key is ever introduced here. These are the public browser values;
// no service-role/admin key exists anywhere in this app.
const game = fs.readFileSync(path.resolve(here, '..', 'index.html'), 'utf8')
const url = game.match(/const URL = '(https:\/\/[a-z0-9]+\.supabase\.co)'/)?.[1]
const key = game.match(/const KEY = '(sb_publishable_[A-Za-z0-9_-]+)'/)?.[1]
if (!url || !key) throw new Error('Could not read the Supabase URL/key from ../index.html')

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(here, 'src') } },
  define: {
    __SUPABASE_URL__: JSON.stringify(url),
    __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(key),
  },
})
