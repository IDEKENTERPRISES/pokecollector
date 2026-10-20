import { RefreshCw, WifiOff } from 'lucide-react'
import PokeBallLoader from './PokeBallLoader'
import { useSettings } from '../contexts/SettingsContext'

export default function AuthStartupScreen({ connectionError = false, onRetry }) {
  const { t } = useSettings()

  return (
    <main className="min-h-screen bg-bg px-4 flex items-center justify-center">
      <section
        className="w-full max-w-md rounded-xl bg-card p-6 text-center sm:p-8"
        aria-live="polite"
      >
        {connectionError ? (
          <>
            <WifiOff size={44} className="mx-auto text-brand-red" aria-hidden="true" />
            <h1 className="mt-4 text-title-2 text-text-primary">
              {t('auth.connectionTitle')}
            </h1>
            <p className="mt-2 text-subheadline leading-relaxed text-text-secondary">
              {t('auth.connectionMessage')}
            </p>
            <button type="button" className="mt-6 flex min-h-[50px] w-full items-center justify-center gap-2 rounded-full bg-accent px-6 text-headline text-on-accent ios-press" onClick={onRetry}>
              <RefreshCw size={16} aria-hidden="true" />
              {t('auth.retryConnection')}
            </button>
          </>
        ) : (
          <>
            <PokeBallLoader size={48} />
            <h1 className="mt-5 text-title-2 text-text-primary">
              {t('auth.startingTitle')}
            </h1>
            <p className="mt-2 text-subheadline text-text-secondary">{t('auth.startingMessage')}</p>
          </>
        )}
      </section>
    </main>
  )
}
