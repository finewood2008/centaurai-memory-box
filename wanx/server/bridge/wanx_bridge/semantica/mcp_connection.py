"""Advertise the authenticated request's public HTTPS origin, never an internal upstream."""

import ipaddress
import re
from urllib.parse import urlsplit

from .client import SemanticaError


def connection_info(request):
    # ASGI scheme is set by TLS or the deployment's trusted-proxy middleware.
    # Do not independently trust caller-supplied Forwarded/X-Forwarded-* values.
    try:
        base = str(request.base_url)
        value = urlsplit(base)
        host = (value.hostname or "").lower().rstrip(".")
        hosts = request.headers.getlist("host")
        # Some Starlette versions silently replace an invalid Host with the
        # listening address. Do not advertise that fallback as an external URL.
        if hosts and (len(hosts) != 1 or hosts[0].lower() != value.netloc.lower()):
            raise ValueError("ambiguous or malformed host")
        port = value.port
        try:
            internal = not ipaddress.ip_address(host).is_global
        except ValueError:
            labels = host.split(".")
            internal = (
                host in {"localhost", "testserver"}
                or host.endswith((".localhost", ".local"))
                or len(labels) < 2
                or len(host) > 253
                or any(
                    not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                    for label in labels
                )
                # URL clients may interpret these as shorthand/octal/hex IPv4,
                # e.g. 127.1 or 0x7f.0.0.1, although ipaddress rejects them.
                or re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", labels[-1]) is not None
            )
        if (
            value.scheme != "https"
            or not host
            or internal
            or port == 0
            or value.username
            or value.password
            or value.query
            or value.fragment
            or "%" in value.netloc
            or "\\" in value.netloc
        ):
            raise ValueError("no public HTTPS origin")
    except ValueError:
        raise SemanticaError("MCP_PUBLIC_URL_UNAVAILABLE", 503) from None
    return {"url": base.rstrip("/") + "/mcp/starlink"}
