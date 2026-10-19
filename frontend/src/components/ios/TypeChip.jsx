import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'
import EnergyIcon from './EnergyIcon'
import { typeKeyFor } from './pokemon'

/**
 * Energy-type chip: a capsule in the type's solid at 24 % over black with a 55 % inner outline,
 * white text and the energy symbol. `type="all"` is the white "All" chip with black text.
 * Pressable when `onPress` is set; `selected` raises it to the full colour.
 */
export default function TypeChip({ type, label, selected = false, onPress, className = '' }) {
  const { t } = useSettings()
  const isAll = type === 'all'
  const key = isAll ? null : (typeKeyFor(type) ?? 'colorless')
  const text = label ?? (isAll ? t('common.all') : (typeof type === 'string' ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() : ''))

  const style = isAll
    ? undefined
    : {
      background: selected
        ? `color-mix(in srgb, var(--type-${key}) 48%, #000)`
        : `color-mix(in srgb, var(--type-${key}) 24%, #000)`,
      boxShadow: `inset 0 0 0 1px color-mix(in srgb, var(--type-${key}) ${selected ? 100 : 55}%, transparent)`,
    }

  const classes = clsx(
    'inline-flex h-8 flex-shrink-0 select-none items-center gap-1.5 rounded-full px-3 text-footnote font-semibold font-display',
    isAll ? (selected ? 'bg-white text-black' : 'bg-white/90 text-black') : 'text-white',
    onPress && 'ios-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint',
    className,
  )
  const content = (
    <>
      {!isAll && <EnergyIcon type={key} size={16} />}
      <span>{text}</span>
    </>
  )

  if (!onPress) return <span className={classes} style={style}>{content}</span>
  return (
    <button type="button" aria-pressed={selected} onClick={onPress} className={classes} style={style}>
      {content}
    </button>
  )
}
