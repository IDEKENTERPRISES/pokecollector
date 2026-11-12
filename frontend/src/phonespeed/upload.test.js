import { describe, expect, it } from 'vitest'
import { createPostGuard, speedRunRequest } from './upload'

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

  it('carries the run id as client_id, in JSON and in multipart', () => {
    expect(speedRunRequest({ ...outcome, runId: 'run-abc12345' }, null).body.client_id).toBe('run-abc12345')
    const file = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })
    expect(JSON.parse(speedRunRequest({ ...outcome, runId: 'run-abc12345' }, file).body.get('data')).client_id).toBe('run-abc12345')
  })
})

describe('one post per run id', () => {
  it('sends a run once: a second call shares the request in flight, a later one is answered without a request', async () => {
    const guard = createPostGuard()
    let sent = 0
    const send = async () => { sent += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true } }
    const [a, b] = await Promise.all([guard.once('run-1', send), guard.once('run-1', send)])
    expect(sent).toBe(1)
    expect(a).toBe(b)
    expect(await guard.once('run-1', send)).toEqual({ skipped: true })
    expect(sent).toBe(1)
    expect(guard.has('run-1')).toBe(true)
    await guard.once('run-2', send)
    expect(sent).toBe(2)
  })

  it('lets a failed post be retried, and never lets a final and a crash post of one run both go out', async () => {
    const guard = createPostGuard()
    let tries = 0
    await expect(guard.once('run-3', async () => { tries += 1; throw new Error('offline') })).rejects.toThrow('offline')
    expect(guard.has('run-3')).toBe(false)
    await guard.once('run-3', async () => { tries += 1 })
    expect(tries).toBe(2)
    const posts = []
    await guard.once('run-4', async () => posts.push('final'))
    if (!guard.has('run-4')) await guard.once('run-4', async () => posts.push('stopped_early'))
    await guard.once('run-4', async () => posts.push('crash'))
    expect(posts).toEqual(['final'])
  })
})
