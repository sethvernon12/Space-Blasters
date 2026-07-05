// ============================================================================
// contracts/capture.mjs — the FROZEN capture contract (Milestone 1).
// The typed shape every answered problem records, plus the three service-function
// SEAMS by name. A shared module: a future game emitter (plain JS) AND the hub
// (TS via checkJs) both import it. No hard dependency — the seams take a
// `transport` ({ restUrl, anonKey }) and use fetch, exactly like the live game's
// Backend, so the client path is anon-key + RLS only (no service-role in a client).
//
// EVENT-SOURCED: an AttemptEvent maps 1:1 onto a public.attempts row (the
// append-only source of truth). Column map in docs/DATA_MAP.md.
// ============================================================================
import { SKILL_TAGS, INPUT_METHODS } from './learning.mjs'

export const CAPTURE_CONTRACT_VERSION = 1

// The four result values a client may emit (derived labels — misconception /
// slip / guess — are written later by analysis, never by the client).
export const EMITTABLE_RESULTS = Object.freeze(['correct', 'incorrect', 'missed', 'invalid'])

/**
 * AttemptEvent — one answered/missed problem, one immutable event. camelCase
 * client shape; maps to snake_case public.attempts columns via attemptToRow().
 * NO PII (no name/nickname/pilot). `context` is the forward-compat escape hatch:
 * arbitrary extra signals recorded WITHOUT a migration (attempts.context jsonb).
 *
 * @typedef {Object} AttemptEvent
 * @property {string}  clientAttemptId  uuid minted at answer time — idempotency key
 * @property {string}  clientSessionId  uuid minted at run start — groups a session
 * @property {number}  stageIndex       0..22, index into the STAGES ladder (authoritative for skill)
 * @property {string}  skill            one of the 13 SKILL_TAGS — cross-checked server-side
 * @property {'correct'|'incorrect'|'missed'|'invalid'} result
 * @property {string}  problemText      e.g. '4 − 2' (no PII, truncated to 64 server-side)
 * @property {number}  correctAnswer
 * @property {?number} chosenAnswer     null when missed
 * @property {?number} responseMs       ms since the problem appeared (null when missed)
 * @property {?('voice'|'typed'|'tap'|'click')} inputMethod  null when missed
 * @property {?number} asrConfidence    0..1, voice answers only
 * @property {number}  runTimeS         cumulative seconds since run start
 * @property {number}  level            global curriculum level
 * @property {string}  mode             journey|beginner|intermediate|advanced|expert
 * @property {Object}  [context]        escape hatch — extra signals, no PII (default {})
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validate an AttemptEvent. Returns [] when valid, else a list of problems. */
export function validateAttemptEvent(e) {
  const errs = []
  if (!e || typeof e !== 'object') return ['not an object']
  if (!UUID.test(e.clientAttemptId || '')) errs.push('clientAttemptId: uuid required')
  if (!UUID.test(e.clientSessionId || '')) errs.push('clientSessionId: uuid required')
  if (!Number.isInteger(e.stageIndex) || e.stageIndex < 0 || e.stageIndex > 22) errs.push('stageIndex: 0..22')
  if (!SKILL_TAGS.includes(e.skill)) errs.push('skill: not one of the 13 SKILL_TAGS')
  if (!EMITTABLE_RESULTS.includes(e.result)) errs.push('result: must be correct|incorrect|missed|invalid')
  if (typeof e.problemText !== 'string' || !e.problemText || e.problemText.length > 64) errs.push('problemText')
  if (!Number.isFinite(e.correctAnswer)) errs.push('correctAnswer')
  if (e.result === 'missed' && e.chosenAnswer != null) errs.push('chosenAnswer must be null when missed')
  if (e.responseMs != null && !(Number.isFinite(e.responseMs) && e.responseMs >= 0)) errs.push('responseMs')
  if (e.inputMethod != null && !INPUT_METHODS.includes(e.inputMethod)) errs.push('inputMethod')
  if (e.asrConfidence != null && !(e.asrConfidence >= 0 && e.asrConfidence <= 1)) errs.push('asrConfidence')
  if (e.context != null && (typeof e.context !== 'object' || Array.isArray(e.context))) errs.push('context: must be a plain object')
  return errs
}

/** Map an AttemptEvent → the snake_case element the record_attempts RPC expects. */
export function attemptToRow(e) {
  return {
    client_attempt_id: e.clientAttemptId,
    stage_index: e.stageIndex,
    skill: e.skill,
    result: e.result,
    problem_text: e.problemText,
    correct_answer: e.correctAnswer,
    chosen_answer: e.chosenAnswer ?? null,
    response_ms: e.responseMs ?? null,
    input_method: e.inputMethod ?? null,
    asr_confidence: e.asrConfidence ?? null,
    run_time_s: e.runTimeS,
    level: e.level,
    context: e.context ?? {},
  }
}

/** Group same-session events into the batch payload record_attempts consumes. */
export function buildBatch(events, meta = {}) {
  const first = events[0]
  return {
    client_session_id: first.clientSessionId,
    module_id: meta.moduleId ?? 'space-blasters',
    mode: first.mode,
    started_at: meta.startedAt ?? null,
    ended_at: meta.endedAt ?? null,
    attempts: events.map(attemptToRow),
  }
}

// ---------------------------------------------------------------------------
// SEAMS — the three service functions, by name. Minimal bodies (the names are
// the seam). The hub and the game emitter call these; the DB tooling calls them
// in the round-trip test.
// ---------------------------------------------------------------------------

/**
 * recordAttempt — write one or more AttemptEvents. Goes through the SECURITY
 * DEFINER record_attempts RPC via anon key + fetch (the only client write path;
 * name+PIN verified server-side, consent-gated, idempotent). Returns the RPC's
 * counts-only result { ok, inserted, duplicates, rejected } or { ok:false, error }.
 * @param {{restUrl:string, anonKey:string}} transport
 * @param {{name:string, pin:string}} credentials
 * @param {AttemptEvent[]|AttemptEvent} eventOrEvents
 */
export async function recordAttempt(transport, credentials, eventOrEvents, meta = {}) {
  const events = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents]
  for (const e of events) {
    const errs = validateAttemptEvent(e)
    if (errs.length) return { ok: false, error: 'invalid_event', detail: errs }
  }
  const res = await fetch(`${transport.restUrl}/rpc/record_attempts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: transport.anonKey,
      Authorization: `Bearer ${transport.anonKey}`,
    },
    body: JSON.stringify({
      p_name: credentials.name,
      p_pin: credentials.pin,
      p_batch: buildBatch(events, meta),
    }),
  })
  if (!res.ok) return { ok: false, error: `http_${res.status}` }
  return res.json()
}

/**
 * getMastery — read the derived per-(child, skill) mastery projection. SEAM
 * stub for Milestone 1: reads are RLS-gated on auth.uid(), which arrives with
 * parent/child auth (a later milestone). Until then this returns an empty,
 * honest projection rather than inventing data.
 * @returns {Promise<{skills: Array}>}
 */
export async function getMastery(/* transport, childRef */) {
  return { skills: [] }
}

/**
 * getNextActivity — the recommended next practice item. SEAM stub for Milestone
 * 1: no recommendation engine is wired yet, so it honestly returns null (callers
 * render an empty "start practicing" state). The name is the seam.
 * @returns {Promise<null>}
 */
export async function getNextActivity(/* transport, childRef */) {
  return null
}
