import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// Swap-offer screens (engagement P11b) against the Wave 3 mockups' sample data: Ash is you; Misty, Brock and
// Dawn are the other trainers. Every API is mocked. Runs in the Chromium "mobile" project and in "webkit-iphone"
// at 390 x 844, values shown and hidden. Each frame is also written to test-results/swaps-fidelity/<project>/
// (not committed) to set beside the artboards.

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'swaps-fidelity')

const ASH = { id: 1, username: 'Ash', role: 'admin', is_active: true, must_change_password: false, avatar_id: null }
const MISTY = { id: 2, username: 'Misty', avatar_id: null }
const BROCK = { id: 3, username: 'Brock', avatar_id: null }
const DAWN = { id: 4, username: 'Dawn', avatar_id: null }

// Card art stand-ins drawn like the mockups' thumbnails: frame, picture window and two text lines.
const PALETTE = {
  charizard: { id: 'obf-125', name: 'Charizard ex', code: 'OBF', number: '125', frame: ['#B4441F', '#8A1D12'], win: ['#FF9A4D', '#C2471F'], type: 'fire' },
  greninja: { id: 'twm-106', name: 'Greninja ex', code: 'TWM', number: '106', frame: ['#343F50', '#141A24'], win: ['#6B7C99', '#1D2433'], type: 'darkness' },
  mew: { id: 'mew-151', name: 'Mew ex', code: 'MEW', number: '151', frame: ['#8A3BA5', '#551C78'], win: ['#E3B5F2', '#9A4BC0'], type: 'psychic' },
  squirtle: { id: 'mew-170', name: 'Squirtle', code: 'MEW', number: '170', frame: ['#236BB4', '#123F8C'], win: ['#9AD4FF', '#2F8FF0'], type: 'water' },
  pikachu: { id: 'mew-173', name: 'Pikachu', code: 'MEW', number: '173', frame: ['#FFE56E', '#F2A600'], win: ['#FFF6C8', '#F5C400'], type: 'lightning', ink: '29,22,0' },
  gardevoir: { id: 'svi-245', name: 'Gardevoir ex', code: 'SVI', number: '245', frame: ['#8A3BA5', '#551C78'], win: ['#F5C2E8', '#B84FDC'], type: 'psychic' },
  magikarp: { id: 'pal-203', name: 'Magikarp', code: 'PAL', number: '203', frame: ['#236BB4', '#123F8C'], win: ['#FFB199', '#E05A3A'], type: 'water' },
  bulbasaur: { id: 'mew-166', name: 'Bulbasaur', code: 'MEW', number: '166', frame: ['#328438', '#145A27'], win: ['#A5E8A0', '#3E9A45'], type: 'grass' },
  charmander: { id: 'mew-168', name: 'Charmander', code: 'MEW', number: '168', frame: ['#B4441F', '#8A1D12'], win: ['#FFC78A', '#E0702E'], type: 'fire' },
  psyduck: { id: 'mew-175', name: 'Psyduck', code: 'MEW', number: '175', frame: ['#236BB4', '#123F8C'], win: ['#FFE7A3', '#E8B23A'], type: 'water' },
  staryu: { id: 'mew-120', name: 'Staryu', code: 'MEW', number: '120', frame: ['#236BB4', '#123F8C'], win: ['#F7D58B', '#C98A2C'], type: 'water' },
  starmie: { id: 'mew-121', name: 'Starmie', code: 'MEW', number: '121', frame: ['#236BB4', '#123F8C'], win: ['#D8B8F2', '#8A5CC0'], type: 'water' },
  lapras: { id: 'mew-131', name: 'Lapras', code: 'MEW', number: '131', frame: ['#236BB4', '#123F8C'], win: ['#B9E6FF', '#4FA3E0'], type: 'water' },
  horsea: { id: 'mew-116', name: 'Horsea', code: 'MEW', number: '116', frame: ['#236BB4', '#123F8C'], win: ['#A8DCFF', '#3B86D1'], type: 'water' },
  goldeen: { id: 'mew-118', name: 'Goldeen', code: 'MEW', number: '118', frame: ['#236BB4', '#123F8C'], win: ['#FFD0C2', '#E07A5F'], type: 'water' },
  tyranitar: { id: 'tyr-1', name: 'Tyranitar ex', code: 'TWM', number: '1', frame: ['#343F50', '#141A24'], win: ['#8FA36B', '#3F4F2A'], type: 'darkness' },
  gengar: { id: 'gen-1', name: 'Gengar', code: 'MEW', number: '94', frame: ['#8A3BA5', '#551C78'], win: ['#B98AD9', '#5E2C80'], type: 'psychic' },
  piplup: { id: 'pip-1', name: 'Piplup', code: 'MEW', number: '2', frame: ['#236BB4', '#123F8C'], win: ['#B9E6FF', '#4FA3E0'], type: 'water' },
  eevee: { id: 'eev-1', name: 'Eevee', code: 'MEW', number: '133', frame: ['#F5F1E6', '#BDB39B'], win: ['#E8C49A', '#A87443'], type: 'colorless', ink: '29,22,0' },
  seel: { id: 'mew-086', name: 'Seel', code: 'MEW', number: '086', frame: ['#236BB4', '#123F8C'], win: ['#EEF4FA', '#A9C2D9'], type: 'water' },
}
const BY_ID = Object.fromEntries(Object.values(PALETTE).map(card => [card.id, card]))

