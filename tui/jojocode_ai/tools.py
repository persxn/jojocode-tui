"""Tool definitions and execution for JojoAI.

Each tool is described to the model with a JSON schema (Ollama / OpenAI function
format) and implemented by a Python function that takes (args: dict, ctx: Ctx)
and returns a string.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass


MAX_OUTPUT = 20000  # chars returned to the model per tool call


def _jojo_data_dir() -> str:
    return os.path.realpath(
        os.environ.get("JOJO_DATA") or os.path.expanduser("~/.local/share/jojocode-ai"))


@dataclass
class Ctx:
    cwd: str


# tools that change state or run arbitrary code -> require user approval
APPROVAL_REQUIRED = {"write_file", "edit_file", "run_bash"}


def _resolve(ctx: Ctx, path: str) -> str:
    if not path:
        path = "."
    if not os.path.isabs(path):
        path = os.path.join(ctx.cwd, path)
    return os.path.normpath(path)


def _blocked(path: str) -> bool:
    """JojoAI's own history/index is off-limits to the tools."""
    try:
        rp = os.path.realpath(path)
        dd = _jojo_data_dir()
        return rp == dd or rp.startswith(dd + os.sep)
    except OSError:
        return False


def _clip(text: str) -> str:
    if len(text) <= MAX_OUTPUT:
        return text
    head = text[: MAX_OUTPUT - 2000]
    tail = text[-1500:]
    return f"{head}\n\n... [truncated {len(text) - MAX_OUTPUT + 3500} chars] ...\n\n{tail}"


# --------------------------------------------------------------------------- #
# implementations
# --------------------------------------------------------------------------- #

def t_list_dir(args, ctx: Ctx) -> str:
    path = _resolve(ctx, args.get("path", "."))
    if _blocked(path):
        return "error: JojoAI's history directory is not accessible to tools"
    if not os.path.isdir(path):
        return f"error: not a directory: {path}"
    rows = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        try:
            st = os.stat(full)
            if os.path.isdir(full):
                rows.append(f"  {name}/")
            else:
                rows.append(f"  {name}  ({st.st_size} bytes)")
        except OSError as e:
            rows.append(f"  {name}  (stat error: {e})")
    return f"{path}\n" + "\n".join(rows) if rows else f"{path}\n  (empty)"


def t_read_file(args, ctx: Ctx) -> str:
    path = _resolve(ctx, args["path"])
    if _blocked(path):
        return "error: JojoAI's history directory is not accessible to tools"
    if not os.path.isfile(path):
        return f"error: no such file: {path}"
    offset = int(args.get("offset", 1))
    limit = int(args.get("limit", 400))
    try:
        with open(path, "r", errors="replace") as f:
            lines = f.readlines()
    except OSError as e:
        return f"error: {e}"
    start = max(offset - 1, 0)
    chunk = lines[start:start + limit]
    numbered = [f"{start + i + 1:6d}\t{ln.rstrip(chr(10))}" for i, ln in enumerate(chunk)]
    footer = ""
    if start + limit < len(lines):
        footer = f"\n... ({len(lines) - start - limit} more lines)"
    return _clip("\n".join(numbered) + footer) or "(empty file)"


def t_write_file(args, ctx: Ctx) -> str:
    path = _resolve(ctx, args["path"])
    if _blocked(path):
        return "error: JojoAI's history directory is not writable by tools"
    content = args.get("content", "")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    existed = os.path.isfile(path)
    try:
        with open(path, "w") as f:
            f.write(content)
    except OSError as e:
        return f"error: {e}"
    verb = "overwrote" if existed else "created"
    return f"{verb} {path} ({len(content)} bytes, {content.count(chr(10)) + 1} lines)"


def t_edit_file(args, ctx: Ctx) -> str:
    path = _resolve(ctx, args["path"])
    if _blocked(path):
        return "error: JojoAI's history directory is not writable by tools"
    old = args["old_string"]
    new = args["new_string"]
    replace_all = bool(args.get("replace_all", False))
    if not os.path.isfile(path):
        return f"error: no such file: {path}"
    try:
        with open(path, "r", errors="replace") as f:
            data = f.read()
    except OSError as e:
        return f"error: {e}"
    count = data.count(old)
    if count == 0:
        return "error: old_string not found in file (must match exactly, including whitespace)"
    if count > 1 and not replace_all:
        return (f"error: old_string appears {count} times; make it unique "
                f"or pass replace_all=true")
    data = data.replace(old, new) if replace_all else data.replace(old, new, 1)
    try:
        with open(path, "w") as f:
            f.write(data)
    except OSError as e:
        return f"error: {e}"
    return f"edited {path} ({count if replace_all else 1} replacement(s))"


