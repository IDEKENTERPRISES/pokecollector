import { describe, expect, it } from 'vitest'
import { speedRunRequest } from './upload'

const outcome = { timings: { a: 1 }, device: { gpu: true }, answer: { topk: { wasm: { whole: [['sv1-1_en', 0.9]], art: [] } }, ocr_lines: ['Slowpoke'] }, rows: { big: 'not sent' } }

describe('speed-test upload', () => {
  it('sends the built-in sample as JSON with no image part', () => {
    const request = speedRunRequest(outcome, null)
    expect(request.multipart).toBe(false)
    expect(Object.keys(request.body).sort()).toEqual(['answer', 'device', 'timings'])
    expect(JSON.stringify(request.body)).not.toContain('not sent')
  })

  it('sends a photo taken here as multipart: the JSON text and the file, nothing else', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'IMG_1.jpg', { type: 'image/jpeg' })
    const request = speedRunRequest(outcome, file)
    expect(request.multipart).toBe(true)
    expect([...request.body.keys()]).toEqual(['data', 'photo'])
    expect(request.body.get('photo').name).toBe('IMG_1.jpg')
    expect(JSON.parse(request.body.get('data')).answer.ocr_lines).toEqual(['Slowpoke'])
  })
})