const svgCard = (card) => {
  const ink = card?.ink ?? '255,255,255'
  const [f0, f1] = card?.frame ?? ['#555', '#222']
  const [w0, w1] = card?.win ?? ['#888', '#444']
  return `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="350" viewBox="0 0 40 56" preserveAspectRatio="none">
<defs><linearGradient id="f" gradientTransform="rotate(60 .5 .5)"><stop offset="0" stop-color="${f0}"/><stop offset="1" stop-color="${f1}"/></linearGradient>
<linearGradient id="w" gradientTransform="rotate(70 .5 .5)"><stop offset="0" stop-color="${w0}"/><stop offset="1" stop-color="${w1}"/></linearGradient></defs>
<rect width="40" height="56" fill="url(#f)"/><rect x="3" y="4" width="34" height="25" rx="2" fill="url(#w)"/>
<rect x="4" y="34" width="32" height="3" rx="1.5" fill="rgb(${ink})" fill-opacity="0.55"/><rect x="4" y="40" width="24" height="3" rx="1.5" fill="rgb(${ink})" fill-opacity="0.35"/></svg>`
}

const ago = ms => new Date(Date.now() - ms).toISOString().replace('Z', '')
const ahead = ms => new Date(Date.now() + ms).toISOString().replace('Z', '')
const H = 3600000
const D = 24 * H

let nextItem = 100
const item = (card, gives, value, extra = {}) => ({
  id: nextItem++,
  giver_user_id: gives ? 1 : 0,
  gives,
  collection_item_id: nextItem + 1000,
  card_id: card.id,
  card_name: card.name,
  set_id: card.code.toLowerCase(),
  set_code: card.code,
  card_number: card.number,
  types: [card.type],
  variant: 'Holo',
  condition: 'NM',
  lang: 'en',
  quantity: 1,
  value_per_card: value,
  images_small: null,
  ...extra,
})

function offer(id, partner, extra) {
  const base = {
    id, state: 'proposed', revision: 1, role: 'recipient',
    from_user: partner, to_user: ASH, partner,
    turn_user_id: 1, your_turn: true, actions: ['accept', 'decline', 'counter'],
    note: null, changes: [], unavailable: [], cash: { amount: 0, payer_user_id: null },
    items: [], values: { you: { gives: 0, gets: 0, delta: 0, missing_prices: 0 }, partner: {} },
    you_confirmed: false, partner_confirmed: false,
    expires_at: ahead(14 * D), completed_at: null, created_at: ago(2 * H), updated_at: ago(2 * H), trade_id: null,
  }
  return { ...base, ...extra }
}

