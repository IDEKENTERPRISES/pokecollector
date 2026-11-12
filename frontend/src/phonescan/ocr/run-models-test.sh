#!/bin/sh
# Run the optional real-model test of the text reader (onnxruntime-web in Node, WebAssembly) against the Python reader's answers.
#
#   frontend/src/phonescan/ocr/run-models-test.sh <folder with det.onnx + rec.onnx>
#
# The folder is the phone bundle's ocr/ folder, or the models folder of the rapidocr-onnxruntime wheel (ch_PP-OCRv4_*_infer.onnx).
# Without a folder the test is skipped (that is what CI does: it cannot download the models).
set -e
if [ -z "$1" ]; then echo "usage: $0 <models folder>" >&2; exit 1; fi
cd "$(dirname "$0")/../../.."
PHONE_OCR_MODELS="$1" npx vitest run src/phonescan/ocr/models.test.js
