// Downloaded card pictures the way F16a stores them: IndexedDB `pokecollector-pictures`, one Blob per
// set (`packs`) plus an index from card id to its slice (`index`). Same names as
// src/offline/carddb/pictureStore.js. Everything is generated inside the page.

// A real 1x1 PNG, so a picture served from the store decodes.
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Seeds the picture store. Either `items: [{ id }]` (each a copy of the 1x1 PNG) or `count` pictures named
 * `${prefix}${n}` padded to `kb` KB. Pictures go into packs of `perSet`. → the number of pictures stored.
 */
export function seedPictureStore(page, { items = null, count = 0, kb = 1, prefix = 'seed', perSet = 150, lang = 'en' } = {}) {
  return page.evaluate(async ({ items: given, count: total, kb: size, prefix: idPrefix, perSet: setSize, lang: language, png }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pokecollector-pictures', 1)
      request.onupgradeneeded = () => {
        const created = request.result
        created.createObjectStore('packs')
        const index = created.createObjectStore('index')
        index.createIndex('p', 'p')
        index.createIndex('lang', 'lang')
        created.createObjectStore('loose').createIndex('lang', 'lang')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const pngBytes = Uint8Array.from(atob(png), char => char.charCodeAt(0))
    const body = new Uint8Array(Math.max(size * 1024, pngBytes.length))
    body.set(pngBytes)
    const ids = given ? given.map(item => item.id) : Array.from({ length: total }, (_, n) => `${idPrefix}${n}`)
    const each = given ? pngBytes.length : body.length
    const bytes = given ? pngBytes : body
    for (let start = 0, set = 0; start < ids.length; start += setSize, set += 1) {
      const chunk = ids.slice(start, start + setSize)
      const key = `${language}|${idPrefix}-set${set}`
      const blob = new Blob(chunk.map(() => bytes))
      const write = value => new Promise((resolve, reject) => {
        const tx = db.transaction(['packs', 'index'], 'readwrite')
        tx.objectStore('packs').put(value, key)
        chunk.forEach((id, n) => tx.objectStore('index').put({ p: key, o: n * each, l: each, t: 'image/png', lang: language }, id))
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
      // WebKit in an automated (private-like) context cannot keep Blobs in IndexedDB: use an ArrayBuffer there.
      await write(blob).catch(async () => write(await blob.arrayBuffer()))
    }
    db.close()
    return ids.length
  }, { items, count, kb, prefix, perSet, lang, png: PNG_BASE64 })
}

/** How many card pictures are in the store (index entries). */
export function storedPictureCount(page) {
  return page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('pokecollector-pictures', 1)
    request.onupgradeneeded = () => request.transaction.abort()
    request.onerror = event => { event.preventDefault(); resolve(0) }
    request.onsuccess = () => {
      const db = request.result
      const count = db.transaction('index').objectStore('index').count()
      count.onsuccess = () => { db.close(); resolve(count.result) }
      count.onerror = () => { db.close(); resolve(0) }
    }
  }))
}
