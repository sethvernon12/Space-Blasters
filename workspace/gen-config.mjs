// Writes workspace/config.local.js (gitignored) from the LOCAL stack env so the
// workspace can talk to it when opened manually. Run:
//   eval "$(supabase status -o env)"; node workspace/gen-config.mjs
import fs from 'node:fs'
const api = (process.env.API_URL || '').replace(/\/$/, '')
const anon = process.env.ANON_KEY || ''
if (!api || !anon) { console.error('Set API_URL + ANON_KEY from `supabase status -o env` first.'); process.exit(1) }
for (const u of [api]) { const h = new URL(u).hostname; if (!['127.0.0.1','localhost','::1'].includes(h)) { console.error('Refusing non-local host:', h); process.exit(1) } }
const js = `// GENERATED, LOCAL-ONLY, gitignored. Local dev key + test child.\nwindow.__WS_CONFIG__ = ${JSON.stringify({ restUrl: api + '/rest/v1', anonKey: anon, name: 'RoundTrip', pin: '2468', record: true }, null, 2)};\n`
fs.writeFileSync(new URL('./config.local.js', import.meta.url), js)
console.log('wrote workspace/config.local.js (local dev config)')
