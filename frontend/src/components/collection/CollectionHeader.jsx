import { useNavigate } from 'react-router-dom'
import { useSettings } from '../../contexts/SettingsContext'
import HeaderBloom from '../ios/HeaderBloom'
import LargeTitle from '../ios/LargeTitle'
import SegmentedControl from '../ios/SegmentedControl'

const SEGMENT_PATHS = {
  cards: '/collection',
  lists: '/binders',
  wishlist: '/wishlist',
}

/**
 * The shared header of the three Collection routes (render it inside a `relative isolate` page): a header bloom in Pokémon blue and the theme
 * accent, the large title with its subtitle, and the Cards | Card Lists | Wishlist segmented
 * control. Switching segments replaces the history entry (Q12) so the segments do not pile up.
 */
export default function CollectionHeader({ active, subtitle }) {
  const { t } = useSettings()
  const navigate = useNavigate()
  const options = [
    { value: 'cards', label: t('collection.segmentCards') },
    { value: 'lists', label: t('nav.binders') },
    { value: 'wishlist', label: t('nav.wishlist') },
  ]

  return (
    <>
      <div className="pointer-events-none absolute -inset-x-4 top-0 h-[380px] sm:-inset-x-8" aria-hidden="true">
        <HeaderBloom variant="collection" />
      </div>
      <div className="-mx-4">
        <LargeTitle title={t('nav.collection')} subtitle={subtitle} />
      </div>
      <div className="pb-3">
        <SegmentedControl
          options={options}
          value={active}
          ariaLabel={t('nav.collection')}
          onChange={(value) => {
            if (value !== active) navigate(SEGMENT_PATHS[value], { replace: true })
          }}
        />
      </div>
    </>
  )
}
