/**
 * Storage seam. The HTTP layer only ever talks to this interface, so the
 * control plane runs with `MemoryStore` (dev / CI — no database) or, in
 * production, `PrismaStore` (prisma-store.ts) against the schema in
 * server/shared/prisma/schema.prisma. `store.test.ts` runs one contract against
 * both, so they cannot drift apart.
 */
import { randomUUID } from 'node:crypto';
import type { Role, AccountStatus, AccessMode, OpenHours } from '@jojoai/shared';

export interface AccountRow {
  id: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  role: Role;
  accessMode: AccessMode;
  createdAt: Date;
  notes?: string | null;
}

export interface GrantRow {
  id: string;
  accountId: string;
  startsAt: Date;
  expiresAt: Date;
  grantedBy: string;
  reason: string;
  revokedAt: Date | null;
  revokedBy?: string | null;
  revokeReason?: string | null;
  paidPaymentLinked: boolean;
  createdAt: Date;
}

export interface OtpRow {
  id: string;
  email: string;
  codeHash: string;
  purpose: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export interface AuthSessionRow {
  id: string;
  accountId: string;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revokeReason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ServiceConfigRow {
  serviceEnabled: boolean;
  maintenanceMessage: string | null;
  maxConcurrentSessions: number;
  idleReleaseMinutes: number;
  whenFull: 'QUEUE' | 'REJECT';
  maxQueueLength: number;
  maxQueueWaitMinutes: number;
  maxConcurrentInference: number;
  sessionMaxTtlHours: number;
  openHoursJson: OpenHours | null;
}

export interface AuditRow {
  id: string;
  actorType: 'OWNER' | 'SYSTEM' | 'ACCOUNT';
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  reason?: string | null;
  ip?: string | null;
  createdAt: Date;
}

export interface Store {
  // accounts
  getAccountByEmail(email: string): Promise<AccountRow | null>;
  getAccountById(id: string): Promise<AccountRow | null>;
  listAccounts(): Promise<AccountRow[]>;
  createAccount(input: Partial<AccountRow> & { email: string; displayName: string }): Promise<AccountRow>;
  updateAccount(id: string, patch: Partial<AccountRow>): Promise<AccountRow>;
  // grants
  grantsForAccount(accountId: string): Promise<GrantRow[]>;
  createGrant(input: Omit<GrantRow, 'id' | 'createdAt' | 'revokedAt'> & Partial<Pick<GrantRow, 'revokedAt'>>): Promise<GrantRow>;
  updateGrant(id: string, patch: Partial<GrantRow>): Promise<GrantRow>;
  // otp
  createOtp(input: Omit<OtpRow, 'id' | 'createdAt' | 'consumedAt' | 'attempts'>): Promise<OtpRow>;
  latestOtp(email: string, purpose: string): Promise<OtpRow | null>;
  countRecentOtp(email: string, sinceMs: number): Promise<number>;
  bumpOtpAttempts(id: string): Promise<void>;
  consumeOtp(id: string): Promise<void>;
  // auth sessions
  createAuthSession(input: Omit<AuthSessionRow, 'id' | 'issuedAt' | 'lastSeenAt' | 'revokedAt'>): Promise<AuthSessionRow>;
  getAuthSessionByHash(tokenHash: string): Promise<AuthSessionRow | null>;
  touchAuthSession(id: string): Promise<void>;
  revokeAuthSession(id: string, reason: string): Promise<void>;
  revokeAccountSessions(accountId: string, reason: string): Promise<number>;
  // config + audit
  serviceConfig(): Promise<ServiceConfigRow>;
  setServiceConfig(patch: Partial<ServiceConfigRow>): Promise<ServiceConfigRow>;
  appendAudit(input: Omit<AuditRow, 'id' | 'createdAt'>): Promise<void>;
  listAudit(limit: number): Promise<AuditRow[]>;
}

const DEFAULT_CONFIG: ServiceConfigRow = {
  serviceEnabled: true,
  maintenanceMessage: null,
  maxConcurrentSessions: 8,
  idleReleaseMinutes: 15,
  whenFull: 'QUEUE',
  maxQueueLength: 5,
  maxQueueWaitMinutes: 10,
  maxConcurrentInference: 4,
  sessionMaxTtlHours: 12,
  openHoursJson: null,
};

export class MemoryStore implements Store {
  private accounts = new Map<string, AccountRow>();
  private grants = new Map<string, GrantRow>();
  private otps = new Map<string, OtpRow>();
  private sessions = new Map<string, AuthSessionRow>();
  private audit: AuditRow[] = [];
  private cfg: ServiceConfigRow = { ...DEFAULT_CONFIG };

  async getAccountByEmail(email: string) {
    const e = email.toLowerCase();
    return [...this.accounts.values()].find((a) => a.email.toLowerCase() === e) ?? null;
  }
  async getAccountById(id: string) {
    return this.accounts.get(id) ?? null;
  }
  async listAccounts() {
    return [...this.accounts.values()].sort((a, b) => +b.createdAt - +a.createdAt);
  }
  async createAccount(input: Partial<AccountRow> & { email: string; displayName: string }) {
    const existing = await this.getAccountByEmail(input.email);
    if (existing) return existing;
    const row: AccountRow = {
      id: input.id ?? randomUUID(),
      email: input.email,
      displayName: input.displayName,
      status: input.status ?? 'PENDING',
      role: input.role ?? 'USER',
      accessMode: input.accessMode ?? 'FREE',
      notes: input.notes ?? null,
      createdAt: input.createdAt ?? new Date(),
    };
    this.accounts.set(row.id, row);
    return row;
  }
  async updateAccount(id: string, patch: Partial<AccountRow>) {
    const row = this.accounts.get(id);
    if (!row) throw new Error(`no account ${id}`);
    Object.assign(row, patch);
    return row;
  }

  async grantsForAccount(accountId: string) {
    return [...this.grants.values()].filter((g) => g.accountId === accountId);
  }
  async createGrant(input: Omit<GrantRow, 'id' | 'createdAt' | 'revokedAt'> & Partial<Pick<GrantRow, 'revokedAt'>>) {
    const row: GrantRow = { id: randomUUID(), createdAt: new Date(), revokedAt: input.revokedAt ?? null, ...input };
    this.grants.set(row.id, row);
    return row;
  }
  async updateGrant(id: string, patch: Partial<GrantRow>) {
    const row = this.grants.get(id);
    if (!row) throw new Error(`no grant ${id}`);
    Object.assign(row, patch);
    return row;
  }

  async createOtp(input: Omit<OtpRow, 'id' | 'createdAt' | 'consumedAt' | 'attempts'>) {
    const row: OtpRow = { id: randomUUID(), createdAt: new Date(), consumedAt: null, attempts: 0, ...input };
    this.otps.set(row.id, row);
    return row;
  }
  async latestOtp(email: string, purpose: string) {
    const e = email.toLowerCase();
    return (
      [...this.otps.values()]
        .filter((o) => o.email.toLowerCase() === e && o.purpose === purpose && !o.consumedAt)
        .sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null
    );
  }
  async countRecentOtp(email: string, sinceMs: number) {
    const e = email.toLowerCase();
    const cut = Date.now() - sinceMs;
    return [...this.otps.values()].filter((o) => o.email.toLowerCase() === e && +o.createdAt >= cut).length;
  }
  async bumpOtpAttempts(id: string) {
    const o = this.otps.get(id);
    if (o) o.attempts += 1;
  }
  async consumeOtp(id: string) {
    const o = this.otps.get(id);
    if (o) o.consumedAt = new Date();
  }

  async createAuthSession(input: Omit<AuthSessionRow, 'id' | 'issuedAt' | 'lastSeenAt' | 'revokedAt'>) {
    const now = new Date();
    const row: AuthSessionRow = { id: randomUUID(), issuedAt: now, lastSeenAt: now, revokedAt: null, ...input };
    this.sessions.set(row.id, row);
    return row;
  }
  async getAuthSessionByHash(tokenHash: string) {
    return [...this.sessions.values()].find((s) => s.tokenHash === tokenHash) ?? null;
  }
  async touchAuthSession(id: string) {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = new Date();
  }
  async revokeAuthSession(id: string, reason: string) {
    const s = this.sessions.get(id);
    if (s && !s.revokedAt) {
      s.revokedAt = new Date();
      s.revokeReason = reason;
    }
  }
  async revokeAccountSessions(accountId: string, reason: string) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === accountId && !s.revokedAt) {
        s.revokedAt = new Date();
        s.revokeReason = reason;
        n++;
      }
    }
    return n;
  }

  async serviceConfig() {
    return { ...this.cfg };
  }
  async setServiceConfig(patch: Partial<ServiceConfigRow>) {
    Object.assign(this.cfg, patch);
    return { ...this.cfg };
  }
  async appendAudit(input: Omit<AuditRow, 'id' | 'createdAt'>) {
    this.audit.push({ id: randomUUID(), createdAt: new Date(), ...input });
  }
  async listAudit(limit: number) {
    return this.audit.slice(-limit).reverse();
  }
}

