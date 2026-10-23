// Realistic offline data for the startup measurements (F14c): a read cache near its cap with every
// page saved, an offline card database of about 30,000 cards over 200 sets, and some downloaded
// pictures. Everything is generated inside the page, so no large payload crosses the test runner.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appVersion = () => {
  try {
    return readFileSync(resolve(process.cwd(), '..', 'VERSION'), 'utf-8').trim()
  } catch {
    return ''
  }
}

export const STARTUP_SIZES = Object.freeze({
  sets: 200,
  cardsPerSet: 150, // 30,000 cards
  readCacheBytes: 44 * 1024 * 1024, // the cap is 50 MiB in all, 15 MiB a query
  pictures: 120,
})

/** Seeds the read cache record of `userId` (the page must be on the app's origin). → bytes written. */
export function seedReadCache(page, userId, { bytes = STARTUP_SIZES.readCacheBytes, withHead = true } = {}) {
  return page.evaluate(async ({ userId: id, bytes: target, version, withHead: writeHead }) => {
    const now = Date.now()
    const state = data => ({
      data, dataUpdateCount: 1, dataUpdatedAt: now, error: null, errorUpdateCount: 0, errorUpdatedAt: 0,
      fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null, isInvalidated: false,
      status: 'success', fetchStatus: 'idle',
    })
    const entry = (queryKey, data) => ({ queryKey, queryHash: JSON.stringify(queryKey), state: state(data) })
    const card = index => ({
      id: `startup-${index}_en`, card_id: `startup-${index}_en`, name: `Startup card ${index}`, number: String(index % 300),
      set_id: `startup-set-${index % 200}_en`, set_name: `Startup set ${index % 200}`, rarity: 'Rare Holo', supertype: 'Pokemon',
      types: ['Lightning'], hp: '120', artist: 'Someone', flavor_text: 'Lorem ipsum dolor sit amet '.repeat(4),
      images_small: `https://assets.example/${index}/small.webp`, images_large: `https://assets.example/${index}/large.webp`,
      price_market: 1 + (index % 50), price_trend: 1 + (index % 40), attacks: [{ name: 'Thunder', damage: '90', cost: ['Lightning', 'Colorless'] }],
    })
    const queries = [
      entry(['dashboard', 'price_market'], { recent_additions: Array.from({ length: 20 }, (_, i) => card(i)), top_cards: Array.from({ length: 20 }, (_, i) => card(i + 20)) }),
      entry(['investment-tracker', '1M', 'price_market'], []),
      entry(['sets', 'all'], Array.from({ length: 200 }, (_, i) => ({ id: `startup-set-${i}_en`, name: `Startup set ${i}`, series: 'Fixture', total: 150 }))),
      entry(['pokedex-summary'], []),
      entry(['custom-matches'], []),
      entry(['settings'], { language: 'en', currency: 'EUR' }),
    ]
    // Fill the rest with collection / search / set pages until the record is about `target` characters.
    let size = 0
    let index = 0
    while (size < target) {
      const rows = Array.from({ length: 4000 }, (_, i) => card(index * 4000 + i))
      const data = index % 2 === 0 ? rows : { items: rows, total: rows.length }
      size += JSON.stringify(data).length
      queries.push(entry(index % 2 === 0 ? ['collection', { page: index }] : ['search', { page: index }], data))
      index += 1
    }
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pokecollector-readcache', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('qc')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction('qc', 'readwrite')
      tx.objectStore('qc').put({ v: 1, savedAt: now, appVersion: version, state: { mutations: [], queries } }, `${location.origin}|${id}`)
      // The head record the app writes next to it: the small queries the first screen needs.
      if (writeHead) {
      const head = queries.filter(query => JSON.stringify(query.state.data).length <= 256 * 1024)
      tx.objectStore('qc').put({ v: 1, savedAt: now, appVersion: version, state: { mutations: [], queries: head } }, `${location.origin}|${id}|head`)
      }
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    return size
  }, { userId, bytes, version: appVersion(), withHead })
}

/**
 * Seeds the offline card database (`en`) the way phones that installed F13a have it: a version 1 database
 * (four stores, no derived ones). Any database the app already created is deleted first, so the app's own
 * upgrade to the current version (and the rebuild of the derived stores) runs on the next start.
 * `sets` sets of `cardsPerSet` cards each.
 */
export function seedCardDb(page, { sets = STARTUP_SIZES.sets, cardsPerSet = STARTUP_SIZES.cardsPerSet } = {}) {
  return page.evaluate(async ({ sets: setCount, cardsPerSet: perSet }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('pokecollector-carddb')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
      request.onblocked = resolve
    })
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pokecollector-carddb', 1)
      request.onupgradeneeded = () => {
        for (const name of ['sets', 'setIndex', 'prices', 'meta']) request.result.createObjectStore(name)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const fields = ['id', 'name', 'set_id', 'number', 'rarity', 'supertype', 'types', 'hp', 'images_small', 'images_large']
    const tx = db.transaction(['sets', 'setIndex', 'prices', 'meta'], 'readwrite')
    const priceRows = []
    for (let s = 0; s < setCount; s += 1) {
      const setId = `startup-set-${s}_en`
      const cards = Array.from({ length: perSet }, (_, c) => {
        const id = `startup-set-${s}-${c}_en`
        priceRows.push([id, 1 + (c % 30)])
        return [id, `Fixture card ${s}-${c}`, setId, String(c + 1), 'Rare', 'Pokemon', ['Lightning'], '120', `https://assets.example/${id}/small.webp`, `https://assets.example/${id}/large.webp`]
      })
      const payload = { v: 1, set: { id: setId, name: `Startup set ${s}`, series: `Series ${s % 20}` }, fields, cards }
      tx.objectStore('sets').put(payload, `en|${setId}`)
      tx.objectStore('setIndex').put({ lang: 'en', setId, hash: `h${s}`, bytes: 40000, cards: perSet }, `en|${setId}`)
    }
    tx.objectStore('prices').put({ v: 1, fields: ['price_market'], rows: priceRows }, 'en')
    tx.objectStore('meta').put({ hash: 'startup-hash', pricesHash: 'startup-prices', pricesUpdatedAt: null, pricesBytes: 1000, sets: setCount, cards: setCount * perSet, syncedAt: Date.now() }, 'en')
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    return setCount * perSet
  }, { sets, cardsPerSet })
}

/** Puts some small pictures in the picture cache (Cache Storage). */
export function seedPictures(page, { count = STARTUP_SIZES.pictures } = {}) {
  return page.evaluate(async total => {
    const cache = await caches.open('pc-carddb-images-v1-en')
    const body = new Uint8Array(20 * 1024)
    for (let i = 0; i < total; i += 1) {
      await cache.put(`/api/images/card/startup-set-0-${i}_en/small`, new Response(body, { headers: { 'Content-Type': 'image/webp' } }))
    }
    return total
  }, count)
}
