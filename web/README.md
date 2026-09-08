# `web/` — ai.jojocode.in

Static landing + docs + a live status panel. No in-browser agent.

- Hero + the one-line install command, with platform tabs
- How it works (local mode vs remote mode), model card
- Live status: seats used/free, model health, protocol version — fetched from
  the backend's `/status.json`, renders even when the server is offline

`index.html` is one self-contained file. Design system adapted from JojoCode's
`/product` page (eyebrow / title+gradient-accent / lede, pill buttons, section
rhythm, reveal-on-scroll, pointer-lit cards, sticky scroll-spy bar) but in the
TUI's green-on-near-black identity. Space Grotesk + JetBrains Mono via Google
Fonts, with system fallbacks; everything else inline, no other external requests.

Sections: hero + copyable install command (OS tabs) · live status strip ·
how-it-works (local vs remote + an inline SVG data-flow diagram) · the agent
loop · models · **every keyboard shortcut in the TUI** · install (TUI / Ollama /
model, update & remove) · security · a full live status panel. All figures come
from `/status.json` and degrade to "unreachable" when the server is down.

Served by `server/backend`: `/` → `web/index.html`; `/install.sh`, `/install.ps1`,
`/ollama-setup.sh`, `/recommend-model.py` → `install/`. Override the dirs with
`JOJOAI_WEB_DIR` / `JOJOAI_INSTALL_DIR`.

```sh
JOJOAI_PORT=7433 node --experimental-strip-types ../server/backend/src/index.ts
# open http://127.0.0.1:7433/
```
