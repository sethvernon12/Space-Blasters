// Visual verification: screenshots index.html at iPhone portrait, iPhone landscape and
// desktop sizes — start screen, an in-game frame (with a boss + falling problem), and the
// results screen — into ../screens/. Run:  cd tools && node screenshot.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = 'file://' + path.join(root, 'index.html');
const outDir = path.join(root, 'screens');
fs.mkdirSync(outDir, { recursive: true });

const VIEWS = [
  { name: 'iphone-portrait',  viewport: { width: 390,  height: 844 }, mobile: true  },
  { name: 'iphone-landscape', viewport: { width: 844,  height: 390 }, mobile: true  },
  { name: 'desktop',          viewport: { width: 1440, height: 900 }, mobile: false },
];

// sample answer history so the results screen shows real stats/table content
const SAMPLE_LOG = [
  { text: '2 + 3', correctAnswer: 5,  chosen: 5,    correct: true,  level: 1, skill: 'addition',    stage: 'Add within 5',      stageIndex: 0, time: 4.2 },
  { text: '1 + 4', correctAnswer: 5,  chosen: 5,    correct: true,  level: 1, skill: 'addition',    stage: 'Add within 5',      stageIndex: 0, time: 8.9 },
  { text: '4 − 2', correctAnswer: 2,  chosen: 3,    correct: false, level: 2, skill: 'subtraction', stage: 'Subtract within 5', stageIndex: 1, time: 15.1 },
  { text: '3 + 2', correctAnswer: 5,  chosen: 5,    correct: true,  level: 2, skill: 'addition',    stage: 'Add within 5',      stageIndex: 0, time: 21.4 },
  { text: '5 − 1', correctAnswer: 4,  chosen: null, correct: false, level: 2, skill: 'subtraction', stage: 'Subtract within 5', stageIndex: 1, missed: true, time: 27.8 },
  { text: '2 + 2', correctAnswer: 4,  chosen: 4,    correct: true,  level: 2, skill: 'addition',    stage: 'Add within 5',      stageIndex: 0, time: 31.0 },
  { text: '7 + 3', correctAnswer: 10, chosen: 10,   correct: true,  level: 3, skill: 'make-ten',    stage: 'Make 10 (number bonds)', stageIndex: 4, time: 38.6 },
];

const browser = await chromium.launch();
for (const v of VIEWS) {
  const ctx = await browser.newContext({
    viewport: v.viewport,
    hasTouch: v.mobile,
    isMobile: v.mobile,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error(`[${v.name}] PAGE ERROR:`, e.message));
  // NEVER touch the real leaderboard from the screenshot tool
  await page.route('**/*supabase.co/**', r => r.abort());
  await page.goto(url);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/${v.name}-1-start.png` });

  // launch a run
  await page.fill('#nameInput', 'Tester');
  await page.fill('#pinInput', '1234');
  await page.click('#startBtn');
  await page.waitForTimeout(2500);                       // let a problem fall into view
  await page.evaluate(() => window.__mathblaster.spawnBoss());
  await page.waitForTimeout(2200);                       // boss glides in
  await page.screenshot({ path: `${outDir}/${v.name}-2-game.png` });

  // results screen, with realistic history
  await page.evaluate(log => {
    window.__mathblaster.game.log.push(...log);
    window.__mathblaster.game.score = 385;
    window.__mathblaster.endGame();
  }, SAMPLE_LOG);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/${v.name}-3-results.png` });
  await ctx.close();
}
await browser.close();
console.log('Screenshots written to', outDir);
