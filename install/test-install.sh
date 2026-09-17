#!/usr/bin/env bash
#
# Install-script conformance run.
#
# Installs the TUI from scratch in a clean container of each supported distro
# and asserts the result actually works — not merely that the script exited 0.
# The distros are chosen for the ways they differ: no Python at all, Python
# without `venv` (Debian splits it out), musl instead of glibc, dnf instead of
# apt, and a non-root user who cannot install anything system-wide.
#
#   ./install/test-install.sh            # every case
#   ./install/test-install.sh debian     # one
#
# It serves this working tree over HTTP so the containers install *this*
# version rather than whatever is published. Nothing here touches the host.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVE="${JOJO_TEST_SERVE:-/tmp/jojo-serve}"
PORT="${JOJO_TEST_PORT:-8771}"
ONLY="${1:-}"

pass=0; fail=0; failed=()

# The host address a container reaches the serving process on. `host-gateway`
# is what makes `host.docker.internal` work on Linux, where it is not built in.
HOSTMAP=(--add-host "host.docker.internal:host-gateway")
ENDPOINT="http://host.docker.internal:$PORT"

say()  { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); failed+=("$*"); }

# ---------------------------------------------------------------- the serving
prepare_serve() {
  mkdir -p "$SERVE/dl"
  cp "$REPO/install/install.sh" "$REPO/install/install.ps1" \
     "$REPO/install/ollama-setup.sh" "$REPO/install/recommend-model.py" "$SERVE/" 2>/dev/null
  # A wheel built from this tree, so the container installs today's code.
  if ! ls "$SERVE"/dl/jojocode_ai_tui-*.whl >/dev/null 2>&1; then
    python3 -m build --wheel --outdir "$SERVE/dl" "$REPO/tui" >/dev/null 2>&1 \
      || { echo "could not build the wheel (pip install build hatchling)"; exit 1; }
  fi
  basename "$(ls -t "$SERVE"/dl/jojocode_ai_tui-*.whl | head -1)" > "$SERVE/dl/tui-wheel"
}

start_serve() {
  # ThreadingHTTPServer, not `python3 -m http.server`.
  #
  # The default is single-threaded, and the installer opens several fetches in
  # quick succession (the script, the wheel index, the wheel, the model
  # helper). One slow or half-closed connection blocked the rest, and a
  # container received a *truncated* install.sh — which surfaced as
  # `Syntax error: end of file unexpected` at whatever line the bytes stopped,
  # a failure that looks exactly like a bug in the script and is not one.
  ( cd "$SERVE" && exec python3 -c '
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
handler = partial(SimpleHTTPRequestHandler, directory=".")
ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), handler).serve_forever()
' "$PORT" ) >/dev/null 2>&1 &
  SERVE_PID=$!
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$PORT/install.sh" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "the test server did not come up on $PORT"; exit 1
}
stop_serve() { [ -n "${SERVE_PID:-}" ] && kill "$SERVE_PID" 2>/dev/null; }
trap stop_serve EXIT

# ------------------------------------------------------------------ one case
#   run_case <label> <image> <bootstrap-cmd> [<user-setup>] [<run-as>]
run_case() {
  local label="$1" image="$2" boot="$3" setup="${4:-true}" as="${5:-}"
  [ -n "$ONLY" ] && [ "$ONLY" != "$label" ] && return 0

  say "$label  ($image)"
  local runner="sh -c"
  [ -n "$as" ] && runner="su $as -c"

  local out
  out="$(docker run --rm "${HOSTMAP[@]}" -e "JOJO_ENDPOINT=$ENDPOINT" \
        -e JOJO_NO_OLLAMA=1 "$image" sh -c "
          set -e
          $boot
          $setup
          # Bootstrap is fatal; the run under test is not. Without this, a
          # failing installer tripped \`set -e\` before its exit code could be
          # printed and the case reported as empty rather than as broken.
          set +e
          # The installer's own exit code, not \`tail\`'s. Piping the run into
          # tail made \$? report the pager and every case looked like it passed.
          $runner 'curl -fsSL \$JOJO_ENDPOINT/install.sh | sh' >/tmp/run.log 2>&1
          echo \"__EXIT__\$?\"
          tail -40 /tmp/run.log
          # The real assertion: the thing it installed has to run.
          $runner '\"\$HOME/.local/bin/jojo\" --version' 2>&1 | tail -3
          echo \"__VER__\$?\"
        " 2>&1)"

  local iexit vexit
  iexit="$(printf '%s' "$out" | sed -n 's/.*__EXIT__\([0-9]*\).*/\1/p' | head -1)"
  vexit="$(printf '%s' "$out" | sed -n 's/.*__VER__\([0-9]*\).*/\1/p' | head -1)"

  if [ "${iexit:-1}" = 0 ]; then ok "$label · installer exited 0"
  else bad "$label · installer exited ${iexit:-?}"; printf '%s\n' "$out" | tail -25 | sed 's/^/      /'; fi

  if [ "${vexit:-1}" = 0 ] && printf '%s' "$out" | grep -q "JojoCode AI TUI"; then
    ok "$label · installed \`jojo\` runs"
  else
    bad "$label · installed \`jojo\` does not run"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
  fi
}

# --------------------------------------------------------------------- cases
prepare_serve
start_serve

APT_BOOT='apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq curl ca-certificates sudo >/dev/null 2>&1'

# No Python at all — the reported case.
run_case debian debian:12-slim "$APT_BOOT"

# Python present but `venv` missing, which is Debian's split package. The
# installer has to notice and install python3-venv rather than dying inside pip.
run_case debian-novenv debian:12-slim \
  "$APT_BOOT; apt-get install -y -qq python3-minimal >/dev/null 2>&1"

# musl, busybox sh, apk. Nothing about this resembles Debian.
run_case alpine alpine:3.20 'apk add --no-cache curl bash sudo >/dev/null 2>&1'

# dnf, and a distro that ships python3 already.
run_case fedora fedora:40 'dnf install -y -q curl sudo >/dev/null 2>&1'

# Ubuntu, because it is what most people actually have.
run_case ubuntu ubuntu:24.04 "$APT_BOOT"

# A user who is NOT root and has no sudo rights: the install must still work
# when Python is already there, and must never write root-owned files.
run_case unprivileged debian:12-slim \
  "$APT_BOOT; apt-get install -y -qq python3 python3-venv python3-pip >/dev/null 2>&1" \
  'useradd -m student' 'student'

# --------------------------------------------------------------------- report
say "Result"
printf '  %d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '\n  failing:\n'; printf '    - %s\n' "${failed[@]}"
  exit 1
fi
printf '\n  \033[32mall install cases pass\033[0m\n'
