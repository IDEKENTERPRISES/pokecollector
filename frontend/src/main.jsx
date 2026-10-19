import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import App from './App.jsx'
import { readPwaFlags } from './pwa/flags'
import { handlePreloadError, initServiceWorker } from './pwa/register'
import { updateStore } from './pwa/updateStore'
import './components/card-system/tokens.css'
import './index.css'
import './components/card-system/styles.css'

// Apply saved theme before first paint to prevent flash
const savedTheme = localStorage.getItem('theme')
if (savedTheme && savedTheme !== 'default') {
  document.documentElement.setAttribute('data-theme', savedTheme)
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
      refetchOnWindowFocus: false,
    },
  },
})

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        position="top-center"
        containerStyle={{ top: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}
        toastOptions={{
          // iOS banner (design doc §6.11): glass, radius 14, Subheadline text
          style: {
            background: 'var(--glass-bg)',
            WebkitBackdropFilter: 'var(--glass-filter)',
            backdropFilter: 'var(--glass-filter)',
            color: 'var(--color-text-primary)',
            border: '0.5px solid var(--glass-border)',
            borderRadius: '14px',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 32px rgba(0,0,0,0.45)',
            fontSize: '15px',
            lineHeight: '20px',
            maxWidth: '360px',
            padding: '10px 14px',
          },
          success: {
            iconTheme: { primary: '#30d158', secondary: '#000' },
          },
          error: {
            iconTheme: { primary: '#ff453a', secondary: '#000' },
          },
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>
)

// Opt-in service worker (PWA_ENABLED). Never activates a new worker without the user's click.
initServiceWorker({ flags: readPwaFlags(), onUpdateReady: registration => updateStore.setReady(registration) })

// A lazy chunk that fails to load after a deploy: offer the update, or reload once.
window.addEventListener('vite:preloadError', event => {
  const { registration } = updateStore.getSnapshot()
  handlePreloadError(event, { onUpdateReady: registration ? () => updateStore.setReady(registration) : null, registration })
})
