import { expect, test } from '@playwright/test'

// F14b: the optional card-picture download fetches one pack per set, saves progress per set, and never
// stops silently. 20 fixture sets with small pictures. "Offline" is simulated the way an iPhone behaves:
// requests that hang (navigator.onLine stays true), not requests that fail fast.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const oak = { ...ada, id: 2, username: 'oak', role: 'admin' }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const SET_COUNT = 20
const CARDS_PER_SET = 8
const FIELDS = ['id', 'name', 'set_id', 'number', 'images_small']
const setId = n => `fx${String(n).padStart(2, '0')}_en`
const SETS = Object.fromEntries(Array.from({ length: SET_COUNT }, (_, n) => {
  const id = setId(n)
  const cards = Array.from({ length: CARDS_PER_SET }, (_item, c) => [`${id}-${c}`, `Card ${c}`, id, String(c), 'x.webp'])
  return [id, { v: 1, set: { id, name: `Fixture ${n}`, series: 'Fixture', images_logo: 'logo.webp', lang: 'en' }, fields: FIELDS, cards }]
}))
const MANIFEST = {
  enabled: true,
  format: 1,
  languages: {
    en: {
      hash: 'lang-hash-1',
      prices_hash: 'prices-hash-1',
      prices_updated_at: '2026-10-22T10:00:00',
      prices_bytes: 20,
      set_count: SET_COUNT,
      card_count: SET_COUNT * CARDS_PER_SET,
      bytes: 3000,
      sets: Object.keys(SETS).map(id => ({ id, hash: `hash-${id}`, cards: CARDS_PER_SET, bytes: 150 })),
    },
  },
}

/** The pack format of backend/services/card_picture_packs.py. */
function buildPack(id) {
  const items = SETS[id].cards.map(row => row[0])
  const index = items.map((card, i) => ({ id: card, o: i * PNG.length, l: PNG.length, t: 'image/png' }))
  const header = Buffer.from(JSON.stringify({ v: 1, items: index, missing: [] }))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  return Buffer.concat([length, header, ...items.map(() => PNG)])
}

async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: state.user })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/offline/carddb/manifest') return route.fulfill({ json: MANIFEST })
    if (path.startsWith('/api/offline/carddb/sets/en/')) {
      return route.fulfill({ json: SETS[path.split('/').pop()], headers: { ETag: '"x"' } })
    }
    if (path === '/api/offline/carddb/prices/en') return route.fulfill({ json: { v: 1, fields: ['price_market'], rows: [] } })
    if (path === '/api/offline/carddb/pictures-prepare') {
      if (route.request().method() === 'POST') {
        state.prepareStarted = true
        return route.fulfill({ json: { running: true, total: 160, cached: 100, done: 0, failed: 0, error: null } })
      }
      return route.fulfill({ json: { running: false, total: 160, cached: 100, done: 0, failed: 0, error: null } })
    }
    if (path.startsWith('/api/offline/carddb/pictures/en/')) {
      const id = path.split('/').pop()
      state.packRequests.push(id)
      if (state.hang) return new Promise(() => {}) // the request never answers, like a stalled iPhone connection
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs))
      return route.fulfill({ body: buildPack(id), contentType: 'application/octet-stream', headers: { ETag: '"p"' } }).catch(() => {})
    }
    if (path.startsWith('/api/images/set/')) {
      state.singleRequests.push(path)
      if (state.hang) return new Promise(() => {})
      return route.fulfill({ body: PNG, contentType: 'image/png' }).catch(() => {})
    }
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

// The phone's card-database controls live on Sync & offline (/offline); the server row stays in Settings.
async function openDataSettings(page, context, state, path = '/offline') {
  await mockApi(context, state)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(user => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, state.user)
  await page.goto(path)
}

const row = page => page.getByTestId('carddb-pictures-row-en')
const savedSets = page => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('pc-carddb-pictures-v1-en') || '{"sets":{}}').sets))
const cachedCount = page => page.evaluate(async () => (await (await caches.open('pc-carddb-images-v1-en')).keys()).length)
const newState = (user = oak) => ({ user, packRequests: [], singleRequests: [], hang: false, delayMs: 0 })

