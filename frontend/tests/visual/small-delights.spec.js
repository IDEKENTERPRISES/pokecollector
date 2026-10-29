import { expect, test } from '@playwright/test'

// Small delights (engagement P8): Home's On this day card, the Showcase 6 picker and the Collection DNA page.
// Runs on iPhone WebKit through playwright.webkit.config.js.

const USER = { id: 1, username: 'Delight Reviewer', role: 'admin', is_active: true, must_change_password: false }
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const CARDS = [
  { id: 11, card_id: 'a_en', name: 'Charizard' },
  { id: 12, card_id: 'b_en', name: 'Pikachu' },
  { id: 13, card_id: 'c_en', name: 'Eevee' },
]
const showcaseCard = card => ({ id: card.id, card_id: card.card_id, name: card.name, image: `/api/images/card/${card.card_id}/small`, set_name: 'Base', variant: 'Normal', market_value: null })

const ON_THIS_DAY = {
  date: '2026-10-28',
  month: 10,
  day: 28,
  total: 3,
  years: [
    { year: 2025, count: 2, cards: [{ card_id: 'a_en', name: 'Charizard', image: '/api/images/card/a_en/small' }, { card_id: 'b_en', name: 'Pikachu', image: '/api/images/card/b_en/small' }] },
    { year: 2023, count: 1, cards: [{ card_id: 'c_en', name: 'Eevee', image: '/api/images/card/c_en/small' }] },
  ],
}

const DNA = {
  total_cards: 12,
  types: [{ type: 'fire', count: 6 }, { type: 'water', count: 4 }, { type: 'colorless', count: 2 }],
  illustrators: [{ name: 'Mitsuhiro Arita', count: 7 }, { name: 'Ken Sugimori', count: 3 }],
  eras: [{ year: 1999, count: 2 }, { year: 2023, count: 10 }],
  pokemon: [{ dex_id: 6, name: 'Charizard', count: 5 }, { dex_id: 25, name: 'Pikachu', count: 3 }],
}

