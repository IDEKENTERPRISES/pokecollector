/**
 * Splits the "Searching for {to}. "{from}" was not found." notice into text and emphasised parts,
 * so the corrected name can be bold without building HTML from the server's strings.
 * Returns [] when the search was not corrected.
 */
export function correctionNoticeParts(template, corrected) {
  if (!template || !corrected?.from || !corrected?.to) return []
  const filled = template.replace('{from}', corrected.from)
  const [before, after = ''] = filled.split('{to}')
  const parts = []
  if (before) parts.push({ text: before, strong: false })
  parts.push({ text: corrected.to, strong: true })
  if (after) parts.push({ text: after, strong: false })
  return parts
}
