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
  - ``fastread``: read the text with a shorter ladder (no black-and-white or glare-removal steps) and a lower budget;
  - ``corners`` (version 8): the card finder judges every quad it finds (shape, share of the picture, rectangle-ness) and
    refuses implausible ones; with none left the plain guide crop is the card (the refused quad is recorded for Scanner lab);
  - ``wholepic`` (version 8, needs ``corners``): a refused quad leaves the whole picture as the card instead of the centre
    guide crop, because a card that fills the guide crop has its edges at the picture border;
  - ``trustrejected`` (version 8, needs ``corners``): a card read from the guide crop because the finder REFUSED its quad is
    decided by the normal rules, not the strict "number read and picture agrees" fallback ones;
  - ``wholeread`` (version 9): a guide picture whose number the normal read did not complete is read once more from the whole
    picture treated as the card (the first steps only, inside the same time budget), merged with the first reading;
  - ``wholestrict`` (version 10, needs ``wholeread``): a number that came only from the whole-picture second read may decide only
    under stricter rules (``pipeline.whole_number_problem``): the set total was read and fits, the card is the picture's first or
    second pick with a higher similarity, no known name contradicts it, and the number line was read with high confidence.
  - ``custom``: the whole-card and artwork searches use the newest uploaded custom picture model (``custom_models.py``) and its two
    indexes (``custom-<sha8>``, ``custom-<sha8>-art``); it turns on ``art``. Without those indexes the row shows them as missing.
    (``wholeview``, version 9, was removed in version 10: it added almost nothing and cost time.)
  - ``widefirst`` (version 12 test): a card whose two tight number strips detect no text at all reads the whole bottom band next
    (``ocr.OcrReader.read``), and skips the sharp / contrast steps when that finds nothing either;
  - ``topname`` (version 12 test): when the name-line and name-band reads detect no line, the name is taken from the top band's lines
    (``names.pick_top_line``: name-like and known to the catalogue). Both are off by default and only comparison rows.
  - ``edgeguard`` (version 14 test, needs ``corners``): an outline in the full frame that touches two or more frame edges, or is over 1.6x the
    guide's area, is not trusted (a sleeve, binder page or table edge, not the card): the card is looked for inside the guide region,
    else the guide crop is the card. The reason is recorded in the detection info. Off by default; a comparison row only.
A label is the options joined by ``+``: ``baseline`` (none), ``names``, ``names+number``, ``names+number+text+tta`` ...

The label in use comes from ``CARD_MATCH_OPTIONS``, else from ``chosen.json`` (written when a comparison
finds a clear winner), else ``names``. Indexes an option needs that are not built yet make that label
unavailable (``missing_indexes``); the matcher in use then falls back to the plain whole-card search.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, replace
from pathlib import Path

from . import config, custom_models
from .model_specs import DEFAULT_MODEL, MODEL_SPECS

logger = logging.getLogger(__name__)

BASE_MODEL = "dinov2-base"
ART_INDEX = f"{DEFAULT_MODEL}-art"  # the artwork-window index of the default model
V12_WORDS = ("widefirst", "topname")  # version 12 test options: server only, off by default
V14_WORDS = ("edgeguard",)  # version 14 test option: off by default
CUSTOM_WORDS = ("custom",)  # the newest uploaded custom picture model
BEST_V8 = "names+number+text+art+tta+fastread+corners+wholepic"
IN_USE = "names+number+text+art+tta+fastread+numberonce+corners+wholepic"  # picked on the server with version 9: 67.4% decided, 0 wrong, p95 1,431 ms
DEFAULT_LABEL = IN_USE  # an unbuilt artwork index is left out, see ``usable``
# The labels the comparison runs, cheapest first.
# The lookup lanes come one at a time right after ``names`` so each one's gain shows as its own row.
# Version 10 has ten rows: the steps up to the set in use (``IN_USE``), the one in use, and on top of it ``wholeread`` and
# ``wholeread+wholestrict``. It drops the three ``wholeview`` rows (no gain, slower) and ``BEST_V8`` without ``numberonce``
# (measured against the set in use with version 9: 66.3% decided against 67.4%, both 0 wrong).
KEPT_LABEL = IN_USE + "+wholeread+wholestrict"  # the kept set: 72.1% decided, 0 wrong on the real photos
NO_STRICT_LABEL = IN_USE + "+wholeread"  # the kept set without ``wholestrict``
BEST_EXISTING_LABEL = KEPT_LABEL + "+widefirst"  # the best existing row, which the server picked with version 12
COMPARE_LABELS = (
    "baseline", "names", "names+number", "names+number+text", "names+number+text+art",
    "names+number+text+art+tta+fastread", "names+number+text+art+tta+fastread+corners", IN_USE,
    IN_USE + "+wholeread", IN_USE + "+wholeread+wholestrict",
    # Version 12 test: the kept set with each new reading option, and both.
    KEPT_LABEL + "+widefirst", KEPT_LABEL + "+topname", KEPT_LABEL + "+widefirst+topname",
    # The kept set without ``wholestrict``, with each reading option (picked on 18 Nov 2026: the pin).
    NO_STRICT_LABEL + "+topname", NO_STRICT_LABEL + "+widefirst+topname",
    # The newest uploaded custom picture model in the kept set, and in the kept set without ``wholestrict``.
    KEPT_LABEL + "+custom", NO_STRICT_LABEL + "+custom",
    # Version 14 test: the set in use (the pin) and the kept set, each with the edge guard.
    NO_STRICT_LABEL + "+widefirst+topname+edgeguard", KEPT_LABEL + "+edgeguard",
)
# The synthetic comparison chooses nothing, so it runs a short list on fewer photos
# (version 5: 10 rows x 400 photos took 89 minutes).
SYNTHETIC_COMPARE_LABELS = (
    "baseline", "names+number+text", "names+number+text+art+tta", "names+number+text+art+tta+fastread",
)
SYNTHETIC_COMPARE_COUNT = 100


