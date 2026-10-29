import { describe, expect, it, vi } from 'vitest'
import {
  SHARE_HEIGHT, SHARE_WIDTH, canShareFile, dateLabel, drawShareImage, renderShareImage, shareFile, shareImageSpec,
  sharePicture, silhouetteOf,
} from './shareImage'

const words = key => ({
  'wtp.shareApp': 'PokéCollector',
  'wtp.title': "Who's That Pokémon?",
  'wtp.shareWon': 'Got it!',
  'wtp.shareLost': 'Missed it',
  'today.streakDays': '{count}-day streak',
  'today.streakOne': '1-day streak',
}[key] ?? key)

const results = {
  '2026-10-27': { choice: 1, correct: false },
  '2026-10-28': { choice: 25, correct: true },
}

const spec = (extra = {}) => shareImageSpec({
  t: words, date: '2026-10-28', result: results['2026-10-28'], results, streak: 12, accent: '#ff3366', locale: 'en-US', ...extra,
})

function recordingContext() {
  const calls = []
  const ctx = new Proxy({}, {
    get(target, name) {
      if (name in target) return target[name]
      if (name === 'calls') return calls
      return (...args) => { calls.push([name, ...args]); return { addColorStop() {} } }
    },
    set(target, name, value) { target[name] = value; calls.push(['set', name, value]); return true },
  })
  return ctx
}

describe('shareImageSpec', () => {
  it('is a 1080x1920 story with the app, the day, the verdict, the week and the streak', () => {
    const picture = spec()
    expect([picture.width, picture.height]).toEqual([SHARE_WIDTH, SHARE_HEIGHT])
    expect([SHARE_WIDTH, SHARE_HEIGHT]).toEqual([1080, 1920])
    expect(picture).toMatchObject({
      appName: 'PokéCollector',
      title: "Who's That Pokémon?",
      outcome: 'Got it!',
      accent: '#ff3366',
      streak: { count: 12, label: '12-day streak' },
    })
    expect(Array.from(picture.grid)).toEqual(['⬜', '⬜', '⬜', '⬜', '⬜', '🟥', '🟩'])
    expect(picture.dateLabel).toContain('28')
    expect(picture.dateLabel).toContain('2026')
  })

  it('reveals the sprite for a right answer and keeps the silhouette for a wrong one', () => {
    expect(spec().silhouette).toBe(false)
    const missed = spec({ date: '2026-10-27', result: results['2026-10-27'] })
    expect(missed.silhouette).toBe(true)
    expect(missed.outcome).toBe('Missed it')
  })

  it('leaves the streak out at zero and says "1-day streak" at one', () => {
    expect(spec({ streak: 0 }).streak).toBeNull()
    expect(spec({ streak: 1 }).streak).toEqual({ count: 1, label: '1-day streak' })
    expect(spec({ streak: -3 }).streak).toBeNull()
  })

  it('falls back to the brand red and a system font', () => {
    const picture = spec({ accent: '' })
    expect(picture.accent).toBe('#EE1515')
    expect(picture.fontFamily).toContain('system-ui')
  })

  it('keeps the sprite inside the panel, clear of the story overlays', () => {
    const { panel, sprite } = spec()
    expect(sprite.x).toBeGreaterThanOrEqual(panel.x)
    expect(sprite.x + sprite.size).toBeLessThanOrEqual(panel.x + panel.width)
    expect(sprite.y + sprite.size).toBeLessThanOrEqual(panel.y + panel.height)
    expect(panel.y).toBeGreaterThanOrEqual(250)
    expect(panel.y + panel.height).toBeLessThanOrEqual(1920 - 250)
  })
})

describe('dateLabel', () => {
  it('names the weekday and month from a local date', () => {
    expect(dateLabel('2026-10-28', 'en-US')).toBe('Wednesday, October 28, 2026')
  })

  it('returns an unparsable date as it came', () => {
    expect(dateLabel('soon', 'en-US')).toBe('soon')
  })
})

describe('drawShareImage', () => {
  it('writes the app, title, date, verdict, week and streak, and draws the sprite', () => {
    const ctx = recordingContext()
    const sprite = { id: 'sprite' }
    const picture = spec()
    drawShareImage(ctx, picture, sprite)
    const texts = ctx.calls.filter(call => call[0] === 'fillText').map(call => call[1])
    expect(texts).toEqual(expect.arrayContaining([
      'PokéCollector', "Who's That Pokémon?", picture.dateLabel, 'Got it!', picture.grid, '🔥 12-day streak',
    ]))
    expect(ctx.calls).toContainEqual(['drawImage', sprite, picture.sprite.x, picture.sprite.y, picture.sprite.size, picture.sprite.size])
    expect(ctx.calls).toContainEqual(['set', 'fillStyle', '#ff3366'])
    expect(ctx.calls).toContainEqual(['fillRect', 0, 0, 1080, 1920])
  })

  it('has no streak pill at zero and a question mark when the sprite is missing', () => {
    const ctx = recordingContext()
    drawShareImage(ctx, spec({ streak: 0 }), null)
    const texts = ctx.calls.filter(call => call[0] === 'fillText').map(call => call[1])
    expect(texts.some(text => String(text).includes('🔥'))).toBe(false)
    expect(texts).toContain('?')
    expect(ctx.calls.some(call => call[0] === 'drawImage')).toBe(false)
  })
})

