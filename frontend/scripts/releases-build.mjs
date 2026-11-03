// Build helpers for the release notes (docs/WELCOME_DESIGN.md §5.4, §5.5): the release id stamp and the
// nonprod-only "Coming next" draft. Only a build made with RELEASE_CHANNEL=nonprod keeps `next`
// (docker-compose.nonprod.yml sets it); every other build, `deploy`'s included, drops it from the bundle.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKSLASH = String.fromCharCode(92)
export const RELEASES_FILE = ['src', 'welcome', 'releases.json']

export function releaseChannel(env = process.env) {
  return env.VITE_RELEASE_CHANNEL === 'nonprod' ? 'nonprod' : 'production'
}

export function readReleases(root) {
  return JSON.parse(readFileSync(resolve(root, ...RELEASES_FILE), 'utf-8'))
}

/** The id of the newest release: what `__RELEASE_ID__` and the service worker's build id carry. */
export function readReleaseId(root) {
  const id = readReleases(root).releases?.[0]?.id
  if (!id) throw new Error('src/welcome/releases.json has no release')
  return id
}

/** The file's text without `next`, unless this is a nonprod build. */
export function releasesSource(text, channel) {
  if (channel === 'nonprod') return text
  const { next: _draft, ...rest } = JSON.parse(text)
  return JSON.stringify(rest)
}

/** Vite plugin: a production build leaves `next` out of the bundle. The dev server keeps it for tests. */
export function releasesPlugin({ channel, command }) {
  return {
    name: 'pokecollector-releases',
    enforce: 'pre',
    transform(code, id) {
      if (command !== 'build' || !id.split('?')[0].split(BACKSLASH).join('/').endsWith('/src/welcome/releases.json')) return null
      return { code: releasesSource(code, channel), map: null }
    },
  }
}
