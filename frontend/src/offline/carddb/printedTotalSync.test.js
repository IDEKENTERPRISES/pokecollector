// The set's printed total reaches phones that already have the card database (phone matcher step 3d). The server put `printed_total`
// into every set payload, so every set's hash changed; a device with the old hashes fetches every set again on its next sync, and the
// phone matcher's catalogue adapter then sees the total (and a new catalogue signature, so its indexes are built again).
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { catalogueSignature, loadCatalogueRows } from '../../phonescan/decide/catalogue.js'
import { createCardDbStore } from './store.js'
import { MANIFEST_PATH, planSync, runCardDbSync, setPath } from './sync.js'

const FIELDS = ['id', 'tcg_card_id', 'name', 'set_id', 'number', 'lang', 'images_small', 'is_digital']
const card = (id, name, number) => [`${id}_en`, id, name, 'sv1', number, 'en', 'https://img.example/x.webp', false]
const setRow = extra => ({ id: 'sv1_en', tcg_set_id: 'sv1', name: 'Scarlet & Violet', abbreviation: 'SVI', total: 258, is_digital: false, lang: 'en', ...extra })
const payload = extra => ({ v: 1, set: setRow(extra), fields: FIELDS, cards: [card('sv1-25', 'Pikachu', '25'), card('sv1-26', 'Raichu', '26')] })

let store
beforeEach(() => { store = createCardDbStore(new IDBFactory()) })

function server(state) {
  return async path => {
    if (path === MANIFEST_PATH) return { status: 200, data: state.manifest }
    if (path === setPath('en', 'sv1_en')) return { status: 200, data: state.payload }
    if (path.includes('/prices/')) return { status: 200, data: { fields: ['price_market'], rows: [['sv1-25_en', 1]] } }
    return { status: 404 }
  }
}
const manifest = (hash, setHash) => ({ languages: { en: { hash, prices_hash: 'P1', prices_bytes: 10, prices_updated_at: '2026-11-12', card_count: 2, sets: [{ id: 'sv1_en', hash: setHash, cards: 2, bytes: 100 }] } } })

describe('printed_total in the offline card database', () => {
  it('an old device re-fetches the set because its hash changed, and the catalogue then carries the printed total', async () => {
    // before: the payload the server built without printed_total
    const state = { manifest: manifest('LANG-OLD', 'SET-OLD'), payload: payload({}) }
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server(state) })
    const before = await loadCatalogueRows(store)
    expect(before.rows.map(row => row.printed_total)).toEqual([null, null])
    expect(before.printedTotalMissing).toBe(2)

    // after the server change: same cards, set payload with printed_total, so a new set hash and language hash
    state.manifest = manifest('LANG-NEW', 'SET-NEW')
    state.payload = payload({ printed_total: 198 })
    const plan = planSync(state.manifest.languages.en, { setHashes: await store.listSetHashes('en'), pricesHash: (await store.getMeta('en')).pricesHash })
    expect(plan.fetchSets.map(item => item.id)).toEqual(['sv1_en'])
    expect(plan.upToDate).toBe(false)

    const result = await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server(state) })
    expect(result.languages[0]).toMatchObject({ fetchedSets: 1 })
    const after = await loadCatalogueRows(store)
    expect(after.rows.map(row => row.printed_total)).toEqual([198, 198])
    expect(after.printedTotalMissing).toBe(0)
    expect(after.signature).not.toBe(before.signature) // the lazy decide indexes rebuild
    expect(after.signature).toBe(catalogueSignature(await store.getMeta('en')))
  })

  it('a device that is already up to date with the new payload fetches nothing', async () => {
    const state = { manifest: manifest('LANG-NEW', 'SET-NEW'), payload: payload({ printed_total: 198 }) }
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server(state) })
    const second = await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server(state) })
    expect(second.languages[0].upToDate).toBe(true)
  })
})
