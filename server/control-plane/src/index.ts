/**
 * Jojo AI — control plane.
 *
 * The always-on half. Issues/revokes login tokens (email + OTP), owns
 * accounts/grants/config/audit, and answers the backend's authz checks.
 * Runs with an in-memory store by default (dev/CI); JOJOAI_CP_STORE=prisma with
 * JOJOAI_DATABASE_URL uses Postgres (prisma-store.ts), which is what makes a
 * restart stop signing everybody out.
 *
 * Routes
 *   GET  /healthz
 *   POST /api/auth/otp/request   { email }                 -> { ok: true }        (always, anti-enumeration)
 *   POST /api/auth/otp/verify    { email, code }           -> { token, expiresAt, role, accountId } | 400
 *   POST /api/auth/logout        { token }                 -> { ok: true }
 *   POST /api/authz/check        { token }  + x-jojoai-service  -> { allow, role?, reason?, accountId?, email? }
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { authorize, type AuthzInput } from '@jojoai/shared/authorize';
import { config, assertConfig } from './config.ts';
import { MemoryStore, seedStore, type Store } from './store.ts';
import { PrismaStore } from './prisma-store.ts';
import { generateCode, hashCode, codeMatches, deliver } from './otp.ts';
import { mintToken, hashToken, secretEquals } from './tokens.ts';

assertConfig();

const store: Store =
  config.store === 'prisma' ? PrismaStore.fromUrl(config.databaseUrl) : new MemoryStore();
await seedStore(store, { ownerEmail: config.ownerEmail, seedJson: config.seedJson });

// ── helpers ──────────────────────────────────────────────────────────────
const json = (res: ServerResponse, code: number, body: unknown): void => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

/** Read + parse a JSON body. Never throws — a bad/oversized/empty body yields {}. */
async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) return {};
      chunks.push(c as Buffer);
    }
    if (!chunks.length) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Build the authorize() snapshot for an account (or null). */
async function snapshot(email: string): Promise<AuthzInput> {
  const account = await store.getAccountByEmail(email);
  const cfg = await store.serviceConfig();
  const grants = account
    ? (await store.grantsForAccount(account.id)).map((g) => ({
        startsAt: g.startsAt,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
        paidPaymentLinked: g.paidPaymentLinked,
      }))
    : [];
  return {
    now: new Date(),
    account: account
      ? { status: account.status, role: account.role, accessMode: account.accessMode }
      : null,
    grants,
    service: {
      enabled: cfg.serviceEnabled,
      maintenanceMessage: cfg.maintenanceMessage,
      openHours: cfg.openHoursJson,
    },
  };
}

const isEmail = (v: unknown): v is string =>
  typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && v.length <= 254;

// ── routes ───────────────────────────────────────────────────────────────
async function otpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const email = String(body.email ?? '').trim().toLowerCase();
  // Uniform 200 no matter what — never reveal whether the address has an account.
  const done = () => json(res, 200, { ok: true });

  if (!isEmail(email)) return done();

  const recent = await store.countRecentOtp(email, 60 * 60 * 1000);
  if (recent >= config.otpRequestsPerHour) {
    await store.appendAudit({ actorType: 'SYSTEM', actorId: null, action: 'otp.rate_limited', targetType: 'email', targetId: email });
    return done();
  }

  const snap = await snapshot(email);
  // Only the account-status part of authorize() gates code issuance; grants /
  // hours / payment are checked at verify + connect. No account ⇒ still 200.
  if (!snap.account || snap.account.status === 'DELETED' || snap.account.status === 'SUSPENDED') {
    return done();
  }

  const code = generateCode();
  await store.createOtp({
    email,
    codeHash: hashCode(code),
    purpose: 'login',
    expiresAt: new Date(Date.now() + config.otpTtlMinutes * 60_000),
    maxAttempts: config.otpMaxAttempts,
  });
  await deliver(email, code);
  await store.appendAudit({ actorType: 'ACCOUNT', actorId: email, action: 'otp.request', targetType: 'email', targetId: email });
  return done();
}