def t_run_bash(args, ctx: Ctx) -> str:
    cmd = args["command"]
    timeout = int(args.get("timeout", 120))
    try:
        p = subprocess.run(
            cmd, shell=True, cwd=ctx.cwd, capture_output=True, text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"error: command timed out after {timeout}s"
    except OSError as e:
        return f"error: {e}"
    out = (p.stdout or "")
    err = (p.stderr or "")
    parts = []
    if out:
        parts.append(out.rstrip())
    if err:
        parts.append("[stderr]\n" + err.rstrip())
    parts.append(f"[exit {p.returncode}]")
    return _clip("\n".join(parts))


def t_search(args, ctx: Ctx) -> str:
    pattern = args["pattern"]
    path = _resolve(ctx, args.get("path", "."))
    rg = shutil.which("rg")
    if rg:
        try:
            p = subprocess.run(
                [rg, "--line-number", "--no-heading", "--color", "never",
                 "-e", pattern, path],
                capture_output=True, text=True, timeout=60,
            )
            out = p.stdout.strip()
            return _clip(out) if out else "(no matches)"
        except (subprocess.TimeoutExpired, OSError):
            pass
    # fallback: python walk
    import re
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return f"error: bad regex: {e}"
    skip_ext = {".db", ".sqlite", ".gguf", ".bin", ".so", ".o", ".png", ".jpg",
                ".jpeg", ".gif", ".pdf", ".zip", ".gz", ".tar", ".pyc", ".woff",
                ".woff2", ".mp4", ".mp3", ".wav"}
    data_dir = _jojo_data_dir()
    hits = []
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", ".venv")
                   and os.path.realpath(os.path.join(root, d)) != data_dir]
        for fn in files:
            if os.path.splitext(fn)[1].lower() in skip_ext:
                continue
            fp = os.path.join(root, fn)
            try:
                with open(fp, "rb") as fb:
                    if b"\x00" in fb.read(2048):          # looks binary
                        continue
                with open(fp, "r", errors="ignore") as f:
                    for i, line in enumerate(f, 1):
                        if rx.search(line):
                            hits.append(f"{fp}:{i}:{line.rstrip()[:400]}")
                            if len(hits) >= 200:
                                return _clip("\n".join(hits) + "\n... (capped at 200)")
            except OSError:
                continue
    return _clip("\n".join(hits)) if hits else "(no matches)"


def t_change_dir(args, ctx: Ctx) -> str:
    target = _resolve(ctx, args["path"])
    if _blocked(target):
        return "error: JojoAI's history directory is not accessible to tools"
    if not os.path.isdir(target):
        return f"error: not a directory: {target}"
    ctx.cwd = target
    entries = sorted(os.listdir(target))[:40]
    listing = "\n".join(f"  {e}" for e in entries) or "  (empty)"
    more = "" if len(entries) < 40 else "\n  …"
    return f"working directory is now {target}\n{listing}{more}"


def t_finish(args, ctx: Ctx) -> str:
    return args.get("message", "done")


IMPLS = {
    "list_dir": t_list_dir,
    "read_file": t_read_file,
    "write_file": t_write_file,
    "edit_file": t_edit_file,
    "run_bash": t_run_bash,
    "search": t_search,
    "change_dir": t_change_dir,
    "finish": t_finish,
}


def run_tool(name: str, args: dict, ctx: Ctx) -> str:
    fn = IMPLS.get(name)
    if fn is None:
        return f"error: unknown tool {name!r}"
    try:
        return fn(args or {}, ctx)
    except KeyError as e:
        return f"error: missing required argument {e}"
    except Exception as e:  # noqa: BLE001 - tool errors go back to the model
        return f"error: {type(e).__name__}: {e}"


# --------------------------------------------------------------------------- #
# schema advertised to the model
# --------------------------------------------------------------------------- #

def _fn(name, description, properties, required):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


TOOLS = [
    _fn("list_dir", "List the entries of a directory.",
        {"path": {"type": "string", "description": "Directory path, absolute or relative to cwd. Default '.'"}},
        []),
    _fn("read_file",
        "Read a text file. Each line is shown as '<line number><TAB><content>'. "
        "The line number and tab are display aids only - they are NOT part of the "
        "file. When calling edit_file, use only the real content after the tab.",
        {"path": {"type": "string"},
         "offset": {"type": "integer", "description": "1-based line to start at. Default 1."},
         "limit": {"type": "integer", "description": "Max lines to return. Default 400."}},
        ["path"]),
    _fn("write_file", "Create a new file or overwrite an existing one with the given content.",
        {"path": {"type": "string"},
         "content": {"type": "string"}},
        ["path", "content"]),
    _fn("edit_file",
        "Replace an exact substring in a file. old_string must match verbatim "
        "(including whitespace) and be unique unless replace_all is true.",
        {"path": {"type": "string"},
         "old_string": {"type": "string"},
         "new_string": {"type": "string"},
         "replace_all": {"type": "boolean"}},
        ["path", "old_string", "new_string"]),
    _fn("run_bash", "Run a shell command in the working directory and return stdout, stderr and exit code.",
        {"command": {"type": "string"},
         "timeout": {"type": "integer", "description": "Seconds before the command is killed. Default 120."}},
        ["command"]),
    _fn("search", "Search file contents recursively for a regex pattern (uses ripgrep if available).",
        {"pattern": {"type": "string"},
         "path": {"type": "string", "description": "Directory to search. Default '.'"}},
        ["pattern"]),
    _fn("change_dir",
        "Change the working directory that later relative paths resolve against. "
        "Use this to move between projects/folders to find, read, edit and create "
        "files. Returns the new directory and a listing.",
        {"path": {"type": "string", "description": "Absolute path, or relative to the current working dir."}},
        ["path"]),
    _fn("finish", "Call ONLY when the whole task is complete and nothing is left to do.",
        {"message": {"type": "string", "description": "Short summary of what was accomplished."}},
        ["message"]),
]
