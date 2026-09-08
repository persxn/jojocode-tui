"""Runtime configuration for JojoAI."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


DEFAULT_HOST = os.environ.get("JOJO_HOST", "http://127.0.0.1:11434")
DEFAULT_MODEL = os.environ.get("JOJO_MODEL", "gpt-oss:120b")


@dataclass
class Config:
    host: str = DEFAULT_HOST
    model: str = DEFAULT_MODEL
    cwd: str = field(default_factory=os.getcwd)
    # gpt-oss reasoning: True/False, or "low" / "medium" / "high"
    think: object = "medium"
    num_ctx: int = 32768
    max_steps: int = 40
    request_timeout: int = 600
    # each chat is isolated. History is always saved per-session, but context
    # from other chats is pulled in ONLY when rag is explicitly enabled
    # (--rag / `/rag on` / `/recall --use`).
    rag: bool = False
    embed_model: str = os.environ.get("JOJO_EMBED_MODEL", "nomic-embed-text")
    # create / edit files without a prompt (still scoped to the working dir).
    # Turn off with --safe.
    auto_edit: bool = True
    # run shell commands without a prompt too. Off by default; --trust turns it on.
    auto_bash: bool = False
    # tool names that may run without asking; "*" means everything
    auto_approve: set = field(default_factory=set)

    # capture the mouse wheel to scroll the transcript (--no-mouse / `/mouse` to disable;
    # hold Shift, or Option on macOS, to select text while it's on)
    mouse: bool = True

    # remote mode: when set, the agent loop runs on this server and `host`/`model`
    # above are ignored (the server owns them). Token comes from `jojo --login`.
    remote_endpoint: str | None = None
    project_label: str = field(
        default_factory=lambda: os.path.basename(os.getcwd()) or "project")

    def approves(self, tool_name: str) -> bool:
        return "*" in self.auto_approve or tool_name in self.auto_approve