async function otpVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const email = String(body.email ?? '').trim().toLowerCase();
  const code = String(body.code ?? '').trim();
  if (!isEmail(email) || !/^\d{4,10}$/.test(code)) return json(res, 400, { error: 'bad request' });

  const challenge = await store.latestOtp(email, 'login');
  if (!challenge || challenge.consumedAt || challenge.expiresAt < new Date()) {
    return json(res, 400, { error: 'no valid code — request a new one' });
  }
  if (challenge.attempts >= challenge.maxAttempts) {
    await store.consumeOtp(challenge.id);
    return json(res, 400, { error: 'too many attempts — request a new code' });
  }
  if (!codeMatches(code, challenge.codeHash)) {
    await store.bumpOtpAttempts(challenge.id);
    return json(res, 400, { error: 'incorrect code' });
  }
  await store.consumeOtp(challenge.id);

  // Re-check the full policy at the moment of token mint.
  const snap = await snapshot(email);
  const decision = authorize(snap);
  if (!decision.allow) {
    await store.appendAudit({ actorType: 'SYSTEM', actorId: null, action: 'authz.deny', targetType: 'email', targetId: email, reason: decision.reason });
    return json(res, 403, { error: `access denied: ${decision.reason}`, reason: decision.reason });
  }

  const account = (await store.getAccountByEmail(email))!;
  const { token, tokenHash } = mintToken();
  const grants = await store.grantsForAccount(account.id);
  const activeGrant = grants.find((g) => !g.revokedAt && g.startsAt <= new Date() && new Date() < g.expiresAt);
  const ttlMs = config.sessionMaxTtlHours * 3_600_000;
  const expiresAt = new Date(
    Math.min(Date.now() + ttlMs, activeGrant ? +activeGrant.expiresAt : Date.now() + ttlMs),
  );

  await store.createAuthSession({
    accountId: account.id,
    tokenHash,
    expiresAt,
    ip: req.socket.remoteAddress ?? null,
    userAgent: (req.headers['user-agent'] as string) ?? null,
  });
  await store.appendAudit({ actorType: 'ACCOUNT', actorId: account.id, action: 'auth.login', targetType: 'account', targetId: account.id });

  return json(res, 200, { token, expiresAt: expiresAt.toISOString(), role: account.role, accountId: account.id });
}

async function authzCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const svc = (req.headers['x-jojoai-service'] as string) ?? '';
  if (!config.serviceToken || !secretEquals(svc, config.serviceToken)) {
    return json(res, 401, { error: 'bad service token' });
  }
  const body = await readJson(req);
  const token = String(body.token ?? '');
  if (!token) return json(res, 400, { error: 'no token' });

  const sess = await store.getAuthSessionByHash(hashToken(token));
  if (!sess) return json(res, 200, { allow: false, reason: 'invalid_token' });
  if (sess.revokedAt) return json(res, 200, { allow: false, reason: 'revoked' });
  if (sess.expiresAt < new Date()) return json(res, 200, { allow: false, reason: 'expired' });
  const account = await store.getAccountById(sess.accountId);
  if (!account) return json(res, 200, { allow: false, reason: 'no_account' });

  const decision = authorize(await snapshot(account.email));
  await store.touchAuthSession(sess.id);
  if (!decision.allow) {
    await store.appendAudit({ actorType: 'SYSTEM', actorId: null, action: 'authz.deny', targetType: 'account', targetId: account.id, reason: decision.reason });
    return json(res, 200, { allow: false, reason: decision.reason });
  }
  return json(res, 200, { allow: true, role: decision.role, accountId: account.id, email: account.email });
}

async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const token = String(body.token ?? '');
  if (token) {
    const sess = await store.getAuthSessionByHash(hashToken(token));
    if (sess) await store.revokeAuthSession(sess.id, 'user_logout');
  }
  return json(res, 200, { ok: true });
}

// ── server ───────────────────────────────────────────────────────────────
export const server = createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0];
  const method = req.method ?? 'GET';
  const route = `${method} ${url}`;

  const handler: Record<string, (rq: IncomingMessage, rs: ServerResponse) => Promise<void>> = {
    'POST /api/auth/otp/request': otpRequest,
    'POST /api/auth/otp/verify': otpVerify,
    'POST /api/auth/logout': logout,
    'POST /api/authz/check': authzCheck,
  };

  if (route === 'GET /healthz') return json(res, 200, { ok: true, service: 'jojoai-control-plane', store: config.store });
  const fn = handler[route];
  if (!fn) return json(res, 404, { error: 'not found' });

  fn(req, res).catch((err: unknown) => {
    console.error('[control-plane]', route, err);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  });
});

export { store };

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(config.port, config.host, () => {
    console.log(
      `[control-plane] http://${config.host}:${config.port}  store=${config.store}  ` +
        `mail=${config.mail}${config.ownerEmail ? `  owner=${config.ownerEmail}` : ''}`,
    );
  });
}
