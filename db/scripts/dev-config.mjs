// DEV-mode config for the staging verification harness. Whitelists the DEV
// Supabase project ref and HARD-REFUSES the prod ref — never runs against prod.
// Used ONLY by server-side verification/seed tooling; the service key it reads
// is never deployed or placed in any client.
export const DEV_REF = 'appplvbgyghlhrjcaagn'
export const PROD_REF = 'oafovcrxdjoyaxsytyjg'

export function assertDevRef(url) {
  const s = String(url || '')
  if (s.includes(PROD_REF)) throw new Error(`REFUSING prod ref ${PROD_REF} — this tooling only ever targets DEV.`)
  if (!s.includes(DEV_REF)) throw new Error(`Expected DEV ref ${DEV_REF} in "${s || '(empty)'}" — refusing (not a DEV target).`)
  return true
}

export function devConfig() {
  const apiUrl = (process.env.DEV_SUPABASE_URL || '').replace(/\/$/, '')
  const anonKey = process.env.DEV_SUPABASE_ANON_KEY || ''
  const serviceKey = process.env.DEV_SUPABASE_SERVICE_KEY || ''
  const dbUrl = process.env.DEV_SUPABASE_DB_URL || ''
  if (!apiUrl || !anonKey || !serviceKey || !dbUrl) {
    throw new Error('Set DEV_SUPABASE_URL / DEV_SUPABASE_ANON_KEY / DEV_SUPABASE_SERVICE_KEY / DEV_SUPABASE_DB_URL (DEV project appplvbgyghlhrjcaagn).')
  }
  assertDevRef(apiUrl)
  assertDevRef(dbUrl)
  return { apiUrl, anonKey, serviceKey, dbUrl }
}
