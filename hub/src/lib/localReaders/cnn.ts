// The license-clean CNN digit-classifier reader CANDIDATE (Phase 5 · 5f-b). Runs IN THE BROWSER:
// it DYNAMIC-imports Apache-2.0 tfjs (so tfjs is NEVER in the main family bundle — only fetched
// if this candidate is ever run), loads OUR OWN self-hosted weights from OUR origin (never an
// external host), classifies the digit, and returns a read_answer + softmax confidence validated
// by the strict schema. It is DISCRIMINATIVE — it emits a class + confidence and cannot
// hallucinate a plausible-wrong number. The child's image NEVER leaves the device: the only fetch
// is the same-origin model; the image is read in-process. NOT the default (deterministic stays
// default until a deliberate 5f-c promotion). MVP: single-digit; multi-digit segmentation is a
// documented 5f extension.
import { validateReaderOutput, type ReaderOutput } from './schema'
import { segmentDigits } from './segment.mjs'

const MODEL_URL = '/models/cnn-digit/model.json' // self-hosted, same-origin

function cropColumns(image: ImageData, x0: number, x1: number): ImageData {
  const bw = x1 - x0 + 1
  const out = new ImageData(bw, image.height)
  for (let y = 0; y < image.height; y++) for (let x = 0; x < bw; x++) {
    const si = (y * image.width + (x0 + x)) * 4, di = (y * bw + x) * 4
    out.data[di] = image.data[si]; out.data[di + 1] = image.data[si + 1]; out.data[di + 2] = image.data[si + 2]; out.data[di + 3] = 255
  }
  return out
}

export async function createCnnReader() {
  const tf = await import('@tensorflow/tfjs') // lazy — kept out of the main family bundle
  const model = await tf.loadLayersModel(MODEL_URL)
  return {
    provider: 'cnn' as const,
    async read(image: ImageData): Promise<ReaderOutput> {
      const { read_answer, confidence } = tf.tidy(() => {
        const gray = tf.browser.fromPixels(image, 1).toFloat().div(255)
        const x = tf.image.resizeBilinear(gray as unknown as import('@tensorflow/tfjs').Tensor3D, [28, 28]).reshape([1, 28, 28, 1])
        const probs = (model.predict(x) as import('@tensorflow/tfjs').Tensor).dataSync()
        let best = 0
        for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i
        return { read_answer: best, confidence: probs[best] }
      })
      const v = validateReaderOutput({ read_answer, confidence, provider: 'cnn', model: 'cnn-digit-v1' })
      return v.ok ? v.value : { read_answer: null, confidence: 0, provider: 'cnn', model: 'cnn-digit-v1' } // malformed → null read, gate escalates
    },
    // 5f-c — multi-digit: segment → classify each digit → concatenate → MIN of the per-digit
    // confidences (a mis-segmentation or an unreadable digit drives the confidence down → the
    // gate escalates → the human corrects; never a wrong recorded grade).
    async readNumber(image: ImageData): Promise<ReaderOutput> {
      const fail = { read_answer: null, confidence: 0, provider: 'cnn', model: 'cnn-digit-v1' }
      const gray = new Float32Array(image.width * image.height)
      for (let i = 0; i < gray.length; i++) gray[i] = image.data[i * 4] / 255 // R channel of the grayscale image
      const boxes = segmentDigits(gray, image.width, image.height)
      if (boxes.length === 0 || boxes.length > 8) return fail // no digits, or an implausible count → escalate
      let digits = ''; let minConf = 1
      for (const b of boxes) {
        const r = await this.read(cropColumns(image, b.x0, b.x1))
        if (r.read_answer === null) return fail
        digits += String(r.read_answer); minConf = Math.min(minConf, r.confidence)
      }
      const num = Number.parseInt(digits, 10)
      const v = validateReaderOutput({ read_answer: Number.isInteger(num) ? num : null, confidence: minConf, provider: 'cnn', model: 'cnn-digit-v1' })
      return v.ok ? v.value : fail
    },
    dispose() { model.dispose() },
  }
}
