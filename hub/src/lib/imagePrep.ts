// Client-side image prep BEFORE upload — so location/EXIF never leaves the device.
// HEIC (iPhone default) is decoded via heic2any (lazy-loaded → its own chunk, kept out
// of the main bundle), then EVERY image is re-encoded through a <canvas>: canvas output
// carries NO EXIF/GPS metadata, so this strips it by construction, and we downscale to
// keep payloads small. The server (upload-work Edge fn) re-strips + re-validates
// fail-closed — this is the first of the two layers.
const MAX_DIM = 2000
const QUALITY = 0.85
const MAX_BYTES = 10 * 1024 * 1024   // 10 MB — the bucket + schema hard cap

export interface PreparedImage { blob: Blob; contentType: 'image/jpeg'; bytes: number }

export async function prepareImage(file: File): Promise<PreparedImage> {
  let src: Blob = file
  const isHeic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name)
  if (isHeic) {
    const heic2any = (await import('heic2any')).default as (o: { blob: Blob; toType?: string; quality?: number }) => Promise<Blob | Blob[]>
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: QUALITY })
    src = Array.isArray(out) ? out[0] : out
  }
  let bmp: ImageBitmap
  try { bmp = await createImageBitmap(src) } catch { throw new Error('That file isn’t a readable image.') }
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process this image.')
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close?.()
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', QUALITY))
  if (!blob) throw new Error('Could not process this image.')
  if (blob.size > MAX_BYTES) throw new Error('That image is too large even after shrinking — try a smaller photo.')
  return { blob, contentType: 'image/jpeg', bytes: blob.size }
}

// Base64 (no data: prefix) for the JSON body to the upload Edge fn.
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  return btoa(bin)
}
