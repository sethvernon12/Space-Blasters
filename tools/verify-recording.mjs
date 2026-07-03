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

// ============================================================================
// OPTIONAL: hosted-DEV end-to-end (runs ONLY when env vars are set — no URLs,
// keys, or credentials live in this file or anywhere committed).
//   SUPABASE_DEV_URL / SUPABASE_DEV_PUBLISHABLE_KEY / DEV_PILOT_NAME / DEV_PILOT_PIN
// The game file is NOT modified: every request the game aims at the PROD host
// is rewritten at the network layer to the DEV project with the DEV key, and
// the run asserts nothing ever escaped to prod.
// ============================================================================
const DEV = {
  url: (process.env.SUPABASE_DEV_URL || '').replace(/\/$/, ''),
  key: process.env.SUPABASE_DEV_PUBLISHABLE_KEY || '',
  pilot: process.env.DEV_PILOT_NAME || '',
  pin: process.env.DEV_PILOT_PIN || '',
};
if (DEV.url && DEV.key && DEV.pilot && DEV.pin) {
  console.log('HOSTED-DEV E2E (env-configured; prod host rewritten to DEV):');
  if (DEV.url.includes('oafovcrxdjoyaxsytyjg')) { console.error('  ✗ refusing: DEV url is the PROD project'); process.exit(1); }
  const PROD_HOST = 'oafovcrxdjoyaxsytyjg.supabase.co';
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await ctx2.newPage();
  const rpcCalls = [];              // captured record_attempts {body, status, json}
  let prodEscapes = 0;
  await page2.route('**/*', (route) => {
    const req = route.request();
    let u; try { u = new URL(req.url()); } catch { return route.continue(); }
    if (u.hostname === PROD_HOST) {
      return route.continue({
        url: DEV.url + u.pathname + u.search,
        headers: { ...req.headers(), apikey: DEV.key, authorization: 'Bearer ' + DEV.key },
      });
    }
    if (u.hostname.endsWith('supabase.co') && !DEV.url.includes(u.hostname)) { prodEscapes++; return route.abort(); }
    return route.continue();
  });
  page2.on('response', async (res) => {
    if (res.url().includes('/rpc/record_attempts')) {
      let json = null; try { json = await res.json(); } catch {}
      rpcCalls.push({ body: res.request().postDataJSON(), status: res.status(), json });
    }
  });
  page2.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

  await page2.goto(url);
  await page2.waitForTimeout(800);
  await page2.fill('#nameInput', DEV.pilot);
  await page2.fill('#pinInput', DEV.pin);
  await page2.click('#startBtn');
  await page2.waitForTimeout(1200);
  await page2.evaluate(() => window.__mathblaster.recorder.setEnabled(true));

  // enqueue a small batch through the REAL answer path (3 correct, 1 incorrect)
  for (const kind of ['ok', 'ok', 'wrong', 'ok']) {
    await page2.waitForFunction(() => {
      const p = window.__mathblaster.problem; return p && !p.answered && !p.dead;
    }, null, { timeout: 15000 });
    await page2.evaluate((k) => {
      const g = window.__mathblaster;
      g.chooseAnswer({ value: k === 'ok' ? g.problem.answer : g.problem.answer + 1 }, 'tap');
    }, kind);
    await page2.waitForTimeout(250);
  }
  const queued = await page2.evaluate(async () => (await window.__mathblaster.recorder.allRows()).length);
  console.log(`  · queued ${queued} attempts in the outbox`);

  // (1) flush -> record_attempts on DEV
  const status = await page2.evaluate(() => window.__mathblaster.recorder.flush());
  await page2.waitForTimeout(1500);
  const inserted = rpcCalls.reduce((n, c) => n + ((c.json && c.json.inserted) || 0), 0);
  if (status === 'flushed' && inserted > 0) ok(`flush -> record_attempts inserted=${inserted} (status '${status}')`);
  else fail(`flush status '${status}', inserted=${inserted}, calls=${rpcCalls.length}`);
  for (const c of rpcCalls) console.log('  · raw record_attempts response:', JSON.stringify(c.json));

  // (2) outbox drains to empty
  const drained = await page2.evaluate(async () => (await window.__mathblaster.recorder.allRows()).length);
  if (drained === 0) ok('outbox drained to empty'); else fail(`outbox still has ${drained} rows`);

  // (3) replay the SAME batch (identical idempotency keys) as an HTTPS client
  let replayInserted = 0, replayOk = true;
  for (const c of rpcCalls) {
    if (!c.body) continue;
    const res = await ctx2.request.post(DEV.url + '/rest/v1/rpc/record_attempts', {
      headers: { 'Content-Type': 'application/json', apikey: DEV.key, Authorization: 'Bearer ' + DEV.key },
      data: c.body,
    });
    const j = await res.json().catch(() => null);
    console.log('  · raw replay response:', JSON.stringify(j));
    if (!j || j.ok !== true || j.inserted !== 0) replayOk = false;
    replayInserted += (j && j.inserted) || 0;
  }
  if (replayOk && replayInserted === 0) ok('replay of the same batch: inserted=0 (idempotent)');
  else fail(`replay inserted=${replayInserted}`);
  const stillEmpty = await page2.evaluate(async () => (await window.__mathblaster.recorder.allRows()).length);
  if (stillEmpty === 0) ok('outbox still empty after replay'); else fail('outbox refilled?!');

  if (prodEscapes === 0) ok('zero requests escaped to any non-DEV supabase host');
  else fail(`${prodEscapes} request(s) tried to reach a non-DEV supabase host (aborted)`);
  await ctx2.close();
}

await browser.close();
console.log(process.exitCode ? 'VERIFY-RECORDING: FAILED' : 'VERIFY-RECORDING: ALL CHECKS PASSED');
