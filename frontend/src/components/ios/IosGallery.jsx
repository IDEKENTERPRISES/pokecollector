import { useState } from 'react'
import { Bell, Camera, Download, Heart, Plus, Settings as SettingsIcon, Share, Trash2, Wifi } from 'lucide-react'
import ActionSheet from './ActionSheet'
import Alert from './Alert'
import Badge from './Badge'
import Button from './Button'
import EnergyIcon from './EnergyIcon'
import GymBadges from './GymBadges'
import HeaderBloom from './HeaderBloom'
import HideValuesToggle from './HideValuesToggle'
import HpBar from './HpBar'
import IconButton from './IconButton'
import ListRow from './ListRow'
import ListSection from './ListSection'
import Menu from './Menu'
import PageSheet from './PageSheet'
import PokeBall from './PokeBall'
import SearchField from './SearchField'
import SegmentedControl from './SegmentedControl'
import SeriesTile from './SeriesTile'
import SetTile from './SetTile'
import StatTile from './StatTile'
import Switch from './Switch'
import TrainerCard from './TrainerCard'
import TypeChip from './TypeChip'
import { BRAND, TYPE_COLOURS, TYPE_KEYS, colourFor } from './pokemon'
import { useSettings } from '../../contexts/SettingsContext'

// Dev-only gallery at /__ios (like /__card-system): every iPhone UI primitive and Pokémon
// component in its states. Sample data only.

