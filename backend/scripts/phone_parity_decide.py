#!/usr/bin/env python3
"""Write the parity fixtures for the phone's lookup and decision port (step 3c, matcher version 11).

    py backend/scripts/phone_parity_decide.py [out_dir] [--cases N] [--seed S]

Default out_dir: frontend/tests/fixtures/phone-matcher/v<matcher version>/decide/. Writes

  catalogue.json  a small hand-written catalogue of English cards joined with their sets (the rows the phone's catalogue adapter
                  produces): reprints with the same number in different sets, same-name printings, gallery numbers (TG, GG, SV),
                  totals with prefixes, digital-only / foreign / picture-less cards that must be left out, and a few card texts;
  cases.json      many ``decide`` inputs (picture score vectors with chosen similarities and leads, reads with and without numbers,
                  numbers read from the whole picture only, wrong totals, name conflicts, option sets) and the Python matcher's full
                  outputs for each: the decision, the merged candidate list with every lane fact, the number corrections.

Nothing here comes from a trainer's scan or a real catalogue picture: every row, line and score is written by hand or drawn from a
seeded random generator. The Python side runs the real ``names``, ``lookup`` and ``pipeline`` modules; only the few lines of
``CardMatcher.match`` that glue them together (from the picture scores to the decision) are repeated here, in ``run_tail``, in the
same order. Printing the coverage at the end is part of the job: every mechanism and refusal reason of ``pipeline.py`` is listed with
how many cases reach it.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import types
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

if os.name == "nt":  # api.recognize imports fcntl through the auth service; the servers and CI are Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

import numpy as np  # noqa: E402

TOP_K = 20

# ── the hand-written catalogue ──────────────────────────────────────────────

# (tcg set id, name, abbreviation, printed total)
SETS = [
    ("sv1", "Scarlet & Violet", "SVI", 198), ("sv2", "Paldea Evolved", "PAL", 193), ("sv3", "Obsidian Flames", "OBF", 197),
    ("sv6", "Twilight Masquerade", "TWM", 167), ("pbl", "Perilous Bloom", "PBL", 84), ("blk", "Black Bolt", "BLK", 86),
    ("bw1", "Black & White", "BLW", 114), ("swsh12tg", "Silver Tempest Trainer Gallery", "SIT", 30),
    ("swsh12pt5gg", "Crown Zenith Galarian Gallery", "CRZ", 70), ("sv4pt5", "Paldean Fates", "PAF", 94), ("svp", "SVP Black Star Promos", "SVP", 0),
    ("sm9", "Team Up", "TEU", 181), ("base1", "Base Set", "BS", 102),
]
SHARED_EFFECT = "You may play only 1 Supporter card during your turn."
GENOME = {"name": "Genome Hacking", "effect": "Choose 1 of your opponent's Active Pokemon's attacks and use it as this attack."}
THUNDER = {"name": "Thunder Jolt", "effect": "Flip a coin. If tails, this Pokemon does 30 damage to itself."}
SURF = {"name": "Surf Crash", "effect": "This attack does 20 damage to each of your opponent's Benched Pokemon."}

# (set, number, name, hp, artist, regulation mark, suffix, supertype, card effect, attacks, abilities)
CARDS = [
    ("sv1", "25", "Pikachu", "60", "Mitsuhiro Arita", "G", None, "Pokémon", None, [THUNDER], None),
    ("sv2", "25", "Pikachu", "60", "Atsuko Nishida", "G", None, "Pokémon", None, [THUNDER], None),
    ("sv3", "25", "Pikachu", "70", "Mitsuhiro Arita", "G", None, "Pokémon", None, [THUNDER], None),
    ("sv6", "17", "Lapras", "110", "Kouki Saitou", "H", None, "Pokémon", None, [SURF], None),
    ("sv1", "17", "Lapras", "110", "Kouki Saitou", "G", None, "Pokémon", None, [SURF], None),
    ("sv2", "17", "Lapras", "100", "Kouki Saitou", "G", None, "Pokémon", None, [SURF], None),
    ("sv1", "2", "Charizard ex", "330", "5ban Graphics", "G", "ex", "Pokémon", None, [{"name": "Burning Darkness", "effect": "This attack does 30 more damage for each Prize card your opponent has taken."}], None),
    ("sv3", "125", "Charizard ex", "330", "PLANETA Mochizuki", "G", "ex", "Pokémon", None, [{"name": "Burning Darkness", "effect": "This attack does 30 more damage for each Prize card your opponent has taken."}], None),
    ("sv1", "3", "Charizard", "170", "Ryuta Fuse", "G", None, "Pokémon", None, None, None),
    ("sv2", "53", "Mew ex", "180", "Yuka Morii", "G", "ex", "Pokémon", None, [GENOME], [{"name": "Restart", "effect": "Once during your turn, you may draw cards until you have 3 cards in your hand."}]),
    ("sv1", "189", "Professor's Research", None, "Ayaka Yoshida", "G", None, "Trainer", "Discard your hand and draw 7 cards. " + SHARED_EFFECT, None, None),
    ("sv2", "190", "Boss's Orders (Giovanni)", None, "Naoki Saito", "G", None, "Trainer", "Switch in 1 of your opponent's Benched Pokemon to the Active Spot. " + SHARED_EFFECT, None, None),
    ("sv3", "191", "Boss's Orders", None, "Naoki Saito", "G", None, "Trainer", "Switch in 1 of your opponent's Benched Pokemon to the Active Spot. " + SHARED_EFFECT, None, None),
    ("sv2", "192", "Erika's Invitation", None, "AKIRA EGAWA", "G", None, "Trainer", "Search your deck for a Basic Pokemon and put it onto your Bench. " + SHARED_EFFECT, None, None),
    ("sv1", "193", "Iono", None, "Ryuta Fuse", "G", None, "Trainer", "Each player shuffles their hand and puts it on the bottom of their deck. " + SHARED_EFFECT, None, None),
    ("sv6", "158", "Pokémon Tool Belt", None, None, "H", None, "Trainer", "The Pokemon this card is attached to takes 10 less damage from attacks.", None, None),
    ("sv2", "100", "Flabébé", "50", "Sanosuke Sakuma", "G", None, "Pokémon", None, None, None),
    ("sv3", "101", "Ho-Oh", "120", "tetsuya koizumi", "G", None, "Pokémon", None, None, None),
    ("sv6", "102", "Ho Oh V", "210", "tetsuya koizumi", "H", "V", "Pokémon", None, None, None),
    ("blk", "13", "Darumaka", "70", "Narumi Sato", "I", None, "Pokémon", None, None, None),
    ("bw1", "23", "Darumaka", "70", "Mizue", None, None, "Pokémon", None, None, None),
    ("sm9", "143", "Kommo-o", "170", "Kagemaru Himeno", None, None, "Pokémon", None, None, None),
    ("sv2", "77", "Comfey", "70", "Eri Yamaki", "G", None, "Pokémon", None, None, None),
    ("pbl", "39", "Dhelmise", "110", "Hasuno", "H", None, "Pokémon", None, None, None),
    ("pbl", "23", "Electrike", "60", "Hasuno", "H", None, "Pokémon", None, None, None),
    ("swsh12tg", "TG06", "Charizard", "170", "Ryuta Fuse", "F", None, "Pokémon", None, None, None),
    ("swsh12tg", "TG16", "Pikachu", "70", "Ryuta Fuse", "F", None, "Pokémon", None, None, None),
    ("swsh12pt5gg", "GG01", "Pikachu", "60", "Ryuta Fuse", "F", None, "Pokémon", None, None, None),
    ("swsh12pt5gg", "GG06", "Mew", "70", "Ryuta Fuse", "F", None, "Pokémon", None, None, None),
    ("sv4pt5", "SV28", "Charizard ex", "330", "5ban Graphics", "G", "ex", "Pokémon", None, None, None),
    ("sv4pt5", "28", "Bidoof", "60", "Hasuno", "G", None, "Pokémon", None, None, None),
    ("svp", "SVP001", "Pikachu", "60", None, None, None, "Pokémon", None, None, None),
    ("svp", "SVP025", "Mew ex", "180", None, None, "ex", "Pokémon", None, None, None),
    ("sm9", "17", "Lapras GX", "190", "Ryuta Fuse", None, "GX", "Pokémon", None, None, None),
    ("base1", "4", "Charizard", "120", "Mitsuhiro Arita", None, None, "Pokémon", None, None, None),
    ("base1", "58", "Pikachu", "40", "Mitsuhiro Arita", None, None, "Pokémon", None, None, None),
    ("base1", "15", "Venusaur", "100", "Mitsuhiro Arita", None, None, "Pokémon", None, None, None),
    ("sv1", "100", "Gardevoir ex", "310", "Ryuta Fuse", "G", "ex", "Pokémon", None, None, None),
    ("sv2", "101", "Gardevoir V", "210", "Ryuta Fuse", "G", "V", "Pokémon", None, None, None),
    ("sv3", "102", "Gardevoir VSTAR", "280", "Ryuta Fuse", "G", "VSTAR", "Pokémon", None, None, None),
    ("sv6", "103", "Gardevoir", "90", "Ryuta Fuse", "H", None, "Pokémon", None, None, None),
    ("sv6", "104", "Gardevoir GX", "230", "Ryuta Fuse", "H", "GX", "Pokémon", None, None, None),
    ("sv1", "110", "Basic Fire Energy", None, None, "G", None, "Energy", None, None, None),
    ("sv2", "111", "Basic Fire Energy", None, None, "G", None, "Energy", None, None, None),
    ("sv3", "112", "Counter Catcher", None, None, "G", None, "Trainer", "You can use this card only if you have more Prize cards remaining than your opponent. Switch in 1 of your opponent's Benched Pokemon to the Active Spot.", None, None),
]
# Rows the server's index leaves out; the phone's adapter must drop them too. (set, number, name, extra fields)
EXCLUDED = [
    ("sv1", "26", "Raichu", {"is_digital": True}), ("sv1", "27", "Sandshrew", {"lang": "de"}), ("sv1", "28", "Sandslash", {"images_small": ""}),
    ("sv1", "29", "", {}),
]


def catalogue_rows() -> list[dict]:
    sets = {tcg: (name, abbreviation, total) for tcg, name, abbreviation, total in SETS}
    rows = []
    for set_id, number, name, hp, artist, regulation, suffix, supertype, effect, attacks, abilities in CARDS:
        rows.append(_row(set_id, number, name, sets, hp=hp, artist=artist, regulation_mark=regulation, suffix=suffix, supertype=supertype,
                         card_effect=effect, attacks=attacks, abilities=abilities))
    for set_id, number, name, extra in EXCLUDED:
        rows.append(_row(set_id, number, name, sets, **extra))
    return rows


def _row(set_id: str, number: str, name: str, sets: dict, **fields) -> dict:
    set_name, abbreviation, total = sets[set_id]
    row = {
        "id": f"{set_id}-{number.lstrip('0') or '0'}_en", "tcg_card_id": f"{set_id}-{number.lstrip('0') or '0'}", "name": name, "number": number, "set_id": set_id,
        "set_name": set_name, "set_abbreviation": abbreviation, "printed_total": total or None, "rarity": "Common", "hp": None, "artist": None,
        "regulation_mark": None, "suffix": None, "supertype": "Pokémon", "card_effect": None, "attacks": None, "abilities": None, "lang": "en",
        "is_digital": False, "images_small": f"https://img.example/{set_id}/{number}/small.webp",
    }
    row.update(fields)
    return row


def kept_rows(rows: list[dict]) -> list[dict]:
    """What the server's index holds: English, physical, with a catalogue picture and a name."""
    return [row for row in rows if row["lang"] == "en" and not row["is_digital"] and row["images_small"] and row["name"]]


