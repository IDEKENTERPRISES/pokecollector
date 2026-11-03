import { useState } from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import { useVisibleTcgdexLanguages } from '../hooks/useVisibleTcgdexLanguages'
import { CARD_VARIANTS } from '../utils/cardVariants'
import { CONDITIONS, toggleFilterValue } from '../utils/cardFilters'
import Badge from './ios/Badge'
import PageSheet from './ios/PageSheet'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'

/**
 * The "Filters" pill with the number of active filters. The Collection page and the swap picker share it, so
 * both look and behave the same; the invisible padding makes the touch target 44 pt tall.
 */
export function CardFilterButton({ count, onPress, className = '' }) {
  const { t } = useSettings()
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={t('common.filter')}
      className={`ios-press relative inline-flex h-9 items-center gap-1.5 rounded-full bg-fill-tertiary px-3 text-footnote font-semibold text-text-primary before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] ${className}`}
    >
      <SlidersHorizontal size={15} aria-hidden="true" /> {t('collection.filtersButton')}
      <Badge count={count} tone="accent" />
    </button>
  )
}

/** Open/close and "Advanced filters" fold state for a CardFilterSheet. The fold opens when an advanced filter is set. */
export function useCardFilterSheet(hasAdvanced) {
  const [isOpen, setIsOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  return {
    isOpen,
    advancedOpen,
    setAdvancedOpen,
    open: () => { setAdvancedOpen(Boolean(hasAdvanced)); setIsOpen(true) },
    close: () => setIsOpen(false),
  }
}

/**
 * The filter page sheet: rarity, condition, variant, printing detail, set and energy type, then the
 * "Advanced filters" fold (category, subtype, legality, language, min and max price, duplicates).
 * `filters`/`onChange(key, value)` use the keys in CARD_FILTER_DEFAULTS; `facets` come from buildCardFacets.
 * `idPrefix` names the controls' ids. Pass `ruleText` and `onRuleTextChange` to add the rule text field
 * (Collection only, it is searched on the server).
 */
export default function CardFilterSheet({
  sheet,
  filters,
  onChange,
  onClear,
  hasActive,
  facets,
  idPrefix = 'collection',
  ruleText,
  onRuleTextChange,
}) {
  const { t } = useSettings()
  const visibleLanguages = useVisibleTcgdexLanguages()
  const {
    filterRarity, filterCondition, filterVariant, filterPrintingDetail, filterSet, filterType,
    filterCategories, filterSubtypes, filterLegality, filterLang, filterMinPrice, filterMaxPrice, filterDuplicates,
  } = filters
  const { rarities, sets, types, categories, subtypes, printingDetails } = facets
  return (
    <PageSheet
      isOpen={sheet.isOpen}
      onClose={sheet.close}
      title={t('collection.filtersTitle')}
      leading={{ label: t('common.clear'), onPress: onClear, disabled: !hasActive }}
      trailing={{ label: t('ios.done'), onPress: sheet.close }}
    >
      <div className="space-y-3 p-4">
        <h3 className="text-sm font-semibold text-text-primary">{t('common.normalFilters')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${idPrefix}-filter-rarity`} className="text-xs text-text-muted mb-1 block">{t('common.rarity')}</label>
            <select id={`${idPrefix}-filter-rarity`} className="select py-1.5 text-sm" value={filterRarity} onChange={(e) => onChange('filterRarity', e.target.value)}>
              <option value="">{t('common.allRarities')}</option>
              {rarities.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-filter-condition`} className="text-xs text-text-muted mb-1 block">{t('common.condition')}</label>
            <select id={`${idPrefix}-filter-condition`} className="select py-1.5 text-sm" value={filterCondition} onChange={(e) => onChange('filterCondition', e.target.value)}>
              <option value="">{t('common.allConditions')}</option>
              {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-filter-variant`} className="text-xs text-text-muted mb-1 block">✨ {t('variants.filterVariant')}</label>
            <select id={`${idPrefix}-filter-variant`} className="select py-1.5 text-sm" value={filterVariant} onChange={(e) => onChange('filterVariant', e.target.value)}>
              <option value="">{t('variants.allVariants')}</option>
              {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-filter-printing-detail`} className="text-xs text-text-muted mb-1 block">{t('printingDetails.label')}</label>
            <select id={`${idPrefix}-filter-printing-detail`} className="select py-1.5 text-sm" value={filterPrintingDetail} onChange={(e) => onChange('filterPrintingDetail', e.target.value)}>
              <option value="">{t('printingDetails.all')}</option>
              {printingDetails.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-filter-set`} className="text-xs text-text-muted mb-1 block">{t('collection.filterSet')}</label>
            <select id={`${idPrefix}-filter-set`} className="select py-1.5 text-sm" value={filterSet} onChange={(e) => onChange('filterSet', e.target.value)}>
              <option value="">{t('collection.allSets')}</option>
              {sets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-filter-energy-type`} className="text-xs text-text-muted mb-1 block">{t('collection.filterEnergyType')}</label>
            <select id={`${idPrefix}-filter-energy-type`} className="select py-1.5 text-sm" value={filterType} onChange={(e) => onChange('filterType', e.target.value)}>
              <option value="">{t('collection.allEnergyTypes')}</option>
              {types.map(tp => <option key={tp} value={tp}>{tp}</option>)}
            </select>
          </div>
        </div>

        <button
          type="button"
          className="btn-ghost w-full justify-between"
          aria-expanded={sheet.advancedOpen}
          aria-controls={`${idPrefix}-advanced-filters`}
          onClick={() => sheet.setAdvancedOpen(value => !value)}
        >
          <span>{t('common.advancedFilters')}</span>
          <ChevronDown size={16} className={`transition-transform ${sheet.advancedOpen ? 'rotate-180' : ''}`} />
        </button>

        {sheet.advancedOpen && (
          <div id={`${idPrefix}-advanced-filters`} className="grid grid-cols-2 gap-3 rounded-xl border border-border p-3">
            {onRuleTextChange && (
              <div className="col-span-2">
                <label htmlFor={`${idPrefix}-filter-rule-text`} className="text-xs text-text-muted mb-1 block">{t('collection.ruleText')}</label>
                <input id={`${idPrefix}-filter-rule-text`} type="text" value={ruleText} onChange={(e) => onRuleTextChange(e.target.value)} className="input py-1.5 text-sm" />
              </div>
            )}
            <fieldset className="col-span-2">
              <legend className="text-xs text-text-muted mb-1 block">{t('collection.filterCardCategory')}</legend>
              <div className="min-h-[34px] rounded-lg border border-border bg-bg px-2 py-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
                {categories.map(category => (
                  <label key={category} className="inline-flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={filterCategories.includes(category)}
                      onChange={() => onChange('filterCategories', toggleFilterValue(filterCategories, category))}
                      className="w-3.5 h-3.5 accent-brand-red"
                    />
                    <span>{category}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="col-span-2">
              <legend className="text-xs text-text-muted mb-1 block">{t('collection.filterSubtype')}</legend>
              <div className="min-h-[34px] rounded-lg border border-border bg-bg px-2 py-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
                {subtypes.map(subtype => (
                  <label key={subtype} className="inline-flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={filterSubtypes.includes(subtype)}
                      onChange={() => onChange('filterSubtypes', toggleFilterValue(filterSubtypes, subtype))}
                      className="w-3.5 h-3.5 accent-brand-red"
                    />
                    <span>{subtype}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label htmlFor={`${idPrefix}-filter-legality`} className="text-xs text-text-muted mb-1 block">{t('collection.filterLegality')}</label>
              <select id={`${idPrefix}-filter-legality`} className="select py-1.5 text-sm" value={filterLegality} onChange={(e) => onChange('filterLegality', e.target.value)}>
                <option value="">{t('collection.allLegalities')}</option>
                <option value="standard">{t('collection.standardLegal')}</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${idPrefix}-filter-language`} className="text-xs text-text-muted mb-1 block">{t('lang.filter')}</label>
              <TcgdexLanguageSelect
                id={`${idPrefix}-filter-language`}
                value={filterLang || 'all'}
                includeAll
                allLabel={t('lang.all')}
                compact
                languages={visibleLanguages}
                onChange={(value) => onChange('filterLang', value === 'all' ? '' : value)}
                className="select py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-filter-min-price`} className="text-xs text-text-muted mb-1 block">{t('collection.filterMinPrice')}</label>
              <input id={`${idPrefix}-filter-min-price`} type="number" min="0" step="0.01" placeholder="0" value={filterMinPrice}
                onChange={(e) => onChange('filterMinPrice', e.target.value)} className="input py-1.5 text-sm" />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-filter-max-price`} className="text-xs text-text-muted mb-1 block">{t('collection.filterMaxPrice')}</label>
              <input id={`${idPrefix}-filter-max-price`} type="number" min="0" step="0.01" placeholder="∞" value={filterMaxPrice}
                onChange={(e) => onChange('filterMaxPrice', e.target.value)} className="input py-1.5 text-sm" />
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={filterDuplicates} onChange={(e) => onChange('filterDuplicates', e.target.checked)}
                  className="w-4 h-4 accent-brand-red" />
                <span className="text-xs text-text-secondary">{t('collection.filterDuplicates')}</span>
              </label>
            </div>
          </div>
        )}
      </div>
    </PageSheet>
  )
}
