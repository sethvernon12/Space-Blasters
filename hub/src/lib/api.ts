// The hub's data layer. Every call goes through the anon-key + user-JWT client,
// so RLS scopes it. Reads/writes MIRROR the frozen contract in
// contracts/capture.mjs + contracts/activity.mjs (the canonical seams the db
// isolation tests exercise); kept as small TS here to stay inside the hub build.
import { supabase } from './supabase'

export interface ChildRow { id: string; nickname: string; grade_band: string | null; parent_id: string | null; auth_user_id: string | null }
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
    supabase.from('children').select('id,nickname,grade_band,parent_id,auth_user_id'),
    supabase.from('tutor_grants').select('child_id,can_write,active'),
  ])
  return { children: (kids.data ?? []) as ChildRow[], grants: (grants.data ?? []) as Grant[] }
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