# ── the Python side: the real modules ───────────────────────────────────────

class Env:
    def __init__(self, rows: list[dict]):
        from services.card_match import lookup, names

        self.rows = kept_rows(rows)
        self.ids = [row["id"] for row in self.rows] + ["ghost-1_en", "ghost-2_en"]  # two picture ids the catalogue lacks
        self.row_of = {card_id: row for row, card_id in enumerate(self.ids)}
        sets = {tcg: (name, abbreviation, total) for tcg, name, abbreviation, total in SETS}
        self.loaded = {}
        name_rows, lookup_rows = [], []
        for row in self.rows:
            total = sets[row["set_id"]][2] or None
            self.loaded[row["id"]] = {
                "id": row["tcg_card_id"], "tcg_card_id": row["tcg_card_id"], "name": row["name"], "number": row["number"], "hp": row["hp"],
                "artist": row["artist"], "regulation_mark": row["regulation_mark"], "card_type": (row["supertype"] or "").lower() or None,
                "set": row["set_name"], "set_abbreviation": row["set_abbreviation"], "printed_total": total, "_lang": "en",
                "images_small": row["images_small"], "images_large": None, "rarity": row["rarity"],
            }
            printed = str(total) if total else None
            name_rows.append(names.NameRow(card_id=row["id"], name=row["name"], number=row["number"], printed_total=printed))
            lookup_rows.append(lookup.LookupRow(
                card_id=row["id"], name=row["name"], number=row["number"], printed_total=printed, set_id=row["set_id"], suffix=row["suffix"],
                texts=lookup.card_texts(row["card_effect"], row["attacks"], row["abilities"])))
        codes: dict[str, set[str]] = {}
        for tcg, _name, abbreviation, _total in SETS:  # build_lookup_index: Set.abbreviation and Set.tcg_set_id
            for code in (abbreviation, tcg):
                if code:
                    codes.setdefault(str(code).upper(), set()).add(tcg)
        self.names = names.NameIndex(name_rows)
        self.lookup = lookup.LookupIndex(lookup_rows, codes)


