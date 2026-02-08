"""SSRF guard: validates URLs before fetching to block private/internal IPs.

Must be called before every outbound HTTP request, especially for
user-supplied URLs (e.g. Admin "Test selectors" button).
"""

import ipaddress
import socket
import logging
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

BLOCKED_NETWORKS = [
    ipaddress.ip_network('127.0.0.0/8'),       # loopback
    ipaddress.ip_network('10.0.0.0/8'),         # private class A
    ipaddress.ip_network('172.16.0.0/12'),      # private class B
    ipaddress.ip_network('192.168.0.0/16'),     # private class C
    ipaddress.ip_network('169.254.0.0/16'),     # link-local
    ipaddress.ip_network('::1/128'),            # IPv6 loopback
    ipaddress.ip_network('fc00::/7'),           # IPv6 unique-local
    ipaddress.ip_network('fe80::/10'),          # IPv6 link-local
]

ALLOWED_SCHEMES = ('http', 'https')

# Max response body size: 5 MB
MAX_RESPONSE_SIZE = 5 * 1024 * 1024


def validate_url_safe(url: str) -> str:
    """
    Validate that a URL is safe to fetch (no SSRF).

    Checks:
    - Scheme must be http or https
    - Hostname must resolve to a public IP (not private/loopback/link-local)

    Args:
        url: The URL to validate

    Returns:
        The validated URL (stripped)

    Raises:
        ValueError: If the URL is unsafe
    """
    url = url.strip()
    parsed = urlparse(url)

    if parsed.scheme not in ALLOWED_SCHEMES:
        raise ValueError(f"URL scheme not allowed: {parsed.scheme!r} (must be http or https)")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL has no hostname")

    # Resolve hostname to IP and check against blocked ranges
    try:
        resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        if not resolved:
            raise ValueError(f"DNS resolution returned no results for: {hostname}")

        for family, _type, _proto, _canonname, sockaddr in resolved:
            ip_str = sockaddr[0]
            try:
                ip = ipaddress.ip_address(ip_str)
                for net in BLOCKED_NETWORKS:
                    if ip in net:
                        raise ValueError(
                            f"URL resolves to blocked private/internal IP: {ip} (hostname: {hostname})"
                        )
            except ValueError as ve:
                if 'blocked' in str(ve).lower() or 'private' in str(ve).lower():
                    raise
                # ip_address() parsing error -- skip this entry
                continue

    except socket.gaierror as e:
        raise ValueError(f"DNS resolution failed for hostname: {hostname} ({e})")

    return url