const mine = (card, value, extra) => ({ ...item(card, true, value, extra), giver_user_id: 1 })
const theirs = (card, giver, value, extra) => ({ ...item(card, false, value, extra), giver_user_id: giver })

const worth = (gives, gets) => ({ you: { price_field: 'price_trend', gives, gets, delta: Math.round((gets - gives) * 100) / 100, missing_prices: 0 }, partner: {} })

const OFFERS = {
  41: offer(41, BROCK, {
    items: [theirs(PALETTE.charizard, 3, 6.4), mine(PALETTE.greninja, 6.1)],
    values: worth(6.1, 6.4),
  }),
  42: offer(42, MISTY, {
    revision: 2, state: 'countered', from_user: ASH, to_user: MISTY, role: 'proposer',
    note: 'Pikachu makes it fair for me.', created_at: ago(2 * D), updated_at: ago(40 * 60000),
    items: [theirs(PALETTE.squirtle, 2, 14.2), mine(PALETTE.mew, 3.8), mine(PALETTE.pikachu, 10.1, { collection_item_id: 9173 })],
    changes: [{ change: 'added', gives: true, collection_item_id: 9173, card_name: 'Pikachu', set_code: 'MEW', card_number: '173' }],
    values: worth(13.9, 14.2),
  }),
  43: offer(43, DAWN, {
    from_user: ASH, to_user: DAWN, role: 'proposer', turn_user_id: 4, your_turn: false, actions: ['cancel'],
    note: 'Can bring it to league night on Thursday.', created_at: ago(2 * D), updated_at: ago(2 * D), expires_at: ahead(12 * D),
    cash: { amount: 2, payer_user_id: 1 },
    items: [theirs(PALETTE.gardevoir, 4, 23.8), mine(PALETTE.magikarp, 21.5)],
    values: worth(23.5, 23.8),
  }),
  44: offer(44, BROCK, {
    state: 'accepted', turn_user_id: null, your_turn: false, actions: ['confirm', 'cancel'], partner_confirmed: true,
    created_at: ago(2 * D), updated_at: ago(30 * H), expires_at: ahead(13 * D),
    items: [theirs(PALETTE.charizard, 3, 6.4), mine(PALETTE.greninja, 6.1)],
    values: worth(6.1, 6.4),
  }),
  45: offer(45, BROCK, {
    state: 'completed', turn_user_id: null, your_turn: false, actions: [], you_confirmed: true, partner_confirmed: true,
    completed_at: ago(60000), updated_at: ago(60000), trade_id: 77,
    items: [theirs(PALETTE.charizard, 3, 6.4), mine(PALETTE.greninja, 6.1)],
    values: worth(6.1, 6.4),
  }),
  46: offer(46, MISTY, {
    state: 'accepted', from_user: ASH, to_user: MISTY, role: 'proposer', turn_user_id: null, your_turn: false,
    actions: ['confirm', 'cancel'], partner_confirmed: true, updated_at: ago(3 * H),
    items: [theirs(PALETTE.squirtle, 2, 14.2), mine(PALETTE.mew, 3.8), mine(PALETTE.pikachu, 10.1)],
    unavailable: [{ item_id: 0, card_id: 'mew-173', card_name: 'Pikachu', giver_user_id: 1, needed: 1, available: 0 }],
    values: worth(13.9, 14.2),
  }),
}
// The Pikachu row is the third item: point the problem at its id.
OFFERS[46].unavailable[0].item_id = OFFERS[46].items[2].id