def _base_compare_title(label: str) -> str:
    """A short readable name for a comparison row (the kept sets are named, the rest list their options)."""
    if label == "baseline":
        return "Baseline (picture only)"
    for prefix, name in ((BEST_EXISTING_LABEL, "Kept set + widefirst"), (KEPT_LABEL, "Kept set"),
                         (NO_STRICT_LABEL, "Kept set without wholestrict"), (IN_USE, "In-use set (v9)")):
        if label == prefix:
            return name
        if label.startswith(prefix + "+"):
            return name + " + " + " + ".join(label[len(prefix) + 1:].split("+"))
    return " + ".join(label.split("+"))


def compare_title(label: str) -> str:
    """The readable row name."""
    return _base_compare_title(label)


def compare_group(label: str) -> str:
    """Where a comparison row sits in the picker: history, v10 kept, v12 or custom."""
    options = parse(label)
    if options.custom:
        return "custom"
    if options.edgeguard:
        return "v14"
    if options.widefirst or options.topname:
        return "v12"
    if options.wholeread:
        return "v10 kept"
    return "history"


def compare_reference_labels(labels=None, data_dir: Path | None = None) -> list[str]:
    """The rows a partial comparison always runs: the label in use (when it is one of the rows) and the kept set,
    in the order of ``labels`` (default: ``COMPARE_LABELS``)."""
    labels = tuple(labels or COMPARE_LABELS)
    wanted = {parse(active_label(data_dir)).label, parse(KEPT_LABEL).label}
    return [label for label in labels if parse(label).label in wanted]


ORDER = ("names", "number", "text", "art", "reprint", "base", "tta", "fastread", "numberonce", "corners", "wholepic", "trustrejected", "wholeread", "wholestrict")


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
    corners: bool = False  # the finder refuses implausible quads (shape, share of the picture); the guide crop is used instead
    wholepic: bool = False  # a refused quad: the whole picture is the card, not the centre guide crop (needs corners)
    trustrejected: bool = False  # a refused quad: the guide-crop card is decided by the normal rules (needs corners)
    wholeread: bool = False  # version 9: a guide picture without a complete number is read once more from the whole picture
    wholestrict: bool = False  # version 10: a number read only from the whole picture decides only under stricter rules (needs wholeread)
    widefirst: bool = False  # version 12 test: no text in the tight number strips -> read the whole bottom band next
    topname: bool = False  # version 12 test: no line in the name strips -> take the name from the top band's lines

    edgeguard: bool = False  # version 14 test: an outline touching 2+ frame edges or far bigger than the guide is not trusted (needs corners)

    custom: bool = False  # the newest uploaded custom picture model and its two indexes (needs art, so turns it on)

    @property
    def label(self) -> str:
        parts = [name for name in ORDER + V12_WORDS + V14_WORDS + CUSTOM_WORDS if getattr(self, name)]
        return "+".join(parts) or "baseline"


def parse(label: str | None) -> Options:
    """``"names+art"`` -> Options. Unknown words are ignored; ``baseline`` / empty = nothing on."""
    words = {word.strip().lower() for word in str(label or "").replace(",", "+").split("+")}
    if "reprint" in words:
        words.add("art")  # the tie-break reads the artwork-only similarity
    if "custom" in words:
        words.add("art")  # the custom model has an artwork index too
    if "wholestrict" in words:
        words.add("wholeread")  # it judges the number the second read produced
    if "wholepic" in words or "trustrejected" in words or "edgeguard" in words:
        words.add("corners")  # both act on a quad the finder refused
    return Options(**{name: name in words for name in ORDER + V12_WORDS + V14_WORDS + CUSTOM_WORDS})


