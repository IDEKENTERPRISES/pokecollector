// The offline copy of "the last release this trainer has seen" (docs/WELCOME_DESIGN.md §5.5).
// A failure never gets in the way: without storage the server's copy is the only one.

const PREFIX = 'pc.whatsNew.seen.'

export function seenKey(userId) {
  return `${PREFIX}${userId}`
}

export function readLocalSeen(userId, storage = globalThis.localStorage) {
  try {
    return storage?.getItem(seenKey(userId)) || null
  } catch {
    return null
  }
}

export function writeLocalSeen(userId, id, storage = globalThis.localStorage) {
  try {
    storage?.setItem(seenKey(userId), id)
  } catch {
    // best effort
  }
}
