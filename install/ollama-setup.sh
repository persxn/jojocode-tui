#!/bin/sh
# ollama-setup.sh — install Ollama and get it serving, on Linux or macOS.
#
#   curl -fsSL https://ai.jojocode.in/ollama-setup.sh | sh
#
# Idempotent: safe to re-run. Does nothing destructive. On Windows, see
# install.ps1 (it calls `winget install Ollama.Ollama`).
#
# Env:
#   OLLAMA_NUM_PARALLEL   how many requests Ollama serves at once (default 2)
#   JOJO_NO_SERVE=1       install only; don't try to start the server
set -eu

log()  { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf 'ollama-setup: %s\n' "$*" >&2; exit 1; }

NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-2}"
os="$(uname -s 2>/dev/null || echo unknown)"

# --- 1. install -------------------------------------------------------------
if command -v ollama >/dev/null 2>&1; then
  log "ollama already installed: $(ollama --version 2>/dev/null | head -1)"
else
  case "$os" in
    Linux)
      command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
        || die "need curl or wget to download Ollama"
      log "installing Ollama (official script)…"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL https://ollama.com/install.sh | sh
      else
        wget -qO- https://ollama.com/install.sh | sh
      fi
      ;;
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        log "installing Ollama via Homebrew…"
        brew install --quiet ollama || brew install --cask ollama
      else
        die "install Homebrew (brew.sh) then re-run, or download Ollama.app from ollama.com/download"
      fi
      ;;
    *)
      die "unsupported OS '$os' — on Windows run install.ps1 instead"
      ;;
  esac
  command -v ollama >/dev/null 2>&1 || die "install finished but 'ollama' is not on PATH"
  log "installed: $(ollama --version 2>/dev/null | head -1)"
fi

[ "${JOJO_NO_SERVE:-0}" = "1" ] && { log "skipping server start (JOJO_NO_SERVE=1)"; exit 0; }

# --- 2. serve -------------------------------------------------------------
if curl -fsS -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  log "Ollama is already serving on 127.0.0.1:11434"
  exit 0
fi

# Prefer a systemd service on Linux if the installer set one up.
if [ "$os" = "Linux" ] && command -v systemctl >/dev/null 2>&1 \
   && systemctl list-unit-files 2>/dev/null | grep -q '^ollama\.service'; then
  log "starting the ollama systemd service…"
  if systemctl is-enabled --quiet ollama.service 2>/dev/null || sudo -n true 2>/dev/null; then
    sudo systemctl enable --now ollama.service 2>/dev/null || systemctl --user start ollama 2>/dev/null || true
  fi
fi

if ! curl -fsS -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  log "starting 'ollama serve' in the background…"
  mkdir -p "${HOME}/.local/share/jojocode-ai"
  OLLAMA_NUM_PARALLEL="$NUM_PARALLEL" \
    nohup ollama serve >"${HOME}/.local/share/jojocode-ai/ollama.log" 2>&1 &
  # wait up to ~15s for it to answer
  i=0
  while [ "$i" -lt 30 ]; do
    curl -fsS -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
    i=$((i + 1)); sleep 0.5
  done
fi

if curl -fsS -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  log "Ollama is serving on 127.0.0.1:11434  (OLLAMA_NUM_PARALLEL=$NUM_PARALLEL)"
else
  warn "could not confirm Ollama is up — check ${HOME}/.local/share/jojocode-ai/ollama.log"
  warn "you can run it yourself with:  OLLAMA_NUM_PARALLEL=$NUM_PARALLEL ollama serve"
  exit 1
fi
