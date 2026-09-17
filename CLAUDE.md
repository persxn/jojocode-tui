# JojoAI — working notes for Claude

JojoAI (`jojo`) is a terminal AI coding agent: a curses TUI that reads and edits
files, runs commands, and drives a task end to end, with an approval prompt
before every write. It runs against a local Ollama, or against a hosted server.

**This is not JojoCode.** `~/src/JojoCode` is the teaching platform — a separate
product with its own repo, database and deploy. The two share the `jojocode.in`
domain (JojoAI lives at `ai.jojocode.in`) and nothing else. Do not assume a
finding in one applies to the other; that mistake has already been made once,
over mail configuration.

---

## Layout

```
tui/jojocode_ai/     the Python TUI (the product)
  tui.py             curses UI (1111 lines — the big one)
  agent.py           local agent loop: model → tool_calls → tools → repeat
  tools.py           LOCAL tool schemas + implementations + approval set
  remote_exec.py     tool implementations used in REMOTE mode (separate copy!)
  remote.py          websocket client for remote mode
  prompts.py         the system prompt (43 lines)
  auth.py            OTP login client + credential store
  config.py          defaults: JOJO_HOST, JOJO_MODEL (gpt-oss:120b)
server/
  backend/           runs the agent loop for remote mode; serves ai.jojocode.in
  control-plane/     accounts, grants, audit, OTP  ← NOT currently deployed
  shared/            protocol, rbac, authorize
install/             install.sh (Linux/macOS), install.ps1 (Windows)
web/index.html       the ai.jojocode.in landing page (single 746-line file)
docs/                ARCHITECTURE.md, BUILD-PLAN.md, WEB-SEARCH-PLAN.md
current_tasks.md     what is in flight right now — read this first
```

## The two modes (and the trap)

| | Local | Remote |
|---|---|---|
| Drives the model | TUI → Ollama | `server/backend` → Ollama |
| **Runs the tools** | this machine | **still this machine** |
| Schema read from | `tools.py` | `server/backend/src/tools.ts` |
| Implementation | `tools.py` `IMPLS` | `remote_exec.py` |

In remote mode the server sends `tool_request` and the TUI executes it locally,
path-jailed to the project root. Tools never run on the server.

> ### ⚠️ Adding a tool means touching three files
> `tools.py` (schema + impl), `tools.ts` (schema), `remote_exec.py` (impl).
> `remote_exec.py` does **not** import from `tools.py` — it has its own `_jail`,
> `_clip` and `_dispatch`.
>
> **This has already drifted.** Local advertises `list_dir, read_file,
> write_file, edit_file, run_bash, search, change_dir, finish`. Remote
> advertises `list_dir, read_file, write_file, run_command`. Four tools exist
> only locally, and `run_bash`/`run_command` are one idea with two names.
> Check both lists before believing a tool exists.

## Conventions

- **Approval gate.** `APPROVAL_REQUIRED = {"write_file", "edit_file",
  "run_bash"}` in `tools.py`. This is the main safety property of the product —
  do not weaken it to make a feature smoother.
- **Tool output is bounded.** Use the existing `_clip()`; never return a whole
  file or page into the model's context.
- **Tool errors are strings, not exceptions.** `run_tool()` catches and returns
  `error: …` so the model can read and recover. Keep that.
- **The prompt is part of the feature.** A tool `prompts.py` doesn't describe
  behaviourally is a tool the model won't reach for.
- Stdlib-only in the TUI where possible: the installer's promise is a venv and
  no build tools.

## Running and testing

```sh
npm test          # @jojoai/shared + @jojoai/control-plane + ws-resume spike
npm run typecheck
```

**The TUI has no tests at all.** Only `server/control-plane/src/index.test.ts`
and `server/shared/src/authorize.test.ts` exist. Any substantial TUI work should
start by creating `tui/tests/` and wiring it into `npm test`.

## Deployment reality (verified 17 Sep 2026)

- `https://ai.jojocode.in` is **live** and serves the **backend**: `/healthz`
  200, `/status.json`, `/install.sh` 200.
- The **control-plane is not routed there**. `POST /api/auth/otp/request`
  returns **404**. Anything depending on accounts, grants or OTP is therefore
  not working in production.

---

## Open work — read `current_tasks.md` for the live list

Summary of where things stopped:

1. **OTP email never arrives — diagnosed, unfixed.** Two stacked causes:
   (a) the control-plane isn't deployed/routed at `ai.jojocode.in`, so the
   TUI's login request 404s; (b) `server/control-plane/src/otp.ts::deliver()`
   **never sends mail** — in `smtp` mode it logs `"SMTP delivery not wired"` and
   returns; the default `console` mode writes the code to stderr and a local
   outbox file. Fix direction: route the control-plane, then wire `deliver()` to
   the Brevo relay JojoCode already uses (`smtp-relay.brevo.com:587`, verified
   authenticating). Reported against a real, verified address — it is not an
   account problem.
2. **Installer errors — not yet diagnosed.** Reported on Windows especially,
   and suspected on Linux where Python isn't preinstalled. `install.sh` shells
   out to a package manager for Python (needs root), needs `python3-venv`
   separately on Debian, then falls back wheel → PyPI → git. `install.ps1` has
   no guarantee `py`/`python` exists. Reproduce before changing anything.
3. **Web search — planned, not built.** See `docs/WEB-SEARCH-PLAN.md`. Two
   tools (`web_search`, `fetch_url`), keyless provider by default, SSRF guard,
   untrusted-content framing for prompt injection, and the approval gate left
   intact. The plan's three open questions need the owner's answer before
   implementation starts.
4. **Landing page is bad on a phone.** At ~390px the nav wraps to three ragged
   lines, the terminal demo card scrolls sideways and clips its own text, and
   the hero is clipped at the fold. `web/index.html` is one self-contained file.

## Style

Match the existing voice in this repo: comments explain *why*, not *what*, and
name the failure a rule exists to prevent. Files here carry real reasoning in
their headers — keep that standard rather than reverting to summary comments.
