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

const MODEL_URL = '/models/cnn-digit/model.json' // self-hosted, same-origin

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
    dispose() { model.dispose() },
  }
}
