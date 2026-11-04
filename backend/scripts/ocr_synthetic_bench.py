"""OCR on synthetic cards at the two stored resolutions: ``py -3 scripts/ocr_synthetic_bench.py [count] [margin]``.
Prints name / number / total / set-code read rates and seconds for the fixed strips and the detect ladder."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.card_match import ocr, ocr_synthetic  # noqa: E402

if __name__ == "__main__":
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 24
    margin = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    reader = ocr.OcrReader(threads=4)
    for mode in ("fixed", "detect"):
        reader.mode = mode
        print(mode, json.dumps(ocr_synthetic.measure(reader, count, margin=margin)))
