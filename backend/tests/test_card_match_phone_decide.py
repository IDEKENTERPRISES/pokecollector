"""Step 3c: the decide parity script runs from generated data only, reaches every mechanism and refusal reason of ``pipeline.py``
that can be reached, and the committed fixtures still hold the Python matcher's answers (a changed answer means the JavaScript port in
frontend/src/phonescan/decide must follow: regenerate the fixtures on purpose, not by accident)."""
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import numpy  # noqa: F401

    from services.card_match import MATCHER_VERSION

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

MECHANISMS = {"number_unique", "number_metadata", "picture_lead_strong", "number_and_picture", "reprint_art_lead", "picture_lead", "name_and_picture", "text_and_picture"}
REASONS = {"no_picture_matches", "card_not_found_no_number_read", "number_lookup_conflicts_with_name", "total_contradicts_read", "closer_printing_of_same_name",
           "rules_choice_not_close_in_picture", "number_not_among_picture_matches", "number_matches_several_printings", "no_number_and_picture_not_clear",
           "whole_number_total_not_confirmed", "whole_number_picture_too_weak", "whole_number_name_conflict", "whole_number_low_confidence"}


@skip
class DecideParityScriptTests(unittest.TestCase):
    def _run(self, folder: Path) -> dict:
        from scripts import phone_parity_decide

        self.assertEqual(phone_parity_decide.main([str(folder)]), 0)
        return json.loads((folder / "cases.json").read_text(encoding="utf-8"))

    def test_the_script_reaches_every_reachable_mechanism_and_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = self._run(Path(tmp))
        cases = data["cases"]
        self.assertEqual(data["matcher_version"], MATCHER_VERSION)
        mechanisms = {c["python"]["decision"]["mechanism"] for c in cases if c["python"]["decision"]}
        reasons = {c["python"]["reason"] for c in cases if not c["python"]["decision"]}
        # artist_hp needs card_info.artist, which the text reader never fills: unreachable from the matcher.
        self.assertEqual(MECHANISMS - mechanisms, set())
        self.assertEqual(REASONS - reasons, set())

    def test_the_committed_decide_fixtures_are_what_the_script_writes(self):
        folder = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "phone-matcher" / f"v{MATCHER_VERSION}" / "decide"
        if not folder.is_dir():
            self.skipTest("the frontend fixtures are not in this checkout (the backend CI image holds only backend/); a frontend unit test checks the port against them")
        with tempfile.TemporaryDirectory() as tmp:
            fresh = self._run(Path(tmp))
            for name in ("catalogue.json", "strings.json"):
                self.assertEqual(json.loads((folder / name).read_text(encoding="utf-8")), json.loads((Path(tmp) / name).read_text(encoding="utf-8")), name)
        committed = json.loads((folder / "cases.json").read_text(encoding="utf-8"))
        self.assertEqual(len(committed["cases"]), len(fresh["cases"]))
        for old, new in zip(committed["cases"], fresh["cases"]):
            self.assertEqual(old["scores"], new["scores"], old["label"])
            self.assertEqual(old["python"], new["python"], old["label"])


if __name__ == "__main__":
    unittest.main()
