// The phone matcher (step 3d of the phone scanner): finder, picture search, text reader and decision joined, run in a Web Worker.
// See docs/phone-scanner/integration.md.
export { createPhoneMatcher, pictureOnlyAnswer, DEFAULT_BUDGETS, KEPT_OPTIONS, STAGES, MATCHER_VERSION } from './matcher'
export { checkManifest } from './guard'
export { buildPictureIndex, pictureIndexFromBuffers, searchLayout, combineScores } from './pictureIndex'
export { createMatcherHost, MODES } from './host'
export { createMatcherClient, loopbackWorker, defaultWorker, MatcherError } from './client'
