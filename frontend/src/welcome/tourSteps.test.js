import { describe, expect, it } from 'vitest'
import en from '../i18n/en'
import { TOUR_SECTIONS, allTourTargets, homeScreenStepKind, tourSteps } from './tourSteps'

const ids = steps => steps.map(step => step.id)
const full = { social: true, standalone: true, flags: { queue: true }, empty: {} }
const get = (path) => path.split('.').reduce((value, part) => value?.[part], en)

describe('tourSteps', () => {
  it('walks the five sections in order, social on', () => {
    const steps = tourSteps(full)
    expect(ids(steps)).toEqual([
      'today', 'challenge-row', 'challenge-hero',
      'tab-collection', 'collection-segments', 'first-binder', 'view-switch',
      'tab-scan', 'shutter', 'scan-queue', 'queue-list',
      'tab-search', 'search-field', 'browse-sets', 'sets-language',
      'tab-profile', 'tile-trades', 'trades-offers', 'back', 'tile-goals', 'first-goal', 'row-offline', 'offline-card',
    ])
    const sections = steps.map(step => step.section)
    expect([...sections].sort((a, b) => a - b)).toEqual(sections)
    expect(new Set(sections).size).toBe(TOUR_SECTIONS.length)
  })

  it('leaves the challenge out and rewords Trades when social is off', () => {
    const steps = tourSteps({ ...full, social: false })
    expect(ids(steps)).not.toContain('challenge-row')
    expect(ids(steps)).not.toContain('challenge-hero')
    expect(steps.find(step => step.id === 'tile-trades').copy).toBe('tileTradesPlain')
    expect(steps.find(step => step.id === 'trades-offers').copy).toBe('tradesPlain')
    const social = tourSteps(full)
    expect(social.find(step => step.id === 'tile-trades').copy).toBe('tileTrades')
    expect(social.find(step => step.id === 'trades-offers').copy).toBe('tradesOffers')
  })

  it('points at + instead of a binder or a goal on an empty account', () => {
    const steps = tourSteps({ ...full, empty: { binders: true, goals: true } })
    expect(ids(steps)).toContain('new-list')
    expect(ids(steps)).toContain('new-goal')
    expect(ids(steps)).not.toContain('first-binder')
    expect(ids(steps)).not.toContain('view-switch') // Book needs a binder to open
    expect(ids(steps)).not.toContain('first-goal')
    expect(steps.find(step => step.id === 'new-list').kind).toBe('info')
    expect(steps.find(step => step.id === 'new-goal').kind).toBe('info')
  })

  it('leaves Sync & offline out when the offline features are off, and ends on the last step', () => {
    const steps = tourSteps({ ...full, flags: {} })
    expect(ids(steps)).not.toContain('row-offline')
    expect(ids(steps)).not.toContain('offline-card')
    expect(steps.at(-1).finish).toBe(true)
    expect(tourSteps(full).at(-1)).toMatchObject({ id: 'offline-card', finish: true, kind: 'info' })
  })

  it('shows the notifications ask in the app and the browser line in a browser', () => {
    expect(tourSteps({ ...full, standalone: true }).find(step => step.id === 'scan-queue').extra).toBe('ask')
    expect(tourSteps({ ...full, standalone: false }).find(step => step.id === 'scan-queue').extra).toBe('browser')
  })

  it('makes the shutter and the explanations info steps and the real controls tap steps', () => {
    const byId = Object.fromEntries(tourSteps(full).map(step => [step.id, step]))
    for (const id of ['today', 'challenge-hero', 'shutter', 'queue-list', 'search-field', 'sets-language', 'trades-offers', 'first-goal', 'offline-card']) {
      expect(byId[id].kind, id).toBe('info')
    }
    for (const id of ['challenge-row', 'tab-collection', 'collection-segments', 'first-binder', 'view-switch', 'tab-scan', 'scan-queue', 'tab-search', 'browse-sets', 'tab-profile', 'tile-trades', 'back', 'tile-goals', 'row-offline']) {
      expect(byId[id].kind, id).toBe('tap')
    }
  })

  it('has a title, a body and (for a tap step) a tap line in the English strings', () => {
    for (const social of [true, false]) {
      for (const empty of [{}, { binders: true, goals: true }]) {
        for (const step of tourSteps({ ...full, social, empty })) {
          const copy = get(`tour.steps.${step.copy}`)
          expect(copy?.title, step.id).toBeTruthy()
          if (step.id === 'offline-card') expect(copy.browse).toBeTruthy()
          else expect(copy.body, step.id).toBeTruthy()
          if (step.kind === 'tap') expect(copy.tap, step.id).toBeTruthy()
        }
      }
    }
  })

  it('gives each routed step a route that matches where the trainer is, and a way back', () => {
    const steps = tourSteps(full)
    expect(steps.find(step => step.id === 'view-switch').route.test('/binders/12')).toBe(true)
    expect(steps.find(step => step.id === 'view-switch').route.test('/binders')).toBe(false)
    expect(steps.find(step => step.id === 'trades-offers').route.test('/trades/offers')).toBe(true)
    for (const step of steps) {
      if (step.route && step.id !== 'view-switch') expect(step.go, step.id).toBeTruthy()
      if (step.go) expect(step.route.test(step.go), step.id).toBe(true)
    }
  })

  it('lists every target it can use', () => {
    const targets = allTourTargets()
    expect(targets).toContain('new-list')
    expect(targets).toContain('new-goal')
    expect(targets).toContain('challenge-hero')
    expect(new Set(targets).size).toBe(targets.length)
  })
})

describe('homeScreenStepKind', () => {
  it('asks iPhone Safari to add the app, offers an install elsewhere, and says nothing in the app', () => {
    expect(homeScreenStepKind({ standalone: false, ios: true, installable: false })).toBe('ios')
    expect(homeScreenStepKind({ standalone: false, ios: false, installable: true })).toBe('install')
    expect(homeScreenStepKind({ standalone: false, ios: false, installable: false })).toBeNull()
    expect(homeScreenStepKind({ standalone: true, ios: true, installable: true })).toBeNull()
  })
})