def top_hits(scores: np.ndarray, ids: list[str], top_k: int):
    count = len(scores)
    k = min(top_k, count)
    part = np.argpartition(-scores, k - 1)[:k]
    top_rows = part[np.argsort(-scores[part])]
    return [(ids[row], float(scores[row])) for row in top_rows]


def run_tail(env: Env, case: dict) -> dict:
    """The part of ``CardMatcher.match`` from the picture scores to the decision (pipeline.py lines ~606-760), with the real modules."""
    from services.card_match import pipeline

    options = case["options"]
    scores = np.array(case["scores"], dtype=np.float64)
    art = np.array([np.nan if v is None else v for v in case["art"]], dtype=np.float64) if case["art"] is not None else None
    count = len(scores)
    top_k = options.get("topK", TOP_K)
    hits = top_hits(scores, env.ids, top_k)
    read = case["read"]
    names = env.names if options.get("useNames", True) else None
    use_number = options.get("useNumber", True)
    use_text = options.get("useText", True)
    ocr_info: dict = {}
    evidence = None
    name_read = None
    number = read["number"] if read else None
    total = read["total"] if read else None
    if read is not None:
        if names is not None and "name" in read:  # read_name ran
            name_read = types.SimpleNamespace(name=read["name"])
        if use_number or use_text:
            body = [line for line in list(read["lines"]) + list(read.get("bodyLines") or []) if line]
            evidence = env.lookup.search(body, number, total, read.get("tokens") or [], number=use_number, text=use_text)
            if not evidence.empty():
                ocr_info["lookup"] = evidence.trace()
        if name_read is not None or evidence is not None:
            hits, added = pipeline.merge_candidates(hits, scores, env.row_of, names, name_read.name if name_read else None, number, total, top_k,
                                                    evidence=evidence, number_once=bool(options.get("numberOnce")))
            ocr_info["text_candidates_added"] = added
    name_known = bool(name_read is not None and name_read.name and names is not None and names.score_names(name_read.name))
    candidates = []
    for position, (card_id, score) in enumerate(hits, start=1):
        row = env.loaded.get(card_id)
        if row is None:
            continue
        candidate = {**row, "_db_id": card_id, "_similarity": round(float(score), 4), "_rank": 1 + int((scores > score).sum()) if count else position, "_position": position}
        if name_read is not None and names is not None:
            candidate["_name_score"] = round(names.name_score_of(card_id, name_read.name), 3)
            candidate["_name_known"] = name_known
        if evidence is not None:
            level = evidence.level_of(card_id)
            if level:
                candidate["_lookup"] = level
                candidate["_lookup_unique"] = evidence.unique_at_or_above(level) == 1
            text_hit = evidence.text.get(card_id)
            if text_hit:
                candidate["_text_score"], candidate["_text_cards"] = round(text_hit.score, 3), text_hit.cards
        if art is not None and card_id in env.row_of and not np.isnan(art[env.row_of[card_id]]):
            candidate["_art_similarity"] = round(float(art[env.row_of[card_id]]), 4)
        candidates.append(candidate)
    if read is not None:
        known = {c.get("set_abbreviation") for c in candidates if c.get("set_abbreviation")}
        set_code = None
        if known:
            upper = {code.upper() for code in known if code}
            set_code = next((token for token in (read.get("tokens") or []) if token in upper), None)
        card_info = {"number_local": number, "number_total": total, "set_code": set_code, "hp": read.get("hp"), "language": "en"}
    else:
        card_info = {}
    card_info["language"] = None
    looked_up = pipeline.number_from_lookup(card_info, candidates) if evidence is not None else None
    if looked_up:
        ocr_info["number_from_lookup"] = looked_up
    corrected = pipeline.correct_number(card_info, candidates, read["lines"] if read else [])
    if corrected:
        ocr_info["corrected"] = corrected
    source = read.get("numberSource") if read else None
    if read and number and not source:
        source = "finder_card"
    chosen, reason = pipeline.decide(
        card_info, candidates, reprint=bool(options.get("reprint")), fallback=bool(options.get("fallback")), number_read=bool(read and number and not looked_up),
        whole_strict=bool(options.get("wholeStrict")), number_source=source, number_confidence=read.get("numberConfidence") if read else None)
    matches = []
    for c in candidates:
        match = {"card_id": c["_db_id"], "tcg_card_id": c["tcg_card_id"], "similarity": c["_similarity"], "rank": c["_position"], "name": c.get("name"),
                 "number": c.get("number"), "set": c.get("set"), "printed_total": c.get("printed_total"), "picture_rank": c["_rank"]}
        for key, field in (("name_score", "_name_score"), ("text_score", "_text_score"), ("art_similarity", "_art_similarity")):
            if field in c:
                match[key] = c[field]
        if c.get("_lookup"):
            match["lookup"] = c["_lookup"]
            match["lookup_unique"] = c.get("_lookup_unique")
        if "_name_known" in c:
            match["name_known"] = c["_name_known"]
        if "_text_cards" in c:
            match["text_cards"] = c["_text_cards"]
        match = {key: value for key, value in match.items() if key not in ("set", "tcg_card_id")}
        matches.append(match)
    decision = None
    if chosen:
        winner = chosen["candidate"]
        decision = {"card_id": winner["_db_id"], "tcg_card_id": winner["tcg_card_id"], "mechanism": chosen["mechanism"], "similarity": winner["_similarity"], "lead": chosen["lead"]}
    return {"decided": decision is not None, "decision": decision, "reason": None if decision else reason, "matches": matches, "ocr": ocr_info,
            "card_info": {key: value for key, value in card_info.items() if key != "language"}}


