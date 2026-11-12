// The phone's text reader (step 3b of the phone scanner): a JavaScript port of the server's ocr.py reading half and names.py
// reading half, matcher version 11. See docs/phone-scanner/ocr.md.
export { readCard, readName, readWhole, secondRead, mergeReads, FAST_BUDGET_SECONDS, NUMBER_LADDER_FAST, NAME_LADDER_FAST, SOURCE_FINDER_CARD, SOURCE_WHOLE_PICTURE } from './reader'
export { characterTable, ctcDecodeBatch } from './recognise'
export { detectBoxes, detectionInput } from './detect'
export { parseText, pickNumberLines, completeness, isComplete, betterRead, isNameLike, cleanNameLine, parseNameLines, findHp } from './parse'