describe('silhouetteOf', () => {
  it('keeps only the shape of the sprite, in black', () => {
    const ctx = recordingContext()
    const canvas = { width: 0, height: 0, getContext: () => ctx }
    const make = (width, height) => Object.assign(canvas, { width, height })
    const image = { naturalWidth: 96, naturalHeight: 64 }
    const result = silhouetteOf(image, make)
    expect(result).toBe(canvas)
    expect(ctx.calls[0]).toEqual(['drawImage', image, 0, 0])
    expect(ctx.calls).toContainEqual(['set', 'globalCompositeOperation', 'source-in'])
    expect(ctx.calls).toContainEqual(['set', 'fillStyle', '#000000'])
    expect(ctx.calls).toContainEqual(['fillRect', 0, 0, 96, 64])
  })
})

describe('renderShareImage', () => {
  const blob = new Blob(['png'], { type: 'image/png' })
  const makeCanvas = (toBlob) => () => ({ width: 0, height: 0, getContext: () => recordingContext(), toBlob })

  it('returns the PNG', async () => {
    const result = await renderShareImage(spec(), '/sprite.png', {
      createCanvas: makeCanvas(done => done(blob)), load: async () => ({ id: 'img' }),
    })
    expect(result).toBe(blob)
  })

  it('draws without the sprite when it does not load', async () => {
    const created = []
    const result = await renderShareImage(spec(), '/missing.png', {
      createCanvas: (...args) => { created.push(args); return makeCanvas(done => done(blob))() },
      load: async () => null,
    })
    expect(result).toBe(blob)
    expect(created).toHaveLength(1)
  })

  it('retries without the sprite when the canvas is tainted', async () => {
    let attempt = 0
    const result = await renderShareImage(spec(), '/other-origin.png', {
      createCanvas: makeCanvas((done) => {
        attempt += 1
        if (attempt === 1) throw new Error('SecurityError')
        done(blob)
      }),
      load: async () => ({ id: 'img' }),
    })
    expect(result).toBe(blob)
    expect(attempt).toBe(2)
  })

  it('gives null when the browser cannot make a PNG', async () => {
    const result = await renderShareImage(spec(), null, { createCanvas: makeCanvas(done => done(null)), load: async () => null })
    expect(result).toBeNull()
  })
})

describe('sharing the picture', () => {
  const blob = new Blob(['png'], { type: 'image/png' })

  const documentWithLink = () => {
    const link = { click: vi.fn(), remove: vi.fn() }
    return { link, doc: { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } } }
  }
  const urls = { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }

  it('names the file whos-that-pokemon.png', () => {
    const file = shareFile(blob)
    expect([file.name, file.type]).toEqual(['whos-that-pokemon.png', 'image/png'])
  })

  it('checks canShare for files (Web Share level 2)', () => {
    const file = shareFile(blob)
    expect(canShareFile(file, { share: vi.fn(), canShare: ({ files }) => files.length === 1 })).toBe(true)
    expect(canShareFile(file, { share: vi.fn(), canShare: () => false })).toBe(false)
    expect(canShareFile(file, { share: vi.fn() })).toBe(false)
    expect(canShareFile(file, {})).toBe(false)
    expect(canShareFile(file, { share: vi.fn(), canShare: () => { throw new Error('x') } })).toBe(false)
  })

  it('shares the file when the device can', async () => {
    const nav = { canShare: vi.fn(() => true), share: vi.fn(async () => {}) }
    const { doc, link } = documentWithLink()
    expect(await sharePicture(blob, { nav, doc, urls })).toBe('shared')
    const { files } = nav.share.mock.calls[0][0]
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('whos-that-pokemon.png')
    expect(link.click).not.toHaveBeenCalled()
  })

  it('downloads when files cannot be shared', async () => {
    const { doc, link } = documentWithLink()
    expect(await sharePicture(blob, { nav: {}, doc, urls })).toBe('downloaded')
    expect(link.download).toBe('whos-that-pokemon.png')
    expect(link.click).toHaveBeenCalledTimes(1)
  })

  it('treats closing the share sheet as cancelled, not as a failure to download', async () => {
    const nav = { canShare: () => true, share: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) }) }
    const { doc, link } = documentWithLink()
    expect(await sharePicture(blob, { nav, doc, urls })).toBe('cancelled')
    expect(link.click).not.toHaveBeenCalled()
  })

  it('downloads when the share itself is refused', async () => {
    const nav = { canShare: () => true, share: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }) }) }
    const { doc, link } = documentWithLink()
    expect(await sharePicture(blob, { nav, doc, urls })).toBe('downloaded')
    expect(link.click).toHaveBeenCalled()
  })
})
