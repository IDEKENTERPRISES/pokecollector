import { describe, expect, it, vi } from 'vitest'
import { attachCollectionPhoto } from './collectionPhoto'

describe('attachCollectionPhoto', () => {
  it('saves the photo even when the card has catalogue artwork', async () => {
    const photo = new Blob(['scan'], { type: 'image/jpeg' })
    const uploadPhoto = vi.fn().mockResolvedValue({})
    const saved = await attachCollectionPhoto({
      created: { id: 11, has_scan_photo: false, card: { id: 'c', images_small: 'art.webp' } },
      photo,
      uploadPhoto,
    })
    expect(saved).toBe(true)
    expect(uploadPhoto).toHaveBeenCalledWith(11, photo)
  })

  it('does nothing when the user removed the photo', async () => {
    const uploadPhoto = vi.fn()
    const saved = await attachCollectionPhoto({ created: { id: 12 }, photo: null, uploadPhoto })
    expect(saved).toBe(false)
    expect(uploadPhoto).not.toHaveBeenCalled()
  })

  it('does not replace an existing photo with an automatic scan', async () => {
    const uploadPhoto = vi.fn()
    const saved = await attachCollectionPhoto({
      created: { id: 13, has_scan_photo: true },
      photo: new Blob(['x']),
      uploadPhoto,
    })
    expect(saved).toBe(false)
    expect(uploadPhoto).not.toHaveBeenCalled()
  })

  it('replaces an existing photo when the user chose one', async () => {
    const photo = new Blob(['mine'])
    const uploadPhoto = vi.fn().mockResolvedValue({})
    const saved = await attachCollectionPhoto({
      created: { id: 14, has_scan_photo: true },
      photo,
      overwrite: true,
      uploadPhoto,
    })
    expect(saved).toBe(true)
    expect(uploadPhoto).toHaveBeenCalledWith(14, photo)
  })

  it('swallows upload failures after the item was added', async () => {
    const saved = await attachCollectionPhoto({
      created: { id: 15 },
      photo: new Blob(['x']),
      uploadPhoto: vi.fn().mockRejectedValue(new Error('storage unavailable')),
    })
    expect(saved).toBe(false)
  })
})
