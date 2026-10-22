import { useEffect, useState } from 'react'

/**
 * How many of `total` items to render right now. A long list (a set with hundreds of cards) renders
 * its first `initial` items at once and the rest in small batches, one per task, so a phone's main
 * thread never blocks for long; a short list (up to `threshold`) renders whole, immediately.
 * The count starts over when `resetKey` changes (another set, filter or sort).
 */
export function useProgressiveCount(total, { resetKey = '', initial = 24, step = 16, threshold = 60 } = {}) {
  const [state, setState] = useState({ key: resetKey, count: initial })
  const count = state.key === resetKey ? state.count : initial

  useEffect(() => {
    if (total <= threshold || count >= total) return undefined
    const timer = window.setTimeout(() => {
      setState({ key: resetKey, count: Math.min(total, count + step) })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [count, total, threshold, step, resetKey])

  return total <= threshold ? total : Math.min(total, count)
}
