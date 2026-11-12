// The decision thresholds. The defaults are the server's constants (backend/services/card_match/pipeline.py,
// matcher version 11). At runtime the phone reads the real values from the bundle manifest
// (`manifest.thresholds`, written by phone.decision_settings from the server's own constants), so a server
// change reaches the phone without a code change: ``thresholdsFromManifest`` overlays them on these defaults.

export const DEFAULT_THRESHOLDS = Object.freeze({
  // in the manifest (phone.decision_settings)
  sim_min_with_rules: 0.55,
  rank_max_with_rules: 10,
  sim_min_picture_only: 0.80,
  lead_min_picture_only: 0.06,
  sim_min_picture_strong: 0.88,
  lead_min_picture_strong: 0.10,
  sim_min_name_picture: 0.80,
  lead_min_name_picture: 0.03,
  name_agrees: 0.95,
  rank_max_with_name: 40,
  picture_keep: 5,
  lookup_rank_max: 60,
  lookup_sim_set: 0.60,
  lookup_sim_total: 0.65,
  lookup_rank_max_total: 30,
  orient_margin: 0.10,
  top_k: 20,
  ocr_accept_confidence: 0.85,
  // constants of pipeline.py that the manifest does not carry (fixed in the code; a manifest value, if present, wins)
  name_weight: 0.25,
  number_weight: 0.12,
  total_weight: 0.04,
  text_agrees: 0.85,
  text_max_cards: 3,
  reprint_art_lead: 0.04,
  same_name_picture_margin: 0.10,
  whole_pick_rank_max: 2,
  whole_sim_margin: 0.10,
})

/** The defaults with the manifest's thresholds laid over them (unknown or non-numeric entries are ignored). */
export function thresholdsFromManifest(manifest) {
  const given = manifest?.thresholds ?? manifest ?? {}
  const out = { ...DEFAULT_THRESHOLDS }
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    if (typeof given[key] === 'number' && Number.isFinite(given[key])) out[key] = given[key]
  }
  return out
}

export const withDefaults = thresholds => (thresholds ? { ...DEFAULT_THRESHOLDS, ...thresholds } : DEFAULT_THRESHOLDS)

/** Accepts a ready thresholds object, a bundle manifest (it has ``thresholds``), or nothing (the defaults). */
export function resolveThresholds(value) {
  if (!value) return DEFAULT_THRESHOLDS
  return thresholdsFromManifest(value.thresholds ? value : { thresholds: value })
}
