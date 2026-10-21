// The splash card's text, the "Wild … appeared!" box and the screen-reader announcement. Pure;
// unit-tested.

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

const FACT_LABELS = {
  'signature-move': 'splash.factSignatureMove',
  move: 'splash.factMove',
  ability: 'splash.factAbility',
  'hidden-ability': 'splash.factHiddenAbility',
  evolution: 'splash.factEvolution',
  trait: 'splash.factTrait',
  pokedex: 'splash.factPokedex',
}

export function factLabelKey(kind) {
  return FACT_LABELS[kind] ?? 'splash.factTrait'
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

const oneDecimal = (language, value) => numberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)
const upToOne = (language, value) => numberFormat(language, { maximumFractionDigits: 1 }).format(value)

/** Height as the Pokédex shows it: 0.4 m and 1′04″. */
export function formatHeight(metres, { language = 'en' } = {}) {
  if (typeof metres !== 'number' || !(metres > 0)) return null
  const inches = Math.round(metres / 0.0254)
  const feet = Math.floor(inches / 12)
  const rest = inches % 12
  return {
    metric: `${oneDecimal(language, metres)} m`,
    imperial: `${feet}′${String(rest).padStart(2, '0')}″`,
    spokenMetric: upToOne(language, metres),
    feet,
    inches: rest,
  }
}

/** Weight in kilograms and pounds: 6.0 kg and 13.2 lbs. */
export function formatWeight(kg, { language = 'en' } = {}) {
  if (typeof kg !== 'number' || !(kg > 0)) return null
  const pounds = kg * 2.20462
  return {
    metric: `${oneDecimal(language, kg)} kg`,
    imperial: `${oneDecimal(language, pounds)} lbs`,
    spokenMetric: upToOne(language, kg),
    spokenImperial: upToOne(language, pounds),
  }
}

function pick(measure, units) {
  if (!measure) return null
  if (units === 'metric') return measure.metric
  if (units === 'imperial') return measure.imperial
  return `${measure.metric} · ${measure.imperial}`
}

export function splashText(entry, { t, language = 'en', units = 'both', fact = null }) {
  const height = formatHeight(entry.height_m, { language })
  const weight = formatWeight(entry.weight_kg, { language })
  const spokenHeight = height
    ? (units === 'imperial'
      ? fill(t('splash.feetInches'), { feet: height.feet, inches: height.inches })
      : fill(t('splash.metres'), { value: height.spokenMetric }))
    : null
  const spokenWeight = weight
    ? [units !== 'imperial' && fill(t('splash.kilograms'), { value: weight.spokenMetric }),
        units !== 'metric' && fill(t('splash.pounds'), { value: weight.spokenImperial })].filter(Boolean).join(', ')
    : null
  const label = fact ? t(factLabelKey(fact.kind)) : null
  const announcement = [
    fill(t(entry.shiny ? 'splash.announceShiny' : 'splash.announce'), {
      name: entry.name, number: entry.dex_id, generation: entry.generation, region: entry.region,
    }),
    spokenHeight && spokenWeight ? fill(t('splash.announceStats'), { height: spokenHeight, weight: spokenWeight }) : null,
    fact ? `${label}${fact.title ? ` ${fact.title}` : ''}: ${fact.text}` : null,
  ].filter(Boolean).join(' ')
  return {
    number: fill(t('splash.number'), { number: String(entry.dex_id).padStart(4, '0') }),
    name: entry.name,
    meta: [entry.genus, fill(t('splash.generation'), { generation: entry.generation }), entry.region]
      .filter(Boolean)
      .join(' · '),
    height: pick(height, units),
    weight: pick(weight, units),
    fact: fact ? { label, title: fact.title || null, text: fact.text } : null,
    wild: [fill(t('splash.wildLine1'), { name: entry.name.toUpperCase() }), t('splash.wildLine2')],
    announcement,
  }
}
