// Starting the tour from elsewhere (Settings › About, the Take the tour card) and the note on Home
// that follows "I'll add it now". In memory only: a closed app starts the tour over (docs/WELCOME_DESIGN.md §3.1).
import { useSyncExternalStore } from 'react'

export const TOUR_START_EVENT = 'pc:start-tour'

export function requestTour() {
  window.dispatchEvent(new Event(TOUR_START_EVENT))
}

let homeNote = false
const listeners = new Set()

export function setHomeNote(value) {
  if (homeNote === !!value) return
  homeNote = !!value
  listeners.forEach(fn => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** True after "I'll add it now": Home shows "Open PokéCollector from your Home Screen to take the tour." */
export function useHomeNote() {
  return useSyncExternalStore(subscribe, () => homeNote, () => homeNote)
}
