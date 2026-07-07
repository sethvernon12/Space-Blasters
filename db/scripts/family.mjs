// ============================================================================
// family.mjs — LOCAL-ONLY family setup + role session helpers for Milestone 3.
//
// Mints GoTrue users (parent/child/tutor) for TWO families and seeds their
// children/consent/tutor_grants, so RLS-scoped reads can be exercised as each
// real role. The SERVICE key is used ONLY here (admin user-minting + pg seed) —
// it never touches a client. Role clients use the ANON key + the user's JWT.
// Refuses any non-localhost host.
// ============================================================================
import { createClient } from '@supabase/supabase-js'
import pgpkg from 'pg'
import { applySchema, FILES_M3 } from './local-stack.mjs'

const { Client } = pgpkg
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1'])
const PW = 'localtest123' // LOCAL test password (not a secret)

export function m3Config() {
  const apiUrl = (process.env.API_URL || '').replace(/\/$/, '')
  const anonKey = process.env.ANON_KEY || ''
  const serviceKey = process.env.SERVICE_ROLE_KEY || ''
  const dbUrl = process.env.DB_URL || ''
  if (!apiUrl || !anonKey || !serviceKey || !dbUrl)
    throw new Error('Missing API_URL / ANON_KEY / SERVICE_ROLE_KEY / DB_URL — source `supabase status -o env` (local).')
  for (const u of [apiUrl, dbUrl]) {
    if (!LOCAL.has(new URL(u).hostname)) throw new Error(`REFUSING non-local host in ${u} — local stack only.`)
  }
  return { apiUrl, anonKey, serviceKey, dbUrl }
}

// The family: opaque child_ids; local emails + one shared test password.
export const FAMILY = {
  alpha: {
    parent: { email: 'seth@local.test', role: 'parent' },
    tutor: { email: 'rose@local.test', role: 'tutor' },
    observer: { email: 'obs@local.test', role: 'observer' }, // view-only grant (can_write=false)
    children: {
      brielle: { childId: 'b1e11e00-0000-4000-8000-000000000001', nickname: 'Brielle', gradeBand: '1', email: 'brielle@local.test' },
      theo: { childId: 'b1e11e00-0000-4000-8000-000000000002', nickname: 'Theo', gradeBand: 'K', email: 'theo@local.test' },
    },
  },
  beta: {
    parent: { email: 'dana@local.test', role: 'parent' },
    children: {
      wren: { childId: 'b1e11e00-0000-4000-8000-000000000003', nickname: 'Wren', gradeBand: '2', email: 'wren@local.test' },
    },
  },
}
export const PASSWORD = PW

export function adminClient(cfg) {
  return createClient(cfg.apiUrl, cfg.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

// Sign in as a role -> a client that carries the user's JWT (anon key + Bearer).
export async function signInAs(cfg, email, password = PW) {
  const c = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  return { client: c, uid: data.user.id, session: data.session }
}

// Enter a child through the REAL mint path (never a password): the PARENT proves
// ownership via authorize_and_record_mint (rate-limited + audited), then a GoTrue
// one-time link is exchanged SERVER-SIDE into the child's session. This mirrors
// the start-child-session Edge Function exactly (that HTTP wrapper is exercised +
// attacked in the mint self-test). Returns a client carrying the child session.
export async function mintChildSession(cfg, parentClient, childId) {
  const { data: az, error: azErr } = await parentClient.rpc('authorize_and_record_mint', { p_child_id: childId })
  if (azErr || !az?.ok) throw new Error(`mint authz failed for ${childId}: ${azErr?.message || az?.error}`)
  const admin = adminClient(cfg)
  const { data: u } = await admin.auth.admin.getUserById(az.auth_user_id)
  const email = u?.user?.email
  if (!email) throw new Error(`no handle for child ${childId}`)
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr || !link?.properties?.hashed_token) throw new Error(`generateLink failed: ${linkErr?.message}`)
  const exchanger = createClient(cfg.apiUrl, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: sess, error: vErr } = await exchanger.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr || !sess?.session) throw new Error(`verifyOtp failed: ${vErr?.message}`)
  return { client: exchanger, uid: az.auth_user_id, session: sess.session }
}

