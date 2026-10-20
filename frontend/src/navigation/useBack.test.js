import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
let pathname = '/'

vi.mock('react', async importOriginal => ({ ...(await importOriginal()), useCallback: fn => fn }))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname }),
}))

const { decideBack, useBack } = await import('./useBack.js')
const { emptyHistory, historyReducer, recordNavigation, resetHistoryMirror } = await import('./historyMirror.js')

const start = (key, path) => historyReducer(emptyHistory, { type: 'POP', key, path })
const push = (state, key, path) => historyReducer(state, { type: 'PUSH', key, path })

describe('decideBack', () => {
  it('goes back when the previous entry is in the same section', () => {
    const history = push(start('a', '/profile'), 'b', '/settings')
    expect(decideBack(history, '/settings')).toEqual({ type: 'back' })
  })

  it('goes to the parent with replace after a tab switch', () => {
    // Collection › binder, Search, Collection (the binder again): back must not land on Search.
    let history = start('a', '/binders')
    history = push(history, 'b', '/binders/7')
    history = push(history, 'c', '/search')
    history = push(history, 'd', '/binders/7')
    expect(decideBack(history, '/binders/7')).toEqual({ type: 'replace', to: '/binders' })
  })

  it('goes to the parent on a cold start (a deep link)', () => {
    expect(decideBack(start('a', '/settings/appearance'), '/settings/appearance')).toEqual({ type: 'replace', to: '/settings' })
    expect(decideBack(start('a', '/sets/base1'), '/sets/base1')).toEqual({ type: 'replace', to: '/sets' })
    expect(decideBack(start('a', '/collection/user/3'), '/collection/user/3')).toEqual({ type: 'replace', to: '/leaderboard' })
  })

  it('goes to the section root for a route with no parent', () => {
    expect(decideBack(start('a', '/search'), '/search')).toEqual({ type: 'replace', to: '/search' })
  })

  it('sends the scan inbox to the previous screen, else Home', () => {
    const history = push(start('a', '/collection'), 'b', '/scans')
    expect(decideBack(history, '/scans')).toEqual({ type: 'back' })
    expect(decideBack(start('a', '/scans'), '/scans')).toEqual({ type: 'replace', to: '/' })
  })

  it('fills route params in the parent', () => {
    expect(decideBack(start('a', '/scans/9'), '/scans/9')).toEqual({ type: 'replace', to: '/scans' })
  })
})

describe('useBack', () => {
  beforeEach(() => {
    navigate.mockClear()
    resetHistoryMirror()
  })

  it('navigates -1 within a section', () => {
    recordNavigation({ type: 'POP', key: 'a', path: '/profile' })
    recordNavigation({ type: 'PUSH', key: 'b', path: '/analytics' })
    pathname = '/analytics'
    useBack()()
    expect(navigate).toHaveBeenCalledWith(-1)
  })

  it('replaces with the parent otherwise', () => {
    recordNavigation({ type: 'POP', key: 'a', path: '/leaderboard/compare/3' })
    pathname = '/leaderboard/compare/3'
    useBack()()
    expect(navigate).toHaveBeenCalledWith('/leaderboard', { replace: true })
  })
})
