import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TABS } from '../navigation/navConfig'
import { allTourTargets } from './tourSteps'

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'welcome' ? [] : sources(path)
    return ['.jsx', '.js'].includes(extname(entry.name)) && !/\.test\./.test(entry.name) ? [{ path, text: readFileSync(path, 'utf8') }] : []
  })
}

const files = sources(src)
const read = name => files.find(file => file.path.replace(/\\/g, '/').endsWith(name))?.text ?? ''

// A hook is "in the source" when a component carries the id in a data-tour attribute or hands it to a tour prop.
const carries = id => files.some(file => (
  file.text.includes(`data-tour="${id}"`)
  || new RegExp(`\\btour[=:]\\s*\\{?[^}\\n]*['"]${id}['"]`).test(file.text)
  || new RegExp(`data-tour=\\{[^}]*['"]${id}['"]`).test(file.text)
))

describe('data-tour hooks', () => {
  it('exist in the source for every id the tour uses', () => {
    const tabs = new Set(['tab-scan', ...TABS.map(tab => `tab-${tab.key}`)])
    const missing = allTourTargets().filter(id => !tabs.has(id) && !carries(id))
    expect(missing).toEqual([])
  })

  it('sit on both the tab bar and the sidebar for every tab', () => {
    expect(read('components/ios/TabBar.jsx')).toContain('data-tour={`tab-${tab.key}`}')
    expect(read('components/ios/ScanButton.jsx')).toContain('data-tour="tab-scan"')
    const sidebar = read('components/ios/SidebarNav.jsx')
    expect(sidebar).toContain('tour={`tab-${tab.key}`}')
    expect(sidebar).toContain('data-tour="tab-scan"')
    for (const id of allTourTargets().filter(item => item.startsWith('tab-'))) {
      if (id !== 'tab-scan') expect(TABS.map(tab => `tab-${tab.key}`)).toContain(id)
    }
  })
})

describe('layers', () => {
  const css = readFileSync(join(src, 'index.css'), 'utf8')
  const value = name => Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(css)?.[1])

  it('puts the tour above the scanner and below the update banner (docs/WELCOME_DESIGN.md §10)', () => {
    const banner = Number(/top-0 z-\[(\d+)\]/.exec(read('components/pwa/UpdateBanner.jsx'))?.[1])
    expect(value('tour')).toBe(59)
    expect(value('scanner')).toBe(58)
    expect(banner).toBe(60)
    expect(value('scanner')).toBeLessThan(value('tour'))
    expect(value('tour')).toBeLessThan(banner)
    expect(value('menu')).toBeLessThan(value('scanner'))
  })
})
