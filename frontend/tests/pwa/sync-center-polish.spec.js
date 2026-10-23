import { expect, test } from '@playwright/test'

// F17: the card database section looks like the rest of Sync & offline, no text is cut off with an
// ellipsis, and the storage block lists what is really on the device.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const FIELDS = ['id', 'tcg_card_id', 'name', 'set_id', 'number', 'rarity', 'supertype', 'hp', 'types', 'dex_ids', 'images_small', 'lang']
const SETS = {
  pbl_en: {
    v: 1,
    set: { id: 'pbl_en', tcg_set_id: 'pbl', name: 'Perilous Bloom', series: 'Fixture Series', series_id: 'fixture', abbreviation: 'PBL', release_date: '2026-08-01', total: 1, lang: 'en' },
    fields: FIELDS,
    cards: [['pbl-9_en', 'pbl-9', 'Pikachu', 'pbl', '9', 'Common', 'Pokémon', '70', ['Lightning'], [25], null, 'en']],
  },
}
const MANIFEST = {
  enabled: true,
  format: 1,
  languages: {
    en: {
      hash: 'lang-hash-1', prices_hash: 'prices-hash-1', prices_updated_at: '2026-10-20T10:00:00', prices_bytes: 20,
      set_count: 1, card_count: 1, bytes: 150, sets: [{ id: 'pbl_en', hash: 'h1', cards: 1, bytes: 150 }],
    },
  },
}

async function mockApi(context) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/offline/carddb/manifest') return route.fulfill({ json: MANIFEST })
    if (path.startsWith('/api/offline/carddb/sets/en/')) {
      return route.fulfill({ json: SETS[path.split('/').pop()], headers: { ETag: '"x"' } })
    }
    if (path === '/api/offline/carddb/prices/en') return route.fulfill({ json: { v: 1, fields: ['price_market'], rows: [] } })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

async function open(page, context, width) {
  await mockApi(context)
  await page.setViewportSize({ width, height: 844 })
  await page.addInitScript(user => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, ada)
  await page.goto('/offline')
  await expect(page.getByTestId('carddb-language-en')).toContainText('cards', { timeout: 30000 })
}

// Elements whose text is cut off with an ellipsis (text-overflow: ellipsis and a scroll width past the box).
const clipped = page => page.evaluate(() => [...document.querySelectorAll('[data-testid="offline-center"] *')]
  .filter(node => getComputedStyle(node).textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth)
  .map(node => node.textContent.trim().slice(0, 60)))

test.describe('Sync & offline polish', () => {
  test.setTimeout(120000)

  test('the card section uses the page list styling and no text is cut off at 390 px', async ({ page, context }) => {
    await open(page, context, 390)
    const look = await page.evaluate(() => {
      const style = node => {
        const css = getComputedStyle(node)
        return { radius: css.borderTopLeftRadius, border: css.borderTopWidth, background: css.backgroundColor, padding: css.paddingTop }
      }
      const sections = [...document.querySelectorAll('[data-testid="offline-center"] > section')]
      const cards = document.querySelector('[data-testid="carddb-section"]')
      const list = cards.querySelector('ul')
      const rows = [...list.children]
      return {
        card: style(cards),
        others: sections.filter(node => node !== cards).map(style),
        listClass: list.className,
        divider: getComputedStyle(rows[0]).borderBottomWidth,
        rowCount: rows.length,
      }
    })
    for (const other of look.others) expect(look.card).toEqual(other)
    expect(look.listClass).toContain('divide-y')
    expect(look.rowCount).toBeGreaterThan(2)
    expect(look.divider).toBe('1px')
    expect(await clipped(page)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('the storage block lists the real figures, not queued photos as "offline data"', async ({ page, context }) => {
    await open(page, context, 390)
    const block = page.getByTestId('storage-breakdown')
    await expect(block).toBeVisible()
    for (const id of ['storage-card-data', 'storage-pictures', 'storage-pages', 'storage-waiting', 'storage-total']) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    await expect(page.getByTestId('storage-card-data')).toContainText(/[0-9.]+ (KB|MB|GB)/)
    await expect(page.getByTestId('storage-waiting')).toContainText('0.0 KB')
    await expect(page.getByText('Used by offline data')).toHaveCount(0)
  })

  test('a narrow phone with large text still shows every label whole', async ({ page, context }) => {
    await open(page, context, 375)
    await page.addStyleTag({ content: 'html { font-size: 24px !important }' })
    expect(await clipped(page)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
