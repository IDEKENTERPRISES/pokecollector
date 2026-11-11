"""Matcher version 6, second round: scan-time groups, the undecided table, a set code glued to the number, the
number counted once, and Ollama counted only where it ran."""
import unittest

try:
    import numpy as np

    from services.card_match import benchmark, ocr, pipeline, variants

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def result(batch, rank, decided=False, right=False, reason=None):
    return {"batch": batch, "rank": rank, "decided": decided, "decided_right": right, "fallback": None, "unsure_reason": reason}


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class ScanTimeGroupTests(unittest.TestCase):
    def test_the_groups_have_n_top1_top20_decided_and_right(self):
        results = [result("tuning", 1, True, True), result("tuning", 3), result("tuning", None),
                   result("new", 1, True, True), result("new", 1, True, False)]
        groups = benchmark.batch_groups(results)
        self.assertEqual(groups["tuning"]["n"], 3)
        self.assertEqual((groups["tuning"]["top1"], groups["tuning"]["top20"], groups["tuning"]["decided"]), (33.3, 66.7, 33.3))
        self.assertEqual(groups["tuning"]["decided_right"], 100.0)
        self.assertEqual((groups["new"]["n"], groups["new"]["decided_right"], groups["new"]["decided_wrong"]), (2, 50.0, 1))

    def test_a_group_with_no_scans_is_none_so_the_lab_can_say_so(self):
        self.assertIsNone(benchmark.batch_groups([result("tuning", 1)])["new"])
        self.assertIsNone(benchmark.batch_groups([])["tuning"])

    def test_scans_are_split_by_the_time_they_were_made_not_by_photo_size(self):
        self.assertEqual(benchmark.scan_batch({"created_at": "2026-11-05T01:59:59+00:00"}), "tuning")
        self.assertEqual(benchmark.scan_batch({"created_at": "2026-11-05T02:00:00+00:00"}), "new")
        self.assertEqual(benchmark.scan_batch({"created_at": "2026-11-05T02:00:00Z"}), "new")
        self.assertEqual(benchmark.scan_batch({"created_at": "2026-11-05T04:30:00+03:00"}), "tuning")  # 01:30 UTC
        self.assertEqual(benchmark.scan_batch({"created_at": "2026-11-05T06:00:00+03:00"}), "new")  # 03:00 UTC
        self.assertEqual(benchmark.scan_batch({}), "tuning")
        self.assertEqual(benchmark.scan_batch({"created_at": "not a time"}), "tuning")

    def test_right_first_picks_that_were_not_decided_are_counted_by_reason(self):
        results = [result("new", 1, True, True), result("new", 1, False, reason="rules_choice_not_close_in_picture"),
                   result("new", 1, False, reason="rules_choice_not_close_in_picture"), result("new", 2, False, reason="x"),
                   result("tuning", 1, False, reason="number_matches_several_printings")]
        counts = benchmark.undecided_first_right(results)
        self.assertEqual((counts["new"]["scans"], counts["new"]["first_right"], counts["new"]["undecided"]), (4, 3, 2))
        self.assertEqual(counts["new"]["reasons"], [{"reason": "rules_choice_not_close_in_picture", "n": 2}])
        self.assertEqual(counts["all"]["undecided"], 3)
        self.assertEqual(counts["tuning"]["reasons"], [{"reason": "number_matches_several_printings", "n": 1}])


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class GluedSetCodeTests(unittest.TestCase):
    def test_a_set_code_glued_to_the_number_is_looked_up_as_the_bare_number_with_the_code_kept(self):
        from services.card_match import lookup

        parsed = ocr.parse_text(["PBL039/084"])
        self.assertEqual((parsed.number_local, parsed.number_total), ("039", "084"))
        self.assertIn("PBL", parsed.tokens)
        pairs = lookup.number_pairs(["PBL039/084"], "PBL039", "084")
        self.assertEqual(pairs[0], ("39", "84"))  # the catalogue key of #039
        self.assertIn("PBL", lookup.set_code_tokens(["PBL039"], ["PBL039/084"]))

    def test_real_number_prefixes_are_left_alone(self):
        from services.card_match import lookup

        for text, number, total in (("TG06/TG30", "TG06", "TG30"), ("GG01/GG70", "GG01", "GG70"), ("SV28/SV94", "SV28", "SV94")):
            parsed = ocr.parse_text([text])
            self.assertEqual((parsed.number_local, parsed.number_total), (number, total))
        self.assertEqual(lookup.number_pairs(["TG06/TG30"], "TG06", "TG30"), [("TG6", "30")])
        self.assertEqual(lookup.number_pairs(["GG01/GG70"]), [("GG1", "70")])
        self.assertEqual(lookup.number_pairs(["SV28/SV94"]), [("SV28", "94")])
        self.assertEqual(lookup.number_pairs(["SWSH020"], "SWSH020", None), [("SWSH20", None)])
        self.assertEqual(ocr.parse_text(["SWSH020"]).number_local, "SWSH020")

    def test_the_glued_number_reaches_the_card_in_the_number_lane(self):
        from services.card_match import lookup

        rows = [lookup.LookupRow("pbl-39_en", "Dhelmise", "039", "84", set_id="pbl"), lookup.LookupRow("pal-39_en", "Other", "039", "193", set_id="pal")]
        index = lookup.LookupIndex(rows, set_codes={"PBL": {"pbl"}})
        pairs = lookup.number_pairs(["PBL039/084"], "PBL039", "084")
        hits, used = index.find_numbers(pairs, lookup.set_code_tokens(["PBL039"]))
        self.assertEqual(hits["pbl-39_en"].level, "number_total_set")
        self.assertEqual(used, ["PBL"])


