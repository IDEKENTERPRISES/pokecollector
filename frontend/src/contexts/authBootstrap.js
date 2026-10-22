const MAX_RETRY_DELAY_MS = 10_000

// iOS keeps requests pending while offline instead of failing them, so the
// startup check must give up on its own. A timeout is a network error (no
// response), never a 401, so it takes the existing degraded/offline path.
export const AUTH_STARTUP_TIMEOUT_MS = 5_000

// With a remembered sign-in the first check gives up sooner: the saved data is waiting, and a server
// that is up answers in well under this. A slow answer only means a short stay in the degraded state.
export const AUTH_SNAPSHOT_TIMEOUT_MS = 1_500

/**
 * Runs `load()` but gives up after `ms` whatever the request does: the request's own timeout is
 * not trusted to fire (a hung connection on a phone, an intercepted request), and nothing at start-up
 * may wait for ever. A give-up is a plain network error, like the request's own timeout.
 */
export function withStartupDeadline(load, ms) {
  let timer = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Startup check timed out'), { code: 'ECONNABORTED' })), ms)
  })
  return Promise.race([load(), deadline]).finally(() => clearTimeout(timer))
}

export function authRetryDelay(attempt) {
  const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 0
  return Math.min(1_000 * (2 ** safeAttempt), MAX_RETRY_DELAY_MS)
}

export function isUnauthorized(error) {
  return error?.response?.status === 401
}

export async function loadAuthState({ token, getAuthMode, getMe, timeout = AUTH_STARTUP_TIMEOUT_MS }) {
  const { multi_user: multiUser, locked } = await getAuthMode({ timeout })

  if (typeof multiUser !== 'boolean') {
    throw new Error('Invalid authentication mode response')
  }

  if (multiUser && !token) {
    return {
      user: null,
      multiUser: true,
      modeLocked: Boolean(locked),
      clearSession: false,
      clearToken: false,
    }
  }

  try {
    const user = await getMe({
      // Single-user mode must always resolve the automatic admin, regardless
      // of any token left in the browser from an earlier multi-user session.
      withoutToken: !multiUser,
      // Bootstrap decides whether a 401 is an expired session. The shared
      // interceptor must not redirect or clear storage before that decision.
      preserveSession: true,
      timeout,
    })
    return {
      user,
      multiUser: Boolean(multiUser),
      modeLocked: Boolean(locked),
      clearSession: false,
      // Once single-user mode is confirmed, a token from an earlier
      // multi-user session must not leak into the rest of the app's requests.
      clearToken: !multiUser && Boolean(token),
    }
  } catch (error) {
    // An expired token is a resolved multi-user state, not a connectivity
    // problem. Network and server failures must bubble up so the caller can
    // retry without destroying an otherwise valid session.
    if (multiUser && token && isUnauthorized(error)) {
      return {
        user: null,
        multiUser: true,
        modeLocked: Boolean(locked),
        clearSession: true,
        clearToken: true,
      }
    }
    throw error
  }
}
