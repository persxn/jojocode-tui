#!/usr/bin/env bash
# Phase 0 spike harness — proves exactly-once tool execution across a
# mid-tool-call client crash + resume. See README.md.
set -uo pipefail
cd "$(dirname "$0")"

PORT=7799
WORK="$(mktemp -d)"
JOURNAL="$WORK/journal.json"
SIDE="$WORK/sideeffect.log"
: > "$SIDE"

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
lines() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

echo "== starting spike server =="
node server.mjs --port "$PORT" --resume-window-ms 600000 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; rm -rf "$WORK"' EXIT
sleep 0.6

# ---------------------------------------------------------------------------
echo
echo "== Scenario A: clean run (baseline) =="
node client.mjs --port "$PORT" --journal "$JOURNAL" --sideeffect "$SIDE" --turn "A" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "client reached turn_done (rc=0)" || bad "client rc=$rc"
n=$(lines "$SIDE"); [ "$n" -eq 1 ] && ok "side effect ran exactly once (lines=$n)" || bad "side effect lines=$n (want 1)"

# ---------------------------------------------------------------------------
echo
echo "== Scenario B: crash AFTER exec, BEFORE result is sent, then resume =="
rm -f "$JOURNAL"; : > "$SIDE"

node client.mjs --port "$PORT" --journal "$JOURNAL" --sideeffect "$SIDE" --turn "B" --crash-after-exec >/dev/null 2>&1
rc=$?
[ "$rc" -eq 7 ] && ok "client crashed as instructed (rc=7)" || bad "client rc=$rc (want 7)"
n=$(lines "$SIDE"); [ "$n" -eq 1 ] && ok "side effect ran once before crash (lines=$n)" || bad "side effect lines=$n (want 1)"
grep -q '"resumeToken"' "$JOURNAL" && ok "resumeToken persisted to journal" || bad "no resumeToken in journal"

echo "  -- reconnecting --"
node client.mjs --port "$PORT" --journal "$JOURNAL" --sideeffect "$SIDE" --turn "B" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "resumed client reached turn_done (rc=0)" || bad "resumed client rc=$rc"
n=$(lines "$SIDE"); [ "$n" -eq 1 ] && ok "EXACTLY-ONCE held across crash+resume (lines=$n)" || bad "side effect lines=$n (want 1 — DUPLICATE EXECUTION)"

# ---------------------------------------------------------------------------
echo
echo "== Scenario C: crash BEFORE exec, then resume (should execute once, total) =="
rm -f "$JOURNAL"; : > "$SIDE"

node client.mjs --port "$PORT" --journal "$JOURNAL" --sideeffect "$SIDE" --turn "C" --crash-before-exec >/dev/null 2>&1
rc=$?
[ "$rc" -eq 7 ] && ok "client crashed before exec (rc=7)" || bad "client rc=$rc (want 7)"
n=$(lines "$SIDE"); [ "$n" -eq 0 ] && ok "side effect did NOT run (lines=$n)" || bad "side effect lines=$n (want 0)"

echo "  -- reconnecting --"
node client.mjs --port "$PORT" --journal "$JOURNAL" --sideeffect "$SIDE" --turn "C" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "resumed client reached turn_done (rc=0)" || bad "resumed client rc=$rc"
n=$(lines "$SIDE"); [ "$n" -eq 1 ] && ok "side effect ran exactly once overall (lines=$n)" || bad "side effect lines=$n (want 1)"

# ---------------------------------------------------------------------------
echo
echo "== Scenario D: stale resume token (past the window) =="
rm -f "$JOURNAL"; : > "$SIDE"
echo '{"sessionId":"gone","resumeToken":"00000000-0000-0000-0000-000000000000","results":{}}' > "$JOURNAL"
out=$(node client.mjs --port "$PORT" --journal "$JOURNAL" --sideeffect "$SIDE" --turn "D" 2>&1)
echo "$out" | grep -q 'resume window expired' && ok "server rejected unknown resume token cleanly" || bad "unexpected: $out"

# ---------------------------------------------------------------------------
echo
echo "================================"
echo "  PASS: $pass   FAIL: $fail"
echo "================================"
[ "$fail" -eq 0 ] && exit 0 || exit 1
