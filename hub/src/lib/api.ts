// The hub's data layer. Every call goes through the anon-key + user-JWT client,
// so RLS scopes it. Reads/writes MIRROR the frozen contract in
// contracts/capture.mjs + contracts/activity.mjs (the canonical seams the db
// isolation tests exercise); kept as small TS here to stay inside the hub build.
import { supabase } from './supabase'

export interface ChildRow { id: string; nickname: string; grade_band: string | null; parent_id: string | null; auth_user_id: string | null; consent_id: string | null }
export interface Grant { child_id: string; can_write: boolean; active: boolean }
export interface SkillMastery { skillKey: string; displayName: string; subject: string; mastery: number; attempts: number; correct: number; position: number }
export interface NextActivity { action: 'keep_practicing' | 'ease' | 'advance'; icon: string; reason: string; focusSkill: string; displayName: string }
export interface Assignment { id: string; title: string; skill_id: string; status: string; created_at: string }
export interface Artifact { id: string; kind: string; author_role: string; payload: Record<string, unknown>; created_at: string }

interface MasteryRow {
  skill_id: string; alpha: number | string; beta: number | string; attempts_count: number; correct_count: number
  skills: { display_name: string; subject: string; position: number } | null
}

export async function loadChildrenAndGrants(): Promise<{ children: ChildRow[]; grants: Grant[] }> {
  const [kids, grants] = await Promise.all([
    supabase.from('children').select('id,nickname,grade_band,parent_id,auth_user_id,consent_id'),
    supabase.from('tutor_grants').select('child_id,can_write,active'),
  ])
  return { children: (kids.data ?? []) as ChildRow[], grants: (grants.data ?? []) as Grant[] }
}

// Start the consent Checkout for a new child (Phase 3.5). Returns the Stripe
// Checkout URL to redirect to; on payment, the signature-verified webhook creates
// the child + immutable consent atomically (no child row exists before consent).
// parent_uid is stamped server-side by the function — never sent from here.
export async function startConsentCheckout(nickname: string, gradeBand: string | null): Promise<{ url: string } | { error: string }> {
  const { data, error } = await supabase.functions.invoke('create-consent-checkout', {
    body: { nickname, gradeBand, returnUrl: window.location.origin },
  })
  if (error) return { error: error.message }
  if (!data?.url) return { error: data?.reason ?? 'checkout_failed' }
  return { url: data.url }
}

export interface Disposition {
  deleted: Record<string, number>
  tombstoned: Record<string, number>
  retained: string[]
  entitlement: string
}
export interface DeletionReceipt {
  id: string; child_id: string; parent_id: string; child_auth_user_id: string | null
  deleting_actor: string; revoke_consent_id: string | null; disposition: Disposition
  prev_receipt_hash: string | null; receipt_hash: string; status: string
  db_purged_at: string; completed_at: string | null; created_at: string
}
export interface DeleteResult { ok: true; status: string; receipt_id: string; receipt_hash: string; disposition: Disposition; idempotent: boolean }

// Consent revocation -> hard deletion (Slice A/B). The Edge function is the gate:
// parent-ownership + non-child + FRESH step-up re-auth + rate-limit BEFORE any
// destruction, then the atomic purge + immutable receipt. A stale token comes back
// as `reauth` so the UI can re-verify; legal_hold / rate_limited surface verbatim.
export async function deleteChild(childId: string): Promise<DeleteResult | { error: string; reauth?: boolean }> {
  const { data, error } = await supabase.functions.invoke('delete-child', { body: { childId } })
  if (error) {
    let body: { error?: string } | null = null
    let status = 0
    // supabase-js surfaces a non-2xx as FunctionsHttpError; the body is on .context
    const ctx = (error as { context?: Response }).context
    if (ctx) { status = ctx.status; try { body = await ctx.json() } catch { /* no body */ } }
    if (status === 401 || body?.error === 'reauth_required') return { error: 'reauth_required', reauth: true }
    return { error: body?.error ?? error.message ?? 'delete_failed' }
  }
  if (!data?.ok) return { error: data?.error ?? 'delete_failed' }
  return data as DeleteResult
}

// Load a full receipt the parent owns (RLS parent-scoped) for display + off-DB export.
export async function loadDeletionReceipt(receiptId: string): Promise<DeletionReceipt | null> {
  const { data } = await supabase.from('deletion_receipts').select('*').eq('id', receiptId).maybeSingle()
  return (data as DeletionReceipt) ?? null
}

