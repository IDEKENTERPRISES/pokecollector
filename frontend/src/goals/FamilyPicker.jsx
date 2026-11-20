import { useMemo, useState } from 'react'
import ListRow from '../components/ios/ListRow'
import ListSection from '../components/ios/ListSection'
import SearchField from '../components/ios/SearchField'
import { filterFamilies } from './goals'

function memberLine(family, matched) {
  return (family.members || []).map(member => (matched.includes(member.dex_id) ? `→ ${member.name}` : member.name)).join(', ')
}

/** Search any Pokémon and pick its evolution family; the popular families show first without a query. */
export default function FamilyPicker({ families, onPick, t }) {
  const [query, setQuery] = useState('')
  const { items, total } = useMemo(() => filterFamilies(families, query), [families, query])
  const hasQuery = query.trim() !== ''
  return (
    <div className="space-y-3">
      <SearchField value={query} onChange={setQuery} placeholder={t('goals.searchPokemon')} onCancel={() => setQuery('')} />
      {hasQuery && total === 0 ? (
        <p className="px-1 text-footnote text-text-secondary" data-testid="family-empty">{t('goals.noFamilies')}</p>
      ) : (
        <ListSection className="mx-0">
          {items.map(({ family, matched }) => (
            <ListRow
              key={family.id}
              testId={`pick-family-${family.id}`}
              title={family.name}
              subtitle={memberLine(family, matched)}
              onClick={() => onPick(family)}
              chevron
            />
          ))}
        </ListSection>
      )}
      {total > items.length && (
        <p className="px-1 text-footnote text-text-secondary" data-testid="family-more">{t('goals.typeToSearch')}</p>
      )}
    </div>
  )
}
