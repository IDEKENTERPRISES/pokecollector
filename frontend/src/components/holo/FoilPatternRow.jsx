import { useId, useState } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { FOIL_PATTERN_IDS, FOIL_SWATCHES } from './foilPatterns'

export function useFoilName() {
  const { t } = useSettings()
  return pattern => (pattern ? t(`holo.pattern.${pattern}`) : t('holo.none'))
}

/** The "Foil pattern" row on the card sheet of an owned copy: current pattern, why, and a picker. */
export default function FoilPatternRow({ foil, value, onChange, pending = false }) {
  const { t } = useSettings()
  const name = useFoilName()
  const [open, setOpen] = useState(false)
  const panelId = useId()

  const current = name(foil.pattern)
  let explanation
  if (foil.source === 'copy') {
    explanation = t('holo.explainCopy').replace('{auto}', name(foil.auto))
  } else if (foil.source === 'tag') {
    explanation = t('holo.explainTag').replace('{tag}', foil.tagName).replace('{auto}', name(foil.rules))
  } else {
    explanation = t('holo.explainAuto')
  }

  const choose = (pattern) => {
    if (pattern !== (value || null)) onChange(pattern)
    setOpen(false)
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-bg-card" data-testid="foil-row">
      <button
        type="button"
        className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2 text-left"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(v => !v)}
        disabled={pending}
      >
        <span className="min-w-0">
          <span className="block text-xs text-text-muted">{t('holo.foilPattern')}</span>
          <span className="block truncate text-sm font-bold text-text-primary" data-testid="foil-current">
            {value ? current : `${t('holo.automatic')} · ${current}`}
          </span>
        </span>
        <ChevronDown size={16} className={clsx('shrink-0 text-text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <p className="px-3 pb-2 text-xs text-text-muted" data-testid="foil-explanation">{explanation}</p>
      {open && (
        <div id={panelId} role="radiogroup" aria-label={t('holo.foilPattern')} className="grid grid-cols-2 gap-2 border-t border-border p-3">
          {[null, ...FOIL_PATTERN_IDS].map((pattern) => {
            const selected = (value || null) === pattern
            return (
              <button
                key={pattern || 'auto'}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => choose(pattern)}
                className={clsx(
                  'flex min-h-[44px] items-center gap-2 rounded-lg border px-2 py-1 text-left text-xs font-bold',
                  selected ? 'border-brand-red bg-brand-red/15 text-text-primary' : 'border-border bg-bg-elevated text-text-secondary',
                )}
              >
                <span
                  className="h-6 w-6 shrink-0 rounded-md border border-white/20"
                  style={{ background: pattern ? FOIL_SWATCHES[pattern] : 'transparent' }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">
                  {pattern ? t(`holo.pattern.${pattern}`) : t('holo.automatic')}
                </span>
                {selected && <Check size={14} aria-hidden />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
