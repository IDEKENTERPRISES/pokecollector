import { useState } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import Sheet from '../ui/Sheet'
import { normalizePocketLayout } from './bookPages'
import { movePageChoices, pocketPosition, slotAt, slotIndexFor } from './slotLayout'

const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text)

function MoveForm({ item, slots, layout, nameFor, onConfirm, onClose }) {
  const { t } = useSettings()
  const perPage = normalizePocketLayout(layout)
  const start = pocketPosition(item.slotIndex, perPage)
  const [page, setPage] = useState(start.page)
  const [pocket, setPocket] = useState(start.pocket)
  const pages = movePageChoices(slots, perPage)
  const lastExistingPage = pages - 2
  const targetIndex = slotIndexFor(page, pocket, perPage)
  const occupant = slotAt(slots, page, pocket, perPage)
  const isSame = targetIndex === item.slotIndex

  let status = t('book.targetEmpty')
  if (isSame) status = t('book.targetSame')
  else if (occupant) status = fill(t('book.targetSwap'), { name: nameFor(occupant) })

  return (
    <form
      className="space-y-4 p-4"
      onSubmit={event => {
        event.preventDefault()
        if (isSame) return
        onConfirm(targetIndex)
        onClose()
      }}
    >
      <p className="text-footnote text-text-secondary">{fill(t('book.moving'), { name: item.name })}</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-footnote text-text-secondary" htmlFor="book-move-page">
          <span>{t('book.page')}</span>
          <select id="book-move-page" className="select w-full" value={page} onChange={event => setPage(Number(event.target.value))}>
            {Array.from({ length: pages }, (_, index) => (
              <option key={index} value={index}>
                {index > lastExistingPage ? fill(t('book.newPage'), { page: index + 1 }) : index + 1}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-footnote text-text-secondary" htmlFor="book-move-pocket">
          <span>{t('book.pocket')}</span>
          <select id="book-move-pocket" className="select w-full" value={pocket} onChange={event => setPocket(Number(event.target.value))}>
            {Array.from({ length: perPage }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}
          </select>
        </label>
      </div>
      <p className="rounded-xl bg-fill-tertiary px-3 py-2 text-footnote" role="status" aria-live="polite" data-testid="book-move-status">
        {status}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-ghost justify-center" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn-primary justify-center" disabled={isSame}>{t('book.moveConfirm')}</button>
      </div>
    </form>
  )
}

/**
 * "Move to…": page and pocket pickers for one card. It is the VoiceOver and precision path for the drag.
 * `item` is { name, slotIndex }; `slots` the current layout; `nameFor(slot)` names the card in a pocket.
 */
export default function MovePocketSheet({ item, slots, layout, nameFor, onConfirm, onClose }) {
  const { t } = useSettings()
  return (
    <Sheet isOpen={Boolean(item)} onClose={onClose} title={t('book.moveToTitle')}>
      {item && (
        <MoveForm
          key={`${item.slotIndex}:${layout}`}
          item={item}
          slots={slots}
          layout={layout}
          nameFor={nameFor}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      )}
    </Sheet>
  )
}
