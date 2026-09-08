/**
 * Control-plane integration test: real HTTP against the in-memory store.
 * Run:  npm run -w @jojoai/control-plane test
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

let server: Server;
let base: string;
let outbox: string;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jojoai-cp-'));
  outbox = join(dir, 'otp.log');
  process.env.JOJOAI_SERVICE_TOKEN = 'test-svc';
  process.env.JOJOAI_OTP_OUTBOX = outbox;
  process.env.JOJOAI_OWNER_EMAIL = 'owner@example.com';
  process.env.JOJOAI_SEED = JSON.stringify([
    { email: 'dev@example.com', displayName: 'Dev', status: 'APPROVED', role: 'USER', grantDays: 30 },
    { email: 'nogrant@example.com', displayName: 'NoGrant', status: 'APPROVED', role: 'USER' },
  ]);

  ({ server } = await import('./index.ts'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// node's fetch types return `unknown` from .json(); tests don't need the ceremony
const rj = (r: Response): Promise<any> => r.json() as Promise<any>;

async function lastCodeFor(email: string): Promise<string> {
  const text = await readFile(outbox, 'utf8');
  const lines = text.trim().split('\n').filter((l) => l.includes(email));
  const m = lines.at(-1)?.match(/code=(\d+)/);
  assert.ok(m, `no code delivered for ${email}`);
  return m![1]!;
}

test('healthz', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal((await rj(r)).ok, true);
});

test('otp/request never reveals whether an account exists', async () => {
  const r = await post('/api/auth/otp/request', { email: 'stranger@example.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(await rj(r), { ok: true });
  // no code should have been generated for a stranger
  let outboxText = '';
  try {
    outboxText = await readFile(outbox, 'utf8');
  } catch {
    /* file may not exist yet */
  }
  assert.ok(!outboxText.includes('stranger@example.com'));
});

test('full login: request → wrong code → right code → token', async () => {
  assert.equal((await post('/api/auth/otp/request', { email: 'dev@example.com' })).status, 200);
  const code = await lastCodeFor('dev@example.com');

  const bad = await post('/api/auth/otp/verify', { email: 'dev@example.com', code: '000000' });
  assert.equal(bad.status, 400);

  const ok = await post('/api/auth/otp/verify', { email: 'dev@example.com', code });
  assert.equal(ok.status, 200);
  const body = await rj(ok);
  assert.match(body.token, /^[\w-]{40,}$/);
  assert.equal(body.role, 'USER');

  // authz/check accepts the fresh token
  const chk = await post('/api/authz/check', { token: body.token }, { 'x-jojoai-service': 'test-svc' });
  assert.equal(chk.status, 200);
  assert.deepEqual(await rj(chk).then((j: any) => ({ allow: j.allow, role: j.role })), {
    allow: true,
    role: 'USER',
  });

  // logout revokes it
  await post('/api/auth/logout', { token: body.token });
  const after = await post('/api/authz/check', { token: body.token }, { 'x-jojoai-service': 'test-svc' });
  assert.equal((await rj(after)).allow, false);
});

test('authz/check requires the service token', async () => {
  const r = await post('/api/authz/check', { token: 'whatever' }, { 'x-jojoai-service': 'nope' });
  assert.equal(r.status, 401);
});

test('approved but no grant → verify denies with no_active_grant', async () => {
  await post('/api/auth/otp/request', { email: 'nogrant@example.com' });
  const code = await lastCodeFor('nogrant@example.com');
  const r = await post('/api/auth/otp/verify', { email: 'nogrant@example.com', code });
  assert.equal(r.status, 403);
  assert.equal((await rj(r)).reason, 'no_active_grant');
});

test('owner (SUPERADMIN) logs in without a grant', async () => {
  await post('/api/auth/otp/request', { email: 'owner@example.com' });
  const code = await lastCodeFor('owner@example.com');
  const r = await post('/api/auth/otp/verify', { email: 'owner@example.com', code });
  assert.equal(r.status, 200);
  const { token, role } = await rj(r);
  assert.equal(role, 'SUPERADMIN');
  const chk = await post('/api/authz/check', { token }, { 'x-jojoai-service': 'test-svc' });
  assert.equal((await rj(chk)).role, 'SUPERADMIN');
});

test('OTP attempt cap burns the challenge', async () => {
  await post('/api/auth/otp/request', { email: 'dev@example.com' });
  for (let i = 0; i < 5; i++) {
    await post('/api/auth/otp/verify', { email: 'dev@example.com', code: '123456' });
  }
  const code = await lastCodeFor('dev@example.com');
  const r = await post('/api/auth/otp/verify', { email: 'dev@example.com', code });
  assert.equal(r.status, 400); // even the correct code fails now
});
