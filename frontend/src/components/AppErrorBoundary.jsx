import { Component } from 'react'
import en from '../i18n/en'

/**
 * Top-level error boundary. A render crash otherwise leaves a blank black page that only a
 * relaunch fixes; this shows a message and a Reload button instead. It sits above the providers,
 * so it reads the English strings directly.
 */
export default class AppErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error('App crashed', error, info?.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    const text = en.errors
    return (
      <main role="alert" className="flex min-h-screen flex-col items-center justify-center gap-3 bg-black px-6 text-center">
        <h1 className="text-title-2 text-text-primary">{text.title}</h1>
        <p className="max-w-xs text-subheadline text-text-secondary">{text.message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 flex min-h-[50px] items-center justify-center rounded-full bg-accent px-8 text-headline text-on-accent ios-press"
        >
          {text.reload}
        </button>
      </main>
    )
  }
}
