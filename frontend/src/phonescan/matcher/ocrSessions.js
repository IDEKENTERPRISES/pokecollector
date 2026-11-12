// The reader's model sessions on WebAssembly: {detect, recognise, characters} for `phonescan/ocr` (docs/phone-scanner/ocr.md).
import { characterTable } from '../ocr'
import { SESSION_OPTIONS } from './ort'

export async function createOcrSessions({ ort, det, rec, characters }) {
  let detector = await ort.InferenceSession.create(new Uint8Array(det), { executionProviders: ['wasm'], ...SESSION_OPTIONS })
  let recogniser = await ort.InferenceSession.create(new Uint8Array(rec), { executionProviders: ['wasm'], ...SESSION_OPTIONS })
  const run = async (session, tensor) => {
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor.data, tensor.dims) })
    const value = out[session.outputNames[0]]
    const data = await value.getData()
    const dims = [...value.dims]
    value.dispose?.()
    return { data, dims }
  }
  const text = typeof characters === 'string' ? characters : new TextDecoder().decode(characters)
  return {
    characters: characterTable(text),
    detect: tensor => run(detector, tensor),
    recognise: tensor => run(recogniser, tensor),
    async release() {
      const sessions = [detector, recogniser]
      detector = recogniser = null
      for (const session of sessions) await session?.release?.()
    },
  }
}