async function mintUser(admin, email) {
  // delete-then-create so each run gets a deterministic, fresh user
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const existing = list.users.find((u) => u.email === email)
  if (existing) await admin.auth.admin.deleteUser(existing.id)
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true })
  if (error) throw new Error(`createUser ${email}: ${error.message}`)
  return data.user.id
}

// Apply the M3 schema (LOCAL: drops + rebuilds public), then seed. Returns uids.
export async function setupFamily(cfg) {
  await applySchema(cfg.dbUrl, FILES_M3)
  return seedFamily(cfg)
}

// Seed the two synthetic families onto an ALREADY-MIGRATED schema (mint users +
// children/consent/grants) WITHOUT touching the schema. Used by the DEV staging
// verify, where migrations are applied via the Supabase MCP (never a drop).
// Assumes a fresh schema (no prior synthetic rows) — to re-seed, reset first.
export async function seedFamily(cfg) {
  const admin = adminClient(cfg)

  // mint users
  const uids = {}
  uids.seth = await mintUser(admin, FAMILY.alpha.parent.email)
  uids.rose = await mintUser(admin, FAMILY.alpha.tutor.email)
  uids.obs = await mintUser(admin, FAMILY.alpha.observer.email)
  uids.brielle = await mintUser(admin, FAMILY.alpha.children.brielle.email)
  uids.theo = await mintUser(admin, FAMILY.alpha.children.theo.email)
  uids.dana = await mintUser(admin, FAMILY.beta.parent.email)
  uids.wren = await mintUser(admin, FAMILY.beta.children.wren.email)

  // seed children + consent + tutor grant (service-side pg; RLS bypassed here by
  // the superuser connection — this is the SEED path, not a client)
  const c = new Client({ connectionString: cfg.dbUrl })
  await c.connect()
  try {
    // idempotent re-seed: clear any prior synthetic child data (cascades to all
    // child-scoped tables). No-op locally (applySchema already dropped public);
    // on DEV it clears a prior seed so this run starts clean.
    await c.query('truncate public.children cascade')
    const seedChild = async (childId, parentUid, childUid, nickname, gradeBand) => {
      await c.query(
        `insert into public.children (id, parent_id, auth_user_id, nickname, grade_band) values ($1,$2,$3,$4,$5)`,
        [childId, parentUid, childUid, nickname, gradeBand])
      const { rows } = await c.query(
        `insert into public.consent_ledger (parent_id, child_id, action, method, policy_version)
         values ($1,$2,'grant','stripe_card_transaction','local-m3') returning id`,
        [parentUid, childId])
      await c.query(`update public.children set consent_id = $1 where id = $2`, [rows[0].id, childId])
    }
    const A = FAMILY.alpha, B = FAMILY.beta
    await seedChild(A.children.brielle.childId, uids.seth, uids.brielle, A.children.brielle.nickname, A.children.brielle.gradeBand)
    await seedChild(A.children.theo.childId, uids.seth, uids.theo, A.children.theo.nickname, A.children.theo.gradeBand)
    await seedChild(B.children.wren.childId, uids.dana, uids.wren, B.children.wren.nickname, B.children.wren.gradeBand)

    // Grandma Rose is a TEACHING tutor for BRIELLE ONLY (not Theo, not Wren)
    await c.query(
      `insert into public.tutor_grants (tutor_id, child_id, granted_by, active, role, can_write)
       values ($1,$2,$3,true,'tutor',true)`,
      [uids.rose, A.children.brielle.childId, uids.seth])
    // A VIEW-ONLY observer for Brielle (can_write=false) — proves can_write_child
    // excludes read-only grants. (Each grant also logs a disclosure consent event.)
    await c.query(
      `insert into public.tutor_grants (tutor_id, child_id, granted_by, active, role, can_write)
       values ($1,$2,$3,true,'observer',false)`,
      [uids.obs, A.children.brielle.childId, uids.seth])
  } finally {
    await c.end()
  }
  return uids
}
