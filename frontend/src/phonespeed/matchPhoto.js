// The photo the full matcher runs on, made the way the server stores it so that phone and server see the same pixels:
// EXIF orientation applied, the long side at most 2048 px (scan_storage / card_match.images.decode_rgb), encoded as a JPEG.
// The phone matches on the pixels DECODED FROM THAT JPEG and uploads that same JPEG, so what the matcher saw is what the server
// receives. (The server re-encodes the upload once more when it stores it, and Safari and Pillow decode a JPEG a hair apart:
// both are small and are named on the page.)
export const MATCH_MAX_SIDE = 2048
export const MATCH_JPEG_QUALITY = 0.92

/** The size after limiting the long side (pure; used by the tests). */
export function fitSize(width, height, maxSide = MATCH_MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

async function bitmapOf(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    return createImageBitmap(blob)
  }
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const toBlob = (canvas, quality) => new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The photo could not be encoded'))), 'image/jpeg', quality))

/** {upload: Blob (JPEG), photo: {data, width, height} (pixels decoded from that JPEG), bytes} */
export async function prepareMatchPhoto(source, { maxSide = MATCH_MAX_SIDE, quality = MATCH_JPEG_QUALITY } = {}) {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source
  const bitmap = await bitmapOf(blob)
  const { width, height } = fitSize(bitmap.width, bitmap.height, maxSide)
  const canvas = canvasFor(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  const upload = await toBlob(canvas, quality)
  canvas.width = canvas.height = 0
  // the pixels the server will see: decode the encoded JPEG, not the canvas
  const decoded = await createImageBitmap(upload)
  const check = canvasFor(decoded.width, decoded.height)
  const draw = check.getContext('2d', { willReadFrequently: true })
  draw.drawImage(decoded, 0, 0)
  decoded.close?.()
  const { data } = draw.getImageData(0, 0, check.width, check.height)
  const out = { data, width: check.width, height: check.height }
  check.width = check.height = 0
  return { upload, photo: out, bytes: upload.size }
}
