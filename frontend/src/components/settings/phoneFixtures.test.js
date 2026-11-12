import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The phone parity fixtures (backend/scripts/phone_parity_fixtures.py) live in one folder per matcher version; each file must say the version of its folder.
const root = join(process.cwd(), 'tests', 'fixtures', 'phone-matcher')

describe('phone matcher parity fixtures', () => {
  it('has a folder per matcher version whose files carry that version', () => {
    expect(existsSync(root)).toBe(true)
    const folders = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^v\d+$/.test(entry.name))
    expect(folders.length).toBeGreaterThan(0)
    for (const folder of folders) {
      for (const file of ['pure-functions.json', 'photos.json']) {
        const data = JSON.parse(readFileSync(join(root, folder.name, file), 'utf8'))
        expect(`v${data.matcher_version}`).toBe(folder.name)
      }
    }
  })
})
