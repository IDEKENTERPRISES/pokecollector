"""Regenerate backend/data/pokemon_families.json (every evolution family) from PokeAPI's species CSV.

Source: PokeAPI/pokeapi, data/v2/csv/pokemon_species.csv, pinned to the commit below.
License: BSD 3-Clause (PokeAPI LICENSE.md, copyright (c) 2013-2023 Paul Hallett and PokeAPI contributors).
Pokemon names and characters are trademarks of Nintendo. Only the species/chain
relations are used; the committed JSON is the runtime data, nothing is fetched at runtime.

One family per evolution chain, covering every species in backend/data/pokedex.json.
The hand-made families already in the file keep their id, name and dex id order (they come first,
in their current order, flagged "popular"); all other chains follow by the first stage's dex number (baby stages count as first), with the base
species' slug as id. Families with a single species are named after it, others "<Base> family".
If a hand-made family does not equal its PokeAPI chain it is kept as is and the leftover chain
members become their own family (none differ today).

Usage (from backend/):  python -m scripts.build_pokemon_families [--csv path/to/pokemon_species.csv]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import urllib.request
from pathlib import Path

POKEAPI_COMMIT = "193d8d4fbb57cf962e3f7c1ce5299a6fe847b3f8"
CSV_URL = f"https://raw.githubusercontent.com/PokeAPI/pokeapi/{POKEAPI_COMMIT}/data/v2/csv/pokemon_species.csv"
DATA = Path(__file__).resolve().parent.parent / "data"


def load_csv(path: str | None) -> list[dict]:
    if path:
        text = Path(path).read_text(encoding="utf-8")
    else:
        request = urllib.request.Request(CSV_URL, headers={"User-Agent": "family-generator/1.0"})
        text = urllib.request.urlopen(request, timeout=60).read().decode("utf-8")
    return list(csv.DictReader(io.StringIO(text)))


def build(species_rows: list[dict], pokedex: list[dict], existing: list[dict]) -> list[dict]:
    dex = {int(p["dex_id"]): p for p in pokedex}
    chain_of = {int(r["id"]): int(r["evolution_chain_id"]) for r in species_rows if int(r["id"]) in dex}
    chains: dict[int, list[int]] = {}
    for species_id in sorted(chain_of):
        chains.setdefault(chain_of[species_id], []).append(species_id)
    missing = set(dex) - set(chain_of)
    if missing:
        raise SystemExit(f"Species missing from the CSV: {sorted(missing)}")

    families: list[dict] = []
    used: set[int] = set()

    parent = {int(r["id"]): int(r["evolves_from_species_id"]) for r in species_rows if r["evolves_from_species_id"]}

    def first_stage(ids: list[int]) -> int:
        roots = [i for i in ids if parent.get(i) not in ids]
        return min(roots or ids)

    def entry(family_id: str, name: str, dex_ids: list[int], popular: bool = False) -> dict:
        base = first_stage(dex_ids)
        row = {
            "base": base,
            "dex_ids": dex_ids,
            "generation": int(dex[base]["generation"]),
            "id": family_id,
            "name": name,
        }
        if popular:
            row["popular"] = True
        return row

    # First run: every entry in the file is hand-made. Later runs: only those flagged popular.
    hand_made = [old for old in existing if old.get("popular")] if any(o.get("popular") for o in existing) else existing
    for old in hand_made:
        ids = [int(d) for d in old["dex_ids"]]
        families.append(entry(old["id"], old["name"], ids, popular=True))
        used.update(ids)
    taken = {f["id"] for f in families}
    for chain_id, members in sorted(chains.items(), key=lambda item: first_stage(item[1])):
        rest = [m for m in members if m not in used]
        if not rest:
            continue
        base = dex[first_stage(rest)]
        family_id = base["slug"] if base["slug"] not in taken else f"{base['slug']}-{base['dex_id']}"
        taken.add(family_id)
        name = f"{base['name_en']} family" if len(rest) > 1 else base["name_en"]
        families.append(entry(family_id, name, rest))
        used.update(rest)
    return families


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--csv", help="local copy of pokemon_species.csv instead of downloading the pinned one")
    args = parser.parse_args()
    out = DATA / "pokemon_families.json"
    pokedex = json.loads((DATA / "pokedex.json").read_text(encoding="utf-8"))
    existing = json.loads(out.read_text(encoding="utf-8"))
    families = build(load_csv(args.csv), pokedex, existing)
    with out.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("[\n" + ",\n".join("  " + json.dumps(f, sort_keys=True, ensure_ascii=False) for f in families) + "\n]\n")
    print(f"{len(families)} families")


if __name__ == "__main__":
    main()