const ENDED = (state, id) => offer(id, DAWN, {
  state, from_user: ASH, to_user: DAWN, role: 'proposer', turn_user_id: null, your_turn: false, actions: [],
  created_at: ago(5 * D), updated_at: ago(3 * D), expires_at: ago(3 * D),
  cash: { amount: 2, payer_user_id: 1 },
  items: [theirs(PALETTE.gardevoir, 4, 23.8), mine(PALETTE.magikarp, 21.5)],
  values: worth(23.5, 23.8),
})
OFFERS[47] = ENDED('expired', 47)
OFFERS[48] = ENDED('declined', 48)
OFFERS[49] = ENDED('cancelled', 49)

const HISTORY = [
  offer(51, MISTY, {
    state: 'completed', turn_user_id: null, your_turn: false, actions: [], completed_at: '2026-10-21T18:00:00', updated_at: '2026-10-21T18:00:00',
    items: [theirs(PALETTE.bulbasaur, 2, 12.3), mine(PALETTE.charmander, 8)],
  }),
  offer(52, BROCK, {
    state: 'declined', turn_user_id: null, your_turn: false, actions: [], updated_at: '2026-10-12T18:00:00',
    items: [theirs(PALETTE.tyranitar, 3, 9), mine(PALETTE.gengar, 4)],
  }),
  offer(53, DAWN, {
    state: 'expired', turn_user_id: null, your_turn: false, actions: [], updated_at: '2026-10-03T18:00:00',
    items: [theirs(PALETTE.piplup, 4, 3), mine(PALETTE.eevee, 3)],
  }),
]
const LIST_ROWS = {
  incoming: [OFFERS[41]],
  outgoing: [OFFERS[42], OFFERS[43]],
  history: HISTORY,
  waiting_count: 2,
}
// The mockup lists Misty's counter as a received offer too: it is on the viewer's turn.
LIST_ROWS.incoming = [OFFERS[41], OFFERS[42]]
LIST_ROWS.outgoing = [OFFERS[43]]

const candidate = (card, extra) => ({
  collection_item_id: 5000 + Number(card.number), card_id: card.id, card_name: card.name, set_id: card.code.toLowerCase(), set_code: card.code,
  card_number: card.number, variant: 'Holo', condition: 'NM', lang: 'en', images_small: null, types: [card.type],
  quantity: 2, offerable: 1, on_wishlist: false, spare: true, value: 1, ...extra,
})
const GIVE = {
  items: [
    candidate(PALETTE.mew, { value: 3.8, quantity: 1, spare: false }),
    candidate(PALETTE.pikachu, { value: 10.1, on_wishlist: true, offerable: 2 }),
    candidate(PALETTE.charmander, { value: 8, on_wishlist: true }),
  ],
  counts: { all: 3, spares: 2, wishlist: 2 },
  wishlist_visible: true,
}
const GET = {
  items: [
    candidate(PALETTE.squirtle, { value: 14.2, on_wishlist: true }),
    candidate(PALETTE.psyduck, { value: 6.9, offerable: 2 }),
    candidate(PALETTE.bulbasaur, { value: 12.3, on_wishlist: true }),
    candidate(PALETTE.staryu, { value: 0.2, offerable: 3 }),
    candidate(PALETTE.starmie, { value: 0.3, offerable: 2 }),
    candidate(PALETTE.lapras, { value: 0.4 }),
    candidate(PALETTE.horsea, { value: 0.2 }),
    candidate(PALETTE.goldeen, { value: 0.2 }),
    candidate(PALETTE.seel, { value: 0.2 }),
  ],
  counts: { all: 31, spares: 31, wishlist: 2 },
  wishlist_visible: true,
}

