// Small Python-compatible helpers the ported matcher needs (the answers must match the server's, so these
// follow Python's rules, not JavaScript's, wherever the two differ).

/** Python's str.casefold for the characters a card name can hold (JavaScript's toLowerCase misses a few). */
export function casefold(text) {
  return String(text)
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ')
    .replace(/ſ/g, 's')
}

/** api.text_search.strip_diacritics: NFKD, combining marks gone, case folded. */
export function stripDiacritics(value) {
  if (value === null || value === undefined) return ''
  const decomposed = String(value).normalize('NFKD').replace(/\p{M}/gu, '')
  return casefold(decomposed)
}

/** Python str(value) for the values that reach the matcher (strings, numbers, null). */
export function pyStr(value) {
  if (value === null || value === undefined) return 'None'
  return String(value)
}

/** `str(value or "")`: null, undefined, '' and 0 all become ''. */
export function strOrEmpty(value) {
  return value ? String(value) : ''
}

/** Python's round(x, digits) for a float: half-to-even on the exact binary value. */
export function pyRound(value, digits = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return number
  const sign = number < 0 ? -1 : 1
  const magnitude = Math.abs(number)
  const factor = 10 ** digits
  const rest = magnitude.toFixed(100).split('.')[1].slice(digits)
  let result
  if (/^50*$/.test(rest)) { // exactly halfway: the even neighbour (toFixed would take the larger)
    const whole = Math.floor(magnitude * factor)
    result = (whole % 2 === 0 ? whole : whole + 1) / factor
  } else {
    result = Number(magnitude.toFixed(digits))
  }
  const signed = sign * result
  return Object.is(signed, -0) ? 0 : signed
}

/** Python's str.split() with no argument: runs of whitespace separate, ends are stripped. */
export function splitWords(text) {
  const trimmed = String(text).trim()
  return trimmed ? trimmed.split(/\s+/) : []
}

/** Python's str.zfill. */
export function zfill(text, width) {
  const value = String(text)
  return value.length >= width ? value : '0'.repeat(width - value.length) + value
}

/** The characters of a string as code points (Python indexes strings that way). */
export function chars(text) {
  return Array.from(String(text))
}

/** Python's `a < b` for equal-length tuples of numbers. */
export function compareTuples(left, right) {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return left.length - right.length
}
