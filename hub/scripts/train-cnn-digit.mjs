// train-cnn-digit.mjs — Phase 5 · 5f-b. Trains the license-clean CNN digit-classifier candidate.
// LICENSE-CLEAN BY CONSTRUCTION: the training data is OUR OWN synthetic digit glyphs (defined
// right here — a 7x5 bitmap font we authored, augmented) — no third-party dataset, no dataset-
// license question — trained on Apache-2.0 tfjs; the exported weights are ours. Self-hosted to
// hub/public/models/cnn-digit/ (the browser fetches the reader from OUR origin, never external).
// This is a DISCRIMINATIVE classifier — it emits a class + a softmax confidence and CANNOT
// hallucinate a plausible-wrong number the way a generative HTR model can.
// NOTE: 5f-b proves the PIPELINE on synthetic glyphs; real-handwriting ACCURACY is the gated
// 5f-c run on the real self-generated set. Multi-digit segmentation is a documented 5f extension.
// Run (from hub deps): cd hub && node ../db/scripts/train-cnn-digit.mjs
import * as tf from '@tensorflow/tfjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(root, 'hub', 'public', 'models', 'cnn-digit')
fs.mkdirSync(outDir, { recursive: true })

// OUR OWN 7x5 digit glyphs (authored here = license-clean).
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

// deterministic PRNG (no Math.random — keeps the build reproducible)
let seed = 1234567
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

// render a glyph into a 28x28 [0,1] Float32Array, with augmentation (shift, scale, noise)
function render(digit) {
  const g = GLYPHS[digit]
  const img = new Float32Array(28 * 28)
  const scale = 2.6 + rnd() * 1.2                 // glyph pixel → block size
  const gw = 5 * scale, gh = 7 * scale
  const ox = Math.round((28 - gw) / 2 + (rnd() * 6 - 3))   // shift ±3
  const oy = Math.round((28 - gh) / 2 + (rnd() * 6 - 3))
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
    if (g[r][c] !== '1') continue
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const y = oy + Math.floor(r * scale + dy), x = ox + Math.floor(c * scale + dx)
      if (y >= 0 && y < 28 && x >= 0 && x < 28) img[y * 28 + x] = 1
    }
  }
  for (let i = 0; i < img.length; i++) img[i] = Math.min(1, Math.max(0, img[i] + (rnd() * 0.24 - 0.12))) // noise
  return img
}

function dataset(perDigit) {
  const xs = [], ys = []
  for (let d = 0; d <= 9; d++) for (let k = 0; k < perDigit; k++) { xs.push(render(d)); ys.push(d) }
  const x = tf.tensor4d(Float32Array.from(xs.flatMap((a) => Array.from(a))), [xs.length, 28, 28, 1])
  const y = tf.oneHot(tf.tensor1d(ys, 'int32'), 10)
  return { x, y }
}

async function main() {
  await tf.setBackend('cpu'); await tf.ready()
  const m = tf.sequential()
  m.add(tf.layers.conv2d({ inputShape: [28, 28, 1], filters: 8, kernelSize: 3, activation: 'relu' }))
  m.add(tf.layers.maxPooling2d({ poolSize: 2 }))
  m.add(tf.layers.conv2d({ filters: 16, kernelSize: 3, activation: 'relu' }))
  m.add(tf.layers.maxPooling2d({ poolSize: 2 }))
  m.add(tf.layers.flatten())
  m.add(tf.layers.dense({ units: 32, activation: 'relu' }))
  m.add(tf.layers.dense({ units: 10, activation: 'softmax' }))
  m.compile({ optimizer: tf.train.adam(0.001), loss: 'categoricalCrossentropy', metrics: ['accuracy'] })

  const train = dataset(35), val = dataset(10)
  await m.fit(train.x, train.y, {
    epochs: 8, batchSize: 32, validationData: [val.x, val.y], verbose: 0,
    callbacks: { onEpochEnd: (e, l) => { if (e % 5 === 4) console.log(`epoch ${e + 1}: val_acc=${l.val_acc?.toFixed(3)}`) } },
  })
  const evalr = m.evaluate(val.x, val.y)
  console.log('final val accuracy (synthetic):', Number(evalr[1].dataSync()[0]).toFixed(3))

  // custom save handler (pure tfjs, no native tfjs-node) → model.json + weights.bin, self-hosted
  await m.save(tf.io.withSaveHandler(async (a) => {
    fs.writeFileSync(path.join(outDir, 'weights.bin'), Buffer.from(a.weightData))
    fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify({
      modelTopology: a.modelTopology, format: a.format, generatedBy: 'aaa-5f-b', convertedBy: null,
      weightsManifest: [{ paths: ['weights.bin'], weights: a.weightSpecs }],
    }))
    return { modelArtifactsInfo: { dateSaved: new Date(0), modelTopologyType: 'JSON' } }
  }))
  fs.writeFileSync(path.join(outDir, 'LICENSE.txt'), 'CNN digit classifier — weights trained by The All-Around Athlete Academy on our own synthetic digit glyphs. Our own artifact. tfjs runtime: Apache-2.0.\n')
  console.log('exported →', outDir, '(model.json + weights.bin + LICENSE.txt)')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
