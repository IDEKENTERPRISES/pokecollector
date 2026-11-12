import api from './client'

// Administrator-sent notifications (backend/api/admin_notifications.py). Admin only.
export const sendAdminNotification = ({ title, body, route, recipients, urgent = false }) =>
  api.post('/admin/notifications', { title, body, route, recipients, urgent }).then(r => r.data)
// How many trainers a send reaches and how many of them are in quiet hours right now.
export const getAdminNotificationAudience = recipients =>
  api.get('/admin/notifications/audience', {
    params: { recipients: recipients === 'all' ? 'all' : recipients.join(',') },
  }).then(r => r.data)
export const getAdminNotifications = () => api.get('/admin/notifications').then(r => r.data)
