import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { User } from 'lucide-react'
import toast from 'react-hot-toast'
import AuthStartupScreen from '../components/AuthStartupScreen'
import { login } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'

export default function Login() {
  const [lastUser] = useState(() => localStorage.getItem('lastUser') || '')
  const [lastUserAvatar] = useState(() => localStorage.getItem('lastUserAvatar') || '')
  const [showSwitchUser, setShowSwitchUser] = useState(() => !localStorage.getItem('lastUser'))
  const [username, setUsername] = useState(() => localStorage.getItem('lastUser') || '')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { user, loading: authLoading, connectionError, loginUser, multiUser, retryConnection } = useAuth()
  const { t } = useSettings()
  const navigate = useNavigate()

  if (authLoading) {
    return <AuthStartupScreen connectionError={connectionError} onRetry={retryConnection} />
  }

  if (user || !multiUser) {
    return <Navigate to="/" replace />
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)

    try {
      const data = await login(username, password)
      localStorage.setItem('lastUser', username)
      localStorage.setItem('lastUserAvatar', data.user.avatar_id || '')
      loginUser(data.access_token, data.user)
      navigate('/')
    } catch (err) {
      toast.error(err.response?.data?.detail || t('auth.loginFailed'))
    } finally {
      setLoading(false)
    }
  }

  const fieldClass = 'w-full bg-transparent px-4 pb-2.5 pt-0.5 text-body text-text-primary placeholder:text-text-tertiary outline-hidden'
  const labelClass = 'block px-4 pt-2.5 text-footnote text-text-secondary'
  const submitClass = 'flex min-h-[50px] w-full items-center justify-center rounded-full bg-accent px-6 text-headline text-on-accent shadow-[0_4px_14px_color-mix(in_srgb,var(--color-accent)_28%,transparent)] disabled:opacity-40 ios-press'

  return (
    <div className="min-h-screen bg-bg px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(48px,env(safe-area-inset-top))]">
      <div className="mx-auto w-full max-w-md">
        <header className="mb-8">
          <p className="text-footnote font-semibold text-text-secondary">PokéCollector</p>
          <h1 className="mt-1 text-large-title text-text-primary">
            {lastUser && !showSwitchUser ? t('auth.welcomeBack') : t('auth.login')}
          </h1>
          <p className="mt-1 text-subheadline text-text-secondary">{t('auth.signInToCollection')}</p>
        </header>

        {lastUser && !showSwitchUser ? (
          <form onSubmit={handleSubmit} method="post" action="/login" className="space-y-5">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-24 w-24 items-center justify-center rounded-full border border-border bg-card">
                {lastUserAvatar ? (
                  <img
                    src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${lastUserAvatar}.gif`}
                    alt={`${lastUser} avatar`}
                    className="w-16 h-16 pixelated"
                  />
                ) : (
                  <User size={40} className="text-text-primary" />
                )}
              </div>
              <label htmlFor="login-username-saved" className="sr-only">{t('auth.username')}</label>
              <input
                type="text"
                name="username"
                id="login-username-saved"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="mt-3 w-full max-w-[16rem] bg-transparent text-center text-title-3 text-text-primary outline-hidden"
              />
            </div>

            <div className="overflow-hidden rounded-xl bg-card">
              <label htmlFor="login-password-saved" className={labelClass}>{t('auth.password')}</label>
              <input
                type="password"
                name="password"
                id="login-password-saved"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={fieldClass}
                autoFocus
                required
              />
            </div>

            <button type="submit" disabled={loading || !password} className={submitClass}>
              {loading ? t('auth.signingIn') : t('auth.login')}
            </button>

            <button
              type="button"
              onClick={() => {
                setShowSwitchUser(true)
                setUsername('')
                setPassword('')
              }}
              className="mx-auto block min-h-[44px] text-body text-tint"
            >
              {t('auth.switchUser')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmit} method="post" action="/login" className="space-y-5">
            <div className="overflow-hidden rounded-xl bg-card">
              <label htmlFor="login-username" className={labelClass}>{t('auth.username')}</label>
              <input
                type="text"
                name="username"
                id="login-username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={fieldClass}
                autoFocus
                required
              />
              <div className="mx-4 h-[0.5px] bg-border" aria-hidden="true" />
              <label htmlFor="login-password" className={labelClass}>{t('auth.password')}</label>
              <input
                type="password"
                name="password"
                id="login-password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={fieldClass}
                required
              />
            </div>

            <button type="submit" disabled={loading || !username || !password} className={submitClass}>
              {loading ? t('auth.signingIn') : t('auth.login')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
