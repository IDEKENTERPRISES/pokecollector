// A generated catalogue of any size for tests and the build-cost estimate: invented names, numbers, totals and
// card texts in the flat row format ``buildDecideIndexes`` takes. Nothing here is real card data.

function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const SYLLABLES = ['ka', 'ri', 'to', 'mu', 'sha', 'ne', 'lo', 'bi', 'zu', 'fa', 'dra', 'gon', 'pi', 'chu', 'ba', 'sa', 'ur', 'el', 'on', 'ix']
const SUFFIXES = [null, null, null, null, 'ex', 'V', 'VMAX', 'GX', 'VSTAR']
const VERBS = ['Discard', 'Search', 'Flip', 'Heal', 'Draw', 'Attach', 'Switch', 'Shuffle', 'Look at', 'Put']
const OBJECTS = ['an Energy card from your hand', 'the top card of your deck', 'a Basic Pokemon to your Bench', '2 cards from your discard pile', 'damage counters from this Pokemon',
  'your opponent\'s Active Pokemon', 'a Supporter card', 'a Stadium card in play', 'this Pokemon to your hand', 'up to 3 Prize cards']
const TAILS = ['Then, shuffle your deck.', 'This attack does 20 more damage for each of your Benched Pokemon.', 'You may do this only once during your turn.', 'If tails, this attack does nothing.']

/** ``count`` English cards over ``Math.ceil(count / 100)`` sets, about 40% with an attack or effect text. */
export function generateCatalogue(count, seed = 1) {
  const random = lcg(seed)
  const pick = list => list[Math.floor(random() * list.length)]
  const word = () => `${pick(SYLLABLES)}${pick(SYLLABLES)}${pick(SYLLABLES)}`
  const sentence = () => `${pick(VERBS)} ${pick(OBJECTS)} named ${word()} for ${10 * (1 + Math.floor(random() * 30))} damage. ${pick(TAILS)}`
  const sets = Array.from({ length: Math.ceil(count / 100) }, (_, index) => ({
    id: `gen${index + 1}`, name: `Generated Set ${index + 1}`, abbreviation: `G${String(index + 1).padStart(2, '0')}`.slice(0, 4), total: 100 + (index % 90),
  }))
  const names = Array.from({ length: Math.max(50, Math.floor(count / 3)) }, () => {
    const syllables = 2 + Math.floor(random() * 3)
    let name = ''
    for (let part = 0; part < syllables; part += 1) name += pick(SYLLABLES)
    return name[0].toUpperCase() + name.slice(1)
  })
  const rows = []
  for (let index = 0; index < count; index += 1) {
    const set = sets[Math.floor(index / 100)]
    const number = (index % 100) + 1
    const suffix = pick(SUFFIXES)
    const name = suffix ? `${pick(names)} ${suffix}` : pick(names)
    const texted = random() < 0.4
    const attack = texted ? { name: `${pick(SYLLABLES)}${pick(SYLLABLES)} ${pick(['Blast', 'Strike', 'Wave', 'Burst'])}`, effect: sentence() } : null
    rows.push({
      id: `${set.id}-${number}_en`, tcg_card_id: `${set.id}-${number}`, name, number: String(number), set_id: set.id, set_name: set.name,
      set_abbreviation: set.abbreviation, printed_total: set.total, rarity: 'Common', hp: String(30 + 10 * Math.floor(random() * 30)), artist: `Artist ${Math.floor(random() * 40)}`,
      regulation_mark: pick(['F', 'G', 'H', null]), suffix, supertype: random() < 0.8 ? 'Pokémon' : 'Trainer',
      card_effect: random() < 0.15 ? sentence() : null,
      attacks: attack ? [attack] : null, abilities: random() < 0.1 ? [{ name: `${pick(SYLLABLES)}${pick(SYLLABLES)} Surge`, effect: sentence() }] : null,
      lang: 'en', is_digital: false, images_small: `https://img.example/${set.id}/${number}.webp`,
    })
  }
  return rows
}
