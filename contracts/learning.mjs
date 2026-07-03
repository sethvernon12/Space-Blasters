// ============================================================================
// contracts/learning.mjs — the TYPED CONTRACTS for the learning data layer.
// Pure data definitions + runtime validators. No DB, no game state, no I/O.
// Consumed by: the game's recording outbox, db/ tooling (reconciliation,
// tests), and later the hub + AI adapter. JSDoc typedefs are the type source
// of truth (TS-checkable via checkJs when the Vite hub lands in Phase 3).
//
// CORE PRINCIPLE (Phase 2): attempts are EVENT-SOURCED — the append-only log
// is the record; every "state" shape here is a DERIVED, recomputable
// projection of it.
// ============================================================================

// ---- SkillTag: the 13 coarse skill ids the game emits (VERBATIM; the only
// allowed values — enforced by a CHECK on skills.category in the DB). --------
export const SKILL_TAGS = Object.freeze([
  'addition', 'subtraction', 'make-ten', 'add-to-20', 'sub-to-20',
  'missing-number', 'two-digit-add', 'two-digit-sub', 'two-digit-both',
  'multiplication', 'two-digit-mult', 'division', 'missing-factor',
]);

// ---- SkillKey: the 23 fine-grained curriculum stage keys (= skills.id =
// mastery.skill_id). Order = the game's STAGES ladder = skills.position. -----
export const SKILL_KEYS = Object.freeze([
  'add5', 'sub5', 'add10', 'sub10', 'make10', 'add20', 'sub20',
  'miss10', 'miss20', 'add2d', 'sub2d', 'add2d2d', 'missBig',
  'mult2', 'mult510', 'multTo5', 'multTo10', 'multMiss', 'mult2d',
  'div2510', 'divTo10', 'divMiss', 'mixMD',
]);

export const RESULTS = Object.freeze([
  'correct',        // right answer
  'incorrect',      // wrong answer chosen (tap/click on a distractor)
  'missed',         // problem fell past the ship — never answered
  'invalid',        // discard-quality evidence (e.g. voice mis-hear); logged
                    // as an event but NEVER counted toward mastery
  'misconception',  // Phase-2+ derived classification (not emitted by the game)
  'slip',           // derived later — logged evidence only, never baked client-side
  'guess',          // derived later
]);

export const INPUT_METHODS = Object.freeze(['voice', 'typed', 'tap', 'click']);

export const isSkillTag = (v) => SKILL_TAGS.includes(v);
export const isSkillKey = (v) => SKILL_KEYS.includes(v);

/**
 * One answered/missed problem — one immutable event. Mirrors a row of
 * public.attempts (see docs/DATA_MAP.md for the game-event → column map).
 * NO PII: no name/nickname/pilot fields, by design.
 * @typedef {Object} AttemptEvent
 * @property {string}  clientAttemptId  uuid minted at answer time — the idempotency key
 * @property {string}  clientSessionId  uuid minted at game start (groups a play session)
 * @property {number}  stageIndex       index into the STAGES ladder (authoritative for skill)
 * @property {string}  skill            SkillTag (one of the 13) — cross-checked server-side
 * @property {'correct'|'incorrect'|'missed'|'invalid'} result  (game-emittable values)
 * @property {string}  problemText      e.g. '4 − 2' (no PII)
 * @property {number}  correctAnswer
 * @property {?number} chosenAnswer     null when missed
 * @property {?number} responseMs       ms since THIS problem appeared (null when missed)
 * @property {?('voice'|'typed'|'tap'|'click')} inputMethod  null when missed
 * @property {?number} asrConfidence    0..1, voice answers only
 * @property {number}  runTimeS         cumulative seconds since run start (legacy field)
 * @property {number}  level            global curriculum level
 * @property {string}  mode             journey|beginner|intermediate|advanced|expert
 */

