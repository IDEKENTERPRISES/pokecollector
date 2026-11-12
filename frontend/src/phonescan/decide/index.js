// Step 3c of the phone scanner: the catalogue lookups and the decision rules of the picture matcher, ported to JavaScript.
// See docs/phone-scanner/decide.md.

export { buildDecideIndexes, buildDecideIndexesAsync, candidateFromRow, catalogueSignature, createLazyIndexes, loadCatalogueRows, INDEXES_VERSION } from './catalogue.js'
export { decideCard, scoresFromTopK } from './decideCard.js'
export { DEFAULT_THRESHOLDS, resolveThresholds, thresholdsFromManifest } from './thresholds.js'
export { constrain, patternDistance } from './constrained.js'
export {
  buildLookupIndex, cardTexts, normText, numberPairs, searchLookup, setCodeTokens, evidenceTrace,
} from './lookup.js'
export { baseKey, buildNameIndex, nameKey, scoreNames, searchNames } from './names.js'
export {
  correctNumber, decide, decideLanes, mergeCandidates, numberFromLookup, wholeNumberProblem,
} from './pipeline.js'
export { candidateRankKey, metadataDecision } from './rules.js'
