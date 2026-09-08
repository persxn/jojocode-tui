"""The JojoAI agent loop: model <-> tools until the task is done."""

from __future__ import annotations

import os
import time

from .config import Config
from .ollama_client import OllamaClient
from .prompts import system_prompt
from .tools import APPROVAL_REQUIRED, TOOLS, Ctx, run_tool


class Agent:
    """Drives one conversation. Emits (kind, *payload) events for a UI to render.

    Events:
      ("user", text)
      ("thinking", delta)
      ("assistant", delta)
      ("tool_start", name, args_dict)
      ("tool_end", name, result_str)
      ("tool_denied", name)
      ("final", text)
      ("error", text)
      ("stats", dict)
      ("turn_end",)
    """

    def __init__(self, cfg: Config, approver=None):
        self.cfg = cfg
        self.client = OllamaClient(cfg.host, cfg.model, cfg.num_ctx, cfg.request_timeout)
        self.ctx = Ctx(cwd=cfg.cwd)
        # approver(name, args) -> bool ; default: allow everything
        self.approver = approver or (lambda n, a: True)
        self.store = None          # optional jojoai.store.Store
        self.messages = [{"role": "system", "content": system_prompt(cfg.cwd)}]
        self._interrupt = False

    def reset(self):
        self.messages = [{"role": "system", "content": system_prompt(self.cfg.cwd)}]

    def interrupt(self):
        self._interrupt = True

    def _pre_approved(self, name: str, args: dict) -> bool:
        """Skip the approval prompt for trusted operations."""
        if name == "run_bash":
            return self.cfg.auto_bash
        if not (self.cfg.auto_edit and name in ("write_file", "edit_file")):
            return False
        try:
            target = os.path.realpath(os.path.join(self.ctx.cwd, args.get("path", "")))
            root = os.path.realpath(self.ctx.cwd)
            return os.path.commonpath([target, root]) == root
        except (ValueError, OSError):
            return False

    def run(self, user_text: str):
        self._interrupt = False
        sent = user_text
        if self.store is not None:
            self.store.set_title(user_text)
            # cross-chat context is pulled in ONLY when recall is explicitly on
            if getattr(self.store, "rag_enabled", False) and len(user_text.strip()) >= 12:
                try:
                    ctx = self.store.context_block(user_text)
                except Exception:  # noqa: BLE001
                    ctx = ""
                if ctx:
                    n = ctx.count("\n[")
                    yield ("recall", max(1, n))
                    sent = f"{ctx}\n\n---\n\n{user_text}"
            self.store.append("user", user_text)
        self.messages.append({"role": "user", "content": sent})
        yield ("user", user_text)

        for step in range(self.cfg.max_steps):
            if self._interrupt:
                yield ("error", "interrupted")
                break

            assistant_text = ""
            tool_calls = []
            got_error = False

            for attempt in (1, 2):                       # one retry on a stream error
                assistant_text = ""
                tool_calls = []
                got_error = False
                for ev in self.client.chat(self.messages, tools=TOOLS, think=self.cfg.think):
                    if self._interrupt:
                        got_error = True
                        yield ("error", "interrupted")
                        break
                    et = ev["type"]
                    if et == "thinking":
                        yield ("thinking", ev["text"])
                    elif et == "content":
                        assistant_text += ev["text"]
                        yield ("assistant", ev["text"])
                    elif et == "tool_calls":
                        tool_calls = ev["calls"]
                    elif et == "done":
                        yield ("stats", ev["stats"])
                    elif et == "error":
                        got_error = True
                        yield ("error", ev["message"])
                        break
                if not got_error or self._interrupt or assistant_text or tool_calls:
                    break
                if attempt == 1:
                    yield ("error", "retrying…")
                    time.sleep(1)

            if got_error and not (assistant_text or tool_calls):
                break
            got_error = False

            # record the assistant turn
            amsg = {"role": "assistant", "content": assistant_text}
            if tool_calls:
                amsg["tool_calls"] = [
                    {"function": {"name": c["name"], "arguments": c["arguments"]}}
                    for c in tool_calls
                ]
            self.messages.append(amsg)

            if not tool_calls:
                final = assistant_text.strip()
                if self.store is not None and final:
                    self.store.append("assistant", final)
                yield ("final", final)
                break

            # execute each requested tool
            finished = False
            for call in tool_calls:
                name = call["name"]
                args = call["arguments"] or {}

                if name in APPROVAL_REQUIRED and not self.cfg.approves(name) \
                        and not self._pre_approved(name, args):
                    if not self.approver(name, args):
                        yield ("tool_denied", name)
                        self.messages.append({
                            "role": "tool", "tool_name": name,
                            "content": "error: user denied this action",
                        })
                        continue

                yield ("tool_start", name, args)
                t0 = time.time()
                result = run_tool(name, args, self.ctx)
                dt = time.time() - t0
                yield ("tool_end", name, result)
                self.messages.append({
                    "role": "tool", "tool_name": name,
                    "content": result if len(result) < 60000 else result[:60000] + "\n...[clipped]",
                })
                if name == "finish":
                    finished = True

            if finished:
                final = result.strip()
                if self.store is not None and final:
                    self.store.append("assistant", final)
                yield ("final", final)
                break
        else:
            yield ("final", "(stopped: reached max steps)")

        yield ("turn_end",)
