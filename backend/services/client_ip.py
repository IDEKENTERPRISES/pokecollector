"""Work out which client a request really came from.

The backend sits behind the bundled nginx (and usually a reverse proxy such as Nginx
Proxy Manager in front of that), so the TCP peer is always a proxy on a private
network. Keying rate limits on that peer put every user in one bucket: five wrong
passwords from anyone locked everybody out of logging in.

Forwarding headers are only believed when the peer is itself a private/loopback
address. A client that reaches the backend directly over a public address cannot
spoof its way to a different bucket by sending ``X-Forwarded-For``.
"""

from __future__ import annotations

import ipaddress
from typing import Optional


def _parse_ip(value: str) -> Optional[ipaddress._BaseAddress]:
    try:
        ip = ipaddress.ip_address(value.strip())
    except ValueError:
        return None
    # "::ffff:10.0.0.1" is the IPv4 address 10.0.0.1.
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped if mapped is not None else ip


def _is_internal(ip: ipaddress._BaseAddress) -> bool:
    """Not globally routable: private, loopback, link-local, CGNAT (Tailscale), reserved."""
    return not ip.is_global


def client_ip_from(peer: str | None, forwarded_for: str | None, real_ip: str | None) -> str:
    """Pick the client address from the socket peer and proxy headers."""
    peer = (peer or "").strip()
    peer_ip = _parse_ip(peer)
    if peer_ip is None or not _is_internal(peer_ip):
        # A direct connection from the public internet: headers cannot be trusted.
        return peer or "unknown"

    hops = [ip for ip in (_parse_ip(part) for part in (forwarded_for or "").split(",")) if ip is not None]
    # Each proxy appends the address it saw, so the rightmost public entry is the
    # one added by our own infrastructure; anything left of it is client-supplied.
    for ip in reversed(hops):
        if not _is_internal(ip):
            return str(ip)
    if hops:
        # Everyone is on a private network (a LAN install): use the originating hop.
        return str(hops[0])

    real = _parse_ip(real_ip or "")
    if real is not None:
        return str(real)
    return peer


def client_ip(request) -> str:
    """The client address for a Starlette/FastAPI request."""
    peer = request.client.host if request.client else None
    return client_ip_from(
        peer,
        request.headers.get("x-forwarded-for"),
        request.headers.get("x-real-ip"),
    )
