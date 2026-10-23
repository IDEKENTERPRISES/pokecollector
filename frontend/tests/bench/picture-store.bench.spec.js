import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect, test, webkit } from '@playwright/test'

// F16a: what do ~22,000 downloaded card pictures cost at launch? Page-context timing of the first
// Cache Storage access (the service worker's launch path: precache, shell, state) and of the first
// IndexedDB picture lookup, on a COLD browser start, in WebKit (the iPhone's engine) and Chromium.
//   none  : the app's own small cache only
//   cache : + pc-carddb-images-v1-en with PICTURES entries (the old store)
//   idb   : + PICTURES pictures as PACKS (one Blob per set) and an index of card id -> slice (the new store)
// PICTURES / PICTURE_KB / RUNS tune the size (default 22,000 x 2 KB, 3 cold starts each).

const PICTURES = Number(process.env.PICTURES ?? 22000)
const PICTURE_KB = Number(process.env.PICTURE_KB ?? 2)
const RUNS = Number(process.env.RUNS ?? 3)
const SETS = 200
const PORT = Number(process.env.BENCH_PORT ?? 4181)

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>bench</title><body>bench</body>')
  })
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)))
}

async function seed(page, mode, count, kb) {
  await page.evaluate(async ({ mode: kind, count: total, kb: size, sets }) => {
    const app = await caches.open('pc-precache-bench')
    for (let i = 0; i < 60; i += 1) await app.put(`/assets/app-${i}.js`, new Response('x'.repeat(2000), { headers: { 'Content-Type': 'text/javascript' } }))
    const bytes = new Uint8Array(size * 1024)
    if (kind === 'cache') {
      const cache = await caches.open('pc-carddb-images-v1-en')
      for (let start = 0; start < total; start += 500) {
        await Promise.all(Array.from({ length: Math.min(500, total - start) }, (_, offset) => (
          cache.put(`${location.origin}/api/images/card/en/seed${start + offset}/small`, new Response(bytes.slice(), { headers: { 'Content-Type': 'image/webp' } }))
        )))
      }
    } else if (kind === 'idb') {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pc-bench-pictures', 1)
        request.onupgradeneeded = () => {
          request.result.createObjectStore('packs')
          request.result.createObjectStore('index')
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const perSet = Math.ceil(total / sets)
      for (let set = 0; set < sets; set += 1) {
        const inSet = Math.min(perSet, total - set * perSet)
        if (inSet <= 0) break
        const blob = new Blob([new Uint8Array(inSet * size * 1024)])
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['packs', 'index'], 'readwrite')
          tx.objectStore('packs').put(blob, `en|set${set}`)
          for (let i = 0; i < inSet; i += 1) {
            tx.objectStore('index').put({ p: `en|set${set}`, o: i * size * 1024, l: size * 1024, t: 'image/webp', lang: 'en' }, `seed${set * perSet + i}`)
          }
          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        })
      }
      db.close()
    }
  }, { mode, count, kb, sets: SETS })
}

async function measure(page, mode, total) {
  return page.evaluate(async ({ kind, total: count }) => {
    const out = {}
    let t = performance.now()
    const cache = await caches.open('pc-precache-bench')
    out.cachesOpenMs = performance.now() - t
    t = performance.now()
    const hit = await cache.match('/assets/app-7.js')
    out.cacheMatchMs = performance.now() - t
    out.cacheHit = hit ? 1 : 0
    t = performance.now()
    await caches.keys()
    out.cachesKeysMs = performance.now() - t
    if (kind === 'idb') {
      t = performance.now()
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pc-bench-pictures', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      out.idbOpenMs = performance.now() - t
      t = performance.now()
      const id = `seed${Math.floor(count / 2)}`
      const entry = await new Promise(resolve => { const r = db.transaction('index').objectStore('index').get(id); r.onsuccess = () => resolve(r.result) })
      const blob = await new Promise(resolve => { const r = db.transaction('packs').objectStore('packs').get(entry.p); r.onsuccess = () => resolve(r.result) })
      const bytes = await blob.slice(entry.o, entry.o + entry.l, entry.t).arrayBuffer()
      out.idbPictureMs = performance.now() - t
      out.idbBytes = bytes.byteLength
      db.close()
    }
    return out
  }, { kind: mode, total })
}

for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
  test(`${name}: first Cache Storage access with ${PICTURES} pictures stored`, async ({}, testInfo) => {
    test.skip(testInfo.project.name !== name, 'one browser per project')
    test.setTimeout(45 * 60 * 1000)
    const server = await startServer()
    const results = {}
    try {
      for (const mode of ['none', 'cache', 'idb']) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pc-bench-${name}-${mode}-`))
        const origin = `http://127.0.0.1:${PORT}/`
        let context = await type.launchPersistentContext(dir)
        let page = await context.newPage()
        await page.goto(origin)
        const seedStart = Date.now()
        await seed(page, mode, PICTURES, PICTURE_KB)
        const seedMs = Date.now() - seedStart
        await context.close()
        const runs = []
        for (let run = 0; run < RUNS; run += 1) {
          context = await type.launchPersistentContext(dir) // a cold browser start on the same storage
          page = await context.newPage()
          const navStart = Date.now()
          await page.goto(origin)
          const loadMs = Date.now() - navStart
          runs.push({ loadMs, ...(await measure(page, mode, PICTURES)) })
          await context.close()
        }
        const keys = Object.keys(runs[0])
        results[mode] = { seedMs, runs, median: Object.fromEntries(keys.map(key => [key, Math.round(median(runs.map(r => r[key])))])) }
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      server.close()
    }
    const summary = Object.fromEntries(Object.entries(results).map(([mode, value]) => [mode, value.median]))
    console.log(`BENCH ${name} pictures=${PICTURES} ${JSON.stringify(summary)}`)
    fs.writeFileSync(testInfo.outputPath(`bench-${name}.json`), JSON.stringify(results, null, 2))
    // The new store must keep the first Cache Storage access about as cheap as having no pictures.
    const base = results.none.median.cachesOpenMs + results.none.median.cacheMatchMs
    const idb = results.idb.median.cachesOpenMs + results.idb.median.cacheMatchMs
    expect(idb).toBeLessThan(Math.max(base * 3, base + 250))
    expect(results.idb.median.idbPictureMs).toBeLessThan(500)
  })
}
