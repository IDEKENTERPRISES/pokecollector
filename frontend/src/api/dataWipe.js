import api from './client'

// Wipe all user data (backend/api/data_wipe.py). Admin only. Scan photos and diagnostics are never deleted.
export const getDataWipePreview = () => api.get('/admin/data-wipe/preview').then(r => r.data)
export const runDataWipe = ({ phrase, password }) =>
  api.post('/admin/data-wipe', { phrase, password: password || null }, { timeout: 15 * 60 * 1000 }).then(r => r.data)
