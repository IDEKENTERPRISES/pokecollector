import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./holo.css', import.meta.url)), 'utf8')
const trainerCard = readFileSync(fileURLToPath(new URL('../ios/TrainerCard.jsx', import.meta.url)), 'utf8')

describe('holo touch-action', () => {
  it('keeps touch-action: none on the tilt stage', () => {
    expect(css).toMatch(/\n\.holo \{[^}]*touch-action: none;/)
  })

  it('lets the scrollable variant pan vertically', () => {
    expect(css).toMatch(/\.holo--scrollable \{ touch-action: pan-y; \}/)
    // it must come after .holo so the same-specificity cascade picks it
    expect(css.indexOf('.holo--scrollable')).toBeGreaterThan(css.indexOf('\n.holo {'))
  })

  it('uses the scrollable variant on the profile trainer card, which has no tilt handlers', () => {
    expect(trainerCard).toContain('holo holo--scrollable')
    expect(trainerCard).not.toMatch(/useTilt|onPointer|onTouch/)
  })
})
