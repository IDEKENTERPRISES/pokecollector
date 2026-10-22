// Runs the card database engine off the main thread (F14a). One request in, one reply out:
//   { id, method, args }  ->  { id, result } | { id, error }
import { createCardDbEngine } from './engine.js'
import { createCardDbStore } from './store.js'

const engine = createCardDbEngine({ store: createCardDbStore() })
const METHODS = new Set(['sets', 'pricesUpdatedAt', 'checklist', 'card', 'search', 'prepare'])

self.onmessage = async event => {
  const { id, method, args } = event.data || {}
  try {
    if (!METHODS.has(method)) throw new Error(`Unknown method ${method}`)
    const result = await engine[method](...(args ?? []))
    self.postMessage({ id, result })
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) })
  }
}
