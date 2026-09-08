/**
 * Truth table for authorize(). Run:  node --test --experimental-strip-types src/authorize.test.ts
 * (or `npm test` from the repo root).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, withinOpenHours, type AuthzInput, type OpenHours } from './authorize.ts';

const NOW = new Date('2026-06-15T12:00:00Z'); // a Monday, 12:00 UTC / 17:30 IST

const grant = (o: Partial<AuthzInput['grants'][number]> = {}) => ({
  startsAt: new Date('2026-06-01T00:00:00Z'),
  expiresAt: new Date('2026-07-01T00:00:00Z'),
  revokedAt: null,
  paidPaymentLinked: false,
  ...o,
});

const base = (o: Partial<AuthzInput> = {}): AuthzInput => ({
  now: NOW,
  account: { status: 'APPROVED', role: 'USER', accessMode: 'FREE' },
  grants: [grant()],
  service: { enabled: true, openHours: null },
  ...o,
});

test('happy path: approved user, active free grant, service on → allow', () => {
  const r = authorize(base());
  assert.equal(r.allow, true);
});

test('account status gates', () => {
  for (const [status, reason] of [
    ['PENDING', 'not_approved'],
    ['SUSPENDED', 'suspended'],
    ['DELETED', 'deleted'],
  ] as const) {
    const r = authorize(base({ account: { status, role: 'USER', accessMode: 'FREE' } }));
    assert.deepEqual(r, { allow: false, reason });
  }
});

test('null account → no_account', () => {
  assert.deepEqual(authorize(base({ account: null })), { allow: false, reason: 'no_account' });
});

test('grant states', () => {
  const mk = (g: Partial<ReturnType<typeof grant>>) => authorize(base({ grants: [grant(g)] }));
  assert.equal(mk({}).allow, true);
  assert.deepEqual(mk({ startsAt: new Date('2026-07-01T00:00:00Z'), expiresAt: new Date('2026-08-01T00:00:00Z') }), {
    allow: false,
    reason: 'not_yet_started',
  });
  assert.deepEqual(mk({ startsAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-02-01T00:00:00Z') }), {
    allow: false,
    reason: 'expired',
  });
  assert.deepEqual(mk({ revokedAt: new Date('2026-06-10T00:00:00Z') }), { allow: false, reason: 'revoked' });
  assert.deepEqual(authorize(base({ grants: [] })), { allow: false, reason: 'no_active_grant' });
});

test('most recent usable grant wins over an expired one', () => {
  const r = authorize(
    base({
      grants: [
        grant({ startsAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-02-01T00:00:00Z') }),
        grant(),
      ],
    }),
  );
  assert.equal(r.allow, true);
});

test('open hours', () => {
  const oh: OpenHours = { tz: 'UTC', windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }] };
  assert.equal(authorize(base({ service: { enabled: true, openHours: oh } })).allow, true); // Mon 12:00 UTC
  const late = new Date('2026-06-15T20:00:00Z');
  assert.deepEqual(authorize(base({ now: late, service: { enabled: true, openHours: oh } })), {
    allow: false,
    reason: 'out_of_hours',
  });
});

test('overnight window wraps midnight', () => {
  const oh: OpenHours = { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00' }] };
  assert.equal(withinOpenHours(oh, new Date('2026-06-15T23:30:00Z')), true);
  assert.equal(withinOpenHours(oh, new Date('2026-06-15T05:00:00Z')), true);
  assert.equal(withinOpenHours(oh, new Date('2026-06-15T12:00:00Z')), false);
});

test('maintenance stops ordinary users even with a valid grant', () => {
  assert.deepEqual(authorize(base({ service: { enabled: false, openHours: null } })), {
    allow: false,
    reason: 'maintenance',
  });
});

test('payment required: blocked until a paid payment is linked', () => {
  const paidAcct = { status: 'APPROVED', role: 'USER', accessMode: 'PAYMENT_REQUIRED' } as const;
  assert.deepEqual(authorize(base({ account: paidAcct, grants: [grant({ paidPaymentLinked: false })] })), {
    allow: false,
    reason: 'payment_required',
  });
  assert.equal(
    authorize(base({ account: paidAcct, grants: [grant({ paidPaymentLinked: true })] })).allow,
    true,
  );
});

test('RBAC: staff connect with no grant; superadmin ignores maintenance', () => {
  const admin = authorize(base({ account: { status: 'APPROVED', role: 'ADMIN', accessMode: 'FREE' }, grants: [] }));
  assert.deepEqual(admin, { allow: true, role: 'ADMIN' });

  const adminDownForMaint = authorize(
    base({ account: { status: 'APPROVED', role: 'ADMIN', accessMode: 'FREE' }, grants: [], service: { enabled: false } }),
  );
  assert.deepEqual(adminDownForMaint, { allow: false, reason: 'maintenance' });

  const superDuringMaint = authorize(
    base({
      account: { status: 'APPROVED', role: 'SUPERADMIN', accessMode: 'FREE' },
      grants: [],
      service: { enabled: false },
    }),
  );
  assert.deepEqual(superDuringMaint, { allow: true, role: 'SUPERADMIN' });

  // a suspended admin is still suspended
  assert.deepEqual(
    authorize(base({ account: { status: 'SUSPENDED', role: 'ADMIN', accessMode: 'FREE' }, grants: [] })),
    { allow: false, reason: 'suspended' },
  );
});
