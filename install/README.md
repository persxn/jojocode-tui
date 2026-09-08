# `install/` — one-command setup

| Script | Does |
|---|---|
| `install.sh` / `install.ps1` | **Turnkey.** Installs Python (+venv/pip) if missing — apt / dnf / pacman / zypper / apk / brew on Linux & macOS, winget on Windows — then a private venv + the TUI + a `jojo` launcher on PATH, then Ollama and a model that fits the machine. `JOJO_NO_OLLAMA=1` for the TUI only; `JOJO_MODEL=<tag>` to override the pick. This is what `curl -fsSL https://ai.jojocode.in/install.sh \| sh` (or `irm …/install.ps1 \| iex`) runs. The only privileged step is the OS package install (sudo when not root). |
| `ollama-setup.sh` | Detect OS/arch, install and start Ollama, set `OLLAMA_NUM_PARALLEL`. Idempotent. |
| `recommend-model.py` | Read CPU / RAM / NVIDIA VRAM / Apple + Grace/Tegra unified memory, recommend the largest model that runs well (`gpt-oss:120b` → `gpt-oss:20b` → `qwen2.5-coder:{14b,7b,3b}`), then `--pull` / `--run` it. stdlib only. |

Quick start:

```sh
curl -fsSL https://ai.jojocode.in/install.sh | sh          # TUI + launcher
curl -fsSL https://ai.jojocode.in/ollama-setup.sh | sh     # Ollama
python3 recommend-model.py --run                           # pick a model + go
```

Verified: `install.sh` into a sandbox prefix → Python detect → venv → pip install
→ `jojo` launcher, all green (Ollama step exercised separately).
`recommend-model.py` correctly identifies a unified-memory board and recommends
`gpt-oss:120b`. `install.ps1` is syntax- and brace-balance-reviewed; not yet run
on a Windows host.