def model_name(options: Options, data_dir: Path | None = None) -> str:
    return custom_models.newest_name(data_dir) if options.custom else DEFAULT_MODEL


def main_index_name(options: Options, data_dir: Path | None = None) -> str:
    return model_name(options, data_dir)


def art_index_name(options: Options, data_dir: Path | None = None) -> str:
    return custom_models.art_name(model_name(options, data_dir)) if options.custom else ART_INDEX


def needed_indexes(options: Options, data_dir: Path | None = None) -> list[str]:
    """Names of the picture indexes (besides the default one) an option set reads. A custom row reads the custom
    model's whole-card index too, and has none to read (``custom-none``) until a model is uploaded."""
    return (
        ([main_index_name(options, data_dir)] if options.custom else [])
        + ([art_index_name(options, data_dir)] if options.art else []) + ([BASE_MODEL] if options.base else [])
    )


def missing_indexes(options: Options, data_dir: Path | None = None) -> list[str]:
    from . import index as index_module

    out = []
    for name in needed_indexes(options, data_dir):
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
    missing = missing_indexes(options, data_dir)
    if not missing:
        return options
    if options.custom and (main_index_name(options, data_dir) in missing or art_index_name(options, data_dir) in missing):
        return usable(replace(options, custom=False), data_dir)  # no custom indexes: the default model's search
    art = art_index_name(options, data_dir)
    return replace(options, art=options.art and art not in missing, base=options.base and BASE_MODEL not in missing,
                   reprint=options.reprint and art not in missing)


def save_chosen(label: str, reason: str, data_dir: Path | None = None) -> None:
    from . import MATCHER_VERSION

    path = chosen_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"label": parse(label).label, "reason": reason, "matcher_version": MATCHER_VERSION}), encoding="utf-8")


_matchers: dict = {}


def build_matcher(options: Options, session_factory, *, data_dir: Path | None = None, ocr_reader=None, read_hp: bool = False):
    """Cached per option set and index build, so the scan queue does not rebuild it for every photo."""
    from . import index as index_module

    index = None
    try:
        index = index_module.get_index(main_index_name(options, data_dir), data_dir)
    except Exception:
        pass
    key = (options, id(index), len(index) if index is not None else 0, id(session_factory), id(ocr_reader), read_hp, str(data_dir),
           tuple(len(ix) for ix in (index_module.get_index(n, data_dir) for n in needed_indexes(options, data_dir)) if ix is not None) if index is not None else ())
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

    embedder = embed.get_embedder(model_name(options, data_dir))
    index = index_module.get_index(main_index_name(options, data_dir), data_dir)
    if index is None or len(index) == 0:
        raise RuntimeError("The picture index is empty: build it first")
    signals = []
    if options.art:
        art = index_module.get_index(art_index_name(options, data_dir), data_dir)
        if art is not None and len(art):
            signals.append(pipeline.Signal("art", art, embedder, crop="art"))
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
        index, embedder, pipeline.db_candidate_loader(session_factory), ocr_reader or get_reader(),
        read_hp=read_hp, extra_signals=signals, tta=options.tta, names=names, label=options.label, fastread=options.fastread, number_once=options.numberonce,
        corners=options.corners, edgeguard=options.edgeguard, wholepic=options.wholepic, trustrejected=options.trustrejected,
        wholeread=options.wholeread, wholestrict=options.wholestrict, widefirst=options.widefirst, topname=options.topname,
        lookup=lookup, use_number=options.number, use_text=options.text, reprint=options.reprint,
    )


def index_specs(data_dir: Path | None = None) -> dict[str, dict]:
    """The picture indexes that can be built: name -> {model, crop, label}."""
    specs = {
        DEFAULT_MODEL: {"model": DEFAULT_MODEL, "crop": "full", "label": "whole card (DINOv2-small)"},
        ART_INDEX: {"model": DEFAULT_MODEL, "crop": "art", "label": "artwork only (DINOv2-small)"},
        BASE_MODEL: {"model": BASE_MODEL, "crop": "full", "label": "whole card (DINOv2-base)"},
    }
    for entry in custom_models.list_models(data_dir):  # uploaded models: two indexes each
        name = entry["id"]
        specs[name] = {"model": name, "crop": "full", "label": f"whole card ({entry['name']})", "custom": True}
        specs[custom_models.art_name(name)] = {"model": name, "crop": "art", "label": f"artwork only ({entry['name']})", "custom": True}
    return specs


assert BASE_MODEL in MODEL_SPECS
