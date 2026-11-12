"""Picture matcher prototype (Scanner Phase 1): find the card in a photo, embed it, search the
catalogue pictures, read the printed number, and decide. See docs/CARD_MATCH.md.

Nothing here changes how scans are recognised today. Importing this package is cheap; the heavy
libraries (OpenCV, ONNX Runtime, RapidOCR) are imported by the modules that need them, on first use.
"""

MATCHER_VERSION = "11"