# ── the cases ───────────────────────────────────────────────────────────────

NO_TARGET = None


class Maker:
    """Builds picture score vectors and reads for one catalogue."""

    def __init__(self, env: Env, rng: random.Random):
        self.env, self.rng = env, rng
        self.by_id = {row["id"]: row for row in env.rows}
        self.by_name: dict[str, list[str]] = {}
        for row in env.rows:
            self.by_name.setdefault(row["name"], []).append(row["id"])

    def u(self, low: float, high: float) -> float:
        return round(self.rng.uniform(low, high), 6)

    def scores(self, target: str | None, sim: float, others: dict[str, float] | None = None, art_lead: float | None = None) -> tuple[list[float], list[float | None] | None]:
        """Every row's picture score: noise low down, the target at ``sim``, chosen cards at chosen scores; the artwork-only scores too."""
        env = self.env
        scores = [self.u(0.04, min(0.5, sim - 0.05) if sim > 0.1 else 0.3) for _ in env.ids]
        others = dict(others or {})
        for ghost in ("ghost-1_en", "ghost-2_en"):  # picture ids the catalogue lacks stay at the bottom (the server's name index holds every indexed id)
            scores[env.row_of[ghost]] = -1.0
        if target is not None:
            scores[env.row_of[target]] = round(sim, 6)
            for sibling in self.by_name.get(self.by_id[target]["name"], []):  # reprints look alike, within a few hundredths
                if sibling != target and sibling not in others:
                    others[sibling] = round(max(0.05, sim - self.rng.choice([0.0123, 0.0341, 0.0567, 0.0874, 0.1319, 0.2217]) - self.u(0, 0.004)), 6)  # (never an exact tie: numpy's top-k order is not defined for ties)
        for card_id, value in others.items():
            scores[env.row_of[card_id]] = round(value, 6)
        art = None
        if self.rng.random() < 0.7:
            art = [round(min(0.999, max(-1.0, s + self.rng.uniform(-0.04, 0.04))), 6) for s in scores]
            if target is not None and art_lead is not None:
                group = [i for i in self.by_name.get(self.by_id[target]["name"], [])]
                for card_id in group:
                    art[env.row_of[card_id]] = round(scores[env.row_of[card_id]] - (0.0 if card_id == target else art_lead + self.u(0, 0.02)), 6)
            if self.rng.random() < 0.1:  # a card the artwork index does not hold
                art[self.rng.randrange(len(art))] = None
        return scores, art

    def read_for(self, target: str | None, plan: dict) -> dict | None:
        rng = self.rng
        if plan.get("noread"):
            return None
        row = self.by_id[target] if target else None
        number = total = None
        lines: list[str] = []
        tokens: list[str] = []
        kind = plan.get("number", "exact")
        if row is not None:
            n, t = row["number"], str(row["printed_total"] or "")
            if kind in ("exact", "padded"):
                number, total = n, t or None
                shown_n = n.zfill(3) if kind == "padded" and n.isdigit() else n
                shown_t = t.zfill(3) if kind == "padded" and t.isdigit() else t
                lines.append(f"{shown_n}/{shown_t}" if shown_t else shown_n)
            elif kind == "no_total":
                number, total = n, None
                lines.append(n)
            elif kind == "bar":
                number, total = "30C", "0" + t if t else None  # "30C | 017/128" parsed as 30C over 017: OCR's own parse is fooled
                lines.append(f"30C | {n}/{t}")
            elif kind == "glued":
                number, total = row["set_abbreviation"] + n.zfill(3), t.zfill(3) if t else None
                lines.append(f"{row['set_abbreviation']}{n.zfill(3)}/{t.zfill(3)}")
                tokens.append(row["set_abbreviation"])
            elif kind == "damaged":  # OCR lost a digit and the slash: "12/13" for "112/113"; read the number as it came out
                digits = (n + t)
                number, total = None, None
                lines.append(digits[:-1] if len(digits) > 3 else digits)
                lines.append(f"{n[1:] or n}/{t[1:] or t}")
                number, total = (n[1:] or n), (t[1:] or t)
            elif kind == "wrong":
                other = self.by_id[rng.choice([r for r in self.by_id if r != target])]
                number, total = other["number"], str(other["printed_total"] or "") or None
                lines.append(f"{number}/{total}" if total else number)
            elif kind == "wrong_total":
                number, total = n, str(int(t) + rng.choice([-20, 14, 31])) if t.isdigit() else "999"
                lines.append(f"{n}/{total}")
            elif kind == "none":
                number = total = None
            if plan.get("token", False) and row["set_abbreviation"] and row["set_abbreviation"] not in tokens:
                tokens.append(row["set_abbreviation"])
            if plan.get("wrong_token"):
                tokens.append("TWM")
            for text in plan.get("body", []):
                lines.append(text)
            if plan.get("body_from_card"):
                texts = [a.get("effect") for a in (row.get("attacks") or [])] + [a.get("name") for a in (row.get("attacks") or [])] + ([row["card_effect"]] if row.get("card_effect") else [])
                texts = [t_ for t_ in texts if t_]
                if texts:
                    lines.append(rng.choice(texts))
        else:
            if kind != "none":
                number, total = str(rng.randrange(1, 190)), str(rng.choice([86, 114, 198]))
                lines.append(f"{number}/{total}")
        read = {"number": number, "total": total, "tokens": tokens, "hp": plan.get("hp", row["hp"] if row and rng.random() < 0.6 else None), "lines": lines,
                "numberSource": plan.get("source", "finder_card"), "numberConfidence": plan.get("confidence", rng.choice([0.5, 0.8, 0.84, 0.86, 0.95]))}
        if plan.get("bodyLines"):
            read["bodyLines"] = plan["bodyLines"]
        name_kind = plan.get("name", "exact")
        if name_kind == "absent":
            pass
        elif name_kind == "none":
            read["name"] = None
        elif name_kind == "exact" and row is not None:
            read["name"] = row["name"]
        elif name_kind == "damaged" and row is not None:
            word = row["name"]
            cut = rng.randrange(1, max(2, len(word) - 1))
            read["name"] = word[:cut] + word[cut + 1:]
        elif name_kind == "other":
            others = [r["name"] for r in self.by_id.values() if row is None or r["name"] != row["name"]]
            read["name"] = rng.choice(others)
        elif name_kind == "unknown":
            read["name"] = "Zzyzx Qwerty"
        elif name_kind == "text" and plan.get("name_text"):
            read["name"] = plan["name_text"]
        else:
            read["name"] = row["name"] if row is not None else None
        return read


