"""RemoteAgent — the same event stream as `agent.Agent`, but the loop runs on a
server.

`agent.Agent.run()` yields ("user"|"thinking"|"assistant"|"tool_start"|
"tool_end"|"tool_denied"|"final"|"error"|"stats"|"info"|"turn_end", …). The TUI
consumes exactly that, from a worker thread, and doesn't care where the tokens
come from. RemoteAgent speaks the WebSocket wire protocol
(`server/shared/src/protocol.ts`) instead of calling Ollama:

  hello ─▶                       ◀─ session_ready {sessionId, seatNo, resumeToken}
  user_turn ─▶                   ◀─ thinking_delta / assistant_delta
                                 ◀─ tool_request {id, name, args, destructive}
  tool_result {id, …} ─▶         ◀─ turn_done {usage, stopReason}

Tools execute locally (`remote_exec`), path-jailed to the project root, with the
user's approval on every destructive call. A per-id journal makes tool execution
exactly-once across a reconnect: on resume the server replays unanswered
requests and we reply from the journal without re-running the side effect.
"""

from __future__ import annotations

import platform
import threading
import time
from types import SimpleNamespace

from . import __version__, remote_exec
from .config import Config
from .wsjson import WSClient, WSClosed, WSError

_RESULT_KEYS = ("ok", "stdout", "stderr", "exitCode", "content",
                "bytesWritten", "refused", "error", "durationMs")


def ws_url(endpoint: str) -> str:
    e = endpoint.rstrip("/")
    if e.startswith("https://"):
        e = "wss://" + e[len("https://"):]
    elif e.startswith("http://"):
        e = "ws://" + e[len("http://"):]
    return e + "/agent"


