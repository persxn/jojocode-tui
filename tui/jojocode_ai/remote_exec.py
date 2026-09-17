"""Local execution of the tool_requests a remote server streams down.

The server runs the agent loop; these run on *this* machine (decision D1). Every
path is forced inside the project root, and the caller (remote.RemoteAgent) is
responsible for getting the user's approval on `destructive` requests before
calling here.

Returns a dict ready to drop into a `tool_result` frame (minus `t`/`id`).
"""

from __future__ import annotations

import os
import subprocess
import time

MAX_READ = 100_000
MAX_OUT = 20_000


def _jail(root: str, path: str) -> str | None:
    """Resolve `path` under `root`; None if it escapes."""
    root = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root, path or "."))
    if full == root or full.startswith(root + os.sep):
        return full
    return None


def _clip(s: str, limit: int = MAX_OUT) -> str:
    if len(s) <= limit:
        return s
    return s[: limit - 400] + f"\n... [truncated {len(s) - limit + 400} chars] ...\n" + s[-300:]


def execute(name: str, args: dict, root: str) -> dict:
    t0 = time.time()
    try:
        payload = _dispatch(name, args or {}, root)
    except FileNotFoundError as e:
        payload = {"ok": False, "error": f"not found: {e}"}
    except PermissionError as e:
        payload = {"ok": False, "error": f"permission denied: {e}"}
    except OSError as e:
        payload = {"ok": False, "error": str(e)}
    payload.setdefault("ok", True)
    payload["durationMs"] = int((time.time() - t0) * 1000)
    return payload


def _dispatch(name: str, args: dict, root: str) -> dict:
    # The network tools are jail-exempt by nature: there is no path to confine,
    # and the confinement that matters for them is the SSRF guard in
    # `websearch`, which refuses anything resolving inside this network.
    if name == "web_search":
        from . import websearch
        try:
            results = websearch.search(
                args.get("query", ""),
                args.get("count", 5),
                provider=os.environ.get("JOJO_SEARCH_PROVIDER", ""),
                key=os.environ.get("JOJO_SEARCH_KEY", ""),
            )
        except websearch.WebError as e:
            return {"ok": False, "error": str(e)}
        if not results:
            return {"ok": True, "stdout": "no results came back (the search provider "
                                          "returned nothing usable)", "count": 0}
        body = "\n".join(
            f"{i}. {r.title}\n   {r.url}" + (f"\n   {r.snippet}" if r.snippet else "")
            for i, r in enumerate(results, 1)
        )
        return {"ok": True, "stdout": _clip(body), "count": len(results)}

    if name == "fetch_url":
        from . import websearch
        try:
            return {"ok": True, "content": websearch.fetch(args.get("url", ""))}
        except websearch.WebError as e:
            return {"ok": False, "error": str(e)}

    if name == "list_dir":
        full = _jail(root, args.get("path", "."))
        if full is None:
            return {"ok": False, "refused": "policy", "error": "path escapes project root"}
        if not os.path.isdir(full):
            return {"ok": False, "error": f"not a directory: {args.get('path', '.')}"}
        rows = []
        for e in sorted(os.listdir(full)):
            p = os.path.join(full, e)
            rows.append(f"{e}/" if os.path.isdir(p) else f"{e}  ({os.path.getsize(p)} B)")
        rel = os.path.relpath(full, root)
        return {"ok": True, "stdout": f"{rel}\n" + "\n".join(f"  {r}" for r in rows)}

    if name == "read_file":
        full = _jail(root, args.get("path", ""))
        if full is None:
            return {"ok": False, "refused": "policy", "error": "path escapes project root"}
        if not os.path.isfile(full):
            return {"ok": False, "error": f"no such file: {args.get('path')}"}
        cap = int(args.get("max_bytes", MAX_READ) or MAX_READ)
        with open(full, "r", errors="replace") as f:
            data = f.read(cap + 1)
        more = len(data) > cap
        return {"ok": True, "content": data[:cap] + ("\n... [clipped]" if more else "")}

    if name == "write_file":
        full = _jail(root, args.get("path", ""))
        if full is None:
            return {"ok": False, "refused": "policy", "error": "path escapes project root"}
        content = args.get("content", "")
        os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
        with open(full, "w") as f:
            f.write(content)
        return {"ok": True, "bytesWritten": len(content.encode())}

    if name == "run_command":
        cmd = args.get("cmd") or args.get("command") or ""
        if not cmd:
            return {"ok": False, "error": "no command"}
        timeout = int(args.get("timeout_ms", 120_000) or 120_000) / 1000
        try:
            p = subprocess.run(cmd, shell=True, cwd=root, capture_output=True,
                               text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"ok": False, "refused": "timeout", "error": f"timed out after {timeout:.0f}s"}
        return {
            "ok": p.returncode == 0,
            "stdout": _clip(p.stdout or ""),
            "stderr": _clip(p.stderr or ""),
            "exitCode": p.returncode,
        }

    return {"ok": False, "error": f"unknown tool {name!r}"}


def summarize(name: str, payload: dict) -> str:
    """A one-liner for the TUI's tool_end line."""
    if payload.get("refused"):
        return f"{payload['refused']}: {payload.get('error', '')}".strip()
    if payload.get("error"):
        return f"error: {payload['error']}"
    if name == "read_file":
        return f"{len(payload.get('content', ''))} chars"
    if name == "list_dir":
        return payload.get("stdout", "").split("\n", 1)[0]
    if name == "write_file":
        return f"wrote {payload.get('bytesWritten', 0)} bytes"
    if name == "run_command":
        return f"exit {payload.get('exitCode')}"
    if name == "web_search":
        return f"{payload.get('count', 0)} results"
    if name == "fetch_url":
        return f"{len(payload.get('content', ''))} chars"
    return "ok"
