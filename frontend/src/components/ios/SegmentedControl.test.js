import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SegmentedControl, { nextSegmentIndex } from './SegmentedControl'

describe('nextSegmentIndex', () => {
  it('moves right and left with the arrow keys and wraps', () => {
    expect(nextSegmentIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextSegmentIndex('ArrowRight', 2, 3)).toBe(0)
    expect(nextSegmentIndex('ArrowLeft', 1, 3)).toBe(0)
    expect(nextSegmentIndex('ArrowLeft', 0, 3)).toBe(2)
  })

  it('treats down and up like right and left', () => {
    expect(nextSegmentIndex('ArrowDown', 0, 4)).toBe(1)
    expect(nextSegmentIndex('ArrowUp', 0, 4)).toBe(3)
  })

  it('jumps to the ends with Home and End', () => {
    expect(nextSegmentIndex('Home', 2, 4)).toBe(0)
    expect(nextSegmentIndex('End', 0, 4)).toBe(3)
  })

  it('ignores other keys and empty controls', () => {
    expect(nextSegmentIndex('Enter', 0, 3)).toBeNull()
    expect(nextSegmentIndex('a', 0, 3)).toBeNull()
    expect(nextSegmentIndex('ArrowRight', 0, 0)).toBeNull()
  })
})

describe('SegmentedControl markup', () => {
  const options = [{ value: 'a', label: 'Cards' }, { value: 'b', label: 'Lists' }, { value: 'c', label: 'Wishlist' }]
  const markup = renderToStaticMarkup(createElement(SegmentedControl, { options, value: 'b', onChange() {}, ariaLabel: 'Collection' }))

  it('is a radiogroup of radios with aria-checked', () => {
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain('aria-label="Collection"')
    expect((markup.match(/role="radio"/g) ?? [])).toHaveLength(3)
    expect((markup.match(/aria-checked="true"/g) ?? [])).toHaveLength(1)
  })

  it('uses a roving tabIndex: only the selected radio is in the tab order', () => {
    expect((markup.match(/tabindex="0"/g) ?? [])).toHaveLength(1)
    expect((markup.match(/tabindex="-1"/g) ?? [])).toHaveLength(2)
  })
})
