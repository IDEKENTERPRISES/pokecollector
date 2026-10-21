// Fits a sprite onto the splash's ground: a scale chosen from the visible pixels, and the offsets
// that stand those pixels on the ground. Showdown's animated sprites and the official artwork
// scale smoothly; pixel sprites by whole numbers, so their pixels stay square and sharp.

/** The box of non-transparent pixels in RGBA data, or null when every pixel is clear. */
export function contentBounds(data, width, height) {
  let top = height
  let left = width
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  return bottom < 0 ? null : { top, left, right: right + 1, bottom: bottom + 1 }
}

/** Size and offsets (CSS px) for an image of `width` x `height` with visible `bounds`. */
export function fitSprite({ width, height, bounds, target, smooth = false, maxSmooth = 2 }) {
  const box = bounds ?? { top: 0, left: 0, right: width, bottom: height }
  const longest = Math.max(box.right - box.left, box.bottom - box.top) || 1
  const scale = smooth
    ? Math.min(maxSmooth, Math.max(0.25, target / longest))
    : Math.min(4, Math.max(2, Math.round(target / longest)))
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    // Pull the visible feet down onto the ground and centre the visible pixels.
    marginBottom: Math.round((box.bottom - height) * scale) || 0,
    left: Math.round(((width - box.right - box.left) / 2) * scale) || 0,
  }
}

/** Reads the visible bounds of a loaded, same-origin image; null if the canvas refuses. */
export function measureBounds(image) {
  try {
    const { naturalWidth: width, naturalHeight: height } = image
    if (!width || !height || width > 1024 || height > 1024) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0)
    return contentBounds(context.getImageData(0, 0, width, height).data, width, height)
  } catch {
    return null
  }
}
