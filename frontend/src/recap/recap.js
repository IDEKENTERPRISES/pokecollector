// Pure helpers for the weekly recap card (engagement P9a).
import { fill } from '../delights/delights'
import { blocksSpec } from '../progress/shareImage'

export const RECAP_SHARE_FILE = 'weekly-recap.png'

/** The card shows only inside the server's window (Sunday 18:00 to Tuesday) and for a week with something in it. */
export function hasRecap(data) {
  return Boolean(data && data.show && data.has_activity)
}

const dayLabel = (iso, locale) => {
  const [year, month, day] = String(iso).split('-').map(Number)
  if (!year || !month || !day) return String(iso)
  try {
    return new Date(year, month - 1, day).toLocaleDateString(locale || undefined, { day: 'numeric', month: 'short' })
  } catch {
    return String(iso)
  }
}

export const weekRange = (data, locale) => `${dayLabel(data.week_start, locale)} – ${dayLabel(data.week_end, locale)}`

/** "+€4.20" / "−€1.00": the sign goes outside the formatted amount, which the caller may have masked. */
export function signedAmount(change, formatted) {
  if (!change) return formatted
  return `${change > 0 ? '+' : '−'}${formatted}`
}

/**
 * The picture's blocks. `money` formats an amount in the trainer's currency (absolute value); amounts
 * are flagged so hide-values masks them inside the picture. The streak line follows the
 * "Show streaks and quests" switch.
 */
export function recapBlocks({ data, t, money, showStreak, locale }) {
  const blocks = [{ type: 'number', value: String(data.cards_added), label: t('recap.cardsAdded') }]
  if (data.value && data.value.change) {
    blocks.push({
      type: 'number',
      value: signedAmount(data.value.change, money(Math.abs(data.value.change))),
      label: t('recap.valueChange'),
      amount: true,
    })
  }
  if (data.best_pull) {
    blocks.push({
      type: 'card',
      url: data.best_pull.image,
      label: `${data.best_pull.name} · ${money(data.best_pull.price)}`,
      amount: true,
    })
  }
  if (data.closest_set) {
    blocks.push({
      type: 'line',
      text: fill(t('recap.closestSet'), { set: data.closest_set.name, missing: data.closest_set.missing }),
    })
  }
  if (showStreak && data.streak?.current > 0) {
    blocks.push({ type: 'line', text: fill(t('recap.streak'), { count: data.streak.current }) })
  }
  return blocks
}

export function recapShareSpec({ data, t, money, showStreak, hideValues, locale, format = 'story', accent, fontFamily }) {
  return blocksSpec({
    format,
    appName: t('wtp.shareApp'),
    title: t('recap.shareTitle'),
    subtitle: weekRange(data, locale),
    blocks: recapBlocks({ data, t, money, showStreak, locale }),
    hideValues,
    accent,
    fontFamily,
  })
}
