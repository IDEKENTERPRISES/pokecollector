/** The request body for POST /card-match/phone-speed: JSON for the built-in sample (no image at all), multipart with the
 *  photo taken or picked on the page otherwise. Only timings, device facts and the phone's answer go in the JSON
 *  (for the full matcher also its `matcher` block: decision, top 20, what it read, stage times). */
export function speedRunRequest(outcome, photoFile) {
  const data = {
    timings: outcome.timings, device: outcome.device, answer: outcome.answer, ...(outcome.matcher ? { matcher: outcome.matcher } : {}), ...(outcome.runId ? { client_id: outcome.runId } : {}),
  }
  if (!photoFile) return { body: data, multipart: false }
  const form = new FormData()
  form.append('data', JSON.stringify(data))
  form.append('photo', photoFile, photoFile.name || 'photo.jpg')
  return { body: form, multipart: true }
}

/**
 * One post per run id. A second call with an id that is already being posted shares that request; one that was posted is
 * answered without a request. A failed post is forgotten, so a retry ("Send numbers") can go out. The server also refuses to
 * store a run id twice, so a replay from the offline queue cannot duplicate a row either.
 */
export function createPostGuard() {
  const done = new Set()
  const flying = new Map()
  return {
    has: id => done.has(id) || flying.has(id),
    once(id, send) {
      if (done.has(id)) return Promise.resolve({ skipped: true })
      if (flying.has(id)) return flying.get(id)
      const request = Promise.resolve().then(send).then(result => { done.add(id); return result }).finally(() => flying.delete(id))
      flying.set(id, request)
      return request
    },
  }
}
