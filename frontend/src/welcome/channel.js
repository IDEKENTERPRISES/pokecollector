// Which stack this build is for. Only nonprod shows "Coming next" in the version history
// (docs/NONPROD.md); `deploy` builds drop the draft from the bundle as well (vite.config.js).
// `window.__PC_RELEASE_CHANNEL__` lets a test pick the channel of a dev-server page.

export function releaseChannel() {
  const override = typeof window !== 'undefined' ? window.__PC_RELEASE_CHANNEL__ : null
  return override || (typeof __RELEASE_CHANNEL__ !== 'undefined' ? __RELEASE_CHANNEL__ : 'production')
}

export function isNonprod() {
  return releaseChannel() === 'nonprod'
}