async function startDownload(page) {
  const download = page.getByTestId('carddb-pictures-en')
  await expect(download).toBeVisible({ timeout: 30000 })
  await download.click()
}

test.describe('card picture download by set pack', () => {
  test.setTimeout(180000)

  test('downloads one pack per set into the picture cache and can be removed', async ({ page, context }) => {
    const state = newState()
    await openDataSettings(page, context, state)
    await startDownload(page)
    await expect(row(page)).toContainText('Downloaded', { timeout: 60000 })
    expect([...state.packRequests].sort()).toEqual(Object.keys(SETS).sort())
    // 8 cards plus the set logo (fetched singly) per set, one cache entry each
    await expect.poll(() => cachedCount(page)).toBe(SET_COUNT * (CARDS_PER_SET + 1))
    expect((await savedSets(page)).length).toBe(SET_COUNT)

    await row(page).getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByTestId('carddb-pictures-en')).toBeVisible()
    expect(await savedSets(page)).toEqual([])
    expect(await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('pc-carddb-images-v1-')))).toEqual([])
  })

  test('"Remove from this device" leaves no pictures behind, including the pictures seen while browsing', async ({ page, context }) => {
    const state = newState()
    await openDataSettings(page, context, state)
    await startDownload(page)
    await expect(row(page)).toContainText('Downloaded', { timeout: 60000 })
    await page.evaluate(async () => {
      await (await caches.open('pc-images-v1')).put('/api/images/card/seen/small', new Response('x', { headers: { 'Content-Type': 'image/png' } }))
    })
    expect(await page.evaluate(async () => (await caches.keys()).sort())).toEqual(['pc-carddb-images-v1-en', 'pc-images-v1'])

    await page.getByTestId('carddb-remove').click()
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('pc-')))).toEqual([])
    expect(await savedSets(page)).toEqual([])
    await expect(page.getByTestId('carddb-remove')).toHaveCount(0, { timeout: 15000 })
    // The section stays (no restart needed) and offers Download again; nothing downloads by itself.
    await expect(page.getByTestId('carddb-section')).toBeVisible()
    await expect(page.getByTestId('carddb-download')).toBeVisible()
    await page.waitForTimeout(1500)
    expect(await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('pc-')))).toEqual([])
    await page.getByTestId('carddb-download').click()
    await expect(page.getByTestId('carddb-language-en')).toContainText('cards', { timeout: 30000 })
  })

  test('reloading midway then resuming does not fetch the finished sets again', async ({ page, context }) => {
    const state = newState()
    state.delayMs = 250
    await openDataSettings(page, context, state)
    await startDownload(page)
    await expect.poll(async () => (await savedSets(page)).length, { timeout: 30000 }).toBeGreaterThanOrEqual(6)
    await page.reload()
    const finishedBeforeReload = await savedSets(page)
    expect(finishedBeforeReload.length).toBeGreaterThanOrEqual(6)
    expect(finishedBeforeReload.length).toBeLessThan(SET_COUNT)

    // After the restart the row shows where it stopped, with a working Resume.
    await expect(row(page)).toContainText('Paused', { timeout: 30000 })
    await expect(row(page)).toContainText(`of ${SET_COUNT}`)
    state.delayMs = 0
    await row(page).getByRole('button', { name: 'Resume' }).click()
    await expect(row(page)).toContainText('Downloaded', { timeout: 60000 })
    for (const id of finishedBeforeReload) expect(state.packRequests.filter(item => item === id), id).toHaveLength(1)
    expect((await savedSets(page)).length).toBe(SET_COUNT)
  })

  test('a stalled connection pauses with the reason and Resume continues when it is back', async ({ page, context }) => {
    const state = newState()
    state.delayMs = 150
    await page.clock.install()
    await openDataSettings(page, context, state)
    await startDownload(page)
    await expect.poll(async () => (await savedSets(page)).length, { timeout: 30000 }).toBeGreaterThanOrEqual(4)

    // "Offline" the iPhone way: requests hang, navigator.onLine stays true.
    state.hang = true
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    await expect.poll(async () => {
      await page.clock.fastForward(30000)
      return row(page).innerText()
    }, { timeout: 60000 }).toContain('Paused: the connection stalled')
    await expect(row(page).getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(row(page)).not.toContainText('Downloading')
    const doneWhenPaused = (await savedSets(page)).length
    expect(doneWhenPaused).toBeLessThan(SET_COUNT)

    state.hang = false
    state.delayMs = 0
    await row(page).getByRole('button', { name: 'Resume' }).click()
    await expect(row(page)).toContainText('Downloaded', { timeout: 60000 })
    expect((await savedSets(page)).length).toBe(SET_COUNT)
  })

  test('a download paused by a lost connection continues by itself when the connection is back', async ({ page, context }) => {
    const state = newState()
    state.delayMs = 150
    await page.clock.install()
    await openDataSettings(page, context, state)
    await startDownload(page)
    await expect.poll(async () => (await savedSets(page)).length, { timeout: 30000 }).toBeGreaterThanOrEqual(3)
    state.hang = true
    await expect.poll(async () => {
      await page.clock.fastForward(10000)
      return row(page).innerText()
    }, { timeout: 60000 }).toContain('Paused')
    state.hang = false
    state.delayMs = 0
    await expect.poll(async () => {
      await page.clock.fastForward(20000)
      return row(page).innerText()
    }, { timeout: 60000 }).toContain('Downloaded')
    expect((await savedSets(page)).length).toBe(SET_COUNT)
  })

  test('Last updated shows the time of day', async ({ page, context }) => {
    const state = newState()
    await openDataSettings(page, context, state)
    await expect(page.getByTestId('carddb-language-en')).toContainText(/Updated Today [0-9]{2}:[0-9]{2}/, { timeout: 30000 })
  })

  test('the server picture row says it is about the server, with a retry for the missing ones', async ({ page, context }) => {
    const state = newState()
    await openDataSettings(page, context, state, '/settings/data')
    const serverRow = page.getByTestId('carddb-prepare-row')
    await expect(serverRow).toContainText("On the server: 100 of 160 pictures ready · 60 couldn't be fetched", { timeout: 30000 })
    await expect(page.getByTestId('carddb-prepare')).toHaveText('Retry the 60 missing')
    // It sits apart from the phone's own picture rows.
    await expect(page.getByTestId('carddb-server-section').getByText('On the server (admins)')).toBeVisible()
    await expect(page.getByTestId('carddb-section')).toHaveCount(0) // the phone's controls are on /offline
  })

  test('an administrator can ask the server to prepare the card pictures', async ({ page, context }) => {
    const state = newState()
    await openDataSettings(page, context, state, '/settings/data')
    const prepare = page.getByTestId('carddb-prepare')
    await expect(prepare).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('carddb-prepare-row')).toContainText('100 of 160')
    await prepare.click()
    await expect.poll(() => state.prepareStarted).toBe(true)
  })
})

test.describe('Sync & offline for a trainer', () => {
  test.setTimeout(180000)

  test('shows the card database controls; Download pictures and Remove work; no server row', async ({ page, context }) => {
    const state = newState(ada)
    await openDataSettings(page, context, state)
    await expect(page.getByTestId('carddb-section')).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('carddb-enabled')).toBeVisible()
    await expect(page.getByTestId('carddb-language-en')).toContainText(/Updated Today [0-9]{2}:[0-9]{2}/, { timeout: 30000 })
    await expect(page.getByTestId('carddb-prepare-row')).toHaveCount(0)
    await expect(page.getByText('On the server (admins)')).toHaveCount(0)

    await startDownload(page)
    await expect(row(page)).toContainText('Downloaded', { timeout: 60000 })
    expect((await savedSets(page)).length).toBe(SET_COUNT)

    await page.getByTestId('carddb-remove').click()
    await expect(page.getByTestId('carddb-remove')).toHaveCount(0, { timeout: 15000 })
    expect(await savedSets(page)).toEqual([])
    await expect(page.getByTestId('carddb-download')).toBeVisible()
  })
})