export interface AccountDisposition { children_purged: number; parent_ops_deleted: number; parent_messages_tombstoned: number; retained: string[] }
export interface AccountDeletionReceipt {
  id: string; parent_id: string; parent_auth_user_id: string | null; deleting_actor: string
  child_count: number; child_receipt_ids: string[]; disposition: AccountDisposition
  prev_receipt_hash: string | null; receipt_hash: string; status: string
  db_purged_at: string; completed_at: string | null; created_at: string
}
export interface DeleteAccountResult { ok: true; status: string; account_receipt_id: string; receipt_hash: string; children_purged: number; idempotent: boolean }

// Whole-account deletion (Slice B3/B4). The Edge gate is identical to deleteChild
// (parent-only + fresh step-up + rate-limit); it routes every child through the
// SAME purge_child kernel and deletes the parent's own login too.
export async function deleteAccount(): Promise<DeleteAccountResult | { error: string; reauth?: boolean }> {
  const { data, error } = await supabase.functions.invoke('delete-account', { body: {} })
  if (error) {
    let body: { error?: string } | null = null
    let status = 0
    const ctx = (error as { context?: Response }).context
    if (ctx) { status = ctx.status; try { body = await ctx.json() } catch { /* no body */ } }
    if (status === 401 || body?.error === 'reauth_required') return { error: 'reauth_required', reauth: true }
    return { error: body?.error ?? error.message ?? 'delete_failed' }
  }
  if (!data?.ok) return { error: data?.error ?? 'delete_failed' }
  return data as DeleteAccountResult
}

export async function loadAccountReceipt(receiptId: string): Promise<AccountDeletionReceipt | null> {
  const { data } = await supabase.from('account_deletion_receipts').select('*').eq('id', receiptId).maybeSingle()
  return (data as AccountDeletionReceipt) ?? null
}

// Does this child's profile still exist for the caller? Used by the child hub to
// detect a mid-session deletion. Fail-OPEN on a transient error (assume still
// present) so a network blip never flips a live child to the "removed" screen —
// only a definitive "no row, no error" means deleted.
export async function childExists(childId: string): Promise<boolean> {
  const { data, error } = await supabase.from('children').select('id').eq('id', childId).maybeSingle()
  if (error) return true // unknown -> treat as present; the next successful check decides
  return !!data
}

// Mint a session for one of the parent's OWN children (the only door). Server-
// side ownership + rate-limit + audit; the raw one-time link never returns here.
export async function startChildSession(childId: string): Promise<{ access_token: string; refresh_token: string } | { error: string }> {
  const { data, error } = await supabase.functions.invoke('start-child-session', { body: { childId } })
  if (error) return { error: error.message }
  if (!data?.access_token) return { error: data?.reason ?? 'mint_failed' }
  return { access_token: data.access_token, refresh_token: data.refresh_token }
}

export async function getMastery(childId: string): Promise<SkillMastery[]> {
  const { data } = await supabase.from('child_skill_mastery')
    .select('skill_id,alpha,beta,attempts_count,correct_count,skills(display_name,subject,position)')
    .eq('child_id', childId)
  const rows = (data ?? []) as unknown as MasteryRow[]
  return rows
    .map((r) => {
      const a = Number(r.alpha), b = Number(r.beta)
      return {
        skillKey: r.skill_id, displayName: r.skills?.display_name ?? r.skill_id,
        subject: r.skills?.subject ?? 'math', mastery: a / (a + b),
        attempts: r.attempts_count, correct: r.correct_count, position: r.skills?.position ?? 99,
      }
    })
    .sort((x, y) => x.position - y.position)
}

// mirrors contracts/activity.mjs
export function nextBestActivity(s: SkillMastery): NextActivity {
  const accuracy = s.attempts > 0 ? s.correct / s.attempts : 0
  const base = { focusSkill: s.skillKey, displayName: s.displayName }
  if (s.attempts < 3) return { ...base, action: 'keep_practicing', icon: 'Target', reason: 'Just getting started — a few more to see where you are.' }
  if (accuracy < 0.5) return { ...base, action: 'ease', icon: 'Heart', reason: 'Tricky today — keep practicing this one, you’ve got it.' }
  if (s.mastery >= 0.85) return { ...base, action: 'advance', icon: 'Rocket', reason: 'Great accuracy — ready for the next skill!' }
  return { ...base, action: 'keep_practicing', icon: 'Star', reason: 'Nice progress — keep going to build fluency.' }
}

