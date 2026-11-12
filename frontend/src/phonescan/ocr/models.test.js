// Optional: the JavaScript reader with the REAL detection and recognition models (onnxruntime-web, WebAssembly, in Node),
// on the generated cards, against what the Python reader read from the same cards. CI has no model files, so this is skipped
// unless PHONE_OCR_MODELS names a folder holding them:
//   det.onnx + rec.onnx            (the phone bundle's ocr/ folder), or
//   ch_PP-OCRv4_det_infer.onnx + ch_PP-OCRv4_rec_infer.onnx   (the models folder of the rapidocr-onnxruntime wheel).
// Run it with `frontend/src/phonescan/ocr/run-models-test.sh <folder>`.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCard, readName } from './reader'
import { characterTable } from './recognise'
import { OCR_FIXTURES, loadCard, readFixture } from './testkit'

const folder = process.env.PHONE_OCR_MODELS
const pick = (...names) => names.map(name => (folder ? resolve(folder, name) : '')).find(path => path && existsSync(path))
const detPath = pick('det.onnx', 'ch_PP-OCRv4_det_infer.onnx')
const recPath = pick('rec.onnx', 'ch_PP-OCRv4_rec_infer.onnx')

describe.skipIf(!detPath || !recPath)('the text reader with the real models (set PHONE_OCR_MODELS)', () => {
  const reference = readFixture('ocr-cases.json')
  const characters = characterTable(readFileSync(resolve(OCR_FIXTURES, 'characters.txt'), 'utf-8'))
  let sessions

  const prepare = async () => {
    if (sessions) return sessions
    const ort = await import('onnxruntime-web')
    ort.env.wasm.numThreads = 1
    const detector = await ort.InferenceSession.create(readFileSync(detPath), { executionProviders: ['wasm'] })
    const recogniser = await ort.InferenceSession.create(readFileSync(recPath), { executionProviders: ['wasm'] })
    const run = async (session, tensor) => {
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor.data, tensor.dims) })
      const value = out[session.outputNames[0]]
      return { data: value.data, dims: value.dims }
    }
    sessions = { characters, detect: tensor => run(detector, tensor), recognise: tensor => run(recogniser, tensor) }
    return sessions
  }

  for (const item of reference.cases.filter(c => c.kind !== 'second_read')) {
    it(`${item.id} (${item.kind})`, { timeout: 120000 }, async () => {
      const live = await prepare()
      const card = loadCard(item.file)
      if (item.kind === 'read') {
        const got = await readCard(live, card, { fast: true, flipped: item.flipped })
        expect({ number: got.number, total: got.total, hp: got.hp }).toEqual({ number: item.result.number, total: item.result.total, hp: item.result.hp })
      } else {
        const got = await readName(live, card, { fast: true, flipped: item.flipped })
        expect(got.name).toBe(item.result.name)
      }
    })
  }
})
