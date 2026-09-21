/**
 * The durable store: `Store` over Postgres, through the Prisma schema in
 * server/shared/prisma/schema.prisma.
 *
 * `JOJOAI_CP_STORE=prisma` + `JOJOAI_DATABASE_URL`. With it, a control-plane
 * restart no longer signs everybody out — tokens, accounts, grants and the
 * audit trail survive, which is the whole reason this exists.
 *
 * A mechanical mapping on purpose. Every rule lives in `index.ts` and
 * `authorize()`; this file only moves rows. Two places where the shapes differ,
 * both handled here so the HTTP layer never learns about them:
 *
 * - **`paidPaymentLinked`** is a boolean on `GrantRow` but a relation in the
 *   schema (a `Payment` with status PAID linked to the grant). A grant created
 *   or marked paid by the owner, with no Razorpay payment behind it, gets a
 *   zero-amount PAID payment whose order id is `manual:<grantId>` — so the
 *   schema's rule ("paid ⇔ a PAID payment is linked") stays true, and the
 *   audit can still tell a manual mark from a real payment.
 * - **Emails** are stored lower-cased and looked up lower-cased, matching the
 *   memory store's case-insensitive behaviour on a column that is `@unique`.
 *
 * The generated client is CommonJS; imported through `createRequire` so this
 * file stays a plain ES module under `--experimental-strip-types`.
 */
import { createRequire } from 'node:module';
import type {
  AccountRow,
  AuditRow,
  AuthSessionRow,
  GrantRow,
  OtpRow,
  ServiceConfigRow,
  Store,
} from './store.ts';

const require = createRequire(import.meta.url);

// Typed loosely at the seam: the generated types live in a gitignored folder,
// and `tsc` must not fail on a checkout where `prisma generate` has not run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export function loadPrismaClient(url: string): Db {
  let mod: { PrismaClient: new (opts: unknown) => Db };
  try {
    mod = require('../../shared/src/generated/client/index.js');
  } catch (error) {
    throw new Error(
      'JOJOAI_CP_STORE=prisma but the Prisma client has not been generated. Run:\n' +
        '  npm run -w @jojoai/shared prisma:generate\n' +
        `(${(error as Error).message})`,
    );
  }
  return new mod.PrismaClient({ datasources: { db: { url } } });
}

const lower = (email: string) => email.trim().toLowerCase();

const GRANT_INCLUDE = { payment: { select: { status: true } } } as const;

function toAccount(row: Db): AccountRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    role: row.role,
    accessMode: row.accessMode,
    createdAt: row.createdAt,
    notes: row.notes ?? null,
  };
}

function toGrant(row: Db): GrantRow {
  return {
    id: row.id,
    accountId: row.accountId,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    grantedBy: row.grantedBy,
    reason: row.reason,
    revokedAt: row.revokedAt ?? null,
    revokedBy: row.revokedBy ?? null,
    revokeReason: row.revokeReason ?? null,
    paidPaymentLinked: row.payment?.status === 'PAID',
    createdAt: row.createdAt,
  };
}

function toConfig(row: Db): ServiceConfigRow {
  return {
    serviceEnabled: row.serviceEnabled,
    maintenanceMessage: row.maintenanceMessage ?? null,
    maxConcurrentSessions: row.maxConcurrentSessions,
    idleReleaseMinutes: row.idleReleaseMinutes,
    whenFull: row.whenFull === 'REJECT' ? 'REJECT' : 'QUEUE',
    maxQueueLength: row.maxQueueLength,
    maxQueueWaitMinutes: row.maxQueueWaitMinutes,
    maxConcurrentInference: row.maxConcurrentInference,
    sessionMaxTtlHours: row.sessionMaxTtlHours,
    openHoursJson: row.openHoursJson ?? null,
  };
}

