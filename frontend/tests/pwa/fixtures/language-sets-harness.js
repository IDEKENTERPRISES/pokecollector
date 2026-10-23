import { expect } from '@playwright/test'
import { buildBilingualCarddb } from './carddb-bilingual.js'

// Shared by the language-sets specs: a mock server that answers like the real backend, about 30,000 cards
// in two languages (en + ja), and the helpers that measure what a person would feel on an iPhone.

export const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
export const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
export const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export const data = buildBilingualCarddb()
export const { dbs, bodies, fields } = data
export const at = Object.fromEntries(fields.map((field, index) => [field, index]))
export const langOfSetId = id => id.slice(id.lastIndexOf('_') + 1)
export const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** GET /api/sets/{id}/checklist the way the real backend answers: the set's own rows in its language. */
export function checklistOf(setId) {
  const lang = langOfSetId(setId)
  const payload = dbs[lang]?.sets[setId]
  if (!payload) return null
  const set = payload.set
  const cards = payload.cards.map(row => {
    const card = Object.fromEntries(fields.map((field, index) => [field, row[index]]))
    return {
      id: card.id,
      name: card.name,
      tcg_card_id: card.tcg_card_id,
      set_id: card.set_id,
      set_ref: { id: set.id, tcg_set_id: set.tcg_set_id, name: set.name, abbreviation: set.abbreviation, lang },
      number: card.number,
      rarity: card.rarity,
      images_small: card.images_small,
      images_large: card.images_large,
      image_source_lang: card.image_source_lang === card.lang ? null : card.image_source_lang,
      data_source_lang: card.data_source_lang === card.lang ? null : card.data_source_lang,
      owned: false, owned_quantity: 0, owned_variants: [], wishlisted: false, quantity: 0, owned_items: [],
      price_market: null, price_low: null,
      dex_ids: card.dex_ids,
      variants_normal: card.variants_normal, variants_reverse: card.variants_reverse,
      variants_holo: card.variants_holo, variants_first_edition: card.variants_first_edition,
      lang: card.lang,
    }
  })
  return {
    set: { id: set.id, name: set.name, series: set.series, total: set.total, images_symbol: null, images_logo: null, lang },
    cards, owned_count: 0, total_count: cards.length, progress: 0,
  }
}

export async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    // Airplane Mode on an iPhone: the request is neither answered nor refused.
    if (state.offline && (state.hideLanguages || path !== '/api/settings/tcgdex-filter-languages')) return undefined
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/' && route.request().method() === 'PUT') {
      Object.assign(state.settings, JSON.parse(route.request().postData() || '{}'))
      return route.fulfill({ json: state.settings })
    }
    if (path === '/api/settings/') return route.fulfill({ json: state.settings })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') {
      return route.fulfill({ json: { languages: (state.languages ?? ['en', 'ja']).map(code => ({ code, name: code === 'ja' ? 'Japanese' : 'English' })) } })
    }
    if (path === '/api/offline/carddb/manifest') return route.fulfill({ status: 200, contentType: 'application/json', body: bodies.manifest })
    const downloaded = /^\/api\/offline\/carddb\/sets\/(en|ja)\/(.+)$/.exec(path)
    if (downloaded) {
      const body = bodies.sets[downloaded[1]][downloaded[2]]
      return body ? route.fulfill({ status: 200, contentType: 'application/json', body, headers: { ETag: '"x"' } }) : route.fulfill({ status: 404, json: {} })
    }
    const prices = /^\/api\/offline\/carddb\/prices\/(en|ja)$/.exec(path)
    if (prices) return route.fulfill({ status: 200, contentType: 'application/json', body: bodies.prices[prices[1]] })
    // The offline runs must be answered by the card database, so the server's sets are not saved for them.
    if (path === '/api/sets/') {
      if (state.cardDbOnly) return route.fulfill({ status: 404, json: {} })
      const lang = url.searchParams.get('lang') || 'en'
      const langs = lang === 'all' ? ['en', 'ja'] : [lang]
      return route.fulfill({ json: langs.flatMap(code => dbs[code].setList.map(set => ({ ...set, owned_count: 0, is_new: false }))) })
    }
    const checklist = /^\/api\/sets\/([^/]+)\/checklist$/.exec(path)
    if (checklist) {
      if (state.cardDbOnly) return route.fulfill({ status: 404, json: {} })
      const body = checklistOf(decodeURIComponent(checklist[1]))
      return body ? route.fulfill({ json: body }) : route.fulfill({ status: 404, json: { detail: 'Set not found' } })
    }
    if (path === '/api/collection/') return route.fulfill({ json: [] })
    if (path.startsWith('/api/images/card/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

export const carddbState = page => page.evaluate(async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pokecollector-carddb')
    request.onupgradeneeded = () => request.transaction.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(() => null)
  if (!database) return { sets: 0, meta: [] }
  const read = (store, method) => new Promise((resolve, reject) => {
    const request = database.transaction(store).objectStore(store)[method]()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const result = { sets: (await read('setIndex', 'getAllKeys')).length, meta: await read('meta', 'getAllKeys') }
  database.close()
  return result
})

// How long the main thread stopped answering: a 20 ms heartbeat records its largest gap (it works in
// WebKit, which has no long-task observer), plus long tasks where the browser reports them.
export const HEARTBEAT = () => {
  window.__gap = 0
  window.__longTasks = []
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    window.__gap = Math.max(window.__gap, now - last - 20)
    last = now
  }, 20)
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration))
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // not supported (WebKit)
  }
}
export const resetStall = page => page.evaluate(() => { window.__gap = 0; window.__longTasks = [] })
export const readStall = page => page.evaluate(() => Math.round(Math.max(window.__gap, ...window.__longTasks, 0)))

/**
 * Taps Back and returns how long the page took, inside the page, from the tap to the target page being
 * painted (two frames after it is in the DOM). Playwright's own click and polling time is not in it.
 */
export async function tapBack(page, targetTestId) {
  const measured = page.evaluate(testId => new Promise(resolve => {
    document.querySelector('[data-testid="nav-back"]').addEventListener('click', () => {
      const started = performance.now()
      const check = () => {
        if (document.querySelector(`[data-testid="${testId}"]`)) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - started))))
        } else {
          requestAnimationFrame(check)
        }
      }
      check()
    }, { once: true, capture: true })
  }), targetTestId)
  await page.getByTestId('nav-back').click()
  return measured
}

/** What the set page shows: the card names and the pictures they ask for. */
export async function setPageCards(page) {
  await expect(page.getByRole('button', { name: /^Add / }).first()).toBeVisible({ timeout: 30000 })
  // Online the pictures load a moment after the cards; offline their requests hang and none arrive.
  await page.waitForFunction(() => document.querySelector('img[src*="/api/images/card/"]'), null, { timeout: 5000 }).catch(() => {})
  return page.evaluate(() => ({
    names: [...document.querySelectorAll('button[aria-label^="Add "]')].map(node => node.getAttribute('aria-label').slice(4)),
    pictures: [...document.querySelectorAll('img')].map(img => img.getAttribute('src') || '').filter(src => src.includes('/api/images/card/')),
  }))
}

