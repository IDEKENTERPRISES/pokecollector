import api from './client'

// Admin banners (backend/api/banners.py). The admin calls need an administrator; the trainer calls do not.
export const getAdminBanners = () => api.get('/admin/banners').then(r => r.data)
export const createBanner = payload => api.post('/admin/banners', payload).then(r => r.data)
export const updateBanner = (id, payload) => api.put(`/admin/banners/${id}`, payload).then(r => r.data)
export const endBanner = id => api.post(`/admin/banners/${id}/end`).then(r => r.data)
export const deleteBanner = id => api.delete(`/admin/banners/${id}`).then(r => r.data)
export const getActiveBanners = () => api.get('/banners/active').then(r => r.data)
export const dismissBanner = id => api.post(`/banners/${id}/dismiss`).then(r => r.data)
