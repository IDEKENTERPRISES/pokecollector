// Matcher only (no AI): the picture matcher was not sure, and the best guess is shown anyway. The scan result carries
// `recognized._picture.forced_pick` (see docs/CARD_MATCH.md, "Matcher only"). Nothing is added until the trainer confirms.

/** True for an unreviewed scan whose proposed card is a forced (unsure) pick. */
export function isForcedPick(item) {
  return item?.status === 'done' && !item?.resolved && item?.recognized?._picture?.forced_pick === true
}

/** The same test for a direct `/recognize` result (the single-photo scanner), which has no status or resolved flag. */
export function isForcedResult(result) {
  return result?.recognized?._picture?.forced_pick === true
}

/** True when the matcher found no candidate at all, so only the search can help. */
export function isNoCandidate(item) {
  return item?.status === 'done' && !item?.resolved && item?.recognized?._picture?.path === 'no_candidate'
}

/** The short "Check this card" badge. */
export function CheckThisCardBadge({ t }) {
  return (
    <span
      data-testid="scan-check-this-card"
      className="inline-flex items-center rounded-full bg-orange-500/15 px-2 py-0.5 text-caption-1 font-semibold text-orange-500"
    >
      {t('scanner.checkThisCard')}
    </span>
  )
}

/** The one-line explanation that goes with the badge. */
export function ForcedPickHint({ t }) {
  return (
    <p role="status" data-testid="scan-forced-hint" className="rounded-xl bg-fill-tertiary px-3 py-2 text-subheadline text-text-secondary">
      {t('scanner.checkThisCardHint')}
    </p>
  )
}

/** True when the finder's outline was rejected as implausible (too big or touching the photo's edges): a framing tip applies. */
export function hasRejectedOutline(recognized) {
  return Boolean(recognized?._picture?.outline_rejected)
}

/** One short framing tip. Never blocks anything. */
export function FramingTip({ t }) {
  return (
    <p role="note" data-testid="scan-framing-tip" className="rounded-xl bg-fill-tertiary px-3 py-2 text-subheadline text-text-secondary">
      {t('scanner.framingTip')}
    </p>
  )
}
