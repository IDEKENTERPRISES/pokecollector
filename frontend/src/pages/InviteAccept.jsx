import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { acceptInvite, checkInvite, inviteErrorMessage } from '../api/invites'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'

const MIN_PASSWORD_LENGTH = 10

/**
 * /invite/:token, outside the shell like /login. Checks the link, then offers the account form:
 * username, password and confirmation, styled like the sign-in screen. On success the new account
 * is signed in and the app opens on Home.
 */
export default function InviteAccept() {
  const { token } = useParams()
  const navigate = useNavigate()
  const { loginUser } = useAuth()
  const { t } = useSettings()
  const [check, setCheck] = useState({ state: 'checking' })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    checkInvite(token)
      .then(result => {
        if (cancelled) return
        setCheck(result.valid ? { state: 'valid', role: result.role } : { state: 'invalid', reason: result.reason })
      })
      .catch(() => {
        if (cancelled) return
        setCheck({ state: 'invalid', reason: 'unreachable' })
      })
    return () => { cancelled = true }
  }, [token])

  const mismatch = confirm.length > 0 && password !== confirm
  const canSubmit = username.trim().length >= 2 && password.length >= MIN_PASSWORD_LENGTH && password === confirm && !submitting

  const handleSubmit = async event => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const data = await acceptInvite(token, { username: username.trim(), password })
      localStorage.setItem('lastUser', data.user.username)
      localStorage.setItem('lastUserAvatar', data.user.avatar_id || '')
      loginUser(data.access_token, data.user)
      navigate('/', { replace: true })
    } catch (error) {
      const reason = error?.response?.data?.detail?.reason
      if (reason) setCheck({ state: 'invalid', reason })
      else toast.error(inviteErrorMessage(error, t('invites.page.failed')))
    } finally {
      setSubmitting(false)
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
          <h1 className="mt-1 text-large-title text-text-primary">{t('invites.page.title')}</h1>
          <p className="mt-1 text-subheadline text-text-secondary">{t('invites.page.subtitle')}</p>
        </header>

        {check.state === 'checking' && (
          <p role="status" className="text-body text-text-secondary">{t('invites.page.checking')}</p>
        )}

        {check.state === 'invalid' && (
          <div className="space-y-5" data-testid="invite-invalid">
            <div className="rounded-xl bg-card px-4 py-4">
              <p className="text-headline text-text-primary" data-reason={check.reason}>
                {t(`invites.page.reasons.${check.reason}`)}
              </p>
              {check.reason !== 'multi_user_off' && check.reason !== 'unreachable' && (
                <p className="mt-1 text-subheadline text-text-secondary">{t('invites.page.ask')}</p>
              )}
            </div>
            <Link to="/login" className="mx-auto block min-h-[44px] text-center text-body text-tint">
              {t('invites.page.home')}
            </Link>
          </div>
        )}

        {check.state === 'valid' && (
          <form onSubmit={handleSubmit} method="post" action="/invite" className="space-y-5" data-testid="invite-form">
            {check.role === 'admin' && <p className="text-footnote text-yellow">{t('invites.page.asAdmin')}</p>}
            <div className="overflow-hidden rounded-xl bg-card">
              <label htmlFor="invite-username" className={labelClass}>{t('invites.page.username')}</label>
              <input
                type="text"
                name="username"
                id="invite-username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={event => setUsername(event.target.value)}
                className={fieldClass}
                maxLength={32}
                autoFocus
                required
              />
              <div className="mx-4 h-px bg-border" />
              <label htmlFor="invite-password" className={labelClass}>{t('invites.page.password')}</label>
              <input
                type="password"
                name="new-password"
                id="invite-password"
                autoComplete="new-password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                className={fieldClass}
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
              <div className="mx-4 h-px bg-border" />
              <label htmlFor="invite-confirm" className={labelClass}>{t('invites.page.confirm')}</label>
              <input
                type="password"
                name="confirm-password"
                id="invite-confirm"
                autoComplete="new-password"
                value={confirm}
                onChange={event => setConfirm(event.target.value)}
                className={fieldClass}
                required
              />
            </div>
            <p className={`px-4 text-footnote ${mismatch ? 'text-red' : 'text-text-secondary'}`}>
              {mismatch ? t('invites.page.mismatch') : t('invites.page.passwordHint')}
            </p>
            <button type="submit" disabled={!canSubmit} className={submitClass}>
              {submitting ? t('invites.page.submitting') : t('invites.page.submit')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
