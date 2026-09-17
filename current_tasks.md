# JojoAI — current tasks

Everything asked for in this session, in one place. Status is honest: `done`
means verified, not merely written.

Repo: `~/src/jojo-ai` (JojoAI: Python TUI + reference server + landing page).
Related repo: `~/src/JojoCode` (the teaching platform — separate product, shares
the `jojocode.in` domain and its Brevo mailer).

---

## 1 · Recon — understand JojoAI and the TUI
**Status: mostly done.** Findings so far:

- Two execution modes. **Local**: TUI talks straight to Ollama. **Remote**: TUI
  talks to `server/backend`, and the agent loop runs there.
- **Local tools** live in `tui/jojocode_ai/tools.py` — `TOOLS` (OpenAI-style
  function schemas), `IMPLS` (name → python fn), `run_tool()` dispatch, and
  `APPROVAL_REQUIRED = {write_file, edit_file, run_bash}`.
- **Remote tools** live in `server/backend/src/tools.ts` — a *separate* list.
- ⚠️ **The two tool sets have already drifted**: local has
  `list_dir, read_file, write_file, edit_file, run_bash, search, change_dir,
  finish`; remote has only `list_dir, read_file, write_file, run_command`.
  Anything new has to be added twice, or the drift has to be fixed first.
- Agent loop: `tui/jojocode_ai/agent.py`, bounded by `cfg.max_steps`, streams
  events, and gates approval-required tools through an approver callback.
- Tests today: `server/control-plane/src/index.test.ts`,
  `server/shared/src/authorize.test.ts`. **The TUI has no tests at all.**

Remaining: read `remote.py` / `orchestrator.ts` closely enough to place a tool
in remote mode.

---

## 2 · Installer errors (Windows, and Linux without Python)
**Status: not yet diagnosed.** Scope from you: errors on install, *especially
Windows*, and look for the same class of problem on Linux, **especially on
systems where Python is not natively installed**.

Files: `install/install.ps1` (Windows), `install/install.sh` (Linux/macOS),
served from `https://ai.jojocode.in/install.sh`.

Early observations (not yet confirmed as the failures you hit):
- `install.sh` tries a package manager install of Python when missing
  (`apt/dnf/pacman/zypper/apk/brew`) — that path needs root and will fail or
  prompt unhelpfully on a locked-down machine.
- It then needs `venv` separately on Debian (`python3-venv`), and falls back
  wheel → PyPI → git, dying with "could not install the TUI" if all three fail.
- Windows has no equivalent guarantee that `py`/`python` exists at all.

Deliverable: reproduce, list each concrete failure mode, then fix.

---

## 3 · OTP email never arrives
**Status: diagnosed — two stacked causes. Not yet fixed.**

You signed in with a verified email (the owner's address) and no code
arrived. It is not your account, and not Gmail:

1. **The OTP endpoints are not deployed.** `https://ai.jojocode.in` serves the
   **backend** (`/healthz`, `/status.json`, `/install.sh` → 200). The OTP routes
   live in the **control-plane**, a different service, which is not routed at
   that hostname. `POST /api/auth/otp/request` returns **404** — the TUI's login
   request has nowhere to land.
2. **Email delivery was never implemented.** In
   `server/control-plane/src/otp.ts`, `deliver()` in `smtp` mode logs
   `"SMTP delivery not wired; code for <email>: <code>"` and returns. The
   default mode is `console`, which writes the code to stderr and a local
   outbox file. **No email is ever sent, to anyone.**

Fix direction: deploy/route the control-plane, then wire `deliver()` to the
Brevo SMTP relay JojoCode already uses (verified working: 19 credential emails
sent, most recent 15 Sep).

---

## 4 · Web search for JojoAI
**Status: recon done, plan not yet written.** Goal: when JojoAI is unsure, it
searches the web, reads what it finds, and folds a summary into its answer.

Required flow, per you:

> **RECON → DESIGN → IMPLEMENT → TEST HEAVILY**, and if it fails,
> **BETTER DESIGN → IMPLEMENT → TEST** as a loop.

Open design questions already surfaced:
- Which provider (no-key DuckDuckGo/SearXNG vs keyed Brave/Tavily).
- One tool or two (`web_search` + `fetch_url`).
- Local mode has no server — so where does egress happen in each mode.
- **Prompt injection is the headline risk**: fetched pages are untrusted text
  entering the context of an agent that can `write_file` and `run_bash`.
- **SSRF**: `fetch_url` must refuse localhost, RFC1918, link-local and cloud
  metadata (`169.254.169.254`).
- Whether network egress joins `APPROVAL_REQUIRED`.

---

## 5 · Implementation plan document
**Status: pending.** Write the web-search plan (task 4) as a document following
the RECON → DESIGN → IMPLEMENT → TEST-heavy → re-design loop.

---

## 6 · CLAUDE.md for JojoAI
**Status: pending.** There is **no `CLAUDE.md` in `~/src/jojo-ai`** today (only
in `~/src/JojoCode`). Write one so a fresh session can pick this up: repo
layout, the two execution modes, the tool-drift trap, how to run things, and
where this work stopped.

---

## 7 · Landing page is bad on a phone
**Status: pending.** `ai.jojocode.in` (`web/index.html`, 746 lines, single file).
From your screenshot at ~390px:
- The nav wraps onto three ragged lines.
- The terminal demo card scrolls sideways and clips its own text
  (`add a --json flag to the export comman…`, `model_done · 4 tools · 3.1k→840 to…`).
- The hero headline is clipped at the fold.

Needs a proper mobile pass, not a patch.

---

## 8 · "A lot of other things to do"
**Status: awaiting your list.** Placeholder so it is not forgotten.

---

## Suggested order

1. **OTP** (3) — diagnosed, users are blocked on it, fix is well understood.
2. **Installer** (2) — blocks anyone getting the TUI at all.
3. **Web search** (4 + 5) — the substantial feature.
4. **Landing page** (7) — visible but nothing is broken behind it.
5. **CLAUDE.md** (6) — write once the above have settled, so it is accurate.

Tell me if you want a different order — (6) can also come first if you want a
clean hand-off point before any code changes.