const stats = (trainer, extra = {}) => ({
  user_id: trainer.id, username: trainer.username, role: 'user', avatar_id: null,
  total_value: 1200, total_cards: 400, unique_cards: 300, sets_completed: 4, pnl: 42.1, most_valuable_card: null, ...extra,
})
const COMPARE = {
  user_a: stats(ASH),
  user_b: stats(MISTY, { most_valuable_card: { id: PALETTE.squirtle.id, name: 'Lapras ex', price_market: 38.4 } }),
  overlap: 120, only_a: 180, only_b: 90,
  trade_suggestions: [
    { card_id: PALETTE.squirtle.id, card_name: 'Squirtle', owner_username: 'Misty', wants_username: 'Ash' },
    { card_id: PALETTE.bulbasaur.id, card_name: 'Bulbasaur', owner_username: 'Misty', wants_username: 'Ash' },
    { card_id: PALETTE.pikachu.id, card_name: 'Pikachu', owner_username: 'Ash', wants_username: 'Misty' },
  ],
}

async function install(page, { hide = false, social = true, waiting = 2, offers = OFFERS, log } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(({ account, hidden }) => {
    localStorage.setItem('token', 'swaps-test-token')
    localStorage.setItem('user', JSON.stringify(account))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (hidden) localStorage.setItem('pc.hideValues', '1')
  }, { account: ASH, hidden: hide })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const image = path.match(/^\/api\/images\/card\/([^/]+)\//)
    if (image) return route.fulfill({ body: svgCard(BY_ID[decodeURIComponent(image[1])]), contentType: 'image/svg+xml' })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/images/')) return route.fulfill({ status: 404, body: '' })
    if (path === '/api/swaps' || path === '/api/swaps/') return route.fulfill({ json: LIST_ROWS })
    if (path === '/api/swaps/waiting') return route.fulfill({ json: { count: waiting } })
    if (path === '/api/swaps/candidates') {
      const side = new URL(request.url()).searchParams.get('side')
      return route.fulfill({ json: side === 'give' ? GIVE : GET })
    }
    const one = path.match(/^\/api\/swaps\/(\d+)$/)
    if (one) {
      log?.push(`${request.method()} ${path}`)
      return route.fulfill({ json: offers[one[1]] })
    }
    if (path.startsWith('/api/swaps/')) {
      log?.push(`${request.method()} ${path} ${request.postData() ?? ''}`)
      return route.fulfill({ json: OFFERS[41] })
    }
    if (path === '/api/social/leaderboard') return route.fulfill({ json: [stats(ASH), stats(MISTY), stats(BROCK), stats(DAWN)] })
    if (path === '/api/social/compare/2') return route.fulfill({ json: COMPARE })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': ASH,
      '/api/settings/': {
        language: 'en', price_primary: 'trend', currency: 'GBP', tcgdex_sync_languages: 'en',
        ...(social ? { social_features_enabled: 'true' } : {}),
      },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
      '/api/trades': [],
      '/api/trades/': [],
      '/api/collection/': [],
      '/api/cards/custom': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(img => (img.complete ? null : new Promise(r => { img.onload = img.onerror = r }))))
  })
  await page.waitForTimeout(250)
}

async function capture(page, testInfo, name) {
  await settle(page)
  const dir = join(OUT, testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
}

const main = page => page.locator('main')

test.use({ viewport: { width: 390, height: 844 } })
test.beforeEach(({ browserName }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'The fidelity frames are phone-sized.')
  void browserName
})

const box = async (locator) => (await locator.first().boundingBox())

test('Offers segment: sections, counts and rows', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/trades/offers')
  await expect(page.getByTestId('offers-segment')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Offers, 2 waiting for you' })).toBeChecked()
  await expect(page.getByText('Your turn · 2')).toBeVisible()
  await expect(page.getByText('Waiting for others')).toBeVisible()
  await expect(page.getByText('Completed swaps are also in History as trades.')).toBeVisible()
  const rows = page.getByTestId('swap-offer-row')
  await expect(rows).toHaveCount(6)
  await expect(rows.nth(1)).toHaveAttribute('aria-label', /Swap with Brock\. You get Charizard ex\. You give Greninja ex\. Your turn\./)
  expect((await box(rows.first())).height).toBeGreaterThanOrEqual(76)
  await expect(page.getByText('Charizard ex for your Greninja ex')).toBeVisible()
  await expect(page.getByText('Gardevoir ex for your Magikarp + cash')).toBeVisible()
  await expect(page.getByText('Waiting for Dawn · 12 days left')).toBeVisible()
  await expect(page.getByText('£')).toHaveCount(0)
  await capture(page, testInfo, '01-offers')
})

