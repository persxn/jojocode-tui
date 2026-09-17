# JojoAI — current tasks

Status is honest: `done` means verified, not merely written.

Repo: `~/src/jojo-ai` (JojoAI: Python TUI + reference server + landing page).
Related repo: `~/src/JojoCode` (the teaching platform — separate product, shares
the `jojocode.in` domain and its Brevo mailer).

---

## This session (17 Sep) — the four you asked for

### 1 · Login from your terminal — **done, verified**
Two separate faults, stacked:

1. **Cloudflare answered 403 before the request reached the server.** urllib
   sends `User-Agent: Python-urllib/3.13` when nobody sets one, and the browser
   integrity check bans that string (`error code: 1010`). Reproduced, then fixed
   in `tui/jojocode_ai/net.py` — every outbound request, including the websocket
   upgrade, now names the product. `tui/tests/test_net.py` is the regression.
2. **The control plane was not running, and the backend did not know where it
   would be**, so the endpoint answered `503 sign-in is not configured`. It runs
   now as `jojoai-control-plane.service`, mail wired to the same Brevo relay
   JojoCode uses, with the owner's address seeded as SUPERADMIN.

Verified: a code was mailed (control-plane log, 15:54), request→verify→token
mints a 12 h SUPERADMIN session, a client installed from the published wheel
gets 200 where it used to get 403, and the websocket reaches the gateway through
Cloudflare and is answered by the control plane's verdict.

**You must reinstall to get the fix** — the client is what was banned. Wheel
0.2.1 is published at `/dl/`, so re-running the installer is enough.

Known limits, written down rather than discovered later:
- `JOJOAI_CP_STORE=memory` — a control-plane restart signs everyone out.
  Accounts are re-seeded; tokens are not. Postgres before this matters.
- The **demo access code no longer works**. Real auth is now wired, and
  `checkAuth` only falls back to it when the control plane is absent.

### 2 · The TUI opened on a model the machine had not pulled — **done**
The installer recommended and pulled qwen2.5-coder:7b; `jojo` still opened on
gpt-oss:120b, because the recommendation had nowhere to be written down. There
is now `~/.config/jojocode-ai/settings.json`, written by `recommend-model.py`
after a successful pull and read by the TUI. `--model` > `JOJO_MODEL` > that
file > the built-in default. `/model` shows and `/model <tag> --save` sets it.
Arrives with the reinstall.

### 3 · The landing page backdrop — **done, verified in a browser**
It froze past `scrollY > innerHeight * 1.6`, which was written into the loop.
Gone: it animates the whole way down and the scroll now drifts the camera.
Rewritten as glowing green embers with a real half-life (2.6 s, six to a cycle)
and a two-lobe additive glow — hot core, wide halo, white at the centre.
`web/bg-test.mjs` asserts the regression in a real browser.

### 4 · Web search for JojoCode — **started: core built and tested, nothing wired**
`packages/ai/src/websearch.ts` in the JojoCode repo: search (keyless DuckDuckGo,
or Brave with a key), fetch-one-page-as-text, an SSRF guard that re-checks every
redirect hop, and the untrusted-content envelope. 15 tests, none touching the
internet. `docs/web-search.md` there holds the recon, the design, and the order
of surfaces — teacher-facing and human-in-the-loop first, JojoBot last or never.

**Waiting on you:** which surface gets it first. Recommendation in that document.

---

## Still open, from before

- **Installer errors on Windows** (`install/install.ps1`). The Linux side was
  reworked and has `install/test-install.sh`; Windows has had no equivalent
  pass, and no Windows box here to run one on.
- **A CLAUDE.md for this repo.** Now exists — check it still matches after the
  above.
- **Postgres for the control plane.** `PrismaStore` is named in a comment and
  does not exist; `MemoryStore` is the only implementation.
- **"A lot of other things to do"** — still awaiting your list.
