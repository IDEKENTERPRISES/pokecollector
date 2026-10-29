import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { PokemonRow } from './TodayCard'

vi.mock('../api/client', () => ({ addToWishlist: vi.fn(), getCard: vi.fn(), getTodaySummary: vi.fn(), postViewedPokemon: vi.fn() }))
vi.mock('../components/CardItem', () => ({ CardModal: () => null }))

const entry = { dex_id: 133, name: 'Eevee', sprite_url: '/x.png', sprite_style: 'pixel' }
const priciest = { card_id: 'sv8pt5-075_en', name: 'Eevee', set_name: 'Prismatic Evolutions', number: '075', price: 41.26 }
const t = (key) => (key === 'today.openCard' ? 'Open card: {name}' : key === 'today.priciest' ? 'Most expensive print {price}' : key)

const render = pokemon => renderToStaticMarkup(
  <MemoryRouter>
    <PokemonRow entry={entry} pokemon={pokemon} t={t} formatPrice={price => `€${price}`} />
  </MemoryRouter>,
)

describe('Today card most expensive print', () => {
  it('keeps the price line as the Pokédex link and makes the name its own button', () => {
    const html = render({ owned_printings: 0, cheapest: null, most_expensive: priciest })
    const link = html.match(/<a [^>]*data-testid="pokemon-priciest"[^>]*>(.*?)<\/a>/)
    expect(link[0]).toContain('href="/pokedex/133?sort=price_desc"')
    expect(link[1]).toBe('Most expensive print €41.26')
    expect(link[0]).not.toContain('<button')
    const button = html.match(/<button [^>]*data-testid="pokemon-priciest-card"[^>]*>(.*?)<\/button>/)
    expect(button[0]).toContain('aria-label="Open card: Eevee · Prismatic Evolutions 075"')
    expect(button[0]).toContain('min-h-[44px]')
    expect(button[1]).toContain('Eevee · Prismatic Evolutions 075')
  })

  it('shows neither target without a most expensive print', () => {
    const html = render({ owned_printings: 1, cheapest: null, most_expensive: null })
    expect(html).not.toContain('pokemon-priciest')
  })
})
