// contracts/activity.mjs — the Milestone-1 rule-based "next best activity".
// Pure + transparent (no engine, no fabricated data): given what was actually
// recorded this session for one skill, pick the next step by simple rules.
// The getNextActivity SEAM (capture.mjs) will call this once server-side reads
// exist; for Milestone 1 the workspace calls it directly on session data.
import { SKILL_KEYS } from './learning.mjs'

/** The next skill on the ladder after `skillKey` (or null at the end). */
export function nextSkillKey(skillKey) {
  const i = SKILL_KEYS.indexOf(skillKey)
  return i >= 0 && i < SKILL_KEYS.length - 1 ? SKILL_KEYS[i + 1] : null
}

/**
 * @param {{ skillKey:string, mastery:number, attempts:number, correct:number }} s
 * @returns {{ action:'keep_practicing'|'ease'|'advance', skillKey:string, icon:string, reason:string }}
 */
export function nextBestActivity(s) {
  const accuracy = s.attempts > 0 ? s.correct / s.attempts : 0
  if (s.attempts < 3) {
    return { action: 'keep_practicing', skillKey: s.skillKey, icon: '🎯',
      reason: 'Just getting started — a few more to see where you are.' }
  }
  if (accuracy < 0.5) {
    return { action: 'ease', skillKey: s.skillKey, icon: '💙',
      reason: 'Tricky today — keep practicing this one, you’ve got it.' }
  }
  if (s.mastery >= 0.85) {
    const next = nextSkillKey(s.skillKey)
    return next
      ? { action: 'advance', skillKey: next, icon: '🚀', reason: 'Great accuracy — ready for the next skill!' }
      : { action: 'keep_practicing', skillKey: s.skillKey, icon: '🏆', reason: 'You’ve mastered the ladder — keep it sharp!' }
  }
  return { action: 'keep_practicing', skillKey: s.skillKey, icon: '⭐',
    reason: 'Nice progress — keep going to build fluency.' }
}