/** Only the columns an update may touch — never ids, never timestamps it owns. */
function pick<T extends object>(patch: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const ACCOUNT_FIELDS = ['email', 'displayName', 'status', 'role', 'accessMode', 'notes'] as const;
const GRANT_FIELDS = ['startsAt', 'expiresAt', 'grantedBy', 'reason', 'revokedAt', 'revokedBy', 'revokeReason'] as const;
const CONFIG_FIELDS = [
  'serviceEnabled',
  'maintenanceMessage',
  'maxConcurrentSessions',
  'idleReleaseMinutes',
  'whenFull',
  'maxQueueLength',
  'maxQueueWaitMinutes',
  'maxConcurrentInference',
  'sessionMaxTtlHours',
  'openHoursJson',
] as const;

export class PrismaStore implements Store {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  static fromUrl(url: string): PrismaStore {
    return new PrismaStore(loadPrismaClient(url));
  }

  async close(): Promise<void> {
    await this.db.$disconnect();
  }

  // ── accounts ────────────────────────────────────────────────────────────
  async getAccountByEmail(email: string) {
    const row = await this.db.account.findUnique({ where: { email: lower(email) } });
    return row ? toAccount(row) : null;
  }

  async getAccountById(id: string) {
    const row = await this.db.account.findUnique({ where: { id } });
    return row ? toAccount(row) : null;
  }

  async listAccounts() {
    const rows = await this.db.account.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toAccount);
  }

  async createAccount(input: Partial<AccountRow> & { email: string; displayName: string }) {
    // Idempotent by email, like the memory store: seeding on every boot must
    // not fail on the second boot.
    const existing = await this.getAccountByEmail(input.email);
    if (existing) return existing;
    const row = await this.db.account.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        email: lower(input.email),
        displayName: input.displayName,
        status: input.status ?? 'PENDING',
        role: input.role ?? 'USER',
        accessMode: input.accessMode ?? 'FREE',
        notes: input.notes ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
    return toAccount(row);
  }

  async updateAccount(id: string, patch: Partial<AccountRow>) {
    const data = pick(patch, ACCOUNT_FIELDS);
    if (typeof data.email === 'string') data.email = lower(data.email);
    const row = await this.db.account.update({ where: { id }, data });
    return toAccount(row);
  }

  // ── grants ──────────────────────────────────────────────────────────────
  async grantsForAccount(accountId: string) {
    const rows = await this.db.accessGrant.findMany({
      where: { accountId },
      include: GRANT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toGrant);
  }

  /** Link (or unlink) the owner-recorded payment that marks a grant paid. */
  private async setManualPayment(grantId: string, accountId: string, paid: boolean): Promise<void> {
    const orderId = `manual:${grantId}`;
    if (paid) {
      await this.db.payment.upsert({
        where: { razorpayOrderId: orderId },
        create: {
          accountId,
          razorpayOrderId: orderId,
          amountPaise: 0,
          status: 'PAID',
          grantId,
          paidAt: new Date(),
        },
        update: { status: 'PAID', paidAt: new Date(), grantId },
      });
    } else {
      // Only the manual mark is withdrawn. A real Razorpay payment is a fact
      // about money and is never rewritten by a flag.
      await this.db.payment.updateMany({
        where: { razorpayOrderId: orderId },
        data: { status: 'REFUNDED', grantId: null },
      });
    }
  }

  async createGrant(
    input: Omit<GrantRow, 'id' | 'createdAt' | 'revokedAt'> & Partial<Pick<GrantRow, 'revokedAt'>>,
  ) {
    const row = await this.db.accessGrant.create({
      data: {
        accountId: input.accountId,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        grantedBy: input.grantedBy,
        reason: input.reason,
        revokedAt: input.revokedAt ?? null,
        revokedBy: input.revokedBy ?? null,
        revokeReason: input.revokeReason ?? null,
      },
    });
    if (input.paidPaymentLinked) await this.setManualPayment(row.id, input.accountId, true);
    const fresh = await this.db.accessGrant.findUniqueOrThrow({ where: { id: row.id }, include: GRANT_INCLUDE });
    return toGrant(fresh);
  }

  async updateGrant(id: string, patch: Partial<GrantRow>) {
    const row = await this.db.accessGrant.update({ where: { id }, data: pick(patch, GRANT_FIELDS) });
    if (patch.paidPaymentLinked !== undefined) {
      await this.setManualPayment(id, row.accountId, patch.paidPaymentLinked);
    }
    const fresh = await this.db.accessGrant.findUniqueOrThrow({ where: { id }, include: GRANT_INCLUDE });
    return toGrant(fresh);
  }

  // ── otp ─────────────────────────────────────────────────────────────────
  async createOtp(input: Omit<OtpRow, 'id' | 'createdAt' | 'consumedAt' | 'attempts'>) {
    const row = await this.db.otpChallenge.create({
      data: {
        email: lower(input.email),
        codeHash: input.codeHash,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        maxAttempts: input.maxAttempts,
      },
    });
    return row as OtpRow;
  }

  async latestOtp(email: string, purpose: string) {
    const row = await this.db.otpChallenge.findFirst({
      where: { email: lower(email), purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return (row as OtpRow | null) ?? null;
  }

  async countRecentOtp(email: string, sinceMs: number) {
    return this.db.otpChallenge.count({
      where: { email: lower(email), createdAt: { gte: new Date(Date.now() - sinceMs) } },
    });
  }

  async bumpOtpAttempts(id: string) {
    // Atomic increment: two wrong guesses racing must both count.
    await this.db.otpChallenge.updateMany({ where: { id }, data: { attempts: { increment: 1 } } });
  }

  async consumeOtp(id: string) {
    await this.db.otpChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
  }

  // ── auth sessions ───────────────────────────────────────────────────────
  async createAuthSession(input: Omit<AuthSessionRow, 'id' | 'issuedAt' | 'lastSeenAt' | 'revokedAt'>) {
    const row = await this.db.authSession.create({
      data: {
        accountId: input.accountId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        revokeReason: input.revokeReason ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
    return row as AuthSessionRow;
  }

  async getAuthSessionByHash(tokenHash: string) {
    const row = await this.db.authSession.findUnique({ where: { tokenHash } });
    return (row as AuthSessionRow | null) ?? null;
  }

  async touchAuthSession(id: string) {
    await this.db.authSession.updateMany({ where: { id }, data: { lastSeenAt: new Date() } });
  }

  async revokeAuthSession(id: string, reason: string) {
    await this.db.authSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  async revokeAccountSessions(accountId: string, reason: string) {
    const result = await this.db.authSession.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return result.count as number;
  }

  // ── config + audit ──────────────────────────────────────────────────────
  async serviceConfig() {
    // The singleton comes into being with the schema's defaults on first read.
    const row = await this.db.serviceConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
    return toConfig(row);
  }

  async setServiceConfig(patch: Partial<ServiceConfigRow>) {
    const data = pick(patch, CONFIG_FIELDS);
    const row = await this.db.serviceConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    });
    return toConfig(row);
  }

  async appendAudit(input: Omit<AuditRow, 'id' | 'createdAt'>) {
    await this.db.auditEvent.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ...(input.beforeJson !== undefined ? { beforeJson: input.beforeJson } : {}),
        ...(input.afterJson !== undefined ? { afterJson: input.afterJson } : {}),
        reason: input.reason ?? null,
        ip: input.ip ?? null,
      },
    });
  }

  async listAudit(limit: number) {
    const rows = await this.db.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return rows as AuditRow[];
  }
}
