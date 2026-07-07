// ============================================================================
// "Secure the yard" self-test — proves the enforcement kernel at the DB layer
// through the real client path (anon key + user JWT, RLS): authorize() is a
// fail-closed gate, consent is a PRECONDITION (blocks even the parent), the AI
// context pack carries NO name, the audit log is append-only, and per-artifact
// visibility_scope defaults private + is enforced. LOCAL only.
//
// Run (stack up): eval "$(supabase status -o env)"; node db/scripts/secure-yard-test.mjs
// ============================================================================
import pgpkg from 'pg'
import { m3Config, setupFamily, signInAs, mintChildSession, FAMILY } from './family.mjs'
import { buildBatch } from '../../contracts/capture.mjs'

const { Client } = pgpkg
let fails = 0
const ok = (m) => console.log('  ✓', m)
const bad = (m) => { fails++; console.error('  ✗', m) }
const uuid = () => crypto.randomUUID()
const cfg = m3Config()
const A = FAMILY.alpha, B = FAMILY.beta
const CID = { Brielle: A.children.brielle.childId, Theo: A.children.theo.childId, Wren: B.children.wren.childId }

console.log('Setup + Brielle records a real set…')
const uids = await setupFamily(cfg)
const S = {}
for (const [w, e] of [['seth', A.parent.email], ['rose', A.tutor.email], ['obs', A.observer.email], ['dana', B.parent.email]]) S[w] = await signInAs(cfg, e)
S.brielle = await mintChildSession(cfg, S.seth.client, CID.Brielle) // children enter via the real mint
S.theo = await mintChildSession(cfg, S.seth.client, CID.Theo)
{
  const ses = uuid()
  const evs = Array.from({ length: 8 }, (_, i) => ({ clientAttemptId: uuid(), clientSessionId: ses, stageIndex: 0, skill: 'addition', result: i === 5 ? 'incorrect' : 'correct', problemText: '2 + 3', correctAnswer: 5, chosenAnswer: i === 5 ? 4 : 5, responseMs: 3000, inputMethod: 'tap', asrConfidence: null, runTimeS: i, level: 1, mode: 'journey', context: { source: 'sy' } }))
  await S.brielle.client.rpc('record_attempts_authed', { p_child_id: CID.Brielle, p_batch: buildBatch(evs) })
}
const az = async (who, child, action = 'child.summary.read') => (await S[who].client.rpc('authorize', { p_action: action, p_child_id: child })).data

// ---- 1. authorize() allow/deny matrix ----
console.log('authorize() gate (default DENY):')
for (const [who, exp] of [['seth', true], ['brielle', true], ['rose', true], ['obs', true], ['theo', false], ['dana', false]]) {
  const r = await az(who, CID.Brielle)
  r.allow === exp ? ok(`read Brielle as ${who} → ${r.allow ? 'allow' : 'deny(' + r.reason + ')'}`) : bad(`${who}: allow=${r.allow} want ${exp}`)
}

// ---- 2. context pack: whitelist, NO name ----
console.log('child_context_pack() (whitelist, name un-emittable by omission):')
{
  const pack = (await S.seth.client.rpc('child_context_pack', { p_child_id: CID.Brielle })).data
  const js = JSON.stringify(pack)
  !js.includes('Brielle') && !js.toLowerCase().includes('nickname') ? ok('pack contains NO name/nickname') : bad(`pack leaked identity: ${js.slice(0, 160)}`)
  pack?.child_id === CID.Brielle && Array.isArray(pack.skills) && pack.skills.length > 0 ? ok(`pack keyed by opaque child_id, ${pack.skills.length} skill(s), add5 mastery ${pack.skills.find(s => s.skill_id === 'add5')?.mastery}`) : bad(`pack shape wrong: ${js.slice(0, 160)}`)
}
{
  const pd = (await S.dana.client.rpc('child_context_pack', { p_child_id: CID.Brielle })).data
  pd?.denied === true ? ok('cross-family context pack → denied') : bad(`dana pack: ${JSON.stringify(pd)}`)
}

