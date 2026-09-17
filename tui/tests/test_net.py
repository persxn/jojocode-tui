"""The user-agent regression.

Cloudflare's browser-integrity check answers `403 error code: 1010` to the
string `Python-urllib/3.x`, which is what urllib sends when nobody sets a
header. That single default made every hosted login impossible. These tests
assert that no outbound request can go out unnamed again.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jojocode_ai import auth, net  # noqa: E402
from jojocode_ai.wsjson import WSClient  # noqa: E402


def test_user_agent_names_the_product_and_is_not_urllib():
    assert net.USER_AGENT.startswith("JojoAI/")
    assert "urllib" not in net.USER_AGENT.lower()
    assert "ai.jojocode.in" in net.USER_AGENT


def test_headers_adds_the_agent_and_keeps_the_rest():
    h = net.headers({"Content-Type": "application/json"})
    assert h["User-Agent"] == net.USER_AGENT
    assert h["Content-Type"] == "application/json"


def test_headers_survives_no_extras():
    assert net.headers()["User-Agent"] == net.USER_AGENT


def test_login_post_sends_the_agent(monkeypatch):
    """The exact request that used to come back 403."""
    seen = {}

    class FakeResponse:
        status = 200

        def read(self):
            return json.dumps({"ok": True}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        seen["ua"] = req.get_header("User-agent")
        return FakeResponse()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    status, _ = auth._post("https://ai.jojocode.in/api/auth/otp/request", {"email": "a@b.co"})
    assert status == 200
    assert seen["ua"] == net.USER_AGENT
    assert not seen["ua"].startswith("Python-urllib")


def test_websocket_handshake_carries_the_agent():
    ws = WSClient("wss://ai.jojocode.in/agent", {"Authorization": "Bearer t"})
    assert ws.headers["User-Agent"] == net.USER_AGENT
    assert ws.headers["Authorization"] == "Bearer t"
