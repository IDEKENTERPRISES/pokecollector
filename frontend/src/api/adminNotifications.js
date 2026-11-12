import api from './client'

// Administrator-sent notifications (backend/api/admin_notifications.py). Admin only.
export const sendAdminNotification = ({ title, body, route, recipients }) =>
  api.post('/admin/notifications', { title, body, route, recipients }).then(r => r.data)
export const getAdminNotifications = () => api.get('/admin/notifications').then(r => r.data)
