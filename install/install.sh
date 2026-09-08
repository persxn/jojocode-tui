#!/bin/sh
# install.sh — set up everything needed to run `jojo` on Linux or macOS.
#
#   curl -fsSL https://ai.jojocode.in/install.sh | sh
#
# Turnkey: installs Python (+ venv/pip) if missing, installs the TUI into a
# private virtualenv, drops a `jojo` launcher on your PATH, installs and starts
# Ollama, and pulls a model that fits this machine. Nothing needs to already be
# present. The only privileged step is the OS package install for Python/Ollama,
# done via sudo when you are not root.
#
# Env overrides:
#   JOJO_TUI_SOURCE      pip target (default: PyPI 'jojocode-ai-tui', then the git repo)
#   JOJO_PREFIX          venv location      (default ~/.local/share/jojocode-ai)
#   JOJO_BINDIR          launcher location  (default ~/.local/bin)
#   JOJO_ENDPOINT        where to fetch helper scripts (default https://ai.jojocode.in)
#   JOJO_NO_OLLAMA=1     install the TUI only; skip Ollama + model
#   JOJO_MODEL=<tag>     pull this model instead of the auto-recommended one
#   JOJO_NONINTERACTIVE=1  never prompt (assume yes)
set -eu

ENDPOINT="${JOJO_ENDPOINT:-https://ai.jojocode.in}"
PREFIX="${JOJO_PREFIX:-$HOME/.local/share/jojocode-ai}"
BINDIR="${JOJO_BINDIR:-$HOME/.local/bin}"
VENV="$PREFIX/venv"
REPO_PIP='jojocode-ai-tui @ git+https://github.com/persxn/jojocode-tui.git#subdirectory=tui'

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31minstall: %s\033[0m\n' "$*" >&2; exit 1; }

OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Linux|Darwin) : ;;
  *) die "this script is for Linux/macOS. On Windows run install.ps1 in PowerShell." ;;
esac
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "need curl or wget"
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }

# --- privilege helper --------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"
  else warn "not root and no sudo — OS package installs will be skipped"; fi
fi
run_priv() { if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then $SUDO "$@"; else return 1; fi; }

# --- detect the OS package manager -----------------------------------
PM=""
for c in apt-get dnf pacman zypper apk brew; do
  command -v "$c" >/dev/null 2>&1 && { PM="$c"; break; }
done

pm_install() { # pm_install <pkg...>
  [ -n "$PM" ] || { warn "no known package manager; install manually: $*"; return 1; }
  case "$PM" in
    apt-get) run_priv apt-get update -qq && run_priv apt-get install -y "$@" ;;
    dnf)     run_priv dnf install -y "$@" ;;
    pacman)  run_priv pacman -Sy --noconfirm "$@" ;;
    zypper)  run_priv zypper --non-interactive install "$@" ;;
    apk)     run_priv apk add "$@" ;;
    brew)    brew install "$@" ;;   # brew must not run under sudo
  esac
}

# --- 1. Python >= 3.9 (+ venv + pip) --------------------------------
step "Python"
find_python() {
  for c in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python; do
    command -v "$c" >/dev/null 2>&1 || continue
    "$c" -c 'import sys;raise SystemExit(0 if sys.version_info[:2]>=(3,9) else 1)' 2>/dev/null \
      && { printf '%s' "$c"; return 0; }
  done
  return 1
}
PY="$(find_python || true)"
if [ -z "$PY" ]; then
  say "  not found — installing"
  case "$PM" in
    apt-get) pm_install python3 python3-venv python3-pip ;;
    dnf)     pm_install python3 python3-pip ;;
    pacman)  pm_install python ;;
    zypper)  pm_install python3 python3-venv python3-pip ;;
    apk)     pm_install python3 py3-pip ;;
    brew)    pm_install python@3.12 ;;
    *)       : ;;
  esac || true
  PY="$(find_python || true)"
fi
[ -n "$PY" ] || die "could not get Python >= 3.9. Install it and re-run:
  Debian/Ubuntu:  sudo apt install python3 python3-venv python3-pip
  Fedora:         sudo dnf install python3 python3-pip
  Arch:           sudo pacman -S python
  macOS:          brew install python@3.12"