/** Runtime guard for an AttemptEvent. Returns [] when valid, else error strings. */
export function validateAttemptEvent(e) {
  const errs = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!e || typeof e !== 'object') return ['not an object'];
  if (!uuid.test(e.clientAttemptId || '')) errs.push('clientAttemptId: uuid required');
  if (!uuid.test(e.clientSessionId || '')) errs.push('clientSessionId: uuid required');
  if (!Number.isInteger(e.stageIndex) || e.stageIndex < 0 || e.stageIndex >= SKILL_KEYS.length)
    errs.push('stageIndex: 0..' + (SKILL_KEYS.length - 1));
  if (!isSkillTag(e.skill)) errs.push('skill: not one of the 13 SkillTags');
  if (!['correct', 'incorrect', 'missed', 'invalid'].includes(e.result)) errs.push('result: invalid');
  if (typeof e.problemText !== 'string' || !e.problemText || e.problemText.length > 64) errs.push('problemText');
  if (!Number.isFinite(e.correctAnswer)) errs.push('correctAnswer');
  if (e.result === 'missed') {
    if (e.chosenAnswer != null) errs.push('chosenAnswer must be null when missed');
  }
  if (e.responseMs != null && !(Number.isFinite(e.responseMs) && e.responseMs >= 0)) errs.push('responseMs');
  if (e.inputMethod != null && !INPUT_METHODS.includes(e.inputMethod)) errs.push('inputMethod');
  if (e.asrConfidence != null && !(e.asrConfidence >= 0 && e.asrConfidence <= 1)) errs.push('asrConfidence');
  return errs;
}

/**
 * Derived per-(child, skillKey) model state — a projection of the attempt log,
 * ALWAYS recomputable from it (see db/scripts/reconcile.mjs). Mirrors a row of
 * public.child_skill_mastery.
 * @typedef {Object} MasteryState
 * @property {string}  skillKey          one of the 23 SKILL_KEYS
 * @property {number}  alpha             Beta posterior successes+1 (>0)
 * @property {number}  beta              Beta posterior failures+1  (>0)
 * @property {number}  attemptsCount     mastery-counted attempts (excludes 'invalid')
 * @property {number}  correctCount      <= attemptsCount
 * @property {?string} lastSeenAt        ISO timestamp
 * @property {?string} lastCorrectAt     ISO timestamp
 * @property {number}  decayHalflifeDays
 * @property {string}  modelVersion
 * @property {?number} fluencyLatencyMsMedian  nullable channels (Phase 2+ populate)
 * @property {?number} fluencyTrend
 * @property {?string} retentionLastSuccessAt
 * @property {?number} retentionStrength
 * @property {?number} confidence
 * @property {?number} transferSuccessCount
 * @property {?string} transferLastSuccessAt
 */

/**
 * The whole skill map for one child at a point in time (derived).
 * @typedef {Object} SkillMapSnapshot
 * @property {string} childId
 * @property {string} asOf                ISO timestamp
 * @property {string} modelVersion
 * @property {MasteryState[]} skills      per skillKey (fine-grained, 23)
 */

/**
 * Compact, PII-FREE learner state — the ONLY learner shape downstream AI may
 * read (CLAUDE.md: send only math work + skill tags, never identity).
 * Aggregated to the 13 SkillTags for compactness; deliberately contains no
 * name/nickname, no free text, no timestamps finer than day granularity.
 * @typedef {Object} LearnerState
 * @property {string} learnerRef          OPAQUE scope id (child uuid) — never a name
 * @property {string} gradeBand           'K'..'4'
 * @property {string} modelVersion
 * @property {Array<{skill: string, mastery: number, uncertainty: number,
 *   attempts: number, daysSinceSeen: ?number, activeMisconceptions: string[],
 *   masteredGates: {accuracy: boolean, retention: boolean, transfer: boolean}}>} skills
 */

/**
 * "Mastered" is a CONJUNCTION of gates — game accuracy alone can NEVER flip it
 * (the transfer gate requires handwritten/open-ended evidence, Phase 5).
 * @param {MasteryState} m  (with decayed mastery already computed by the caller)
 * @param {number} decayedMastery
 * @param {string[]} activeMisconceptions
 */
export function masteredGates(m, decayedMastery, activeMisconceptions) {
  return {
    accuracy: decayedMastery >= 0.85 && m.attemptsCount >= 10,
    retention: m.retentionLastSuccessAt != null,          // >=1 spaced-retrieval success
    transfer: (m.transferSuccessCount ?? 0) >= 1,         // >=1 handwritten/open-ended pass
    noActiveMisconception: activeMisconceptions.length === 0,
  };
}
export function isMastered(gates) {
  return gates.accuracy && gates.retention && gates.transfer && gates.noActiveMisconception;
}