const today = () => {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const entryFor = date => ({
  date,
  dex_id: 133,
  name: 'Eevee',
  lang: 'en',
  generation: 1,
  region: 'Kanto',
  types: ['normal'],
  genus: 'Evolution Pokémon',
  height_m: 0.3,
  weight_kg: 6.5,
  shiny: false,
  facts: [{ kind: 'trait', text: 'It can evolve in many ways.' }],
  sprite_url: '/api/pokedex/images/showdown/133.gif',
  sprite_style: 'animated',
})

const puzzleFor = date => ({
  date,
  lang: 'en',
  answer: 25,
  sprite_url: '/api/pokedex/images/artwork/25.png',
  choices: [{ dex_id: 1, name: 'Bulbasaur' }, { dex_id: 25, name: 'Pikachu' }, { dex_id: 4, name: 'Charmander' }, { dex_id: 7, name: 'Squirtle' }],
})

async function install(page, { onThisDay = ON_THIS_DAY } = {}) {
  const state = { showcase: [], puts: [] }
  await page.addInitScript((user) => {
    localStorage.setItem('token', 'delights-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
  }, USER)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path.startsWith('/api/pokedex/images/') || path.startsWith('/api/images/')) {
      return route.fulfill({ body: PNG, contentType: 'image/png' })
    }
    const date = new URL(request.url()).searchParams.get('date') || today()
    if (path === '/api/pokedex/splash') return route.fulfill({ json: entryFor(date) })
    if (path === '/api/pokedex/wtp') return route.fulfill({ json: puzzleFor(date) })
    if (path === '/api/progress/daily/view') return route.fulfill({ json: {} })
    if (path === '/api/progress/on-this-day') return route.fulfill({ json: onThisDay })
    if (path === '/api/analytics/dna') return route.fulfill({ json: DNA })
    if (path === '/api/profile/showcase') {
      if (request.method() === 'PUT') {
        state.showcase = request.postDataJSON().ids
        state.puts.push(state.showcase)
      }
      const cards = state.showcase.map(id => showcaseCard(CARDS.find(card => card.id === id)))
      return route.fulfill({ json: { max: 6, cards } })
    }
    if (path === '/api/collection/') {
      return route.fulfill({ json: CARDS.map(card => ({ ...card, quantity: 1, variant: 'Normal', card: { id: card.card_id, name: card.name } })) })
    }
    if (path === '/api/progress/today') {
      return route.fulfill({ json: { date: today(), streak: { current: 1, best: 1 }, quests: [{ id: 'view_pokemon', done: false }, { id: 'play_wtp', done: false }, { id: 'add_card', done: false }], xp: { xp: 10, level: 1, level_start: 0, next_level_at: 50 }, pokemon: { dex_id: 133, owned_printings: 1, cheapest: null }, wtp: { played: false, correct: false } } })
    }
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    const responses = {
      '/api/auth/mode': { multi_user: false },
      '/api/auth/me': USER,
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'EUR', tcgdex_sync_languages: 'en' },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
      '/api/dashboard/': { total_cards: 12, unique_cards: 3, owned_sets: 1, recent_additions: [], top_cards: [] },
      '/api/wishlist/': [],
      '/api/sets/': [],
      '/api/binders/': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
  return state
}

test('On this day shows the years and thumbnails, and is absent when nothing was acquired', async ({ page }) => {
  await install(page)
  await page.goto('/')

  const card = page.getByTestId('on-this-day')
  await expect(card).toBeVisible()
  await expect(card).toContainText('3 cards joined your collection on this day')
  await expect(page.getByTestId('on-this-day-2025')).toContainText('2 cards')
  await expect(page.getByTestId('on-this-day-2023').getByRole('img', { name: 'Eevee' })).toBeVisible()
  await expect(card.getByRole('link', { name: 'See them' })).toHaveAttribute('href', /\/collection\?sort=acquired_at/)
})

test('On this day leaves no empty slot on a day with nothing', async ({ page }) => {
  await install(page, { onThisDay: { date: '2026-10-28', month: 10, day: 28, total: 0, years: [] } })
  await page.goto('/')
  await expect(page.getByTestId('today-card')).toBeVisible()
  await expect(page.getByTestId('on-this-day')).toHaveCount(0)
})

test('the Showcase picker saves up to six cards and the trainer card shows them', async ({ page }) => {
  const state = await install(page)
  await page.goto('/profile')

  await page.getByTestId('profile-showcase').click()
  const picker = page.getByTestId('showcase-picker')
  await expect(picker).toBeVisible()
  await expect(page.getByTestId('showcase-count')).toContainText('0 of 6 picked')

  await picker.getByRole('button', { name: /Pikachu/ }).click()
  await picker.getByRole('button', { name: /Charizard/ }).click()
  await expect(page.getByTestId('showcase-count')).toContainText('2 of 6 picked')
  await page.getByRole('button', { name: 'Done' }).click()

  await expect.poll(() => state.puts.length).toBe(1)
  expect(state.puts[0]).toEqual([12, 11])
  const strip = page.getByTestId('showcase-strip')
  await expect(strip).toBeVisible()
  await expect(strip.getByTestId('showcase-card')).toHaveCount(2)
  await expect(page.getByTestId('profile-showcase')).toContainText('2 of 6')
})

// Reduce Motion is on here, so the slide transition is skipped and the page change is instant.
test.describe('Collection DNA', () => {
  test.use({ reducedMotion: 'reduce' })

  test('shows the type wheel, illustrators, eras and Pokémon', async ({ page }) => {
  await install(page)
  await page.goto('/profile')
  // The row links to the page; the page is opened directly because WebKit's slide transition crashes
  // the renderer on this tall page in the test browser.
  await expect(page.getByTestId('profile-dna')).toHaveAttribute('href', '/dna')
  await page.goto('/dna')

  await expect(page.getByTestId('collection-dna')).toBeVisible()
  await expect(page.getByTestId('dna-types').getByRole('img', { name: 'Share of your collection by type' })).toBeVisible()
  await expect(page.getByTestId('dna-types')).toContainText('50%')
  await expect(page.getByTestId('dna-illustrators')).toContainText('Mitsuhiro Arita')
  await expect(page.getByTestId('dna-eras')).toContainText('2023')
  await expect(page.getByTestId('dna-pokemon')).toContainText('Charizard')

  // No sideways scroll at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
})