say "  $(command -v "$PY")  ($("$PY" --version 2>&1))"

# `venv` present? (Debian splits it out.)
if ! "$PY" -m venv --help >/dev/null 2>&1; then
  say "  installing the venv module"
  case "$PM" in
    apt-get) pm_install python3-venv ;;
    zypper)  pm_install python3-venv ;;
    *) : ;;
  esac || true
  "$PY" -m venv --help >/dev/null 2>&1 || die "python venv module unavailable — install python3-venv"
fi

# --- 2. virtualenv + the TUI ---------------------------------------
step "The TUI"
mkdir -p "$PREFIX"
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
SRC="${JOJO_TUI_SOURCE:-jojocode-ai-tui}"
if ! "$VENV/bin/python" -m pip install --quiet "$SRC" 2>/dev/null; then
  say "  installing from the git repo"
  "$VENV/bin/python" -m pip install --quiet "$REPO_PIP" \
    || die "could not install the TUI (tried '$SRC' and the git repo)"
fi
say "  $("$VENV/bin/jojo" --version 2>/dev/null || echo installed)"

# --- 3. launcher --------------------------------------------------
step "Launcher"
mkdir -p "$BINDIR"
printf '#!/bin/sh\nexec "%s/bin/jojo" "$@"\n' "$VENV" > "$BINDIR/jojo"
chmod 0755 "$BINDIR/jojo"
say "  $BINDIR/jojo"
case ":$PATH:" in
  *":$BINDIR:"*) : ;;
  *)
    if [ "${SHELL##*/}" = zsh ]; then SHRC="$HOME/.zshrc"; else SHRC="$HOME/.bashrc"; fi
    LINE="export PATH=\"$BINDIR:\$PATH\"   # jojocode-ai"
    if [ -f "$SHRC" ] && grep -qF "$LINE" "$SHRC" 2>/dev/null; then
      say "  $BINDIR already added to $SHRC — open a new shell"
    elif printf '\n%s\n' "$LINE" >> "$SHRC" 2>/dev/null; then
      say "  added $BINDIR to PATH in $SHRC — open a new shell (or: source $SHRC)"
    else
      say "  add to PATH:  export PATH=\"$BINDIR:\$PATH\""
    fi ;;
esac

# --- 4. Ollama + a model ---------------------------------------
if [ "${JOJO_NO_OLLAMA:-0}" = "1" ]; then
  step "Skipping Ollama (JOJO_NO_OLLAMA=1)"
else
  step "Ollama"
  if command -v ollama >/dev/null 2>&1; then
    say "  already installed: $(ollama --version 2>/dev/null | head -1)"
  else
    fetch "$ENDPOINT/ollama-setup.sh" | sh || warn "Ollama setup had a problem — re-run: $ENDPOINT/ollama-setup.sh"
  fi
  if command -v ollama >/dev/null 2>&1 || [ -x "$HOME/.ollama/bin/ollama" ]; then
    step "Model"
    tmp_rec="$(mktemp)"; trap 'rm -f "$tmp_rec"' EXIT
    fetch "$ENDPOINT/recommend-model.py" > "$tmp_rec"
    if [ -n "${JOJO_MODEL:-}" ]; then
      "$VENV/bin/python" "$tmp_rec" --model "$JOJO_MODEL" --pull --yes || warn "model pull failed"
    else
      "$VENV/bin/python" "$tmp_rec" --pull --yes || warn "model pull failed — pick one later with recommend-model.py"
    fi
  fi
fi

cat <<EOF

$(printf '\033[1;32m✓ ready\033[0m')  Start it in any project directory:

    jojo                        # local — uses your Ollama
    jojo --model gpt-oss:20b    # a specific model
    jojo --remote https://ai.jojocode.in --login   # a hosted server

  Update:  "$VENV/bin/python" -m pip install -U jojocode-ai-tui
  Remove:  rm -rf "$PREFIX" "$BINDIR/jojo"
EOF
