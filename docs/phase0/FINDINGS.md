# Phase 0 — Findings

## F1. Ollama concurrency benchmark — gpt-oss:120b on a unified-memory host

**Date:** 2026-09-07 · **Box:** a 120 GB unified-memory host · **Ollama:**
0.33.2 (bundled) · **Model:** `gpt-oss:120b`
(64 GB resident, MXFP4) · flash attention on · 250–300 `num_predict`, temp 0.
Script: `phase0/bench.mjs`.

### Results

| `OLLAMA_NUM_PARALLEL` | concurrent reqs | per-stream tok/s | TTFT (p50) | aggregate tok/s | wall (all done) |
|---|---|---|---|---|---|
| **1** (Ollama default) | 1 | 43 | 154 ms | 43 | 6.7 s |
| **1** | 2 | 43 *(serialized)* | 6.8 s *(queued)* | 43 | 13.3 s |
| **1** | 4 | 43 *(serialized)* | 13.5 s | 43 | 26.9 s |
| **1** | 8 | 43 *(serialized)* | up to **73 s** | 28.6 *(degrades)* | 80 s |
| **4** | 2 | 38 | 210 ms | 75 | 6.7 s |
| **4** | 4 | 28 | 430 ms | 109 | 9.2 s |
| **8** | 8 | 24.5 | 600 ms | **187** | 10.7 s |

### What this means

1. **Ollama's default serializes every request.** `OLLAMA_NUM_PARALLEL` is unset
   → Ollama picks **1** for a model this large. The first benchmark showed zero
   concurrency benefit purely because of this. **We must set it explicitly.**
2. **With it set, continuous batching genuinely works.** 8 concurrent requests
   at `NUM_PARALLEL=8` complete together in ~10.7 s (vs 80 s serialized), each
   streaming ~24.5 tok/s with 600 ms TTFT. Aggregate throughput scales
   43 → 75 → 109 → 187 tok/s as parallelism goes 1 → 2 → 4 → 8.
3. **Memory is the ceiling, not compute.** At `NUM_PARALLEL=8` with the 64 GB
   model, `free -g` showed **108 / 119 GB used, ~1 GB free**. That fits but with
   no headroom — and JojoCode's Postgres + web + worker (~7 GB) also live on this
   box. `NUM_PARALLEL=4` leaves ~20 GB free: the safe operating point.
4. **Context window is divided per slot.** Total model context 131 072 tokens ÷
   `NUM_PARALLEL`:
   - N=2 → **64 K / slot** (comfortable for deep agent tasks)
   - N=4 → **32 K / slot** (workable; the agent orchestrator must budget to this)
   - N=8 → **16 K / slot** (tight once real files + transcript are in play)
5. **Per-stream speed stays usable even at 8-way** (24.5 tok/s ≈ many hosted
   chat models). Users won't feel starved by parallelism itself — only by the
   *queue* when active users exceed the slot count.
6. **`gpt-oss:20b` reference:** 60 tok/s single-stream, 13 GB, TTFT 112 ms. A
   viable "fast lane" / fallback / high-parallelism option. Quality tradeoff
   unquantified.

### Recommendations (update D7)

- **Set `OLLAMA_NUM_PARALLEL=4`** as the baseline (was implicitly 1).
  Revisit `2` if agent tasks need >32 K context per turn, or `6` if this box
  becomes dedicated to Jojo AI (no JojoCode co-tenant). `8` is memory-marginal.
- **`max_concurrent_inference` knob default = 4** (the plan proposed 2 — the
  data says 4 is free). It stays a knob; ops can lower it.
- The **per-message queue is normal operation, not an edge case**: with 8 seats
  and 4 inference slots, whenever 5–8 users send at once, 1–4 wait — but only
  ~1 turn (~9 s), not minutes. Acceptable. Show queue position in the CLI.
- **Agent orchestrator context budget must target ~28 K usable tokens**
  (32 K/slot minus response headroom) at `NUM_PARALLEL=4`. This makes
  context-window trimming / summarization a Phase 1 requirement, not a
  nice-to-have.
- Consider a later **"fast path" on `gpt-oss:20b`** for cheap operations
  (title generation, quick classification, retries) to keep 120b slots for real
  reasoning. Defer past V1.

### Ops notes

- Bring Ollama up with: `OLLAMA_NUM_PARALLEL=4 OLLAMA_FLASH_ATTENTION=1
  OLLAMA_NUM_PARALLEL=4 ollama serve`
  (or bake into a systemd unit for the real deployment).
- Model auto-unloads after ~5 min idle (frees the 64 GB). First call after that
  pays ~11 s reload.
- `ollama ps` shows resident model, processor split (100 % GPU here), and the
  context value.

---

## F2. WS agent-loop reconnect/resume + exactly-once tools — PASS (2026-09-07)

**De-risks R7 / R8** — the riskiest part of decision D2. Spike in
`phase0/spike-ws-resume/` (server + Node client + harness). `npm run spike:resume`.

**Mechanism:** stable `id` per `tool_request`; client keeps a local journal
(`resumeToken` + `id → result`); server holds a disconnected session for a
resume window and tracks unanswered tool requests; on reconnect the server
replays them; the client answers replayed ids from its journal **without
re-running the side effect**.

**Result: 12/12 assertions pass**, including the one that matters —

| Scenario | Outcome |
|---|---|
| A · clean run | turn completes, side effect once |
| **B · crash after exec, before result sent → reconnect** | **exactly-once holds** — side effect still ran once after resume+replay |
| C · crash before exec → reconnect | runs exactly once overall |
| D · stale resume token | server closes cleanly ("resume window expired") |

**Conclusion:** the D2 server-side-loop + thin-client design is sound for
exactly-once tool execution across a client crash. The approach lifts directly
into Phase 1 with two additions: (1) persist `AgentSession`/`AgentTurn` to
Postgres so resume also survives a **backend restart** (not just a client
crash); (2) bound journal + result sizes, and define replay ordering when
multiple tool calls are pending at once.

## F3. `ai.jojocode.in` Cloudflare tunnel latency spike — BLOCKED

Needs Cloudflare dashboard access or a tunnel connector token from the owner.
Deferred until then; does not block Phase 1 backend/CLI work on the LAN.