export interface AttemptDraft {
  clientAttemptId: string; clientSessionId: string; stageIndex: number; skill: string
  result: 'correct' | 'incorrect' | 'missed' | 'invalid'; problemText: string
  correctAnswer: number; chosenAnswer: number | null; responseMs: number | null
  inputMethod: string | null; runTimeS: number; level: number; context: Record<string, unknown>
}

export function buildBatch(events: AttemptDraft[]) {
  const first = events[0]
  return {
    client_session_id: first.clientSessionId, module_id: 'space-blasters', mode: 'journey',
    attempts: events.map((e) => ({
      client_attempt_id: e.clientAttemptId, stage_index: e.stageIndex, skill: e.skill, result: e.result,
      problem_text: e.problemText, correct_answer: e.correctAnswer, chosen_answer: e.chosenAnswer,
      response_ms: e.responseMs, input_method: e.inputMethod, run_time_s: e.runTimeS, level: e.level, context: e.context,
    })),
  }
}

export async function recordAttemptsAuthed(childId: string, events: AttemptDraft[]): Promise<{ ok: boolean; inserted: number } | null> {
  const { data } = await supabase.rpc('record_attempts_authed', { p_child_id: childId, p_batch: buildBatch(events) })
  return data as { ok: boolean; inserted: number } | null
}

// tutor / parent teaching writes
export async function createAssignment(childId: string, uid: string, skillId: string, title: string) {
  return supabase.from('assignments').insert({ child_id: childId, assigned_by: uid, skill_id: skillId, title }).select()
}
export async function listAssignments(childId: string): Promise<Assignment[]> {
  const { data } = await supabase.from('assignments').select('id,title,skill_id,status,created_at').eq('child_id', childId).order('created_at', { ascending: false })
  return (data ?? []) as Assignment[]
}
export async function createGrade(childId: string, uid: string, payload: Record<string, unknown>) {
  return supabase.from('teaching_artifacts').insert({ child_id: childId, author_id: uid, author_role: 'tutor', kind: 'grade', payload }).select()
}
export async function listArtifacts(childId: string): Promise<Artifact[]> {
  const { data } = await supabase.from('teaching_artifacts').select('id,kind,author_role,payload,created_at').eq('child_id', childId).order('created_at', { ascending: false })
  return (data ?? []) as Artifact[]
}

export interface ChildSummary { summary: string; meta?: { provider: string; model: string; promptVersion: string } }

// The ONLY AI boundary — routes through the child-summary Edge Function (the
// single model door: authorize -> context pack -> gateway(mock) -> verify ->
// moderate -> audit). Server-side only; the client just invokes it with its JWT.
// Returns null on deny/error (no fabricated fallback).
export async function getChildSummary(childId: string): Promise<ChildSummary | null> {
  const { data, error } = await supabase.functions.invoke('child-summary', { body: { childId } })
  if (error || !data || (data as { denied?: boolean }).denied) return null
  return data as ChildSummary
}

// ---- RM-08 grading loop (every AI grade is a proposal; a human records it) ----
export interface PendingGrade { id: string; child_id: string; target_id: string; payload: { verdict?: string; feedback?: string; model?: string; prompt_version?: string } }
export async function getPendingGrades(): Promise<PendingGrade[]> {
  const { data } = await supabase.rpc('pending_grades')
  return (data ?? []) as PendingGrade[]
}
export async function approveGrade(proposalId: string, override?: string) {
  return supabase.rpc('approve_grade', { p_proposal_id: proposalId, p_override_feedback: override ?? null })
}
// gradeWork routes through the single model door (Edge Function); returns a proposal, records nothing.
export async function gradeWork(submissionId: string) {
  const { data, error } = await supabase.functions.invoke('grade-work', { body: { submissionId } })
  if (error) return null
  return data
}

// ---- RM-08b assignment generation (proposal-behind-approval, same as grades) ----
export interface PendingAssignment { id: string; child_id: string; payload: { title?: string; skill_id?: string; predicted_p?: number; items?: Array<{ prompt?: string }>; model?: string } }
export async function getPendingAssignments(): Promise<PendingAssignment[]> {
  const { data } = await supabase.rpc('pending_assignments')
  return (data ?? []) as PendingAssignment[]
}
export async function approveAssignment(proposalId: string, overrideTitle?: string) {
  return supabase.rpc('approve_assignment', { p_proposal_id: proposalId, p_override_title: overrideTitle ?? null })
}
export async function generateAssignment(childId: string) {
  const { data, error } = await supabase.functions.invoke('generate-assignment', { body: { childId } })
  if (error) return null
  return data
}
