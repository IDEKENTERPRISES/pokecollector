// Where the camera screen's guide frame sits inside the captured video frame.
//
// The live preview shows the video with object-fit: cover, so part of the frame is
// cropped away on screen, and the guide frame (a 63:88 card shape) is centred on the
// screen. This maps the guide rectangle back to the full captured frame and returns it
// as thousandths of the frame's width and height, with a small margin so a card that is
// a little off-centre still sits inside.

export const GUIDE_MARGIN = 0.04

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// containerRect / guideRect: { left, top, width, height } in CSS px (the video element
// fills the container). videoWidth / videoHeight: the captured frame in px.
export function guideBoxInFrame(containerRect, guideRect, videoWidth, videoHeight, margin = GUIDE_MARGIN) {
  if (!containerRect?.width || !containerRect?.height || !guideRect?.width || !videoWidth || !videoHeight) return null
  const scale = Math.max(containerRect.width / videoWidth, containerRect.height / videoHeight)
  const offsetX = (containerRect.width - videoWidth * scale) / 2
  const offsetY = (containerRect.height - videoHeight * scale) / 2
  const left = (guideRect.left - containerRect.left - offsetX) / scale
  const top = (guideRect.top - containerRect.top - offsetY) / scale
  const width = guideRect.width / scale
  const height = guideRect.height / scale

  const padX = width * margin
  const padY = height * margin
  const x0 = clamp((left - padX) / videoWidth, 0, 1)
  const y0 = clamp((top - padY) / videoHeight, 0, 1)
  const x1 = clamp((left + width + padX) / videoWidth, 0, 1)
  const y1 = clamp((top + height + padY) / videoHeight, 0, 1)
  if (x1 - x0 < 0.1 || y1 - y0 < 0.1) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// The box travels in the file name ("scan-123-g118_142_764_820.jpg"), which survives the
// offline upload queue and re-encoding; the server reads it back when the photo arrives.
export function guideFileName(baseName, box) {
  if (!box) return baseName
  const permille = value => String(Math.round(value * 1000))
  const encoded = `g${permille(box.x)}_${permille(box.y)}_${permille(box.w)}_${permille(box.h)}`
  const dot = baseName.lastIndexOf('.')
  return dot > 0 ? `${baseName.slice(0, dot)}-${encoded}${baseName.slice(dot)}` : `${baseName}-${encoded}`
}
