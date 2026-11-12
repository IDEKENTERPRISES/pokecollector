// The version guard: this code was written for the server's matcher version 11 (see docs/phone-scanner/integration.md).
// A bundle of another version has other views, indexes, thresholds or reading rules: running it would give wrong answers
// that look like answers, so the matcher refuses and the page shows "phone matcher needs updating".

export const MATCHER_VERSION = 11

/**
 * {ok: true} when the manifest is one this code can run, else {ok: false, code, message} (never throws).
 * `code`: 'no_manifest' | 'matcher_version' | 'incomplete'.
 */
export function checkManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, code: 'no_manifest', message: 'The phone bundle manifest is missing.' }
  const version = Number(manifest.matcher_version)
  if (version !== MATCHER_VERSION) {
    return {
      ok: false,
      code: 'matcher_version',
      bundleVersion: manifest.matcher_version ?? null,
      codeVersion: MATCHER_VERSION,
      message: `Phone matcher needs updating: this app was written for matcher version ${MATCHER_VERSION}, the server's phone bundle is version ${manifest.matcher_version ?? '?'}.`,
    }
  }
  const paths = new Set((manifest.files || []).map(item => item.path))
  const missing = []
  if (!manifest.model?.file || !paths.has(manifest.model.file)) missing.push('the 8-bit model')
  for (const path of ['ocr/det.onnx', 'ocr/rec.onnx', 'ocr/characters.txt']) if (!paths.has(path)) missing.push(path)
  if (![...paths].some(path => path.startsWith('index/whole/'))) missing.push('the whole-card index')
  if (![...paths].some(path => path.startsWith('index/art/'))) missing.push('the artwork index')
  if (missing.length) return { ok: false, code: 'incomplete', message: `The phone bundle is incomplete: ${missing.join(', ')}.` }
  return { ok: true }
}
