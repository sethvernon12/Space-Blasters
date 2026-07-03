// ============================================================================
// Verifies the Phase-2 recording feature IN THE REAL BROWSER, with all
// supabase.co traffic blocked (nothing hosted is ever touched):
//   1. FLAG OFF (shipping default): a played run makes ZERO recording network
//      calls, creates NO IndexedDB outbox, and the game/report behave as
//      before (log entries gain only additive fields).
//   2. FLAG ON (test hook only): answers queue into the outbox, a flush
//      attempts exactly one record_attempts call — and when the network is
//      down (aborted), the game KEEPS RUNNING and the rows stay queued
//      (fail-open, nothing lost, nothing broken).
// Run:  cd tools && node verify-recording.mjs
// ============================================================================
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = 'file://' + path.join(root, 'index.html');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const requests = [];
await page.route('**/*supabase.co/**', r => { requests.push(r.request().url()); r.abort(); });
page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

const fail = (msg) => { console.error('  ✗', msg); process.exitCode = 1; };
const ok = (msg) => console.log('  ✓', msg);

await page.goto(url);
await page.waitForTimeout(800);
await page.fill('#nameInput', 'Tester');
await page.fill('#pinInput', '1234');
await page.click('#startBtn');
await page.waitForTimeout(1200);

// answer three problems through the real answer path (waiting for each problem)
async function answerOne(method) {
  await page.waitForFunction(() => {
    const p = window.__mathblaster.problem;
    return p && !p.answered && !p.dead;
  }, null, { timeout: 10000 });
  await page.evaluate((m) => {
    const g = window.__mathblaster;
    g.chooseAnswer({ value: g.problem.answer }, m);
  }, method);
  await page.waitForTimeout(300);
}

console.log('FLAG OFF (shipping default):');
for (const m of ['tap', 'typed', 'voice']) await answerOne(m);

const off = await page.evaluate(async () => {
  // IMPORTANT: list databases BEFORE touching recorder.allRows() — the test
  // hook itself opens (and would create) the outbox DB.
  const dbs = (await (indexedDB.databases ? indexedDB.databases() : [])).map(d => d.name);
  return {
    enabled: window.__mathblaster.recorder.isEnabled(),
    dbs,
    outbox: (await window.__mathblaster.recorder.allRows()).length,
    log: window.__mathblaster.game.log.map(e => ({
      skill: e.skill, correct: e.correct, responseMs: e.responseMs, inputMethod: e.inputMethod })),
  };
});
if (off.enabled === false) ok('flag is OFF by default'); else fail('flag not off!');
if (!requests.some(u => u.includes('record_attempts'))) ok('zero record_attempts network calls');
else fail('record_attempts was called with the flag OFF');
if (!off.dbs.includes('mb_outbox')) ok('no IndexedDB outbox created'); else fail('outbox DB exists with flag OFF');
if (off.outbox === 0) ok('outbox empty'); else fail('outbox not empty with flag OFF');
if (off.log.length === 3 && off.log.every(e => e.correct && Number.isFinite(e.responseMs) && e.responseMs >= 0))
  ok(`game.log intact + additive fields present (${off.log.map(e => `${e.inputMethod}:${e.responseMs}ms`).join(', ')})`);
else fail('game.log entries wrong: ' + JSON.stringify(off.log));

console.log('FLAG ON (test hook) — fail-open with the network DOWN:');
await page.evaluate(() => window.__mathblaster.recorder.setEnabled(true));
for (const m of ['tap', 'tap']) await answerOne(m);
await page.evaluate(() => window.__mathblaster.recorder.flush());
await page.waitForTimeout(600);

const on = await page.evaluate(async () => ({
  outbox: (await window.__mathblaster.recorder.allRows()).length,
  gameAlive: !!window.__mathblaster.problem || window.__mathblaster.game.solvedCount >= 5,
  solved: window.__mathblaster.game.solvedCount,
}));
const rpcCalls = requests.filter(u => u.includes('record_attempts')).length;
if (rpcCalls >= 1) ok(`flush attempted the RPC (${rpcCalls} call(s), all aborted by the block)`);
else fail('flag ON but no RPC attempt was made');
if (on.outbox >= 2) ok(`rows stayed queued after network failure (${on.outbox} in outbox — nothing lost)`);
else fail(`outbox lost rows: ${on.outbox}`);
if (on.gameAlive && on.solved === 5) ok('game kept running through the failed flush (5 problems solved)');
else fail(`gameplay disturbed: solved=${on.solved}`);

// leaderboard path unaffected: end the game; submit_score attempt is aborted too
await page.evaluate(() => window.__mathblaster.endGame());
await page.waitForTimeout(600);
const resultsUp = await page.evaluate(() =>
  !document.getElementById('resultScreen').classList.contains('hidden'));
if (resultsUp) ok('results screen shows normally (offline-tolerant, same as before)');
else fail('results screen did not appear');

await browser.close();
console.log(process.exitCode ? 'VERIFY-RECORDING: FAILED' : 'VERIFY-RECORDING: ALL CHECKS PASSED');