function Section({ id, title, children }) {
  return (
    <section id={id} data-testid={`gallery-${id}`} className="space-y-3">
      <h2 className="px-4 text-title-3 font-display">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, children }) {
  return (
    <div className="space-y-1.5 px-4">
      <p className="text-footnote text-text-secondary">{label}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

const SEGMENTS = [
  { value: 'cards', label: 'Cards' },
  { value: 'lists', label: 'Card Lists' },
  { value: 'wishlist', label: 'Wishlist' },
]

const NOOP = () => {}

export default function IosGallery() {
  const { formatPrice } = useSettings()
  const [segment, setSegment] = useState('cards')
  const [segmentLong, setSegmentLong] = useState('b')
  const [switchOn, setSwitchOn] = useState(true)
  const [query, setQuery] = useState('')
  const [filledQuery, setFilledQuery] = useState('Charizard')
  const [chip, setChip] = useState('fire')
  const [sort, setSort] = useState('date')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [dirtySheetOpen, setDirtySheetOpen] = useState(false)
  const [actionOpen, setActionOpen] = useState(false)
  const [alertOpen, setAlertOpen] = useState(false)
  const [stackedAlertOpen, setStackedAlertOpen] = useState(false)
  const [lastAction, setLastAction] = useState('none')

  return (
    <div className="relative isolate mx-auto max-w-[560px] space-y-8 pb-24 pt-[max(24px,var(--safe-top))]" data-testid="ios-gallery">
      <HeaderBloom variant="home" />
      <header className="space-y-1 px-4">
        <h1 className="text-large-title font-display">iPhone UI</h1>
        <p className="text-subheadline text-text-secondary">Primitives and the Pokémon layer, in every state. Dev only.</p>
        <p className="text-footnote text-text-muted" data-testid="gallery-last-action">Last action: {lastAction}</p>
      </header>

      <Section id="tokens" title="Tokens">
        <Row label="Type scale">
          <div className="space-y-0.5">
            <p className="text-tile-number font-display">Tile number 30</p>
            <p className="text-large-title font-display">Large title 34</p>
            <p className="text-title-1 font-display">Title 1 28</p>
            <p className="text-title-2 font-display">Title 2 22</p>
            <p className="text-title-3 font-display">Title 3 20</p>
            <p className="text-headline">Headline 17 semibold</p>
            <p className="text-body">Body 17</p>
            <p className="text-callout">Callout 16</p>
            <p className="text-subheadline">Subheadline 15</p>
            <p className="text-footnote">Footnote 13</p>
            <p className="text-caption-1">Caption 1 12</p>
            <p className="text-caption-2">Caption 2 11</p>
          </div>
        </Row>
        <Row label="Surfaces and text">
          {['bg-black', 'bg-surface', 'bg-elevated', 'bg-fill', 'bg-fill-tertiary', 'bg-accent', 'bg-green', 'bg-red', 'bg-yellow', 'bg-orange', 'bg-blue'].map(cls => (
            <span key={cls} className={`${cls} grid h-10 min-w-[64px] place-items-center rounded-lg px-2 text-caption-2 ring-1 ring-white/10`}>{cls.replace('bg-', '')}</span>
          ))}
        </Row>
        <Row label="Text levels">
          <span className="text-text-primary">primary</span>
          <span className="text-text-secondary">secondary</span>
          <span className="text-text-muted">muted</span>
          <span className="text-label-tertiary">tertiary (disabled only)</span>
          <span className="text-brand-red">accent tint</span>
        </Row>
        <Row label="Glass">
          <div className="glass rounded-[14px] px-4 py-3 text-subheadline">.glass material</div>
          <div className="holo rounded-[14px] bg-card px-4 py-3 text-subheadline">.holo sheen</div>
        </Row>
        <Row label="Brand triad">
          {Object.entries(BRAND).map(([name, hex]) => (
            <span key={name} className="grid h-10 w-20 place-items-center rounded-lg text-caption-1 font-semibold" style={{ background: hex, color: name === 'yellow' ? '#1D1600' : '#fff' }}>{name}</span>
          ))}
        </Row>
      </Section>

      <Section id="buttons" title="Buttons">
        <Row label="Button: filled, tinted, gray, plain">
          <Button>Filled</Button>
          <Button variant="tinted">Tinted</Button>
          <Button variant="gray">Gray</Button>
          <Button variant="plain">Plain</Button>
        </Row>
        <Row label="Destructive, disabled, loading">
          <Button destructive>Delete</Button>
          <Button variant="tinted" destructive>Remove</Button>
          <Button variant="plain" destructive>Log out</Button>
          <Button disabled>Disabled</Button>
          <Button loading>Saving</Button>
        </Row>
        <Row label="Sizes and icon">
          <Button size="sm" icon={Plus}>Small</Button>
          <Button size="md" icon={Download}>Medium</Button>
          <Button size="lg" icon={Camera}>Large</Button>
        </Row>
        <div className="px-4"><Button full icon={<PokeBall size={20} top="#fff" />}>Start scanning (3)</Button></div>
        <Row label="IconButton: glass, gray, plain, small">
          <IconButton icon={Share} label="Share" />
          <IconButton icon={Bell} label="Notifications" variant="gray" />
          <IconButton icon={Heart} label="Favourite" variant="plain" />
          <IconButton icon={Trash2} label="Delete" variant="gray" size="sm" />
          <HideValuesToggle />
        </Row>
        <Row label="Badge: counts, 99+, dot, tones">
          <Badge count={3} />
          <Badge count={150} />
          <Badge dot tone="yellow" />
          <Badge count={7} tone="yellow" />
          <Badge count={7} tone="green" />
          <Badge count={7} tone="blue" />
          <Badge count={7} tone="accent" />
          <Badge count={7} tone="gray" />
        </Row>
      </Section>

      <Section id="controls" title="Controls">
        <div className="space-y-3 px-4">
          <SegmentedControl ariaLabel="Collection" options={SEGMENTS} value={segment} onChange={setSegment} />
          <SegmentedControl
            ariaLabel="Page level"
            size="md"
            options={[{ value: 'a', label: 'Investment' }, { value: 'b', label: 'A very long segment label' }, { value: 'c', label: 'Rarity' }, { value: 'd', label: 'Duplicates' }]}
            value={segmentLong}
            onChange={setSegmentLong}
          />
        </div>
        <Row label="Switch: on, off, disabled">
          <Switch label="Demo switch" checked={switchOn} onChange={setSwitchOn} />
          <Switch label="Off switch" checked={false} onChange={NOOP} />
          <Switch label="Disabled switch" checked disabled onChange={NOOP} />
        </Row>
        <div className="space-y-3 px-4">
          <SearchField value={query} onChange={setQuery} placeholder="Search cards..." onCancel={() => setQuery('')} />
          <SearchField value={filledQuery} onChange={setFilledQuery} placeholder="Search cards..." ariaLabel="Filled search" />
          <SearchField value="" onChange={NOOP} placeholder="Search needs a connection" disabled ariaLabel="Disabled search" />
        </div>
      </Section>

      <Section id="lists" title="Lists">
        <ListSection header="Account" footer="Sentence-case footer text in Footnote.">
          <ListRow icon={SettingsIcon} iconColor="#8E8E93" title="Settings" to="/__ios" />
          <ListRow icon={Wifi} iconColor="var(--color-blue)" title="Sync & offline" value="2 waiting" onClick={() => setLastAction('sync row')} chevron />
          <ListRow icon={Bell} iconColor="var(--color-red)" title="Notifications" badge={3} onClick={() => setLastAction('notifications row')} chevron />
          <ListRow title="Plain row with subtitle" subtitle="A description in Footnote" value="Value" />
          <ListRow title="Show sets in series" trailing={<Switch label="Show sets in series" checked={switchOn} onChange={setSwitchOn} />} />
          <ListRow title="Disabled row" disabled onClick={NOOP} />
          <ListRow title="Log out" destructive onClick={() => setLastAction('log out row')} />
        </ListSection>
      </Section>

      <Section id="overlays" title="Menus, sheets and alerts">
        <Row label="Menu (checked option, destructive, sections)">
          <Menu
            label="Sort"
            trigger={<Button variant="gray" size="sm">Sort</Button>}
            align="start"
            sections={[
              [
                { id: 'date', label: 'Date added', checked: sort === 'date', onSelect: () => setSort('date') },
                { id: 'name', label: 'Name', checked: sort === 'name', onSelect: () => setSort('name') },
                { id: 'price', label: 'Price', checked: sort === 'price', onSelect: () => setSort('price') },
              ],
              [{ id: 'export', label: 'Export CSV', icon: Download, onSelect: () => setLastAction('export') }, { id: 'delete', label: 'Delete', icon: Trash2, destructive: true, onSelect: () => setLastAction('delete') }],
            ]}
          />
          <Menu label="More actions" sections={[[{ id: 'a', label: 'Scan cards', icon: Camera, onSelect: () => setLastAction('scan') }, { id: 'b', label: 'Disabled', disabled: true }]]} />
        </Row>
        <Row label="PageSheet, ActionSheet, Alert">
          <Button variant="gray" size="sm" onClick={() => setSheetOpen(true)}>Page sheet</Button>
          <Button variant="gray" size="sm" onClick={() => setDirtySheetOpen(true)}>Dirty sheet</Button>
          <Button variant="gray" size="sm" onClick={() => setActionOpen(true)}>Action sheet</Button>
          <Button variant="gray" size="sm" onClick={() => setAlertOpen(true)}>Alert</Button>
          <Button variant="gray" size="sm" onClick={() => setStackedAlertOpen(true)}>Alert (3)</Button>
        </Row>
      </Section>

      <Section id="pokemon" title="Pokémon layer">
        <Row label="Poké Ball: accent, red, blue, glossy, sizes">
          <PokeBall size={28} />
          <PokeBall size={28} top={BRAND.red} />
          <PokeBall size={28} top={BRAND.blue} />
          <PokeBall size={44} gloss />
          <PokeBall size={70} top="var(--color-accent)" gloss />
        </Row>
        <Row label="Energy symbols (all eleven types)">
          {TYPE_KEYS.map(type => <EnergyIcon key={type} type={type} size={28} />)}
        </Row>
        <Row label="Type chips: All, unselected, selected">
          <TypeChip type="all" selected={chip === 'all'} onPress={() => setChip('all')} />
          {TYPE_KEYS.map(type => (
            <TypeChip key={type} type={type} selected={chip === type} onPress={() => setChip(type)} />
          ))}
        </Row>
        <div className="grid grid-cols-2 gap-3 px-4">
          <StatTile type="fire" icon={Heart} label="Cards" value="1,284" detail="412 unique" to="/__ios" />
          <StatTile type="water" label="Sets" value="38" detail="6 complete" />
          <StatTile type="grass" label="Pokédex" value="212/1025" detail="species caught" />
          <StatTile type="lightning" label="Value" value={formatPrice(1234.5)} detail="+3.2% this month" sparkline={[4, 5, 4.6, 6, 6.4, 7.2, 7]} />
          <StatTile type="psychic" label="Psychic" value="9" />
          <StatTile type="fighting" label="Fighting" value="9" />
          <StatTile type="darkness" label="Darkness" value="9" />
          <StatTile type="metal" label="Metal" value="9" />
          <StatTile type="dragon" label="Dragon" value="9" />
          <StatTile type="fairy" label="Fairy" value="9" />
          <StatTile type="colorless" label="Colorless" value="9" />
        </div>
        <Row label="HpBar: 100 %, 51 %, 50 %, 20 %, 19 %, 0 %, empty max">
          <div className="w-full space-y-2" data-testid="hp-bars">
            {[[100, 100], [51, 100], [50, 100], [20, 100], [19, 100], [0, 100], [0, 0]].map(([value, max]) => (
              <div key={`${value}/${max}`} className="flex items-center gap-3">
                <span className="w-16 text-caption-1 tabular-nums text-text-secondary">{value}/{max}</span>
                <HpBar value={value} max={max} label={`${value} of ${max}`} />
              </div>
            ))}
          </div>
        </Row>
        <Row label="Header blooms (collection, search, series colour)">
          <div className="relative isolate h-28 w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10"><HeaderBloom variant="collection" /></div>
          <div className="relative isolate h-28 w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10"><HeaderBloom variant="search" /></div>
          <div className="relative isolate h-28 w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10"><HeaderBloom colour={colourFor('sword-shield')} /></div>
        </Row>
        <div className="space-y-3 px-4">
          <TrainerCard
            user={{ name: 'Ash', handle: 'ash-ketchum', id: 42 }}
            stats={{ cards: '1,284', sets: '38', pokedex: '212' }}
            badges={{ earned: [true, true, true, false, true, false, false, false], total: 20, to: '/__ios' }}
          />
          <TrainerCard user={{ name: 'Single user' }} stats={{ cards: '12', sets: '2', pokedex: '9' }} />
          <GymBadges earned={8} total={20} />
          <GymBadges earned={0} total={20} />
        </div>
        <div className="grid grid-cols-2 gap-3 px-4">
          <SeriesTile series={{ key: 'sword-shield', name: 'Sword & Shield', years: '2020–2022', setCount: 17 }} owned={620} total={2800} to="/__ios" />
          <SeriesTile series={{ key: 'base', name: 'Base', years: '1999–2000', setCount: 3 }} owned={300} total={300} complete />
          <SetTile set={{ id: 'swsh1', name: 'Sword & Shield', abbreviation: 'SSH' }} owned={120} total={216} to="/__ios" />
          <SetTile set={{ id: 'future', name: 'Upcoming Set', abbreviation: 'UPC', releaseLabel: '12 Dec 2026' }} owned={0} total={180} upcoming />
          <SetTile set={{ id: 'base1', name: 'Base Set', abbreviation: 'BS' }} owned={102} total={102} complete />
          <SetTile set={{ id: 'low', name: 'Almost nothing', abbreviation: 'LOW' }} owned={9} total={100} />
        </div>
        <Row label="Type tile palette (top → bottom, text colour)">
          {TYPE_KEYS.map(type => (
            <span key={type} className="grid h-12 w-[88px] place-items-center rounded-xl text-caption-1 font-semibold" style={{ background: `linear-gradient(150deg, ${TYPE_COLOURS[type].top}, ${TYPE_COLOURS[type].bottom})`, color: TYPE_COLOURS[type].text }}>{type}</span>
          ))}
        </Row>
      </Section>

      <PageSheet
        isOpen={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Filters"
        trailing={{ label: 'Done', onPress: () => { setLastAction('filters done'); setSheetOpen(false) } }}
        footer={<Button full onClick={() => setSheetOpen(false)}>Apply filters</Button>}
      >
        <div className="space-y-4 py-4">
          <ListSection header="Rarity">
            {['Common', 'Uncommon', 'Rare', 'Ultra Rare'].map(name => <ListRow key={name} title={name} />)}
          </ListSection>
          <ListSection><ListRow title="Only owned" trailing={<Switch label="Only owned" checked={switchOn} onChange={setSwitchOn} />} /></ListSection>
          <div className="h-[60vh]" aria-hidden="true" />
        </div>
      </PageSheet>
      <PageSheet isOpen={dirtySheetOpen} onClose={() => setDirtySheetOpen(false)} title="Edit card" isDirty trailing={{ label: 'Save', onPress: () => setDirtySheetOpen(false) }}>
        <p className="p-4 text-body">This sheet has unsaved changes, so Cancel, the swipe and the backdrop ask before closing.</p>
      </PageSheet>
      <ActionSheet
        isOpen={actionOpen}
        onClose={() => setActionOpen(false)}
        title="Discard 3 photos?"
        message="They have not been scanned yet."
        actions={[{ label: 'Discard', destructive: true, onSelect: () => setLastAction('discard') }, { label: 'Save for later', onSelect: () => setLastAction('save for later') }]}
        cancelLabel="Keep"
      />
      <Alert
        isOpen={alertOpen}
        onClose={() => setAlertOpen(false)}
        title="Delete card list?"
        message="This cannot be undone."
        actions={[
          { label: 'Cancel', style: 'cancel', onSelect: () => setAlertOpen(false) },
          { label: 'Delete', style: 'destructive', preferred: true, onSelect: () => { setLastAction('alert delete'); setAlertOpen(false) } },
        ]}
      />
      <Alert
        isOpen={stackedAlertOpen}
        onClose={() => setStackedAlertOpen(false)}
        title="You are offline"
        message="Three choices stack."
        actions={[
          { label: 'Retry', preferred: true, onSelect: () => setStackedAlertOpen(false) },
          { label: 'Keep waiting', onSelect: () => setStackedAlertOpen(false) },
          { label: 'Cancel', style: 'cancel', onSelect: () => setStackedAlertOpen(false) },
        ]}
      />
    </div>
  )
}
