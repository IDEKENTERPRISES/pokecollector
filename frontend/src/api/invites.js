import api from './client'

// Invite links and the audit log (backend/api/invites.py). The admin calls need a signed-in admin
// in multi-user mode; check and accept are public, so they never send the stored token.

const publicCall = { skipAuthentication: true, preserveSessionOnUnauthorized: true }

export const createInvite = ({ role = 'trainer', expiresInDays = 7, note } = {}) =>
  api.post('/auth/invites', { role, expires_in_days: expiresInDays, ...(note ? { note } : {}) }).then(r => r.data)
export const getInvites = () => api.get('/auth/invites').then(r => r.data)
export const revokeInvite = id => api.delete(`/auth/invites/${id}`).then(r => r.data)
export const getAuditLog = ({ limit = 25, before } = {}) =>
  api.get('/auth/audit', { params: { limit, ...(before ? { before } : {}) } }).then(r => r.data)

export const checkInvite = token =>
  api.get(`/auth/invites/${encodeURIComponent(token)}/check`, publicCall).then(r => r.data)
export const acceptInvite = (token, { username, password }) =>
  api.post(`/auth/invites/${encodeURIComponent(token)}/accept`, { username, password }, publicCall).then(r => r.data)

/** The message of a failed invite call: a plain `detail`, or `detail.message` for refusals. */
export function inviteErrorMessage(error, fallback) {
  const detail = error?.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (detail?.message) return detail.message
  return fallback
}

/** The link to hand out. Built from this site's own address, whatever proxy the API sits behind. */
export const inviteLink = (token, origin = globalThis.location?.origin ?? '') => `${origin}/invite/${token}`
