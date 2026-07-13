// ============================================================================
// RM-40 CNN reader in-browser pipeline (Phase 5 · 5f-b). Proves the license-clean CNN digit
// candidate runs IN THE BROWSER through the whole pipeline — the model loads + runs in-browser,
// raw output → read_answer + confidence, strict schema, and the child's image NEVER leaves the
// device (the only network is the same-origin self-hosted model; no external host; no upload).
// Scored via the 5f-a metrics on synthetic digits. This is the DELIBERATE benchmark (heavy
// in-browser inference), NOT part of the fast per-commit suite. Deterministic reader stays
// default; external provider stays bundle-excluded.
// Run (deps installed, model trained): node db/scripts/rm40-cnn-harness.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exactMatch, calibration } from '../../supabase/functions/_shared/grade-metrics.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 8173
let fails = 0
const ok = (m) => console.log('  ✓', m); const bad = (m) => { fails++; console.error('  ✗', m) }

// serve a temp dir: tfjs UMD + the self-hosted model + a harness page (all same-origin)
const dir = path.join(root, 'tools', 'cnn-harness'); fs.mkdirSync(dir, { recursive: true })
fs.mkdirSync(path.join(dir, 'model'), { recursive: true })
fs.copyFileSync(path.join(root, 'hub/node_modules/@tensorflow/tfjs/dist/tf.min.js'), path.join(dir, 'tf.min.js'))
for (const f of ['model.json', 'weights.bin']) fs.copyFileSync(path.join(root, 'hub/public/models/cnn-digit', f), path.join(dir, 'model', f))

// the harness page: renders OUR OWN glyphs (mirror of the trainer), runs the SAME reader steps
// as hub/src/lib/localReaders/cnn.ts, in-browser, and records results. No image is ever fetched
// or POSTed — it is drawn + read in-process.
fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><body><script src="tf.min.js"></script><script>
const G={0:['01110','10001','10011','10101','11001','10001','01110'],1:['00100','01100','00100','00100','00100','00100','01110'],2:['01110','10001','00001','00010','00100','01000','11111'],3:['11110','00001','00001','01110','00001','00001','11110'],4:['00010','00110','01010','10010','11111','00010','00010'],5:['11111','10000','11110','00001','00001','10001','01110'],6:['00110','01000','10000','11110','10001','10001','01110'],7:['11111','00001','00010','00100','01000','01000','01000'],8:['01110','10001','10001','01110','10001','10001','01110'],9:['01110','10001','10001','01111','00001','00010','01100']};
function imgOf(d,jx,jy){const c=document.createElement('canvas');c.width=28;c.height=28;const x=c.getContext('2d');x.fillStyle='#000';x.fillRect(0,0,28,28);x.fillStyle='#fff';const g=G[d],s=2.8,ox=(28-5*s)/2+jx,oy=(28-7*s)/2+jy;for(let r=0;r<7;r++)for(let cc=0;cc<5;cc++)if(g[r][cc]==='1')x.fillRect(ox+cc*s,oy+r*s,s,s);return x.getImageData(0,0,28,28);}
function valid(o){const ra=o.read_answer;if(!(ra===null||Number.isInteger(ra)))return null;if(!(typeof o.confidence==='number'&&o.confidence>=0&&o.confidence<=1))return null;return o;}
(async()=>{
  const model=await tf.loadLayersModel('model/model.json');   // self-hosted, same-origin
  const rows=[];
  for(let d=0;d<=9;d++)for(const [jx,jy] of [[0,0],[1,-1],[-1,1]]){
    const im=imgOf(d,jx,jy);
    const o=tf.tidy(()=>{const t=tf.browser.fromPixels(im,1).toFloat().div(255);const xx=tf.image.resizeBilinear(t,[28,28]).reshape([1,28,28,1]);const p=model.predict(xx).dataSync();let b=0;for(let i=1;i<p.length;i++)if(p[i]>p[b])b=i;return {read_answer:b,confidence:p[b]};});
    const v=valid({...o,provider:'cnn'});
    rows.push({truth:d, read:v?v.read_answer:null, confidence:v?v.confidence:0});
  }
  // adversarial: a NaN/garbage output must be rejected by the schema → null (not stored)
  const adv=valid({read_answer:NaN,confidence:5,provider:'cnn'});
  window.__cnn={rows, backend:tf.getBackend(), schemaRejectsGarbage: adv===null};
})().catch(e=>{window.__cnn={error:String(e&&e.message||e)};});
</script></body></html>`)

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dir], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 700))
const browser = await chromium.launch()
const reqs = []
try {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  page.on('request', (r) => reqs.push({ url: r.url(), method: r.method() }))
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.waitForFunction(() => window.__cnn && (window.__cnn.rows || window.__cnn.error), { timeout: 120000 })
  const res = await page.evaluate(() => window.__cnn)
  if (res.error) { bad(`in-browser inference errored: ${res.error}`) }
  else {
    res.backend && ok(`CNN model loaded + ran IN-BROWSER (tfjs backend: ${res.backend})`)
    const em = exactMatch(res.rows); const cal = calibration(res.rows)
    console.log('    exact-match:', JSON.stringify(em)); console.log('    calibration:', JSON.stringify(cal))
    res.rows.length === 30 && res.rows.every((r) => r.read === null || Number.isInteger(r.read))
      ? ok('every read is a validated int-or-null (strict schema on raw model output)') : bad('reads not schema-valid')
    em.rate >= 0.8 ? ok(`reads the synthetic glyphs (exact-match ${em.rate.toFixed(2)} — pipeline works; real-handwriting accuracy is the gated 5f-c run)`) : bad(`exact-match too low: ${em.rate}`)
    res.schemaRejectsGarbage ? ok('strict schema REJECTS adversarial/garbage output (NaN/out-of-range → null, never stored)') : bad('schema accepted garbage')
  }
  // no-network-on-local: every request is same-origin (self-hosted); no external host; no upload
  const external = reqs.filter((r) => !r.url.startsWith(`http://127.0.0.1:${PORT}/`))
  const uploads = reqs.filter((r) => r.method === 'POST' || r.method === 'PUT')
  external.length === 0 && uploads.length === 0
    ? ok(`no-network-on-local: ${reqs.length} requests, ALL same-origin self-hosted (tfjs+model); 0 external, 0 uploads — the image never left the device`) : bad(`network leak: external=${JSON.stringify(external)} uploads=${JSON.stringify(uploads)}`)
  await ctx.close()
} finally { await browser.close(); server.kill(); fs.rmSync(dir, { recursive: true, force: true }) }
console.log(fails ? `\n=== RM-40 CNN HARNESS: ${fails} FAIL ===` : '\n=== RM-40 CNN HARNESS: ALL PASS (in-browser CNN inference; strict schema incl. adversarial reject; no-network-on-local; scored via 5f-a metrics) ===')
process.exit(fails ? 1 : 0)