class RemoteAgent:
    def __init__(self, cfg: Config, token: str, approver=None):
        self.cfg = cfg
        self.endpoint = (cfg.remote_endpoint or "").rstrip("/")
        self.token = token
        self.approver = approver or (lambda n, a: True)
        self.project_label = cfg.project_label

        # attributes the TUI pokes at — kept compatible with agent.Agent
        self.store = None
        self.messages: list[dict] = []
        self.ctx = SimpleNamespace(cwd=cfg.cwd)
        self.client = SimpleNamespace(
            model=cfg.model,
            version=lambda: f"remote {self.endpoint}",
            has_model=lambda _m: True,
        )

        self._ws: WSClient | None = None
        self._interrupt = False
        self._resume_ok = False
        self._stop = False
        self._hb: threading.Thread | None = None
        self.session_id = ""
        self.resume_token: str | None = None
        self.seat = 0
        self.journal: dict[str, dict] = {}

    # -- TUI-facing control ------------------------------------------- #
    def interrupt(self) -> None:
        self._interrupt = True

    def reset(self) -> None:
        self._hard_close()
        self.resume_token = None
        self.journal.clear()
        self.messages.clear()

    def close(self) -> None:
        self._stop = True
        if self._ws:
            try:
                self._ws.send_json({"t": "bye", "reason": "user_quit"})
            except (WSError, OSError):
                pass
        self._hard_close()

    # -- connection ------------------------------------------------- #
    def _hard_close(self) -> None:
        w, self._ws = self._ws, None
        if w:
            try:
                w.close()
            except OSError:
                pass

    def _connect(self, *, resume: bool) -> None:
        ws = WSClient(ws_url(self.endpoint))
        ws.connect()
        hello = {
            "t": "hello",
            "protocol": 1,
            "token": self.token,
            "client": {"version": __version__, "os": platform.system(),
                       "arch": platform.machine()},
            "projectLabel": self.project_label,
        }
        if resume and self.resume_token:
            hello["resumeToken"] = self.resume_token
        ws.send_json(hello)
        msg = ws.recv_json(timeout=25)
        if not msg:
            raise WSError("no session_ready from server")
        if msg.get("t") == "closing":
            raise WSError(msg.get("reason", "server refused the connection"))
        if msg.get("t") != "session_ready":
            raise WSError(f"unexpected first frame: {msg.get('t')}")
        self._ws = ws
        self.session_id = msg["sessionId"]
        self.resume_token = msg["resumeToken"]
        self.seat = msg.get("seatNo", 0)
        self._resume_ok = True
        self._start_heartbeat()

    def _ensure(self) -> None:
        if self._ws is None:
            self._connect(resume=False)

    def _reconnect(self) -> bool:
        for attempt in range(3):
            try:
                self._connect(resume=True)
                return True
            except (WSError, WSClosed, OSError):
                time.sleep(1.5 * (attempt + 1))
        return False

    def _start_heartbeat(self) -> None:
        if self._hb and self._hb.is_alive():
            return

        def beat() -> None:
            while not self._stop and self._ws is not None:
                time.sleep(25)
                try:
                    if self._ws:
                        self._ws.send_json({"t": "heartbeat"})
                except (WSError, WSClosed, OSError):
                    return

        self._hb = threading.Thread(target=beat, daemon=True)
        self._hb.start()

    # -- the turn ------------------------------------------------- #
    def run(self, text: str):
        self._interrupt = False
        yield ("user", text)
        self.messages.append({"role": "user", "content": text})

        try:
            self._ensure()
        except (WSError, WSClosed, OSError) as e:
            yield ("error", f"cannot connect to {self.endpoint}: {e}")
            yield ("turn_end",)
            return

        try:
            self._ws.send_json({"t": "user_turn", "text": text})  # type: ignore[union-attr]
        except (WSError, WSClosed, OSError):
            if not self._reconnect():
                yield ("error", "connection lost and could not resume")
                yield ("turn_end",)
                return
            self._ws.send_json({"t": "user_turn", "text": text})  # type: ignore[union-attr]

        streamed = False
        while True:
            try:
                msg = self._ws.recv_json(timeout=1.0)  # type: ignore[union-attr]
            except WSClosed as e:
                if self._resume_ok and not self._interrupt and self._reconnect():
                    yield ("info", "connection dropped — resumed")
                    continue
                yield ("error", f"disconnected: {e}")
                break
            except WSError as e:
                yield ("error", str(e))
                break

            if msg is None:  # idle tick
                if self._interrupt:
                    try:
                        self._ws.send_json({"t": "interrupt"})  # type: ignore[union-attr]
                    except (WSError, WSClosed, OSError):
                        pass
                continue

            t = msg.get("t")
            if t == "thinking_delta":
                yield ("thinking", msg.get("text", ""))
            elif t == "assistant_delta":
                streamed = True
                yield ("assistant", msg.get("text", ""))
            elif t == "tool_request":
                yield from self._tool(msg)
            elif t == "replay_begin":
                yield ("info", f"reconnected — replaying {msg.get('count', 0)} tool call(s)")
            elif t == "replay_end":
                pass
            elif t == "queued":
                yield ("info", f"queued — position {msg.get('position')} "
                               f"({msg.get('aheadOf')} ahead)")
            elif t == "session_ready":  # a mid-turn resume landed
                self.session_id = msg["sessionId"]
                self.resume_token = msg["resumeToken"]
            elif t == "turn_done":
                u = msg.get("usage", {})
                yield ("stats", {
                    "prompt_eval_count": u.get("tokensIn"),
                    "eval_count": u.get("tokensOut"),
                    "eval_duration": (u.get("modelMs") or 0) * 1_000_000 or None,
                })
                if not streamed:
                    yield ("final", "")
                self.messages.append({"role": "assistant", "content": ""})
                break
            elif t == "error":
                yield ("error", f"{msg.get('code', 'error')}: {msg.get('message', '')}")
            elif t == "closing":
                yield ("error", msg.get("reason", "server closing the session"))
                self._resume_ok = bool(msg.get("resumable"))
                self._hard_close()
                break
            # heartbeat_ack: ignore

        yield ("turn_end",)

    def _tool(self, msg: dict):
        tid = msg.get("id", "")
        name = msg.get("name", "")
        args = msg.get("args", {}) or {}

        if tid in self.journal:  # exactly-once on replay — no re-execution
            self._send_result(tid, self.journal[tid])
            return

        if msg.get("destructive") and not self.cfg.approves("*"):
            if not self.approver(name, args):
                payload = {"ok": False, "refused": "user_rejected"}
                self.journal[tid] = payload
                self._send_result(tid, payload)
                yield ("tool_denied", name)
                return

        yield ("tool_start", name, args)
        payload = remote_exec.execute(name, args, self.ctx.cwd)
        self.journal[tid] = payload
        self._send_result(tid, payload)
        yield ("tool_end", name, remote_exec.summarize(name, payload))

    def _send_result(self, tid: str, payload: dict) -> None:
        frame = {"t": "tool_result", "id": tid}
        frame.update({k: payload[k] for k in _RESULT_KEYS if k in payload})
        try:
            self._ws.send_json(frame)  # type: ignore[union-attr]
        except (WSError, WSClosed, OSError):
            pass  # the server will replay this request on reconnect
