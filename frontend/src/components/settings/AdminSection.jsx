import BannerCard from './BannerCard'
import SendNotificationCard from './SendNotificationCard'

/** Settings > Administrator. Add further admin tools here, one card each. */
export default function AdminSection() {
  return (
    <div className="space-y-6" data-testid="admin-section">
      <SendNotificationCard />
      <BannerCard />
    </div>
  )
}