/** Seed helper: owner account + optional JSON list. Idempotent by email. */
export async function seedStore(
  store: Store,
  opts: { ownerEmail?: string; seedJson?: string },
): Promise<void> {
  if (opts.ownerEmail) {
    await store.createAccount({
      email: opts.ownerEmail,
      displayName: 'Owner',
      status: 'APPROVED',
      role: 'SUPERADMIN',
      accessMode: 'FREE',
    });
  }
  if (opts.seedJson) {
    let list: Array<Partial<AccountRow> & { email: string; displayName?: string; grantDays?: number }> = [];
    try {
      list = JSON.parse(opts.seedJson);
    } catch {
      console.warn('[control-plane] JOJOAI_SEED is not valid JSON — ignored');
      return;
    }
    for (const a of list) {
      const acct = await store.createAccount({
        email: a.email,
        displayName: a.displayName ?? a.email.split('@')[0]!,
        status: a.status ?? 'APPROVED',
        role: a.role ?? 'USER',
        accessMode: a.accessMode ?? 'FREE',
      });
      if (a.grantDays && a.grantDays > 0) {
        const now = new Date();
        await store.createGrant({
          accountId: acct.id,
          startsAt: now,
          expiresAt: new Date(+now + a.grantDays * 86_400_000),
          grantedBy: 'seed',
          reason: 'seeded',
          paidPaymentLinked: acct.accessMode === 'FREE' ? false : true,
        });
      }
    }
  }
}
