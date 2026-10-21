// Fits a pixel sprite onto the splash's ground: a whole-number scale chosen from the visible
// pixels, and the offsets that stand those pixels on the grass. The static sprites after
// Black/White have wide transparent margins; the animated ones are already cropped.

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
export function fitSprite({ width, height, bounds, target }) {
  const box = bounds ?? { top: 0, left: 0, right: width, bottom: height }
  const longest = Math.max(box.right - box.left, box.bottom - box.top) || 1
  const scale = Math.min(4, Math.max(2, Math.round(target / longest)))
  return {
    width: width * scale,
    height: height * scale,
    // Pull the visible feet down onto the ground and centre the visible pixels.
    marginBottom: -(height - box.bottom) * scale,
    left: Math.round(((width - box.right - box.left) / 2) * scale),
  }
}

/** Reads the visible bounds of a loaded, same-origin image; null if the canvas refuses. */
export function measureBounds(image) {
  try {
    const { naturalWidth: width, naturalHeight: height } = image
    if (!width || !height || width > 512 || height > 512) return null
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
