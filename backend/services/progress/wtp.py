"""Who's That Pokémon: one species a day, the same for everyone, with four choices and one try.

The species comes from the splash's fixed shuffled order (services/pokedex_splash.py), half a cycle
away from the Pokémon of the day, so the Today card never gives the answer away. Everything is
derived from the date, so a phone can fetch tomorrow's puzzle ahead and play it offline.
"""
from __future__ import annotations

import hashlib
import random
from datetime import date

from services.pokedex import MAX_DEX_ID, pokedex_by_id
from services.pokedex_splash import DAILY_EPOCH, daily_order, image_url, normalize_language

WTP_OFFSET = 512
CHOICES = 4
SPRITE_KIND = "artwork"


def wtp_species(day: date) -> int:
    return daily_order()[((day - DAILY_EPOCH).days + WTP_OFFSET) % MAX_DEX_ID]


def _name(dex_id: int, lang: str) -> str:
    entry = pokedex_by_id()[dex_id]
    return entry.get(f"name_{lang}") or entry.get("name_en")


def build_puzzle(day: date, lang: str = "en") -> dict:
    lang = normalize_language(lang)
    answer = wtp_species(day)
    rng = random.Random(int.from_bytes(hashlib.sha256(f"wtp:{day.isoformat()}".encode()).digest()[:8], "big"))
    pool = [dex_id for dex_id in pokedex_by_id() if dex_id != answer]
    ids = rng.sample(pool, CHOICES - 1) + [answer]
    rng.shuffle(ids)
    return {
        "date": day.isoformat(),
        "lang": lang,
        "answer": answer,
        "sprite_url": image_url(SPRITE_KIND, answer),
        "choices": [{"dex_id": dex_id, "name": _name(dex_id, lang)} for dex_id in ids],
    }
