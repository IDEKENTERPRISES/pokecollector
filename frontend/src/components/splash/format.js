// The splash card's text and its screen-reader announcement. Pure; unit-tested.

// The 18 game types on the app's 11 energy-type colours (design doc §7.12), as the TCG maps them.
const ENERGY_FOR_TYPE = {
  normal: 'colorless', flying: 'colorless',
  fire: 'fire',
  water: 'water', ice: 'water',
  grass: 'grass', bug: 'grass',
  electric: 'lightning',
  psychic: 'psychic', poison: 'psychic', ghost: 'psychic',
  fighting: 'fighting', ground: 'fighting', rock: 'fighting',
  dark: 'darkness',
  steel: 'metal',
  dragon: 'dragon',
  fairy: 'fairy',
}

export function typeColour(types) {
  const energy = ENERGY_FOR_TYPE[String(types?.[0] ?? '').toLowerCase()] ?? 'colorless'
  return `var(--type-${energy})`
}

/** Replace {name} placeholders; values are inserted literally (no `$` patterns). */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
}

function numberFormat(language, options) {
  try {
    return new Intl.NumberFormat(language, options)
  } catch {
    return new Intl.NumberFormat('en', options)
  }
}

/** { short: '6.0 kg', value: '6' } in the app language, or null without a weight. */
export function formatWeight(kg, { unit = 'kg', language = 'en' } = {}) {
  if (typeof kg !== 'number' || !(kg > 0)) return null
  const value = unit === 'lb' ? kg * 2.20462 : kg
  return {
    short: `${numberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} ${unit === 'lb' ? 'lbs' : 'kg'}`,
    value: numberFormat(language, { maximumFractionDigits: 1 }).format(value),
  }
}

export function splashText(entry, { t, language = 'en', unit = 'kg' }) {
  const weight = formatWeight(entry.weight_kg, { unit, language })
  const spokenWeight = weight ? fill(t(unit === 'lb' ? 'splash.pounds' : 'splash.kilograms'), { value: weight.value }) : ''
  return {
    number: fill(t('splash.number'), { number: String(entry.dex_id).padStart(4, '0') }),
    name: entry.name,
    meta: [fill(t('splash.generation'), { generation: entry.generation }), entry.region, weight?.short]
      .filter(Boolean)
      .join(' · '),
    fact: entry.fact || '',
    announcement: fill(t('splash.announce'), {
      name: entry.name,
      number: entry.dex_id,
      generation: entry.generation,
      region: entry.region,
      weight: spokenWeight ? `, ${spokenWeight}` : '',
      fact: entry.fact || '',
    }).trim(),
  }
}