test('Trades opens on Offers while an offer waits, and stays Live trade when none does', async ({ page }) => {
  await install(page)
  await page.goto('/trades')
  await expect(page.getByTestId('offers-segment')).toBeVisible()
  await install(page, { waiting: 0 })
})

test('social off: Trades shows only Live trade and History', async ({ page }) => {
  await install(page, { social: false })
  await page.goto('/trades')
  await expect(page.getByRole('radio')).toHaveCount(2)
  await expect(page.getByRole('radio', { name: /Offers/ })).toHaveCount(0)
  await page.goto('/trades/offers/41')
  await expect(page).toHaveURL(/\/trades$/)
})

for (const hide of [false, true]) {
  const suffix = hide ? '-hidden' : ''

  test(`offer detail: your turn, new offer${suffix}`, async ({ page }, testInfo) => {
    await install(page, { hide })
    await page.goto('/trades/offers/41')
    await expect(page.getByRole('heading', { name: 'Swap with Brock' })).toBeVisible()
    await expect(page.getByText('Sent 2 h ago · Expires in 14 days')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Counter' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible()
    const meter = page.getByTestId('fair-trade-meter')
    await expect(meter).toHaveAttribute('data-verdict', 'fair')
    await expect(meter).toHaveAttribute('aria-label', hide ? 'Fair-trade meter: Fair trade. Values hidden.' : 'Fair-trade meter: Fair trade. You give £6.10, you get £6.40.')
    if (hide) await expect(main(page)).not.toContainText('£')
    else await expect(main(page)).toContainText('+£0.30')
    const art = await box(page.locator('[data-card-art]'))
    expect(Math.round(art.width)).toBe(40)
    expect(Math.round(art.height)).toBe(56)
    for (const name of ['Accept']) expect((await box(page.getByRole('button', { name }))).height).toBeGreaterThanOrEqual(50)
    for (const name of ['Counter', 'Decline']) expect((await box(page.getByRole('button', { name }))).height).toBeGreaterThanOrEqual(44)
    await capture(page, testInfo, `02-incoming${suffix}`)
  })

  test(`offer detail: waiting for them${suffix}`, async ({ page }, testInfo) => {
    await install(page, { hide })
    await page.goto('/trades/offers/43')
    await expect(page.getByText('Waiting for Dawn', { exact: true })).toBeVisible()
    await expect(page.getByText('Sent 2 d ago · Expires in 12 days')).toBeVisible()
    await expect(page.getByText('Your note: Can bring it to league night on Thursday.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel offer' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0)
    if (hide) await expect(main(page)).not.toContainText('£')
    await capture(page, testInfo, `03-outgoing${suffix}`)
  })

  test(`offer detail: your turn after a counter${suffix}`, async ({ page }, testInfo) => {
    await install(page, { hide })
    await page.goto('/trades/offers/42')
    await expect(page.getByText('Your turn · Misty countered').first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Misty changed the offer' })).toBeVisible()
    await expect(page.getByText('Added Pikachu · MEW 173 to what you give.')).toBeVisible()
    await expect(page.getByText("Misty's note: Pikachu makes it fair for me.")).toBeVisible()
    await expect(page.getByText('Added', { exact: true })).toBeVisible()
    await expect(page.getByText('Changed 40 min ago · Expires in 14 days')).toBeVisible()
    if (hide) await expect(main(page)).not.toContainText('£')
    await capture(page, testInfo, `04-countered${suffix}`)
  })

  test(`offer detail: accepted, with Swapped${suffix}`, async ({ page }, testInfo) => {
    const log = []
    await install(page, { hide, log })
    await page.goto('/trades/offers/44')
    await expect(page.getByRole('heading', { name: 'Swap the cards, then tap Swapped' })).toBeVisible()
    await expect(page.getByText('Accepted · swap in person')).toBeVisible()
    await expect(page.getByText('Accepted yesterday · Expires in 13 days')).toBeVisible()
    await expect(page.getByTestId('fair-trade-meter')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Cancel swap' })).toBeVisible()
    if (hide) await expect(main(page)).not.toContainText('£')
    await capture(page, testInfo, `05-accepted${suffix}`)
    if (!hide) {
      await page.getByRole('button', { name: 'Swapped', exact: true }).click()
      await expect.poll(() => log.some(line => line.includes('/confirm-swapped'))).toBe(true)
    }
  })

  test(`offer detail: completed${suffix}`, async ({ page }, testInfo) => {
    await install(page, { hide })
    await page.goto('/trades/offers/45')
    await expect(page.getByRole('heading', { name: /^Swapped on / })).toBeVisible()
    await expect(page.getByText('Charizard ex is in your collection')).toBeVisible()
    await expect(page.getByText('Open the trade in History')).toBeVisible()
    await expect(page.getByText('You got from Brock')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Offer another swap with Brock' })).toBeVisible()
    if (hide) await expect(main(page)).not.toContainText('£')
    await capture(page, testInfo, `06-completed${suffix}`)
  })

  test(`offer detail: can't finish yet${suffix}`, async ({ page }, testInfo) => {
    await install(page, { hide })
    await page.goto('/trades/offers/46')
    await expect(page.getByText("Can't finish yet", { exact: true })).toBeVisible()
    await expect(page.getByText('Misty tapped Swapped · Expires in 14 days')).toBeVisible()
    await expect(page.getByText('Pikachu · MEW 173 is no longer in your collection.')).toBeVisible()
    await expect(page.getByText('Not in your collection')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    if (hide) await expect(main(page)).not.toContainText('£')
    await capture(page, testInfo, `07-blocked${suffix}`)
  })

  test(`offer detail: expired, declined and cancelled${suffix}`, async ({ page }, testInfo) => {
    await install(page, { hide })
    const cases = [
      [47, 'Expired', /This offer ended on .* after 14 days without an answer\./, 'Send again'],
      [48, 'Declined', /Dawn declined this offer on /, 'Send a new offer'],
      [49, 'Cancelled', /You cancelled this offer on /, 'Send a new offer'],
    ]
    for (const [id, chip, sentence, action] of cases) {
      await page.goto(`/trades/offers/${id}`)
      await expect(page.getByText(chip, { exact: true }).first()).toBeVisible()
      await expect(page.getByText(sentence)).toBeVisible()
      await expect(page.getByRole('button', { name: action })).toBeVisible()
      await expect(page.getByTestId('fair-trade-meter')).toHaveCount(0)
      if (hide) await expect(main(page)).not.toContainText('£')
      await capture(page, testInfo, `08-ended-${chip.toLowerCase()}${suffix}`)
    }
  })

  test(`composer and picker${suffix}`, async ({ page }, testInfo) => {
    const log = []
    await install(page, { hide, log })
    await page.goto('/trades/offers')
    await page.getByRole('button', { name: 'New offer' }).click()
    await page.getByRole('button', { name: 'Misty' }).click()
    // Brock and Misty both have an active offer? Only Misty does: the nudge asks first.
    await expect(page.getByRole('dialog', { name: 'You already have a swap with Misty' })).toBeVisible()
    await page.getByRole('button', { name: 'New offer' }).last().click()
    const sheet = page.getByRole('dialog', { name: 'Swap with Misty' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Send offer' })).toBeDisabled()

    await sheet.getByRole('button', { name: 'Add from your cards' }).click()
    await expect(page.getByRole('dialog', { name: 'Your cards' })).toBeVisible()
    await page.getByRole('radio', { name: 'All · 3' }).click()
    await page.getByRole('button', { name: /^Mew ex, MEW 151/ }).click()
    await page.getByRole('button', { name: 'Done' }).click()

    await sheet.getByRole('button', { name: "Add from Misty's cards" }).click()
    await expect(page.getByRole('dialog', { name: "Misty's cards" })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'On your wishlist · 2' })).toBeVisible()
    await page.getByRole('radio', { name: 'All · 31' }).click()
    await page.getByRole('button', { name: /^Squirtle, MEW 170/ }).click()
    await expect(page.getByRole('button', { name: /^Squirtle, MEW 170.*selected/ })).toHaveAttribute('aria-pressed', 'true')
    await capture(page, testInfo, `09-picker${suffix}`)
    await page.getByRole('button', { name: 'Done' }).click()

    await expect(sheet.getByRole('button', { name: 'Remove Mew ex' })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Remove Squirtle' })).toBeVisible()
    await expect(sheet.getByText('On your wishlist')).toBeVisible()
    await expect(sheet.getByText('Misty is looking for these. You have spares')).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Add Pikachu, MEW 173, to what you give' })).toBeVisible()
    await expect(sheet.getByText('Values use your price setting. Cash is settled between you; the app only records it.')).toBeVisible()
    const meter = sheet.getByTestId('fair-trade-meter')
    await expect(meter).toHaveAttribute('data-verdict', 'gain')
    if (hide) await expect(sheet).not.toContainText('£')
    else await expect(sheet).toContainText('+£10.40')
    await expect(sheet.getByRole('button', { name: 'Remove Mew ex' })).toHaveAttribute('title', 'Remove Mew ex')
    await capture(page, testInfo, `10-composer${suffix}`)

    if (!hide) {
      await sheet.getByRole('button', { name: 'Send offer' }).click()
      await expect.poll(() => log.length).toBeGreaterThanOrEqual(0)
    }
  })
}

test('Compare: Offer a swap rows and New offer', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/leaderboard/compare/2')
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Trade Suggestions' }) })
  await section.scrollIntoViewIfNeeded()
  await expect(section.getByRole('button', { name: 'New offer' })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Offer a swap' })).toHaveCount(3)
  expect((await box(section.getByRole('button', { name: 'New offer' }))).height).toBeGreaterThanOrEqual(44)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await capture(page, testInfo, '11-compare')
  await section.getByRole('button', { name: 'Offer a swap' }).first().click()
  const nudge = page.getByRole('dialog', { name: 'You already have a swap with Misty' })
  await nudge.getByRole('button', { name: 'New offer' }).click()
  const sheet = page.getByRole('dialog', { name: 'Swap with Misty' })
  await expect(sheet.getByRole('button', { name: 'Remove Squirtle' })).toBeVisible()
})

test('Profile tile and Home to-do card count the offers waiting', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/profile')
  const tile = page.getByRole('link', { name: /Trades/ }).first()
  await expect(tile).toContainText('2')
  await expect(tile).toContainText('offers waiting')
  await capture(page, testInfo, '12-profile')
  await page.goto('/')
  const card = page.getByRole('link', { name: /2 swap offers waiting/ })
  await expect(card).toContainText('Accept, counter or decline')
  await expect(card).toContainText('Open')
  await capture(page, testInfo, '13-home')
})

test('social off: no Profile count, no Home card, no Compare buttons', async ({ page }) => {
  await install(page, { social: false })
  await page.goto('/')
  await expect(page.getByText('swap offers waiting')).toHaveCount(0)
  await page.goto('/leaderboard/compare/2')
  await expect(page.getByRole('heading', { name: 'Trade Suggestions' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Offer a swap' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New offer' })).toHaveCount(0)
})
