# `tui/` — the JojoCode AI TUI

The terminal client. A full-screen curses app (Python) with a green
forest→mint theme, an animated ASCII cat, streamed reasoning, syntax-highlighted
code, and per-tool approval prompts.

Two modes:

| Mode | How it runs | Use when |
|---|---|---|
| **local** (default) | Drives your own Ollama on `127.0.0.1:11434`; the agent loop runs on your machine | You have a capable box and want zero dependencies on a server |
| **remote** (`--remote https://host`) | OTP login, then a WebSocket session to a hosted server that runs the loop; tools still execute locally with your approval | You want a big model you can't host |

> Populated in **T3**. See [`../docs/BUILD-PLAN.md`](../docs/BUILD-PLAN.md).
