// ============================================================================
// contracts/mastery.mjs — updateMastery(prior, event) -> next, as a PURE
// function. No DB, no game state, no clock reads (time comes in on the event).
//
// THIS IS THE MODEL SPEC. The SQL inside record_attempts (supabase/migrations/
// 0001_mastery.sql) implements the SAME math; db/scripts/reconcile.mjs replays
// the attempt log through THIS function and diffs against the stored
// projection, so any divergence between the two implementations fails CI.
//
// Model (mastery-v1):
//   * Beta posterior over P(correct): alpha (successes+1), beta (failures+1).
//   * TIME-DECAY at update: before applying an event, both parameters relax
//     toward the uninformative prior (1,1) with a half-life in days:
//         w      = 0.5 ^ (days_since_last_seen / halflife)
//         alpha' = 1 + (alpha - 1) * w ;  beta' = 1 + (beta - 1) * w
//     so long-unseen skills drift toward "uncertain", never below the prior.
//   * Event application: correct -> alpha'+1 ; incorrect|missed -> beta'+1 ;
//     invalid -> NO change (discard-quality evidence is logged, never counted).
//   * mastery = alpha/(alpha+beta) in (0,1); uncertainty = posterior variance.
//
// PROPERTIES (tested in db/scripts/mastery-test.mjs) — all relative to the
// DECAYED prior at the event's timestamp:
//   * idempotent replay happens at the STORAGE layer (unique client_attempt_id
//     + insert-or-ignore): re-feeding the same deduplicated log reproduces the
//     same state bit-for-bit.
//   * monotonic: 'correct' never lowers mastery; 'incorrect'/'missed' never
//     raise it; 'invalid' changes nothing.
//   * bounded: alpha,beta >= 1 always; mastery stays strictly inside (0,1).
// ============================================================================

export const MASTERY_MODEL_VERSION = 'mastery-v1';
export const DEFAULT_HALFLIFE_DAYS = 30;

/** A fresh, uninformative state for a (child, skill) pair. */
export function initialMastery(skillKey, halflifeDays = DEFAULT_HALFLIFE_DAYS) {
  return {
    skillKey,
    alpha: 1,
    beta: 1,
    attemptsCount: 0,
    correctCount: 0,
    lastSeenAt: null,
    lastCorrectAt: null,
    decayHalflifeDays: halflifeDays,
    modelVersion: MASTERY_MODEL_VERSION,
  };
}

/** Decay (alpha, beta) toward the (1,1) prior for a gap in days. Pure. */
export function decayParams(alpha, beta, gapDays, halflifeDays) {
  if (!(gapDays > 0)) return { alpha, beta };
  const w = Math.pow(0.5, gapDays / halflifeDays);
  return { alpha: 1 + (alpha - 1) * w, beta: 1 + (beta - 1) * w };
}

/** Point estimate + uncertainty from the (possibly decayed) parameters. */
export function masteryOf(alpha, beta) {
  const m = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  return { mastery: m, uncertainty: Math.sqrt(variance) };
}

/** Read-time view: what is this skill's mastery AS OF `atIso`, without mutating? */
export function decayedView(state, atIso) {
  const gapDays = state.lastSeenAt
    ? Math.max(0, (Date.parse(atIso) - Date.parse(state.lastSeenAt)) / 86400000)
    : 0;
  const { alpha, beta } = decayParams(state.alpha, state.beta, gapDays, state.decayHalflifeDays);
  return { alpha, beta, ...masteryOf(alpha, beta) };
}

/**
 * THE update. Pure: returns a new state, never mutates `prior`.
 * @param {ReturnType<typeof initialMastery>} prior
 * @param {{result:'correct'|'incorrect'|'missed'|'invalid', at:string}} event
 *        `at` = ISO timestamp of the attempt (attempts.created_at server-side).
 */
export function updateMastery(prior, event) {
  if (event.result === 'invalid') return { ...prior };   // logged, never counted

  const gapDays = prior.lastSeenAt
    ? Math.max(0, (Date.parse(event.at) - Date.parse(prior.lastSeenAt)) / 86400000)
    : 0;
  let { alpha, beta } = decayParams(prior.alpha, prior.beta, gapDays, prior.decayHalflifeDays);

  const correct = event.result === 'correct';
  if (correct) alpha += 1; else beta += 1;               // incorrect AND missed count against

  return {
    ...prior,
    alpha,
    beta,
    attemptsCount: prior.attemptsCount + 1,
    correctCount: prior.correctCount + (correct ? 1 : 0),
    lastSeenAt: event.at,
    lastCorrectAt: correct ? event.at : prior.lastCorrectAt,
  };
}

/** Replay a whole (deduplicated, time-ordered) event list from scratch. */
export function replay(skillKey, events, halflifeDays = DEFAULT_HALFLIFE_DAYS) {
  let s = initialMastery(skillKey, halflifeDays);
  for (const e of events) s = updateMastery(s, e);
  return s;
}