// ---- 3. audit_log append-only ----
console.log('audit_log (append-only):')
let auditId
{
  auditId = (await S.seth.client.rpc('write_audit', { p_action: 'child.summary.read', p_child_id: CID.Brielle, p_decision: 'allow', p_detail: { provider: 'mock', model: 'deterministic-summary-v1', prompt_version: 'summary-v1' } })).data
  auditId ? ok('write_audit appended a row') : bad('write_audit failed')
  const rows = (await S.seth.client.from('audit_log').select('id,decision').eq('child_id', CID.Brielle)).data
  rows?.some((r) => r.id === auditId) ? ok('guardian reads the audit row') : bad('audit not readable by guardian')
  const upd = await S.seth.client.from('audit_log').update({ decision: 'deny' }).eq('id', auditId).select()
  ;(upd.error || !upd.data?.length) ? ok('UPDATE audit_log → blocked (immutable)') : bad('audit UPDATE not blocked')
  const del = await S.seth.client.from('audit_log').delete().eq('id', auditId).select()
  ;(del.error || !del.data?.length) ? ok('DELETE audit_log → blocked (immutable)') : bad('audit DELETE not blocked')
  const cross = (await S.dana.client.from('audit_log').select('id').eq('child_id', CID.Brielle)).data
  !cross?.length ? ok('other family cannot read the audit row') : bad('audit cross-family read leak')
}

// ---- 4. visibility_scope default-private + enforced ----
console.log('visibility_scope (default private, enforced):')
{
  const priv = (await S.seth.client.from('teaching_artifacts').insert({ child_id: CID.Brielle, author_id: uids.seth, author_role: 'parent', kind: 'feedback', payload: { note: 'p' } }).select()).data
  const privId = priv?.[0]?.id
  priv?.[0]?.visibility_scope === 'private' ? ok('new artifact defaults to visibility_scope=private') : bad(`default not private: ${JSON.stringify(priv?.[0])}`)
  const seenAuthor = (await S.seth.client.from('teaching_artifacts').select('id').eq('id', privId)).data
  seenAuthor?.length === 1 ? ok('author/guardian sees the private artifact') : bad('guardian cannot see own private artifact')
  const seenRose = (await S.rose.client.from('teaching_artifacts').select('id').eq('id', privId)).data
  !seenRose?.length ? ok('non-author tutor does NOT see the private artifact') : bad('PRIVATE LEAK to tutor')
  const fam = (await S.rose.client.from('teaching_artifacts').insert({ child_id: CID.Brielle, author_id: uids.rose, author_role: 'tutor', kind: 'feedback', payload: {}, visibility_scope: 'family' }).select()).data
  const seenObs = (await S.obs.client.from('teaching_artifacts').select('id').eq('id', fam?.[0]?.id)).data
  seenObs?.length === 1 ? ok('family-scoped artifact IS visible to a viewer (observer)') : bad('family artifact not visible to observer')
}

// ---- K2 (0013): child-visible artifacts pass the moderation choke on insert ----
console.log('K2 (child-visible artifact moderation):')
{
  const child = (await S.seth.client.from('teaching_artifacts').insert({ child_id: CID.Brielle, author_id: uids.seth, author_role: 'parent', kind: 'feedback', payload: { feedback: 'Great — go to http://cheats.example.com' }, visibility_scope: 'sent-to-child' }).select()).data?.[0]
  const priv = (await S.seth.client.from('teaching_artifacts').insert({ child_id: CID.Brielle, author_id: uids.seth, author_role: 'parent', kind: 'feedback', payload: { feedback: 'private ref http://internal.example.com' }, visibility_scope: 'private' }).select()).data?.[0]
  const childClean = !/cheats\.example\.com/.test(child?.payload?.feedback ?? '')
  const privKept = /internal\.example\.com/.test(priv?.payload?.feedback ?? '')  // private is not child-visible → not moderated
  childClean && privKept ? ok('link in a sent-to-child feedback is moderated; a private artifact is left untouched') : bad(`K2: childClean=${childClean} privKept=${privKept} priv=${JSON.stringify(priv?.payload)}`)
}

