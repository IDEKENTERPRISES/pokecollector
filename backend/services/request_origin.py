"""Cross-origin policy helpers.

The web UI is served by the same nginx that proxies /api, so browsers talk to the
API same-origin and never need CORS. Native clients (an iPhone app, scripts) send
no Origin header at all. Allowing every origin therefore only ever helps a hostile
page: in single-user mode requests without a token are treated as the administrator,
so any website the owner opened could read or change their collection.

Two layers:

* CORS is closed unless CORS_ORIGINS names specific origins.
* Browsers send CORS-exempt "simple" requests (a multipart or form POST, such as
  the database restore upload) cross-site without a preflight, so closing CORS
  alone does not stop them from *acting*. State-changing requests that carry no
  bearer token and a foreign Origin are refused outright.
"""

from __future__ import annotations

import logging
import os
from typing import Mapping
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def parse_allowed_origins(raw: str | None) -> list[str]:
    """Split CORS_ORIGINS into a clean list. Empty means no cross-origin access."""
    origins = []
    for part in (raw or "").split(","):
        origin = part.strip().rstrip("/")
        if origin:
            origins.append(origin)
    if "*" in origins:
        logger.warning(
            "CORS_ORIGINS contains '*'. Any website can then call this API from a "
            "browser; list your own origin(s) instead."
        )
    return origins


def allowed_origins_from_env() -> list[str]:
    return parse_allowed_origins(os.environ.get("CORS_ORIGINS"))


def _hostname_of_host_header(host: str) -> str:
    host = (host or "").strip().lower()
    if host.startswith("["):  # [::1]:3000
        return host[1:].split("]", 1)[0]
    return host.split(":", 1)[0]


def is_cross_site_unauthenticated_write(
    method: str,
    headers: Mapping[str, str],
    allowed_origins: list[str],
) -> bool:
    """True for a browser write that carries no token and comes from a foreign site."""
    if method.upper() not in UNSAFE_METHODS:
        return False
    if headers.get("authorization"):
        # A bearer token cannot be attached by a cross-site form or image tag.
        return False
    origin = (headers.get("origin") or "").strip()
    if not origin:
        # Not a browser cross-origin request (native app, curl, same-origin GET...).
        return False
    if "*" in allowed_origins or origin.rstrip("/") in allowed_origins:
        return False
    if origin.lower() == "null":
        return True
    origin_host = (urlparse(origin).hostname or "").lower()
    request_host = _hostname_of_host_header(headers.get("host", ""))
    # Compare hostnames only: nginx forwards Host without the port, while the
    # browser's Origin includes it.
    return not origin_host or origin_host != request_host
