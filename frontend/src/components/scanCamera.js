// Whether the scan overlay opens the live camera or goes straight to the photo picker (design doc §5.3).

export const CAMERA_DENIED_KEY = 'pc.scan.cameraDenied'

export function liveCameraSupported() {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}

export function readCameraDenied() {
  try {
    return globalThis.sessionStorage?.getItem(CAMERA_DENIED_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberCameraDenied() {
  try {
    globalThis.sessionStorage?.setItem(CAMERA_DENIED_KEY, '1')
  } catch { /* storage can be blocked; the denial is then only remembered by the open overlay */ }
}

export function clearCameraDenied() {
  try {
    globalThis.sessionStorage?.removeItem(CAMERA_DENIED_KEY)
  } catch { /* nothing to clear */ }
}

/** A permission refusal, as opposed to a missing or busy camera. */
export function isCameraDenial(error) {
  return error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
}

/** 'camera' when the live viewfinder can open, 'fallback' when the review sheet shows the pickers. */
export function chooseCaptureMode({ supported = liveCameraSupported(), denied = readCameraDenied() } = {}) {
  return supported && !denied ? 'camera' : 'fallback'
}
