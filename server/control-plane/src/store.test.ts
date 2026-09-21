/**
 * One contract, two stores.
 *
 * Every behaviour the HTTP layer relies on, asserted against `MemoryStore`
 * always and against `PrismaStore` whenever `JOJOAI_TEST_DATABASE_URL` points
 * at a scratch database (it is wiped). The point is that the two cannot drift:
 * a rule the memory store keeps and Postgres forgets is a login that works in
 * CI and fails in production.
 *
 *   JOJOAI_TEST_DATABASE_URL=postgresql://…/jojoai_test npm test -w @jojoai/control-plane
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, seedStore, type Store } from './store.ts';
import { PrismaStore } from './prisma-store.ts';

const TEST_URL = process.env.JOJOAI_TEST_DATABASE_URL ?? '';

type Maker = { name: string; make: () => Promise<Store>; done?: () => Promise<void> };
const makers: Maker[] = [{ name: 'MemoryStore', make: async () => new MemoryStore() }];

if (TEST_URL) {
  let prisma: PrismaStore | null = null;
  makers.push({
    name: 'PrismaStore',
    make: async () => {
      prisma = PrismaStore.fromUrl(TEST_URL);
      // A scratch database, wiped per run — never point this at the real one.
      await prisma.db.$executeRawUnsafe(
        'TRUNCATE account, access_grant, payment, otp_challenge, auth_session, audit_event, service_config CASCADE',
      );
      return prisma;
    },
    done: async () => {
      await prisma?.close();
    },
  });
}

for (const maker of makers) {
  describe(maker.name, () => {
    let store: Store;
    before(async () => {
      store = await maker.make();
    });
    after(async () => {
      await maker.done?.();
    });

    test('accounts: created once per email, found case-insensitively', async () => {
      const a = await store.createAccount({ email: 'Owner@Example.com', displayName: 'Owner', role: 'SUPERADMIN', status: 'APPROVED' });
      const again = await store.createAccount({ email: 'owner@example.com', displayName: 'Dup' });
      assert.equal(again.id, a.id, 'createAccount is idempotent by email');
      assert.equal((await store.getAccountByEmail('OWNER@example.COM'))?.id, a.id);
      assert.equal((await store.getAccountById(a.id))?.role, 'SUPERADMIN');
      const updated = await store.updateAccount(a.id, { displayName: 'The Owner', status: 'SUSPENDED' });
      assert.equal(updated.displayName, 'The Owner');
      assert.equal(updated.status, 'SUSPENDED');
      await store.updateAccount(a.id, { status: 'APPROVED' });
      assert.ok((await store.listAccounts()).some((x) => x.id === a.id));
    });

    test('grants: paid flag survives a round trip, and can be withdrawn', async () => {
      const acct = await store.createAccount({ email: 'paid@example.com', displayName: 'P', accessMode: 'PAYMENT_REQUIRED', status: 'APPROVED' });
      const now = new Date();
      const g = await store.createGrant({
        accountId: acct.id,
        startsAt: now,
        expiresAt: new Date(+now + 86_400_000),
        grantedBy: 'owner',
        reason: 'test',
        paidPaymentLinked: true,
      });
      assert.equal(g.paidPaymentLinked, true);
      assert.equal(g.revokedAt, null);
      const [listed] = await store.grantsForAccount(acct.id);
      assert.equal(listed?.paidPaymentLinked, true);

      const unpaid = await store.updateGrant(g.id, { paidPaymentLinked: false });
      assert.equal(unpaid.paidPaymentLinked, false);
      const revoked = await store.updateGrant(g.id, { revokedAt: new Date(), revokedBy: 'owner', revokeReason: 'x' });
      assert.ok(revoked.revokedAt instanceof Date);
      assert.equal(revoked.revokeReason, 'x');
    });

    test('otp: latest unconsumed, attempts count, consume is final', async () => {
      const base = { email: 'otp@example.com', codeHash: 'h1', purpose: 'login', maxAttempts: 5 };
      await store.createOtp({ ...base, expiresAt: new Date(Date.now() + 60_000) });
      await new Promise((r) => setTimeout(r, 5));
      const second = await store.createOtp({ ...base, codeHash: 'h2', expiresAt: new Date(Date.now() + 60_000) });
      const latest = await store.latestOtp('OTP@example.com', 'login');
      assert.equal(latest?.id, second.id);
      assert.equal(await store.countRecentOtp('otp@example.com', 60_000), 2);

      await store.bumpOtpAttempts(second.id);
      await store.bumpOtpAttempts(second.id);
      assert.equal((await store.latestOtp('otp@example.com', 'login'))?.attempts, 2);

      await store.consumeOtp(second.id);
      assert.notEqual((await store.latestOtp('otp@example.com', 'login'))?.id, second.id);
    });

    test('sessions: found by hash, revoked singly and per account', async () => {
      const acct = await store.createAccount({ email: 'sess@example.com', displayName: 'S', status: 'APPROVED' });
      const expiresAt = new Date(Date.now() + 3_600_000);
      const s1 = await store.createAuthSession({ accountId: acct.id, tokenHash: 'hash-1', expiresAt, ip: '1.2.3.4', userAgent: 'test' });
      await store.createAuthSession({ accountId: acct.id, tokenHash: 'hash-2', expiresAt });
      assert.equal((await store.getAuthSessionByHash('hash-1'))?.id, s1.id);
      assert.equal(await store.getAuthSessionByHash('nope'), null);

      await store.touchAuthSession(s1.id);
      await store.revokeAuthSession(s1.id, 'user_logout');
      const gone = await store.getAuthSessionByHash('hash-1');
      assert.ok(gone?.revokedAt);
      assert.equal(gone?.revokeReason, 'user_logout');

      assert.equal(await store.revokeAccountSessions(acct.id, 'suspended'), 1, 'only the one still live');
    });

    test('config: defaults on first read, patch persists', async () => {
      const cfg = await store.serviceConfig();
      assert.equal(cfg.serviceEnabled, true);
      assert.equal(cfg.sessionMaxTtlHours, 12);
      const next = await store.setServiceConfig({ maintenanceMessage: 'back soon', whenFull: 'REJECT' });
      assert.equal(next.maintenanceMessage, 'back soon');
      assert.equal((await store.serviceConfig()).whenFull, 'REJECT');
      await store.setServiceConfig({ maintenanceMessage: null, whenFull: 'QUEUE' });
    });

    test('audit: newest first, limited', async () => {
      await store.appendAudit({ actorType: 'SYSTEM', actorId: null, action: 'a.one' });
      await new Promise((r) => setTimeout(r, 5));
      await store.appendAudit({ actorType: 'OWNER', actorId: 'o', action: 'a.two', beforeJson: { x: 1 } });
      const [first] = await store.listAudit(1);
      assert.equal(first?.action, 'a.two');
    });

    test('seed: owner and JSON list, idempotent across boots', async () => {
      const seed = JSON.stringify([{ email: 'seeded@example.com', grantDays: 3 }]);
      await seedStore(store, { ownerEmail: 'boss@example.com', seedJson: seed });
      await seedStore(store, { ownerEmail: 'boss@example.com', seedJson: '[]' });
      assert.equal((await store.getAccountByEmail('boss@example.com'))?.role, 'SUPERADMIN');
      const seeded = await store.getAccountByEmail('seeded@example.com');
      assert.equal((await store.grantsForAccount(seeded!.id)).length, 1);
    });
  });
}
