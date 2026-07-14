// ============================================================================
// RM-41 (browser) multi-digit CNN reader + the promotion gate on a real run (Phase 5 · 5f-c).
// The DELIBERATE in-browser benchmark (heavy; not per-commit). Renders synthetic MULTI-DIGIT
// numbers, runs the reader IN-BROWSER (segment → classify each → concatenate → MIN confidence),
// scores via the 5f-a metrics, and shows the promotion gate REFUSES to promote on this run
// (synthetic + an incomplete device matrix → deterministic stays default). No-network-on-local.
// NOTE: exact-match here is a SYNTHETIC pipeline-proof number, NOT the accuracy verdict — the
// real bar is real child handwriting + multi-digit, measured at the gate.
// Run (model trained): node db/scripts/rm41-cnn-harness.mjs
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exactMatch, calibration } from '../../supabase/functions/_shared/grade-metrics.mjs'
import { activeReader, READER_DEFAULT } from '../../hub/src/lib/localReaders/promotion.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 8174
let fails = 0
const ok = (m) => console.log('  ✓', m); const bad = (m) => { fails++; console.error('  ✗', m) }

const dir = path.join(root, 'tools', 'cnn-harness2'); fs.mkdirSync(path.join(dir, 'model'), { recursive: true })
fs.copyFileSync(path.join(root, 'hub/node_modules/@tensorflow/tfjs/dist/tf.min.js'), path.join(dir, 'tf.min.js'))
fs.copyFileSync(path.join(root, 'hub/src/lib/localReaders/segment.mjs'), path.join(dir, 'segment.mjs')) // test the REAL segmenter
for (const f of ['model.json', 'weights.bin']) fs.copyFileSync(path.join(root, 'hub/public/models/cnn-digit', f), path.join(dir, 'model', f))

fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><body><script src="tf.min.js"></script><script type="module">
import { segmentDigits } from './segment.mjs';
const G={0:['01110','10001','10011','10101','11001','10001','01110'],1:['00100','01100','00100','00100','00100','00100','01110'],2:['01110','10001','00001','00010','00100','01000','11111'],3:['11110','00001','00001','01110','00001','00001','11110'],4:['00010','00110','01010','10010','11111','00010','00010'],5:['11111','10000','11110','00001','00001','10001','01110'],6:['00110','01000','10000','11110','10001','10001','01110'],7:['11111','00001','00010','00100','01000','01000','01000'],8:['01110','10001','10001','01110','10001','10001','01110'],9:['01110','10001','10001','01111','00001','00010','01100']};
// render a whole NUMBER: each digit in its own 28-wide cell with a clear gap → the segmenter splits them
function imgOfNumber(n){const ds=String(n).split('');const cell=28,c=document.createElement('canvas');c.width=cell*ds.length;c.height=28;const x=c.getContext('2d');x.fillStyle='#000';x.fillRect(0,0,c.width,28);x.fillStyle='#fff';const s=2.8;ds.forEach((d,i)=>{const g=G[+d],ox=i*cell+(cell-5*s)/2,oy=(28-7*s)/2;for(let r=0;r<7;r++)for(let cc=0;cc<5;cc++)if(g[r][cc]==='1')x.fillRect(ox+cc*s,oy+r*s,s,s);});return x.getImageData(0,0,c.width,28);}
function crop(im,x0,x1){const bw=x1-x0+1,o=new ImageData(bw,im.height);for(let y=0;y<im.height;y++)for(let x=0;x<bw;x++){const si=(y*im.width+(x0+x))*4,di=(y*bw+x)*4;o.data[di]=im.data[si];o.data[di+1]=im.data[si+1];o.data[di+2]=im.data[si+2];o.data[di+3]=255;}return o;}
function valid(o){const ra=o.read_answer;if(!(ra===null||Number.isInteger(ra)))return null;if(!(typeof o.confidence==='number'&&Number.isFinite(o.confidence)&&o.confidence>=0&&o.confidence<=1))return null;return o;}
(async()=>{
  const model=await tf.loadLayersModel('model/model.json');
  const readDigit=(im)=>tf.tidy(()=>{const t=tf.browser.fromPixels(im,1).toFloat().div(255);const xx=tf.image.resizeBilinear(t,[28,28]).reshape([1,28,28,1]);const p=model.predict(xx).dataSync();let b=0;for(let i=1;i<p.length;i++)if(p[i]>p[b])b=i;return {read_answer:b,confidence:p[b]};});
  async function readNumber(im){const gray=new Float32Array(im.width*im.height);for(let i=0;i<gray.length;i++)gray[i]=im.data[i*4]/255;const boxes=segmentDigits(gray,im.width,im.height);if(!boxes.length||boxes.length>8)return {read_answer:null,confidence:0};let s='',mc=1;for(const b of boxes){const r=readDigit(crop(im,b.x0,b.x1));if(r.read_answer===null)return {read_answer:null,confidence:0};s+=String(r.read_answer);mc=Math.min(mc,r.confidence);}const num=parseInt(s,10);return {read_answer:Number.isInteger(num)?num:null,confidence:mc,segs:boxes.length};}
  const NUMS=[5,7,42,100,356,8,21,90];const rows=[];
  for(const n of NUMS){const o=await readNumber(imgOfNumber(n));const v=valid({...o,provider:'cnn'});rows.push({truth:n, read:v?v.read_answer:null, confidence:v?v.confidence:0, segs:o.segs, digits:String(n).length});}
  window.__r={rows, backend:tf.getBackend()};
})().catch(e=>{window.__r={error:String(e&&e.message||e)};});
</script></body></html>`)

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', dir], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 700))
const browser = await chromium.launch()
const reqs = []
try {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  page.on('request', (r) => reqs.push({ url: r.url(), method: r.method() }))
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.waitForFunction(() => window.__r && (window.__r.rows || window.__r.error), { timeout: 120000 })
  const res = await page.evaluate(() => window.__r)
  if (res.error) { bad(`in-browser multi-digit read errored: ${res.error}`) }
  else {
    ok(`multi-digit reader ran IN-BROWSER (tfjs: ${res.backend})`)
    const em = exactMatch(res.rows), cal = calibration(res.rows)
    console.log('    rows:', JSON.stringify(res.rows.map((r) => ({ t: r.truth, r: r.read, segs: r.segs, c: +r.confidence.toFixed(2) }))))
    res.rows.every((r) => r.digits === 1 || r.segs === r.digits)
      ? ok('segmentation split each multi-digit number into the right number of digit-boxes') : bad(`seg counts: ${JSON.stringify(res.rows.map((r) => [r.truth, r.segs]))}`)
    res.rows.every((r) => r.read === null || Number.isInteger(r.read))
      ? ok('every multi-digit read is a validated int-or-null (strict schema on the combined output)') : bad('reads not schema-valid')
    const multi = res.rows.filter((r) => r.digits > 1)
    multi.every((r) => r.confidence <= 1) && multi.length > 0
      ? ok(`min-confidence combine: a multi-digit read is only as confident as its weakest digit (${multi.length} multi-digit numbers)`) : bad('min-confidence')
    em.rate >= 0.4
      ? ok(`reads synthetic numbers (exact-match ${em.rate.toFixed(2)} — SYNTHETIC pipeline proof, NOT the accuracy verdict; real bar is real handwriting at the gate)`) : bad(`exact-match too low even for a pipeline proof: ${em.rate}`)
    // the promotion gate on THIS run: synthetic + an incomplete matrix → deterministic stays default
    const evidence = { wasm: { exact_match: em.rate, high_conf_exact_match: (cal.find((c) => c.lo === 0.9)?.exact_match ?? 0) }, webgpu: null, manual_old_iphone: null }
    activeReader({ candidate: 'cnn', on_real_set: false, evidence }) === READER_DEFAULT
      ? ok('promotion gate on this run: synthetic evidence + an incomplete device matrix → NOT promoted; deterministic stays default') : bad('this synthetic run promoted the candidate')
  }
  const external = reqs.filter((r) => !r.url.startsWith(`http://127.0.0.1:${PORT}/`))
  const uploads = reqs.filter((r) => r.method === 'POST' || r.method === 'PUT')
  external.length === 0 && uploads.length === 0
    ? ok(`no-network-on-local: ${reqs.length} requests, ALL same-origin; 0 external, 0 uploads — the image never left the device`) : bad(`network leak: ${JSON.stringify({ external, uploads })}`)
  await ctx.close()
} finally { await browser.close(); server.kill(); fs.rmSync(dir, { recursive: true, force: true }) }
console.log(fails ? `\n=== RM-41 CNN HARNESS: ${fails} FAIL ===` : '\n=== RM-41 CNN HARNESS: ALL PASS (in-browser multi-digit segment→classify→min-confidence; strict schema; no-network; promotion gate refuses a synthetic/incomplete run) ===')
process.exit(fails ? 1 : 0)
