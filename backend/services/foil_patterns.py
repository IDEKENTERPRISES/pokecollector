"""Foil pattern ids a collection copy may be pinned to (holo viewer, P3)."""

FOIL_PATTERNS = (
    "holo",
    "reverse",
    "cracked-ice",
    "cosmos",
    "etched",
    "rainbow",
    "gold",
    "pokeball-reverse",
    "radiant",
    "amazing",
    "v-full-art",
    "vmax",
    "vstar",
    "trainer-gallery",
    "shiny",
    "illustration-rare",
    "special-illustration",
)


def normalize_foil_pattern(value):
    """Return a valid pattern id, or None for automatic. Raises ValueError otherwise."""
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip().lower()
        if not cleaned:
            return None
        if cleaned in FOIL_PATTERNS:
            return cleaned
    raise ValueError(f"foil_pattern must be one of: {', '.join(FOIL_PATTERNS)}")
