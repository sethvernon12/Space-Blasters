// ============================================================================
// verify-bundle.mjs — deployment PROVENANCE + safety scan of a live hub build.
// Fetches the LIVE HTML, extracts the content-hashed JS asset it actually
// references, fetches THAT asset, and in one pass records:
//   * the asset URL + its SHA-256 (the provenance anchor for the deploy record)
//   * POSITIVE control — a marker that MUST be present (build is the real thing)
//   * NEGATIVE markers — dev-switcher / synthetic-account strings that MUST be
//     absent (flag-off front door, no synthetic creds leaked)
//   * SECRET patterns — Stripe/Google/webhook keys + any embedded service_role JWT
// Exits non-zero on any positive-missing / negative-present / secret hit.
//
// Run: node scripts/verify-bundle.mjs https://theallaroundathleteacademy.com
// ============================================================================
import { createHash } from 'node:crypto'

const url = process.argv[2]
if (!url) { console.error('usage: node scripts/verify-bundle.mjs <https url>'); process.exit(2) }
const origin = new URL(url).origin

const POSITIVE = ['with Google']                          // flag-off Google front door
const NEGATIVE = ['@local.test', 'localtest123', 'Sign in as'] // dev switcher must be tree-shaken
const SECRETS = [/sk_test_[0-9A-Za-z]/, /sk_live_[0-9A-Za-z]/, /whsec_[0-9A-Za-z]/, /GOCSPX-/, /service_role/]

let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }

const html = await (await fetch(url)).text()
const assetPath = html.match(/\/assets\/index-[A-Za-z0-9_]+\.js/)?.[0]
if (!assetPath) { console.error('could not find /assets/index-*.js in the live HTML'); process.exit(1) }
const assetUrl = origin + assetPath
const js = await (await fetch(assetUrl)).text()          // undici auto-decompresses
const sha = createHash('sha256').update(js).digest('hex')

console.log(`\nPROVENANCE`)
console.log(`  asset : ${assetUrl}`)
console.log(`  bytes : ${js.length}`)
console.log(`  sha256: ${sha}`)

console.log(`\nPOSITIVE control (must be present)`)
for (const s of POSITIVE) (js.includes(s) ? ok : bad)(`present: "${s}"`)

console.log(`\nNEGATIVE markers (must be absent)`)
for (const s of NEGATIVE) (js.includes(s) ? bad : ok)(`absent: "${s}"`)

console.log(`\nSECRET patterns (must be absent)`)
for (const re of SECRETS) { const m = js.match(re); (m ? bad : ok)(`no match: ${re}${m ? ` — HIT "${m[0]}"` : ''}`) }
// decode every JWT-looking token and check the payload role (embedded key catch)
let jwtHit = false
for (const tok of js.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/g) ?? []) {
  try {
    const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString())
    if (payload?.role === 'service_role') { jwtHit = true; bad(`embedded service_role JWT (${tok.slice(0, 12)}…)`) }
  } catch { /* not a JWT */ }
}
if (!jwtHit) ok('no embedded service_role JWT')

console.log(fails ? `\n=== VERIFY-BUNDLE: ${fails} FAIL ===` : `\n=== VERIFY-BUNDLE: CLEAN (sha256 ${sha.slice(0, 16)}…) ===`)
process.exit(fails ? 1 : 0)