class _Evidence:
    """Just what ``merge_candidates`` asks of the lookup's evidence."""

    def __init__(self, bonuses, adds=()):
        self.bonuses, self.adds = bonuses, list(adds)

    def empty(self):
        return False

    def add_ids(self):
        return self.adds

    def number_bonus(self, card_id):
        return self.bonuses.get(card_id, 0.0)

    def bonus(self, card_id, *, number=True):
        return self.number_bonus(card_id) if number else 0.0


class _Names:
    """A name index that read no name but knows which card carries the read number and total."""

    def __init__(self, number_ok):
        self.number_ok = set(number_ok)

    def search(self, *_a):
        return []

    def name_score_of(self, *_a):
        return 0.0

    def agreement(self, card_id, _score, _number, _total):
        return type("A", (), {"number_ok": card_id in self.number_ok, "total_ok": card_id in self.number_ok})()


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class NumberOnceTests(unittest.TestCase):
    def merge(self, hits, wrong, level_bonus, once, adds=()):
        row_of = {card_id: row for row, card_id in enumerate([c for c, _s in hits] + list(adds))}
        scores = np.zeros(len(row_of), dtype=np.float32)
        for card_id, score in hits:
            scores[row_of[card_id]] = score
        ordered, _added = pipeline.merge_candidates(
            hits, scores, row_of, _Names([wrong]), "Mon", "x", "y", evidence=_Evidence({wrong: level_bonus}, adds), number_once=once)
        return [card_id for card_id, _s in ordered]

    def test_the_option_is_a_comparison_row_after_the_set_it_changes(self):
        label = "names+number+text+art+tta+fastread+numberonce+corners+wholepic"  # version 9: asked on top of the measured best set
        self.assertTrue(variants.parse(label).numberonce)
        self.assertEqual(variants.parse(label).label, label)
        self.assertIn(label, variants.COMPARE_LABELS)
        self.assertFalse(variants.parse(variants.DEFAULT_LABEL).numberonce)

    def test_kommo_o_143_beats_comfey_077_once_the_read_number_is_counted_once(self):
        # picture 0.634 against 0.4243; the read number 077/128 is Comfey's (number + total level, 0.14)
        hits = [("kommo-o", 0.634), ("comfey", 0.4243)]
        self.assertEqual(self.merge(hits, "comfey", 0.14, once=False)[0], "comfey")  # twice: 0.4243 + 0.16 + 0.14 = 0.7243
        self.assertEqual(self.merge(hits, "comfey", 0.14, once=True)[0], "kommo-o")  # once: 0.4243 + 0.16 = 0.5843 < 0.634

    def test_dhelmise_039_still_loses_to_electrike_023_with_one_count_and_that_is_reported_not_special_cased(self):
        # picture 0.6547 against 0.5287; 0.5287 + 0.16 = 0.6887 > 0.6547 even when counted once
        hits = [("dhelmise", 0.6547), ("electrike", 0.5287)]
        self.assertEqual(self.merge(hits, "electrike", 0.14, once=False)[0], "electrike")
        self.assertEqual(self.merge(hits, "electrike", 0.14, once=True)[0], "electrike")

    def test_a_card_only_the_lookup_found_still_joins_the_list_with_one_count(self):
        # Lapras: "30C | 017/128" parses wrongly; the lookup brings the card in although the picture search missed it
        hits = [(f"p{n}", 0.7 - n * 0.01) for n in range(6)]
        for once in (False, True):
            self.assertIn("lapras", self.merge(hits, "lapras", 0.20, once=once, adds=["lapras"]))

    def test_the_winner_rule_counts_a_top_1_gain_without_a_loss_above_half_a_point(self):
        def r(label, top1, top20, decided):
            return {"label": label, "status": "ok", "top1": top1, "top20": top20, "decided": decided, "decided_wrong": 0, "p95_ms": 1000}

        base = r("names+number+text+art+tta", 70.0, 97.1, 71.2)
        self.assertEqual(benchmark.pick_winner([base, r("names+number+text+art+tta+numberonce", 71.0, 97.1, 71.2)])["label"],
                         "names+number+text+art+tta+numberonce")
        self.assertEqual(benchmark.pick_winner([base, r("x", 70.3, 97.1, 71.2)])["label"], base["label"])  # under half a point
        self.assertEqual(benchmark.pick_winner([base, r("x", 75.0, 96.0, 71.2)])["label"], base["label"])  # loses on top 20
        self.assertEqual(benchmark.pick_winner([base, r("x", 75.0, 97.1, 70.0)])["label"], base["label"])  # and on decided


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class OllamaCountTests(unittest.TestCase):
    def trace(self, mechanism, selected, path=None):
        data = {"decision": {"mechanism": mechanism, "selected": selected}}
        if path:
            data["picture_match"] = {"path": path}
        return data

    def test_a_picture_first_decision_is_not_ollamas(self):
        from services import scan_trace

        decided = self.trace("picture_match", "tcg-1", "decided")
        self.assertFalse(scan_trace.ollama_ran(decided))
        self.assertIsNone(scan_trace.ollama_selected(decided))
        self.assertIsNone(scan_trace.ollama_selected(self.trace("picture_match", "tcg-1")))  # the mechanism says it too
        self.assertFalse(scan_trace.ollama_ran(self.trace(None, None, "unsure_inbox")))
        ran = self.trace("ollama_vision", "tcg-2", "unsure_ollama")
        self.assertTrue(scan_trace.ollama_ran(ran))
        self.assertEqual(scan_trace.ollama_selected(ran), "tcg-2")
        old = self.trace("ollama_vision", "tcg-3")  # a scan made without picture-first
        self.assertTrue(scan_trace.ollama_ran(old))
        self.assertEqual(scan_trace.ollama_selected(old), "tcg-3")

    def test_agreement_does_not_compare_the_matcher_with_its_own_decision(self):
        from services import scan_trace

        data = {**self.trace("picture_match", "tcg-1", "decided"), "shadow": {"status": "ok", "decision": {"tcg_card_id": "tcg-1"}, "matches": []}}
        scan_trace.apply_shadow_agreement(data)
        self.assertEqual(data["shadow"]["agreement"], "matcher_only")
        self.assertIsNone(data["shadow"]["agrees"])

    def test_the_comparison_counts_ollama_only_where_it_ran(self):
        from services.card_match import shadow

        pairs = [("a", "a", None, False), ("b", "b", None, False), ("c", None, "c", True), ("d", "d", "x", True)]
        scores = shadow.score_pairs(pairs)
        self.assertEqual(scores["n"], 4)
        self.assertEqual(scores["current"]["n"], 2)
        self.assertEqual((scores["current"]["decided"], scores["current"]["decided_pct"]), (2, 100.0))
        self.assertEqual((scores["both_decided"], scores["differ"]), (1, 1))
        self.assertEqual(shadow.score_pairs([("a", "a", "a")])["current"]["n"], 1)  # three-item pairs still work


if __name__ == "__main__":
    unittest.main()
