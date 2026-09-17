"""The one place that says who we are on the wire.

── Why this file exists ────────────────────────────────────────────────────

`urllib.request` sends `User-Agent: Python-urllib/3.13` unless you tell it
otherwise, and Cloudflare's browser-integrity check bans that string outright:
every request from the TUI to `https://ai.jojocode.in` came back **403 with
`error code: 1010`** before it reached the server at all. Login could not
possibly work, however correct the email, the code, or the server was — and the
error the user saw, `otp request failed (HTTP 403)`, pointed at the account
rather than at the header that was actually to blame.

Any other user-agent passes. So every outbound request the TUI makes names
itself, in one place, and the identity is real: product, version, platform, and
a URL a server operator can look up before deciding to block us.

`websearch.py` keeps its own browser-shaped agent deliberately — that one talks
to strangers' websites, not to our own service, and is a different negotiation.
"""

from __future__ import annotations

import platform

from . import __version__

USER_AGENT = (
    f"JojoAI/{__version__} ({platform.system()} {platform.machine()}; "
    f"Python/{platform.python_version()}; +https://ai.jojocode.in)"
)


def headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Outbound headers with the agent already set (and never overwritten)."""
    h = {"User-Agent": USER_AGENT}
    if extra:
        h.update(extra)
        h["User-Agent"] = extra.get("User-Agent", USER_AGENT)
    return h
