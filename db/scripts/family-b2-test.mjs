// ============================================================================
// B2 self-test — the per-child READ path made real. Brielle records a real
// practice set (record_attempts_authed, her own session); then getMastery /
// getNextActivity are read through each role's AUTHENTICATED client and RLS
// scopes them: owner + granted tutor get her real numbers, everyone else gets
// nothing, and revoking the grant cuts the tutor off. Invents no data.
//
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/family-b2-test.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, FAMILY } from './family.mjs'
import { buildBatch, getMastery, getNextActivity } from '../../contracts/capture.mjs'

const { Client } = pgpkg
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()

const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { brielle: A.children.brielle.childId, theo: A.children.theo.childId }
const transportFor = (s) => ({ restUrl: cfg.apiUrl + '/rest/v1', anonKey: cfg.anonKey, accessToken: s.session.access_token })

console.log('Setting up families + signing in…')
const uids = await setupFamily(cfg)
const S = {}
for (const [who, email] of [
  ['seth', A.parent.email], ['rose', A.tutor.email], ['obs', A.observer.email],
  ['brielle', A.children.brielle.email], ['dana', B.parent.email],
]) S[who] = await signInAs(cfg, email)

// ---- Brielle records a REAL set (7 of 8 correct on add5) via her own session ----
console.log('Brielle records a real practice set (record_attempts_authed):')
{
  const session = uuid()
  const events = Array.from({ length: 8 }, (_, i) => ({
    clientAttemptId: uuid(), clientSessionId: session, stageIndex: 0, skill: 'addition',
    result: i === 3 ? 'incorrect' : 'correct', problemText: '2 + 3', correctAnswer: 5,
    chosenAnswer: i === 3 ? 4 : 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null,
    runTimeS: i * 4, level: 1, mode: 'journey', context: { source: 'b2' },
  }))
  const { data, error } = await S.brielle.client.rpc('record_attempts_authed', { p_child_id: CID.brielle, p_batch: buildBatch(events) })
  data?.ok && data.inserted === 8 ? ok('Brielle recorded 8 attempts (7 correct) on add5') : bad(`record failed: ${JSON.stringify(data || error?.message)}`)
}

// ---- getMastery is real + identical for everyone RLS lets read ----
console.log('getMastery is RLS-scoped and real:')
const add5Of = (m) => m.skills.find((s) => s.skillKey === 'add5')
async function masteryVia(who) { return getMastery(transportFor(S[who]), CID.brielle) }
{
  const b = await masteryVia('brielle'), a = add5Of(b)
  a && a.attempts === 8 && a.correct === 7 && Math.abs(a.mastery - 0.8) < 1e-9 && a.subject === 'math'
    ? ok(`brielle (child) reads her add5: attempts 8, correct 7, mastery ${a.mastery.toFixed(2)}, subject ${a.subject}`)
    : bad(`brielle read wrong: ${JSON.stringify(a)}`)
}
for (const who of ['seth', 'rose', 'obs']) {
  const a = add5Of(await masteryVia(who))
  a && a.attempts === 8 && a.correct === 7 ? ok(`${who} reads Brielle's add5 (same real numbers)`) : bad(`${who} read wrong: ${JSON.stringify(a)}`)
}
{
  const d = await masteryVia('dana')
  d.skills.length === 0 ? ok('dana (other family) reads Brielle → empty (RLS blocks)') : bad(`dana should see nothing: ${JSON.stringify(d.skills)}`)
}
{
  const t = await getMastery(transportFor(S.brielle), CID.theo)
  t.skills.length === 0 ? ok('brielle reads Theo (not her) → empty') : bad(`brielle→Theo should be empty: ${JSON.stringify(t.skills)}`)
}

// ---- getNextActivity is derived from the real mastery ----
console.log('getNextActivity derives from real mastery:')
{
  const na = await getNextActivity(transportFor(S.brielle), CID.brielle)
  na && na.focusSkill === 'add5' && na.action ? ok(`next activity: ${na.action} on ${na.displayName} — "${na.reason}"`) : bad(`next activity wrong: ${JSON.stringify(na)}`)
  const none = await getNextActivity(transportFor(S.dana), CID.brielle)
  none === null ? ok('dana gets no recommendation for Brielle (nothing visible)') : bad('dana should get null')
}

// ---- revoke the tutor grant → the tutor loses the read ----
console.log('revocation cuts access:')
{
  const { error } = await S.seth.client.from('tutor_grants').update({ active: false }).eq('tutor_id', uids.rose).eq('child_id', CID.brielle)
  if (error) bad(`seth revoke failed: ${error.message}`)
  const afterRose = await masteryVia('rose')
  afterRose.skills.length === 0 ? ok('after revoke, rose reads Brielle → empty (access cut)') : bad(`rose should be cut off: ${JSON.stringify(afterRose.skills)}`)
  const stillObs = add5Of(await masteryVia('obs'))
  stillObs && stillObs.attempts === 8 ? ok('obs (still-active grant) still reads Brielle') : bad('obs should still read')
}

// ---- DB cross-check (test-side pg) ----
console.log('DB cross-check:')
{
  const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
  try {
    const { rows } = await c.query(`select attempts_count, correct_count, alpha, beta from public.child_skill_mastery where child_id=$1 and skill_id='add5'`, [CID.brielle])
    rows.length === 1 && rows[0].attempts_count === 8 && rows[0].correct_count === 7
      ? ok(`db: add5 mastery attempts_count=8, correct_count=7 (α=${(+rows[0].alpha).toFixed(1)}, β=${(+rows[0].beta).toFixed(1)})`)
      : bad(`db mastery wrong: ${JSON.stringify(rows)}`)
  } finally { await c.end() }
}

console.log(fails ? `\nB2: ${fails} FAIL` : '\nB2: ALL PASS')
process.exit(fails ? 1 : 0)
