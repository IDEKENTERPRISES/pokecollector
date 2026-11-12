// The picture embedder: DINOv2-small, the CLS token, L2 normalised (embed.OnnxEmbedder.embed), as `phonespeed/runtime.js` does it.
// Three ways to run it, one interface `{embed(images) -> Promise<Float32Array[]>, backend, release()}`:
//   ortEmbedder       an ORT session in this scope (WebAssembly uint8, or WebGPU fp16)
//   remoteEmbedder    the model lives in another scope (the main thread, when a worker has no WebGPU): the pre-processed tensors
//                     go over by `request(tensors, half)` and the unit vectors come back
// The model input is built here (`preprocessRgba`) so that every way sees the same pixels.
import { fromHalfBits, preprocessRgba, toHalfBits } from '../../phonespeed/preprocess'
import { l2Normalise } from '../../phonespeed/index8'
import { SESSION_OPTIONS } from './ort'

export const wantsHalf = session => {
  const meta = session.inputMetadata
  const first = Array.isArray(meta) ? meta[0] : meta?.[session.inputNames[0]]
  return String(first?.type || '').includes('float16')
}

/** One tensor -> one unit embedding, with `session` of `ort`. */
export async function embedTensor(ort, session, data, half) {
  const input = half ? new ort.Tensor('float16', toHalfBits(data), [1, 3, 224, 224]) : new ort.Tensor('float32', data, [1, 3, 224, 224])
  const out = await session.run({ [session.inputNames[0]]: input })
  const result = out[session.outputNames[0]]
  const values = await result.getData()
  const floats = result.type === 'float16' ? fromHalfBits(values) : values
  const dim = result.dims[result.dims.length - 1]
  const cls = Float32Array.from(floats.subarray(0, dim))
  result.dispose?.()
  return l2Normalise(cls)
}

/** Creates the session from the model bytes (the bytes are dropped as soon as the session holds them). */
export async function ortEmbedder({ ort, buffer, provider, backend }) {
  let session = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: [provider], ...SESSION_OPTIONS })
  const half = wantsHalf(session)
  return {
    backend,
    where: 'here',
    async embed(images) {
      const vectors = []
      for (const image of images) vectors.push(await embedTensor(ort, session, preprocessRgba(image.data, image.width, image.height), half))
      return vectors
    },
    async release() { const old = session; session = null; await old?.release?.() },
  }
}

/** The model is elsewhere: `request(tensors: Float32Array[], half: boolean) -> Promise<Float32Array[]>`. */
export function remoteEmbedder({ request, backend, half }) {
  return {
    backend,
    where: 'main thread',
    async embed(images) {
      const tensors = images.map(image => preprocessRgba(image.data, image.width, image.height))
      return request(tensors, half)
    },
    async release() {},
  }
}

/** The side that holds the model for `remoteEmbedder`: runs the tensors it is sent. */
export async function serveEmbeddings({ ort, session }) {
  const half = wantsHalf(session)
  return async tensors => {
    const vectors = []
    for (const data of tensors) vectors.push(await embedTensor(ort, session, data, half))
    return vectors
  }
}
