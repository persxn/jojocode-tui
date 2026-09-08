"""Minimal Ollama client (stdlib only) for the native /api/chat streaming endpoint."""

from __future__ import annotations

import json
import urllib.error
import urllib.request


class OllamaError(RuntimeError):
    pass


class OllamaClient:
    def __init__(self, host: str, model: str, num_ctx: int = 32768, timeout: int = 600):
        self.host = host.rstrip("/")
        self.model = model
        self.num_ctx = num_ctx
        self.timeout = timeout

    # -- introspection ----------------------------------------------------- #
    def _get(self, path: str):
        req = urllib.request.Request(self.host + path, method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())

    def version(self) -> str:
        try:
            return self._get("/api/version").get("version", "?")
        except Exception as e:  # noqa: BLE001
            raise OllamaError(f"cannot reach Ollama at {self.host}: {e}")

    def list_models(self):
        try:
            data = self._get("/api/tags")
        except Exception as e:  # noqa: BLE001
            raise OllamaError(f"cannot list models: {e}")
        return [m["name"] for m in data.get("models", [])]

    def has_model(self, name: str) -> bool:
        try:
            names = self.list_models()
        except OllamaError:
            return False
        return name in names or any(n.split(":")[0] == name.split(":")[0] for n in names)

    # -- chat ------------------------------------------------------------- #
    def chat(self, messages, tools=None, think="medium"):
        """Yield event dicts:
        {"type": "thinking", "text": str}
        {"type": "content",  "text": str}
        {"type": "tool_calls", "calls": [{"name": str, "arguments": dict}]}
        {"type": "done", "stats": dict}
        {"type": "error", "message": str}
        """
        body = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "options": {"num_ctx": self.num_ctx},
        }
        if think is not None and think is not False:
            body["think"] = think
        if tools:
            body["tools"] = tools

        data = json.dumps(body).encode()
        req = urllib.request.Request(
            self.host + "/api/chat", data=data, method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            yield {"type": "error", "message": f"HTTP {e.code}: {detail}"}
            return
        except urllib.error.URLError as e:
            yield {"type": "error", "message": f"connection failed: {e.reason}"}
            return

        pending_calls = []
        with resp:
            for raw in resp:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if "error" in obj:
                    yield {"type": "error", "message": obj["error"]}
                    return
                msg = obj.get("message") or {}
                if msg.get("thinking"):
                    yield {"type": "thinking", "text": msg["thinking"]}
                if msg.get("content"):
                    yield {"type": "content", "text": msg["content"]}
                for tc in msg.get("tool_calls") or []:
                    fn = tc.get("function", {})
                    name = fn.get("name", "")
                    raw_args = fn.get("arguments", {})
                    if isinstance(raw_args, str):
                        try:
                            raw_args = json.loads(raw_args)
                        except json.JSONDecodeError:
                            raw_args = {"_raw": raw_args}
                    pending_calls.append({"name": name, "arguments": raw_args})
                if obj.get("done"):
                    if pending_calls:
                        yield {"type": "tool_calls", "calls": pending_calls}
                    yield {"type": "done", "stats": {
                        "prompt_eval_count": obj.get("prompt_eval_count"),
                        "eval_count": obj.get("eval_count"),
                        "eval_duration": obj.get("eval_duration"),
                        "load_duration": obj.get("load_duration"),
                        "total_duration": obj.get("total_duration"),
                    }}
                    return
