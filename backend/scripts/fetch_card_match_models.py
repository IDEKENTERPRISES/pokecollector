#!/usr/bin/env python3
"""Download the pinned card-match model files and check their sha256 (run at Docker build time).

    python fetch_card_match_models.py [target_dir]     # default /app/models

Reads the list from services/card_match/model_specs.py (next to this file in the Docker build stage,
or in ../services/card_match in the repository). Nothing is downloaded when the app runs.
"""
import hashlib
import importlib.util
import sys
import urllib.request
from pathlib import Path

here = Path(__file__).resolve().parent
spec_path = next(path for path in (here / "model_specs.py", here.parent / "services" / "card_match" / "model_specs.py") if path.is_file())
module_spec = importlib.util.spec_from_file_location("model_specs", spec_path)
specs = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(specs)


def main() -> int:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "/app/models")
    target.mkdir(parents=True, exist_ok=True)
    for name, spec in specs.MODEL_SPECS.items():
        path = target / spec["filename"]
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == spec["sha256"]:
            print(f"{name}: already present")
            continue
        print(f"{name}: downloading {spec['url']}")
        digest = hashlib.sha256()
        with urllib.request.urlopen(spec["url"], timeout=120) as response, path.open("wb") as handle:
            for chunk in iter(lambda: response.read(1 << 20), b""):
                digest.update(chunk)
                handle.write(chunk)
        if digest.hexdigest() != spec["sha256"]:
            path.unlink(missing_ok=True)
            print(f"{name}: checksum mismatch (got {digest.hexdigest()})", file=sys.stderr)
            return 1
        print(f"{name}: ok ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