def random_cases(env: Env, count: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    maker = Maker(env, rng)
    ids = [row["id"] for row in env.rows]
    cases = []
    for number in range(count):
        target = rng.choice(ids) if rng.random() > 0.08 else None
        sim = rng.choice([0.95, 0.91, 0.86, 0.82, 0.75, 0.68, 0.62, 0.57, 0.52, 0.45, 0.33])
        sim = round(sim + rng.uniform(-0.02, 0.02), 6)
        others = {}
        if rng.random() < 0.25:  # another card is closer in the picture, or nearly
            rival = rng.choice([i for i in ids if i != target])
            others[rival] = round(sim + rng.choice([-0.02, 0.01, 0.04, 0.12]), 6)
        if rng.random() < 0.25:  # a card with the same number sits near the top
            row = maker.by_id.get(target) if target else None
            if row:
                for other in ids:
                    if other != target and maker.by_id[other]["number"] == row["number"] and other not in others:
                        others[other] = round(sim - rng.choice([0.02, 0.08, 0.15, 0.3]) - maker.u(0, 0.004), 6)
        scores, art = maker.scores(target, sim, others, art_lead=rng.choice([None, 0.01, 0.05, 0.09]))
        plan = {
            "number": rng.choices(["exact", "padded", "no_total", "bar", "glued", "damaged", "wrong", "wrong_total", "none"], [34, 6, 6, 5, 5, 8, 8, 6, 22])[0],
            "name": rng.choices(["exact", "damaged", "other", "unknown", "none", "absent"], [34, 18, 8, 5, 10, 25])[0],
            "token": rng.random() < 0.3, "wrong_token": rng.random() < 0.05, "body_from_card": rng.random() < 0.35,
            "source": rng.choices(["finder_card", "whole_picture"], [70, 30])[0], "noread": rng.random() < 0.04,
        }
        options = {"numberOnce": rng.random() < 0.75, "wholeStrict": rng.random() < 0.5, "reprint": rng.random() < 0.15, "fallback": rng.random() < 0.08,
                   "useNumber": rng.random() > 0.08, "useText": rng.random() > 0.08, "useNames": rng.random() > 0.05}
        cases.append({"label": f"random-{number}", "scores": scores, "art": art, "read": maker.read_for(target, plan), "options": options})
    return cases


def crafted_cases(env: Env, seed: int) -> list[dict]:
    """Cases written for the mechanisms and refusals the random ones may not reach (the coverage report says which)."""
    rng = random.Random(seed + 1)
    maker = Maker(env, rng)
    cases = []

    def add(label, target, sim, others=None, read=None, options=None, art_lead=None, plan=None):
        scores, art = maker.scores(target, sim, others, art_lead=art_lead)
        read_value = read if read is not None else maker.read_for(target, plan or {})
        cases.append({"label": label, "scores": scores, "art": art, "read": read_value, "options": {"numberOnce": True, "wholeStrict": True, **(options or {})}})

    add("picture_lead_clear", "sv6-103_en", 0.93, plan={"noread": True})
    add("picture_lead_no_number", "sv1-3_en", 0.9, others={"sv1-2_en": 0.7, "base1-4_en": 0.6}, plan={"number": "none", "name": "absent"})
    add("name_and_picture", "sv3-101_en", 0.82, others={"sv1-100_en": 0.78}, plan={"number": "none", "name": "exact"})
    add("name_and_picture_lead_too_small", "sv3-101_en", 0.82, others={"sv1-100_en": 0.805}, plan={"number": "none", "name": "exact"})
    add("text_and_picture", "sv2-53_en", 0.84, others={"sv1-100_en": 0.7}, plan={"number": "none", "name": "absent", "body": ["Choose 1 of your opponent's Active Pokemon's attacks and use it as this attack."]})
    add("text_attack_name_only", "sv2-53_en", 0.84, others={"sv1-100_en": 0.7}, plan={"number": "none", "name": "absent", "body": ["Genome Hacking"]})
    add("text_shared_sentence_adds_nobody", "sv1-189_en", 0.7, plan={"number": "none", "name": "absent", "body": [SHARED_EFFECT]})
    add("text_conflicting_name", "sv2-53_en", 0.84, others={"sv1-100_en": 0.7}, plan={"number": "none", "name": "other", "body": ["Choose 1 of your opponent's Active Pokemon's attacks and use it as this attack."]})
    add("rules_number_unique", "sv1-25_en", 0.9, plan={"number": "exact", "name": "exact"})
    add("rules_number_metadata_set", "sv2-25_en", 0.8, plan={"number": "exact", "token": True, "name": "absent"})
    add("rules_not_close_in_picture", "sv1-25_en", 0.5, plan={"number": "exact", "name": "absent"})
    add("rules_lookup_near_far_in_picture", "pbl-39_en", 0.7, others={f"{r['id']}": 0.72 + 0.001 * i for i, r in enumerate(env.rows[:14]) if r["id"] != "pbl-39_en"},
        plan={"number": "exact", "name": "absent"})
    add("number_and_picture_tie_break", "sv3-25_en", 0.9, others={"sv1-25_en": 0.7, "sv2-25_en": 0.65}, plan={"number": "no_total", "name": "absent"})
    add("number_matches_several_no_clear_gap", "sv3-25_en", 0.9, others={"sv1-25_en": 0.88, "sv2-25_en": 0.65}, plan={"number": "no_total", "name": "absent"})
    add("number_matches_several_reprint", "sv3-25_en", 0.9, others={"sv1-25_en": 0.88, "sv2-25_en": 0.87}, art_lead=0.06, plan={"number": "no_total", "name": "absent"}, options={"reprint": True})
    add("reprint_no_number", "sv3-25_en", 0.9, others={"sv1-25_en": 0.88, "sv2-25_en": 0.87}, art_lead=0.06, plan={"number": "none", "name": "absent"}, options={"reprint": True})
    add("number_not_among_pictures", "sv1-2_en", 0.7, plan={"number": "wrong", "name": "absent"})
    unknown_number = {"number": "199", "total": "198", "tokens": [], "hp": None, "lines": ["199/198"], "numberSource": "finder_card", "numberConfidence": 0.9}
    add("picture_lead_strong", "sv1-2_en", 0.93, others={"sv1-3_en": 0.5}, read={**unknown_number, "name": None})
    add("picture_lead_strong_not_clear_enough", "sv1-2_en", 0.93, others={"sv1-3_en": 0.88}, read={**unknown_number, "name": None})
    add("picture_lead_strong_fallback_closed", "sv1-2_en", 0.93, others={"sv1-3_en": 0.5}, read={**unknown_number, "name": None}, options={"fallback": True})
    add("total_contradicts_read", "sv1-25_en", 0.9, plan={"number": "wrong_total", "name": "exact"})
    add("total_contradicts_picture_lane", "sv1-3_en", 0.92, others={"sv1-2_en": 0.6}, read={"number": None, "total": "500", "tokens": [], "hp": None, "lines": ["x/500"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": None})
    add("darumaka_total_contradicts_tie_lane", "bw1-23_en", 0.64, others={"blk-13_en": 0.79},
        read={"number": "23", "total": "86", "tokens": [], "hp": "70", "lines": ["023/086"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": "Darumaka"})
    add("darumaka_closer_same_name_tie_lane", "bw1-23_en", 0.64, others={"blk-13_en": 0.79},
        read={"number": "23", "total": None, "tokens": [], "hp": "70", "lines": ["023"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": "Darumaka"})
    add("darumaka_closer_same_name_rules_lane", "bw1-23_en", 0.64, others={"blk-13_en": 0.79},
        read={"number": "23", "total": None, "tokens": ["BLW"], "hp": "70", "lines": ["023"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": "Darumaka"})
    add("kommo_comfey_numberonce", "sm9-143_en", 0.634, others={"sv2-77_en": 0.4243},
        read={"number": "77", "total": "128", "tokens": [], "hp": "170", "lines": ["077/128"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": "Kommo-o"})
    add("kommo_comfey_two_counts", "sm9-143_en", 0.634, others={"sv2-77_en": 0.4243},
        read={"number": "77", "total": "128", "tokens": [], "hp": "170", "lines": ["077/128"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": "Kommo-o"}, options={"numberOnce": False})
    add("lookup_conflicts_with_name", "pbl-39_en", 0.7, others={"pbl-23_en": 0.45},
        read={"number": "39", "total": "84", "tokens": ["PBL"], "hp": None, "lines": ["PBL039/084"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": "Pikachu"})
    add("glued_set_code", "pbl-39_en", 0.7, plan={"number": "glued", "name": "exact"})
    add("bar_misparse_number_from_lookup", "sv6-17_en", 0.7, plan={"number": "bar", "name": "absent"})
    add("gallery_tg", "swsh12tg-TG06_en", 0.8, plan={"number": "exact", "name": "exact"})
    add("gallery_tg_prefix_lost", "swsh12tg-TG06_en", 0.8, read={"number": "06", "total": "30", "tokens": [], "hp": None, "lines": ["06/TG30"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": "Charizard"})
    add("gallery_gg_sv", "sv4pt5-SV28_en", 0.8, plan={"number": "exact", "name": "exact"})
    add("promo_number_only", "svp-SVP025_en", 0.8, read={"number": "SVP025", "total": None, "tokens": ["SVP"], "hp": None, "lines": ["SVP025"], "numberSource": "finder_card", "numberConfidence": 0.9, "name": "Mew ex"})
    add("constrained_correction", "sv6-17_en", 0.75, read={"number": "7", "total": "67", "tokens": [], "hp": None, "lines": ["7/67"], "numberSource": "finder_card", "numberConfidence": 0.6, "name": None})
    add("constrained_lost_slash", "sv1-25_en", 0.75, read={"number": None, "total": None, "tokens": [], "hp": None, "lines": ["251198"], "numberSource": "finder_card", "numberConfidence": 0.6, "name": None})
    add("fallback_no_number", "sv1-3_en", 0.95, plan={"noread": False, "number": "none", "name": "exact"}, options={"fallback": True})
    add("fallback_number", "sv1-25_en", 0.8, plan={"number": "exact", "name": "exact"}, options={"fallback": True})
    add("fallback_number_from_lookup", "sv6-17_en", 0.8, plan={"number": "bar", "name": "exact"}, options={"fallback": True})
    add("whole_number_total_missing", "sv1-25_en", 0.8, plan={"number": "no_total", "name": "absent", "source": "whole_picture", "confidence": 0.95})
    add("whole_number_picture_weak_sim", "sv1-25_en", 0.6, plan={"number": "exact", "name": "absent", "source": "whole_picture", "confidence": 0.95})
    add("whole_number_picture_weak_rank", "sv1-25_en", 0.8, others={"sv2-77_en": 0.82, "sv1-2_en": 0.81}, plan={"number": "exact", "name": "absent", "source": "whole_picture", "confidence": 0.95})
    add("whole_number_name_conflict", "sv1-25_en", 0.8, plan={"number": "exact", "name": "other", "source": "whole_picture", "confidence": 0.95})
    add("whole_number_low_confidence", "sv1-25_en", 0.8, plan={"number": "exact", "name": "absent", "source": "whole_picture", "confidence": 0.7})
    add("whole_number_ok", "sv1-25_en", 0.8, plan={"number": "exact", "name": "exact", "source": "whole_picture", "confidence": 0.95})
    add("whole_number_picture_decides", "sv1-2_en", 0.93, others={"sv1-3_en": 0.5}, read={**unknown_number, "name": None, "numberSource": "whole_picture", "numberConfidence": 0.2})
    add("whole_number_name_conflict_lookup_off", "sv1-25_en", 0.8, plan={"number": "exact", "name": "other", "source": "whole_picture", "confidence": 0.95}, options={"useNumber": False})
    add("whole_number_strict_off", "sv1-25_en", 0.8, plan={"number": "no_total", "name": "absent", "source": "whole_picture", "confidence": 0.2}, options={"wholeStrict": False})
    add("rule_box_text", "sv1-2_en", 0.7, plan={"number": "none", "name": "absent", "body": ["Pokemon ex rule: When your Pokemon ex is Knocked Out, your opponent takes 2 Prize cards."]})
    add("hp_only_artist_hp_unreachable", "sv1-25_en", 0.9, plan={"number": "none", "name": "absent", "hp": "60"})
    add("empty_picture_list_unknown_ids", None, 0.3, plan={"number": "none", "name": "absent"})
    ghost_scores = [0.0] * len(env.ids)
    ghost_scores[env.row_of["ghost-1_en"]] = 0.99
    ghost_scores[env.row_of["ghost-2_en"]] = 0.98
    cases.append({"label": "only_ghost_ids", "scores": ghost_scores, "art": None, "read": None, "options": {"topK": 2}})
    # the same name in different spellings
    add("name_hyphen_space", "sv3-101_en", 0.5, read={"number": None, "total": None, "tokens": [], "hp": None, "lines": [], "numberSource": None, "numberConfidence": None, "name": "Ho Oh"})
    add("name_accent", "sv2-100_en", 0.7, read={"number": None, "total": None, "tokens": [], "hp": None, "lines": [], "numberSource": None, "numberConfidence": None, "name": "Flabebe"})
    add("name_qualifier", "sv2-190_en", 0.6, read={"number": None, "total": None, "tokens": [], "hp": None, "lines": [], "numberSource": None, "numberConfidence": None, "name": "Boss's Orders"})
    add("name_suffix_missing", "sv1-2_en", 0.7, read={"number": None, "total": None, "tokens": [], "hp": None, "lines": [], "numberSource": None, "numberConfidence": None, "name": "Charizrd"})
    return cases


# ── string and number helpers (difflib, normalising, rounding) ──────────────

ROUND_VALUES = [0.03125, 0.09375, 0.15625, 0.5, 0.12345, 0.6791, 0.66666666, 1.0, 0.0, 0.999995, 0.00005, 0.25, 0.375, 0.8125, 0.7, 0.12355, 0.5005, 0.4995, 2.5, 0.0625]
NORM_TEXT_INPUTS = ["Flip a coin. If tails, this Pokémon does 30 damage to itself.", "  Mixed   CASE\tand\nlines ", "Straße ſtraße", "Ｆｕｌｌ ｗｉｄｔｈ ３０", "Ho-Oh's  “quote”", "", "e\u0301cole", "100% sure! #1"]
NAME_INPUTS = ["Mew ex", "Pikachu V", "Ho-Oh", "Ho Oh V", "HO-OH VSTAR", "Flabébé", "Boss’s Orders (Giovanni)", "Boss's Orders", "Charizard & Braixen-GX", "Charizard&Braixen GX", "Mr. Mime", "Mr Mime",
               "Farfetch’d", "Nidoran♀", "Straße", "Lugia  LV.X", "Dark Charizard", "Pikachu TAG TEAM", "Œuf", "  Padded Name  ", "Eevee V-UNION", "V", "ex", ""]
NUMBER_INPUTS = ["017", "17", "TG06", "tg6", "TG06/TG30", "SWSH020", "SVP001", "0", "000", "1000", "7a", "09b", "GG 01", "SV-28", "x", "", None, "12/13", "PBL039", "H12", " 25 "]


def string_cases() -> dict:
    from api import recognize as rules
    from services.card_match import lookup, names

    import difflib

    rng = random.Random(3)
    alphabets = ["ab", "abc", "abcd", "aeiou ", "0123456789 /"]
    pairs = []
    for _ in range(260):
        alphabet = rng.choice(alphabets)
        a = "".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 15)))
        b = "".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 15)))
        pairs.append((a, b))
    pairs += [("abcabc", "abc"), ("aaaa", "aa"), ("pikachu", "pikachuu"), ("kommo o", "kommoo"), ("lapras", "lapras gx"), ("", ""), ("a", ""), ("dragonair", "dragonite"),
              ("choose 1 of your opponent s active pokemon s attacks", "choose 1 of your opponents active pokemons attacks and use it as this attack"), ("é", "e")]
    out = {"ratios": [], "round": [], "norm_text": [], "names": [], "numbers": [], "name_score": []}
    for a, b in pairs:
        matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
        blocks = [[m.a, m.b, m.size] for m in matcher.get_matching_blocks()]
        out["ratios"].append({"a": a, "b": b, "ratio": matcher.ratio(), "quick": matcher.quick_ratio(), "real_quick": matcher.real_quick_ratio(), "blocks": blocks})
    out["round"] = [{"value": v, "digits": d, "rounded": round(v, d)} for v in ROUND_VALUES for d in (3, 4)]
    out["norm_text"] = [{"input": text, "output": lookup.norm_text(text)} for text in NORM_TEXT_INPUTS]
    out["names"] = [{"input": text, "key": names.name_key(text), "base_key": names.base_key(text), "compatible_with": {other: rules._scanner_names_compatible(text, other) for other in ("Mew ex", "Ho-Oh", "Boss's Orders", "Boss's Orders (Giovanni)", "Mr. Mime")}} for text in NAME_INPUTS]
    out["numbers"] = [{"input": value, "normalized": rules._normalize_number(value), "total": rules._normalize_printed_total(value), "number_key": lookup._number_key(value), "total_key": lookup._total_key(value),
                       "matches": {other: rules._numbers_match(value, other) for other in ("17", "017", "TG6", "30")},
                       "signal": {str(other): rules._printed_total_signal(value, other) for other in ("17", "TG30", "30", None)}} for value in NUMBER_INPUTS]
    keys = ["pikachu", "pikachuv", "mewex", "hooh", "charizardex", "lapras", "lapragx", "flabebe"]
    for read in ("Pikachu", "Pikchu", "Mew", "Ho Oh", "Charizrd", "Laprass", "Flabebe", "Zzz"):
        rows = [names.NameRow(f"c{index}", name, "1", "10") for index, name in enumerate(["Pikachu", "Pikachu V", "Mew ex", "Ho-Oh", "Charizard ex", "Lapras", "Lapras GX", "Flabébé"])]
        index = names.NameIndex(rows)
        out["name_score"].append({"read": read, "scores": [[row.card_id, round(index.name_score_of(row.card_id, read), 6)] for row in rows], "names": [[round(score, 6), key] for score, key in index.score_names(read)]})
    del keys
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_dir", nargs="?", type=Path)
    parser.add_argument("--cases", type=int, default=300)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args(argv)
    from services.card_match import MATCHER_VERSION

    out_dir = args.out_dir or HERE.parents[1] / "frontend" / "tests" / "fixtures" / "phone-matcher" / f"v{MATCHER_VERSION}" / "decide"
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = catalogue_rows()
    env = Env(rows)
    cases = crafted_cases(env, args.seed) + random_cases(env, args.cases, args.seed)
    mechanisms, reasons = Counter(), Counter()
    for case in cases:
        case["python"] = run_tail(env, case)
        result = case["python"]
        if result["decided"]:
            mechanisms[result["decision"]["mechanism"]] += 1
        else:
            reasons[result["reason"]] += 1
    header = {"matcher_version": MATCHER_VERSION, "note": "Generated by backend/scripts/phone_parity_decide.py from hand-written rows and seeded random scores only."}
    (out_dir / "catalogue.json").write_text(json.dumps({**header, "ids": env.ids, "rows": rows}, separators=(",", ":"), ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    (out_dir / "strings.json").write_text(json.dumps({**header, **string_cases()}, separators=(",", ":"), ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    (out_dir / "cases.json").write_text(json.dumps({**header, "seed": args.seed, "cases": cases}, separators=(",", ":"), ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    from services.card_match import pipeline  # noqa: F401

    print(f"Wrote {len(cases)} decide cases and {len(rows)} catalogue rows to {out_dir}")
    print("decided, by mechanism:", dict(mechanisms))
    print("unsure, by reason:", dict(reasons))
    expected_mechanisms = {"number_unique", "number_metadata", "artist_hp", "picture_lead_strong", "number_and_picture", "reprint_art_lead", "picture_lead", "name_and_picture", "text_and_picture"}
    expected_reasons = {"no_picture_matches", "card_not_found_no_number_read", "number_lookup_conflicts_with_name", "total_contradicts_read", "closer_printing_of_same_name",
                        "rules_choice_not_close_in_picture", "number_not_among_picture_matches", "number_matches_several_printings", "no_number_and_picture_not_clear",
                        "whole_number_total_not_confirmed", "whole_number_picture_too_weak", "whole_number_name_conflict", "whole_number_low_confidence"}
    print("mechanisms not reached:", sorted(expected_mechanisms - set(mechanisms)), "(artist_hp needs card_info.artist, which OCR never fills: unreachable)")
    print("reasons not reached:", sorted(expected_reasons - set(reasons)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
