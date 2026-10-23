// The engine as the app uses it: in a Web Worker, so decoding and searching tens of thousands of
// cards never blocks the main thread. If a worker can't be started (or dies), the same engine runs
// inline, slower but working. Tests use createCardDbEngine directly.

import { createCardDbEngine } from './engine.js'

const METHODS = ['sets', 'pricesUpdatedAt', 'checklist', 'card', 'search', 'prepare']

export function createBackgroundEngine({ store, createWorker = defaultWorker }) {
  const inline = createCardDbEngine({ store })
  let worker = null
  let broken = false
  let nextId = 1
  const pending = new Map()

  const fail = reason => {
    broken = true
    for (const { reject } of pending.values()) reject(reason)
    pending.clear()
    try {
      worker?.terminate()
    } catch {
      // already gone
    }
    worker = null
  }

  function start() {
    if (worker || broken) return worker
    try {
      worker = createWorker()
    } catch {
      broken = true
      return null
    }
    if (!worker) {
      broken = true
      return null
    }
    worker.onmessage = event => {
      const { id, result, error } = event.data || {}
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (error !== undefined) entry.reject(new Error(error))
      else entry.resolve(result)
    }
    worker.onerror = event => {
      event?.preventDefault?.()
      fail(new Error('card database worker failed'))
    }
    worker.onmessageerror = () => fail(new Error('card database worker message failed'))
    return worker
  }

  const call = (method, args) => {
    const target = start()
    if (!target) return inline[method](...args)
    return new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      pending.set(id, { resolve, reject })
      try {
        target.postMessage({ id, method, args })
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    }).catch(error => {
      // A dead worker falls back to running inline; a real error from the engine is passed on.
      if (broken) return inline[method](...args)
      throw error
    })
  }

  return Object.fromEntries(METHODS.map(method => [method, (...args) => call(method, args)]))
}

function defaultWorker() {
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' })
}
