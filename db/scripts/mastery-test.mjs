// ============================================================================
// Property + golden tests for contracts/mastery.mjs (the pure model spec).
// No database — these pin the MATH. Seeded PRNG so runs are reproducible.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialMastery, updateMastery, decayParams, decayedView, masteryOf, replay,
  DEFAULT_HALFLIFE_DAYS,
} from '../../contracts/mastery.mjs';

// deterministic LCG (no Math.random -> reproducible failures)
function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
}
const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const RESULTS = ['correct', 'incorrect', 'missed', 'invalid'];

function randomEvents(rnd, n) {
  const out = [];
  let t = T0;
  for (let i = 0; i < n; i++) {
    t += Math.floor(rnd() * 3 * 86400000);         // 0..3-day gaps
    out.push({ result: RESULTS[Math.floor(rnd() * RESULTS.length)], at: iso(t) });
  }
  return out;
}

test('bounded: alpha,beta >= 1 and mastery strictly inside (0,1) over long random runs', () => {
  const rnd = prng(42);
  for (let run = 0; run < 50; run++) {
    let s = initialMastery('add5');
    for (const e of randomEvents(rnd, 200)) {
      s = updateMastery(s, e);
      assert.ok(s.alpha >= 1 && s.beta >= 1, `alpha/beta >= 1 (got ${s.alpha}/${s.beta})`);
      const { mastery } = masteryOf(s.alpha, s.beta);
      assert.ok(mastery > 0 && mastery < 1, `mastery in (0,1), got ${mastery}`);
      assert.ok(s.correctCount <= s.attemptsCount, 'correct <= attempts');
    }
  }
});

test('monotonic vs the DECAYED prior: correct never lowers, incorrect/missed never raise', () => {
  const rnd = prng(7);
  for (let i = 0; i < 500; i++) {
    let s = initialMastery('sub5');
    for (const e of randomEvents(rnd, Math.floor(rnd() * 20))) s = updateMastery(s, e);
    const at = iso(Date.parse(s.lastSeenAt ?? iso(T0)) + Math.floor(rnd() * 40 * 86400000));
    const before = decayedView(s, at).mastery;       // effective mastery at event time
    const up = masteryOf(updateMastery(s, { result: 'correct', at }).alpha,
                         updateMastery(s, { result: 'correct', at }).beta).mastery;
    const down1 = updateMastery(s, { result: 'incorrect', at });
    const down2 = updateMastery(s, { result: 'missed', at });
    assert.ok(up >= before - 1e-12, `correct raised or held (${before} -> ${up})`);
    assert.ok(masteryOf(down1.alpha, down1.beta).mastery <= before + 1e-12, 'incorrect never raises');
    assert.ok(masteryOf(down2.alpha, down2.beta).mastery <= before + 1e-12, 'missed never raises');
  }
});

test("invalid changes NOTHING (mis-hears are logged upstream, never counted)", () => {
  const rnd = prng(99);
  let s = initialMastery('mult2');
  for (const e of randomEvents(rnd, 30)) s = updateMastery(s, e);
  const next = updateMastery(s, { result: 'invalid', at: iso(T0 + 400 * 86400000) });
  assert.deepEqual(next, s, 'state identical after an invalid event');
});

test('decay: evidence relaxes toward the (1,1) prior; mastery -> 0.5 with age, never past it', () => {
  // strong positive state
  const alpha = 9, beta = 2;
  let prevMastery = masteryOf(alpha, beta).mastery;
  for (const gap of [1, 5, 15, 30, 60, 120, 365]) {
    const d = decayParams(alpha, beta, gap, DEFAULT_HALFLIFE_DAYS);
    const m = masteryOf(d.alpha, d.beta).mastery;
    assert.ok(m <= prevMastery + 1e-12, `mastery non-increasing with gap (${gap}d)`);
    assert.ok(m >= 0.5, 'a positive state decays TOWARD 0.5, never below it');
    assert.ok(d.alpha >= 1 && d.beta >= 1, 'decay never crosses the prior');
    prevMastery = m;
  }
  // exact half-life: evidence mass above the prior halves
  const h = decayParams(5, 1, DEFAULT_HALFLIFE_DAYS, DEFAULT_HALFLIFE_DAYS);
  assert.ok(Math.abs(h.alpha - 3) < 1e-12, 'alpha: 1 + (5-1)*0.5 = 3');
  assert.ok(Math.abs(h.beta - 1) < 1e-12, 'beta stays at the prior');
});

test('golden cases (mastery-v1)', () => {
  const s0 = initialMastery('add5');
  // first correct: (2,1) -> 2/3
  const s1 = updateMastery(s0, { result: 'correct', at: iso(T0) });
  assert.deepEqual([s1.alpha, s1.beta, s1.attemptsCount, s1.correctCount], [2, 1, 1, 1]);
  assert.ok(Math.abs(masteryOf(s1.alpha, s1.beta).mastery - 2 / 3) < 1e-12);
  assert.equal(s1.lastCorrectAt, iso(T0));
  // a MISSED problem counts against, same as incorrect: (2,2) -> 0.5
  const s2 = updateMastery(s1, { result: 'missed', at: iso(T0 + 1000) });
  assert.ok(Math.abs(s2.beta - 2) < 1e-9, 'missed adds to beta');
  assert.equal(s2.lastCorrectAt, iso(T0), 'missed does not touch lastCorrectAt');
  // 30-day gap then correct: decay halves evidence first, then +1
  const s3 = updateMastery(s2, { result: 'correct', at: iso(T0 + 1000 + 30 * 86400000) });
  // decayed: alpha ≈ 1+(2-1)*0.5 = 1.5, beta = 1+(2-1)*0.5 = 1.5; then correct -> (≈2.5, 1.5)
  // (1e-6 tolerance: the 1-second step between s1 and s2 also decays, by ~2.7e-7)
  assert.ok(Math.abs(s3.alpha - 2.5) < 1e-6 && Math.abs(s3.beta - 1.5) < 1e-6, `got ${s3.alpha}/${s3.beta}`);
  assert.deepEqual([s3.attemptsCount, s3.correctCount], [3, 2]);
});

test('replay determinism + storage-level idempotency (dedup by clientAttemptId)', () => {
  const rnd = prng(1234);
  const events = randomEvents(rnd, 60).map((e, i) => ({ ...e, clientAttemptId: `id-${i}` }));
  // determinism: same input -> bit-identical state
  assert.deepEqual(replay('div2510', events), replay('div2510', events));
  // idempotency lives at the storage layer: unique client_attempt_id + insert-or-
  // ignore means a replayed/duplicated feed deduplicates to the same event list
  const withDupes = [...events, ...events, events[3], events[10]]
    .sort(() => 0)                                  // stable — order preserved
    ;
  const seen = new Set();
  const deduped = withDupes.filter(e => !seen.has(e.clientAttemptId) && seen.add(e.clientAttemptId));
  assert.deepEqual(replay('div2510', deduped), replay('div2510', events),
    'dedup(replayed feed) reproduces the exact same mastery state');
});

test('updateMastery is pure: the prior object is never mutated', () => {
  const s = initialMastery('mixMD');
  const frozen = JSON.stringify(s);
  updateMastery(s, { result: 'correct', at: iso(T0) });
  updateMastery(s, { result: 'invalid', at: iso(T0) });
  assert.equal(JSON.stringify(s), frozen);
});