// ---- 5. revoked grant loses authorize ----
console.log('revocation:')
{
  await S.seth.client.from('tutor_grants').update({ active: false }).eq('tutor_id', uids.rose).eq('child_id', CID.Brielle)
  const r = await az('rose', CID.Brielle)
  r.allow === false ? ok('revoked tutor → authorize denies') : bad(`revoked rose still allowed: ${JSON.stringify(r)}`)
}

// ---- 6. assignments UPDATE can't forge provenance (0006 #6) ----
console.log('assignments provenance:')
{
  const ins = (await S.seth.client.from('assignments').insert({ child_id: CID.Brielle, assigned_by: uids.seth, skill_id: 'add5', title: 'prov' }).select()).data
  const aid = ins?.[0]?.id
  const forge = await S.seth.client.from('assignments').update({ assigned_by: uids.rose }).eq('id', aid).select()
  ;(forge.error || !forge.data?.length) ? ok('cannot forge assigned_by via assignments UPDATE') : bad('assigned_by forge NOT blocked')
  const status = await S.seth.client.from('assignments').update({ status: 'done' }).eq('id', aid).select()
  !status.error && status.data?.length === 1 ? ok('legit status update still allowed') : bad(`status update failed: ${status.error?.message}`)
}

// ---- 7. consent is a PRECONDITION — blocks reads AND the gate; no oracle (restore after) ----
console.log('consent precondition (0006 #2 + #4):')
{
  const c = new Client({ connectionString: cfg.dbUrl }); await c.connect()
  const saved = (await c.query(`select consent_id from public.children where id=$1`, [CID.Brielle])).rows[0].consent_id
  await c.query(`update public.children set consent_id=null where id=$1`, [CID.Brielle])
  // the gate blocks even the parent
  const r = await az('seth', CID.Brielle)
  r.allow === false && r.reason === 'no_consent' ? ok('missing consent BLOCKS even the parent (no_consent)') : bad(`consent gate: ${JSON.stringify(r)}`)
  const pd = (await S.seth.client.rpc('child_context_pack', { p_child_id: CID.Brielle })).data
  pd?.denied && pd.reason === 'no_consent' ? ok('context pack denied when consent missing') : bad(`pack no-consent: ${JSON.stringify(pd)}`)
  // ACC-03 extended to RAW READS: even the parent reads nothing with consent missing
  const mast = (await S.seth.client.from('child_skill_mastery').select('skill_id').eq('child_id', CID.Brielle)).data
  const att = (await S.seth.client.from('attempts').select('id').eq('child_id', CID.Brielle)).data
  ;(!mast?.length && !att?.length) ? ok('missing consent BLOCKS raw mastery + attempts reads (even the parent)') : bad(`consent-on-reads leak: mastery=${mast?.length} attempts=${att?.length}`)
  // no consent-state oracle: an UNSCOPED caller gets not_authorized, never no_consent
  const ot = await az('theo', CID.Brielle)
  const od = await az('dana', CID.Brielle)
  ot.reason === 'not_authorized' && od.reason === 'not_authorized' ? ok('unscoped callers get not_authorized (no consent-state oracle)') : bad(`oracle leak: theo=${ot.reason} dana=${od.reason}`)
  await c.query(`update public.children set consent_id=$1 where id=$2`, [saved, CID.Brielle])
  await c.end()
}

console.log(fails ? `\nSECURE-YARD: ${fails} FAIL` : '\nSECURE-YARD: ALL PASS')
process.exit(fails ? 1 : 0)
