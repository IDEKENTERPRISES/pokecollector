"""Which picture-matching options are on, and building a matcher for them.

Options (all measured side by side by the labelled benchmark, "Compare options" in Scanner lab):
  - ``names``: read the name line and bring the catalogue's close names in as text candidates (names.py);
  - ``number``: look up every card with the printed number/total (and set code) the text holds (lookup.py);
  - ``text``: match attack, ability and effect text to the card table (lookup.py);
  - ``reprint``: break ties between reprints by the artwork-only similarity (needs, and so turns on, ``art``);
  - ``tta``: test-time augmentation, two extra views of the card (tighter crop, normalised brightness);
  - ``art``: a second picture index of the artwork window only, averaged with the whole-card one;
  - ``base``: a second index from the bigger DINOv2-base model, averaged with the first;
  - ``numberonce``: a read number moves a printing up the ranking once instead of twice;
  - ``fastread``: read the text with a shorter ladder (no black-and-white or glare-removal steps) and a lower budget.
A label is the options joined by ``+``: ``baseline`` (none), ``names``, ``names+number``, ``names+number+text+tta`` ...

The label in use comes from ``CARD_MATCH_OPTIONS``, else from ``chosen.json`` (written when a comparison
finds a clear winner), else ``names``. Indexes an option needs that are not built yet make that label
unavailable (``missing_indexes``); the matcher in use then falls back to the plain whole-card search.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from . import config
from .model_specs import DEFAULT_MODEL, MODEL_SPECS

logger = logging.getLogger(__name__)

BASE_MODEL = "dinov2-base"
ART_INDEX = f"{DEFAULT_MODEL}-art"  # the artwork-window index of the default model
DEFAULT_LABEL = "names+number+text+art+tta"  # v6 (was names+number+text); an unbuilt artwork index is left out, see ``usable``
# The labels the comparison runs, cheapest first.
# The lookup lanes come one at a time right after ``names`` so each one's gain shows as its own row.
COMPARE_LABELS = (
    "baseline", "names", "names+number", "names+number+text", "names+number+text+tta", "names+number+text+art",
    "names+number+text+art+reprint", "names+number+text+art+tta", "names+number+text+art+tta+fastread",
    "names+number+text+art+tta+numberonce", "names+number+text+base", "names+number+text+art+base",
)
# The synthetic comparison chooses nothing, so it runs a short list on fewer photos
# (version 5: 10 rows x 400 photos took 89 minutes).
SYNTHETIC_COMPARE_LABELS = (
    "baseline", "names+number+text", "names+number+text+art+tta", "names+number+text+art+tta+fastread",
)
SYNTHETIC_COMPARE_COUNT = 100
ORDER = ("names", "number", "text", "art", "reprint", "base", "tta", "numberonce", "fastread")


@dataclass(frozen=True)
class Options:
    names: bool = False
    number: bool = False
    text: bool = False
    reprint: bool = False
    tta: bool = False
    art: bool = False
    base: bool = False
    numberonce: bool = False  # a read number moves a printing up once, not twice (name search's and the number lookup's)
    fastread: bool = False  # read the text with a shorter ladder (no black-and-white or glare-removal steps) and a lower time budget

    @property
    def label(self) -> str:
        parts = [name for name in ORDER if getattr(self, name)]
        return "+".join(parts) or "baseline"


def parse(label: str | None) -> Options:
    """``"names+art"`` -> Options. Unknown words are ignored; ``baseline`` / empty = nothing on."""
    words = {word.strip().lower() for word in str(label or "").replace(",", "+").split("+")}
    if "reprint" in words:
        words.add("art")  # the tie-break reads the artwork-only similarity
    return Options(**{name: name in words for name in ORDER})


def needed_indexes(options: Options) -> list[str]:
    """Names of the picture indexes (besides the default one) an option set reads."""
    return ([ART_INDEX] if options.art else []) + ([BASE_MODEL] if options.base else [])


def missing_indexes(options: Options, data_dir: Path | None = None) -> list[str]:
    from . import index as index_module

    out = []
    for name in needed_indexes(options):
        status = index_module.index_status(name, data_dir)
        if not status.get("built") or not status.get("count"):
            out.append(name)
    return out


def chosen_path(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / "chosen.json"


def active_label(data_dir: Path | None = None) -> str:
    env = os.environ.get("CARD_MATCH_OPTIONS")
    if env is not None and env.strip():
        return parse(env).label
    try:
        chosen = json.loads(chosen_path(data_dir).read_text(encoding="utf-8"))
        # A file written by an older matcher version chose among older option sets on older rules: it must not hold
        # back this version's default. The next real-photo comparison writes a new one.
        from . import MATCHER_VERSION

        if str(chosen.get("matcher_version")) != str(MATCHER_VERSION):
            return parse(DEFAULT_LABEL).label
        return parse(chosen.get("label")).label
    except (OSError, ValueError, AttributeError):
        return parse(DEFAULT_LABEL).label


def usable(options: Options, data_dir: Path | None = None) -> Options:
    """The options with the parts whose picture index is not built left out; the name, number, text, extra-view
    and reading options still run, so a half-built setup still answers."""
    from dataclasses import replace

    missing = missing_indexes(options, data_dir)
    if not missing:
        return options
    return replace(options, art=options.art and ART_INDEX not in missing, base=options.base and BASE_MODEL not in missing,
                   reprint=options.reprint and ART_INDEX not in missing)


def save_chosen(label: str, reason: str, data_dir: Path | None = None) -> None:
    from . import MATCHER_VERSION

    path = chosen_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"label": parse(label).label, "reason": reason, "matcher_version": MATCHER_VERSION}), encoding="utf-8")


_matchers: dict = {}


def build_matcher(options: Options, session_factory, *, data_dir: Path | None = None, ocr_reader=None, read_hp: bool = False):
    """Cached per option set and index build, so the scan queue does not rebuild it for every photo."""
    index = None
    try:
        from . import index as index_module

        index = index_module.get_index(DEFAULT_MODEL, data_dir)
    except Exception:
        pass
    key = (options, id(index), len(index) if index is not None else 0, id(session_factory), id(ocr_reader), read_hp, str(data_dir),
           tuple(len(ix) for ix in (index_module.get_index(n, data_dir) for n in needed_indexes(options)) if ix is not None) if index is not None else ())
    cached = _matchers.get("last")
    if cached and cached[0] == key:
        return cached[1]
    matcher = _build_matcher(options, session_factory, data_dir=data_dir, ocr_reader=ocr_reader, read_hp=read_hp)
    _matchers["last"] = (key, matcher)
    return matcher


def _build_matcher(options: Options, session_factory, *, data_dir: Path | None = None, ocr_reader=None, read_hp: bool = False):
    """A CardMatcher with these options. Raises RuntimeError when the default index is missing; an extra
    index that is not built leaves that option out (logged), so a half-built setup still answers."""
    from . import embed, index as index_module, lookup as lookup_module, names as names_module, pipeline
    from .ocr import get_reader

    index = index_module.get_index(DEFAULT_MODEL, data_dir)
    if index is None or len(index) == 0:
        raise RuntimeError("The picture index is empty: build it first")
    signals = []
    if options.art:
        art = index_module.get_index(ART_INDEX, data_dir)
        if art is not None and len(art):
            signals.append(pipeline.Signal("art", art, embed.get_embedder(DEFAULT_MODEL), crop="art"))
        else:
            logger.info("Card-match: the artwork index is not built; running without it")
    if options.base:
        base = index_module.get_index(BASE_MODEL, data_dir)
        if base is not None and len(base) and embed.model_available(BASE_MODEL):
            signals.append(pipeline.Signal("base", base, embed.get_embedder(BASE_MODEL)))
        else:
            logger.info("Card-match: the DINOv2-base index is not built; running without it")
    names = names_module.get_name_index(session_factory, index) if options.names else None
    lookup = lookup_module.get_lookup_index(session_factory, index) if (options.number or options.text) else None
    return pipeline.CardMatcher(
        index, embed.get_embedder(DEFAULT_MODEL), pipeline.db_candidate_loader(session_factory), ocr_reader or get_reader(),
        read_hp=read_hp, extra_signals=signals, tta=options.tta, names=names, label=options.label, fastread=options.fastread, number_once=options.numberonce,
        lookup=lookup, use_number=options.number, use_text=options.text, reprint=options.reprint,
    )


def index_specs() -> dict[str, dict]:
    """The picture indexes that can be built: name -> {model, crop, label}."""
    return {
        DEFAULT_MODEL: {"model": DEFAULT_MODEL, "crop": "full", "label": "whole card (DINOv2-small)"},
        ART_INDEX: {"model": DEFAULT_MODEL, "crop": "art", "label": "artwork only (DINOv2-small)"},
        BASE_MODEL: {"model": BASE_MODEL, "crop": "full", "label": "whole card (DINOv2-base)"},
    }


assert BASE_MODEL in MODEL_SPECS
