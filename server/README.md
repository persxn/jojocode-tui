# `server/` — reference hosted service

Everything needed to offer the TUI as a rentable, multi-user service. This is a
**reference implementation**: self-host it, bring your own infra, and put your
own secrets in `.env` (only `.env.example` is in git).

| Path | What | Status |
|---|---|---|
| `shared/` | Prisma schema (control-plane DB), the CLI↔backend wire protocol, and two pure libs: `authorize.ts` (the access-decision function) + `rbac.ts` (roles + capabilities) | T2, T10 |
| `control-plane/` | Always-on `node:http` service: email-OTP login, opaque hashed tokens, `POST /api/authz/check` for the backend. In-memory store (dev/CI) or Prisma (prod) | T10 |
| `backend/` | host-side WebSocket gateway — auth on connect via the control plane (fail-closed), the server-side orchestrator loop, the Ollama client; seat/queue/idle/reaper next | T11 |
| `admin/` | Minimal standalone panel: accounts, grants, live sessions, config, audit | T12 |

Auth is email + OTP (no long-lived password), opaque tokens (only the SHA-256 is
stored), RBAC (`SUPERADMIN` / `ADMIN` / `USER`), and time-boxed access grants
("rental") with an optional per-account paid toggle. Secrets: `../server/.env.example`.

### Run it locally (no database)

```sh
# control plane
JOJOAI_SERVICE_TOKEN=dev JOJOAI_OWNER_EMAIL=you@example.com \
  node --experimental-strip-types control-plane/src/index.ts      # :7460

# backend, wired to it
JOJOAI_CONTROL_PLANE_URL=http://127.0.0.1:7460 JOJOAI_SERVICE_TOKEN=dev \
  node --experimental-strip-types backend/src/index.ts            # :7420

npm test        # authorize (10) + control-plane (7) + ws-resume spike (12)
```

### Running it for real (what `ai.jojocode.in` does)

Both halves read one mode-600 `server/.env`; nothing lives in a unit file,
because a unit is world-readable and `systemctl cat` prints it.

```ini
# ~/.config/systemd/user/jojoai-control-plane.service
EnvironmentFile=%h/src/jojo-ai/server/.env
ExecStart=node --experimental-strip-types %h/src/jojo-ai/server/control-plane/src/index.ts
```

The backend unit reads the same file, which is what sets
`JOJOAI_CONTROL_PLANE_URL` — **without it every login attempt is answered
`503 sign-in is not configured on this server`**, whatever the client does.

Two things that follow from wiring it up, and surprise people:

- **The demo code stops working.** `checkAuth` only falls back to
  `JOJOAI_DEMO_CODE` when the control plane is *not* configured. Once it is,
  every token is minted by OTP.
- **`JOJOAI_CP_STORE=memory` forgets on restart.** Accounts are re-seeded from
  `JOJOAI_OWNER_EMAIL` / `JOJOAI_SEED`, but issued tokens are not — a restart
  signs everybody out. Point it at Postgres before that matters.

Mail is `JOJOAI_MAIL=smtp` plus `JOJOAI_SMTP_HOST/PORT/USER/PASS`. Four plain
variables rather than a URL: a relay key is long and lands in the password
position, where an unescaped `@` or `/` silently truncates it.

> See [`../docs/BUILD-PLAN.md`](../docs/BUILD-PLAN.md).
