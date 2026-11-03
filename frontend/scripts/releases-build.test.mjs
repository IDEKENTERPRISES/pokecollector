import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { readReleaseId, releaseChannel, releasesPlugin, releasesSource } from './releases-build.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'src', 'welcome', 'releases.json')
const toPosix = (p) => p.split(String.fromCharCode(92)).join('/')
const text = readFileSync(file, 'utf-8')

test('the release file has a draft to strip', () => {
  assert.ok(JSON.parse(text).next, 'releases.json should carry a `next` draft on nonprod')
})

test('the release id is the first entry', () => {
  assert.equal(readReleaseId(root), JSON.parse(text).releases[0].id)
})

test('only a nonprod build keeps the draft', () => {
  assert.equal(releaseChannel({}), 'production')
  assert.equal(releaseChannel({ VITE_RELEASE_CHANNEL: 'nonprod' }), 'nonprod')
  assert.equal(releaseChannel({ VITE_RELEASE_CHANNEL: 'anything else' }), 'production')
  assert.ok(JSON.parse(releasesSource(text, 'nonprod')).next)
  const stripped = JSON.parse(releasesSource(text, 'production'))
  assert.equal('next' in stripped, false)
  assert.deepEqual(stripped.releases, JSON.parse(text).releases)
})

test('a deploy-style build leaves `next` (and the Cyndaquil draft) out of the bundle', () => {
  const plugin = releasesPlugin({ channel: 'production', command: 'build' })
  const out = plugin.transform(text, toPosix(file) + '?import')
  assert.ok(out)
  assert.doesNotMatch(out.code, /Cyndaquil/)
  assert.equal(JSON.parse(out.code).releases.length, JSON.parse(text).releases.length)
  // Other files and the dev server are left alone.
  assert.equal(plugin.transform('{}', join(root, 'package.json')), null)
  assert.equal(releasesPlugin({ channel: 'production', command: 'serve' }).transform(text, file), null)
  assert.equal(releasesPlugin({ channel: 'nonprod', command: 'build' }).transform(text, file).code, text)
})
