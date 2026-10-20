import ActionSheet from '../ios/ActionSheet'
import { useSettings } from '../../contexts/SettingsContext'

/**
 * Four-way choice shown by the logout guard (docs/PWA_OFFLINE_DESIGN.md D7, §6.6 A6) as an iOS
 * action sheet: Sync first, Log out and keep items, Log out and delete items, Cancel. A chosen
 * action resolves the guard once; the sheet's own close afterwards is a no-op on the settled promise.
 */
export default function LogoutGuardDialog({ isOpen, busy = false, onSync, onKeep, onDiscard, onCancel }) {
  const { t } = useSettings()

  return (
    <ActionSheet
      isOpen={isOpen}
      onClose={busy ? undefined : onCancel}
      title={t('sync.logoutTitle')}
      message={busy ? t('sync.syncingLabel') : t('sync.logoutMessage')}
      zIndex={500}
      actions={[
        { label: t('sync.logoutSyncFirst'), onSelect: onSync, disabled: busy },
        { label: t('sync.logoutKeep'), onSelect: onKeep, disabled: busy },
        { label: t('sync.logoutDiscard'), onSelect: onDiscard, disabled: busy, destructive: true },
      ]}
      cancelLabel={t('common.cancel')}
    />
  )
}
