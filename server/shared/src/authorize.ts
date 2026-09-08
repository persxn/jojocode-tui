/**
 * `authorize()` — the single server-side gate (IMPLEMENTATION-PLAN §5.2).
 *
 * Pure and synchronous. The caller assembles a snapshot (account + that
 * account's grants + the service config) and this decides ALLOW / DENY(reason).
 * It is evaluated at: OTP request, OTP verify, WS connect, every inbound WS
 * message (against a short-cached snapshot), and a periodic sweep.
 *
 * Seat availability is deliberately NOT here — that's a separate check at
 * session-start only.
 */

import type { Role } from './rbac.ts';
import { isStaff } from './rbac.ts';

export type AccountStatus = 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'DELETED';
export type AccessMode = 'FREE' | 'PAYMENT_REQUIRED';

export interface GrantSnapshot {
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  /** true ⇔ a PAID payment is linked to this grant (only matters for PAYMENT_REQUIRED). */
  paidPaymentLinked: boolean;
}

export interface OpenHours {
  /** IANA tz, e.g. "Asia/Kolkata". */
  tz: string;
  /** Weekly windows. `days`: 0=Sun … 6=Sat. `from`/`to`: "HH:MM", 24h, local to tz. */
  windows: Array<{ days: number[]; from: string; to: string }>;
}

export interface AuthzInput {
  now: Date;
  account: { status: AccountStatus; role: Role; accessMode: AccessMode } | null;
  grants: GrantSnapshot[];
  service: { enabled: boolean; maintenanceMessage?: string | null; openHours?: OpenHours | null };
}

export type DenyReason =
  | 'no_account'
  | 'not_approved'
  | 'suspended'
  | 'deleted'
  | 'no_active_grant'
  | 'not_yet_started'
  | 'expired'
  | 'revoked'
  | 'out_of_hours'
  | 'maintenance'
  | 'payment_required';

export type AuthzResult = { allow: true; role: Role } | { allow: false; reason: DenyReason };

const ALLOW = (role: Role): AuthzResult => ({ allow: true, role });
const DENY = (reason: DenyReason): AuthzResult => ({ allow: false, reason });

export function authorize(input: AuthzInput): AuthzResult {
  const { now, account, grants, service } = input;

  if (!account) return DENY('no_account');
  switch (account.status) {
    case 'DELETED':
      return DENY('deleted');
    case 'SUSPENDED':
      return DENY('suspended');
    case 'PENDING':
      return DENY('not_approved');
    case 'APPROVED':
      break;
    default:
      return DENY('not_approved');
  }

  // Staff (ADMIN / SUPERADMIN) connect without a grant, ignore open-hours and
  // payment — but a hard maintenance stop still applies to everyone but SUPERADMIN.
  if (isStaff(account.role)) {
    if (!service.enabled && account.role !== 'SUPERADMIN') return DENY('maintenance');
    return ALLOW(account.role);
  }

  const active = grants.find(
    (g) => g.revokedAt === null && g.startsAt <= now && now < g.expiresAt,
  );
  if (!active) {
    const grantDenial = classifyNoGrant(grants, now);
    return DENY(grantDenial);
  }

  if (service.openHours && !withinOpenHours(service.openHours, now)) return DENY('out_of_hours');
  if (!service.enabled) return DENY('maintenance');
  if (account.accessMode === 'PAYMENT_REQUIRED' && !active.paidPaymentLinked) {
    return DENY('payment_required');
  }

  return ALLOW(account.role);
}

/** Which flavour of "no usable grant" is it? Most-actionable reason wins. */
function classifyNoGrant(grants: GrantSnapshot[], now: Date): DenyReason {
  if (grants.length === 0) return 'no_active_grant';
  // a grant that would be live right now but was revoked
  if (grants.some((g) => g.revokedAt !== null && g.startsAt <= now && now < g.expiresAt)) {
    return 'revoked';
  }
  // a grant that hasn't started yet
  if (grants.some((g) => g.revokedAt === null && g.startsAt > now)) return 'not_yet_started';
  // a grant that has ended
  if (grants.some((g) => g.revokedAt === null && g.expiresAt <= now)) return 'expired';
  return 'no_active_grant';
}

/** Is `now` inside any configured weekly window, evaluated in the config's tz? */
export function withinOpenHours(oh: OpenHours, now: Date): boolean {
  if (!oh.windows.length) return true;
  const { day, minutes } = wallClock(now, oh.tz);
  return oh.windows.some((w) => {
    if (!w.days.includes(day)) return false;
    const from = hhmmToMinutes(w.from);
    const to = hhmmToMinutes(w.to);
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  });
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local weekday (0=Sun) + minutes-since-midnight for `now` in `tz`. */
function wallClock(now: Date, tz: string): { day: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // some ICU builds emit "24" at midnight
  return { day: days[get('weekday')] ?? 0, minutes: hour * 60 + Number(get('minute')) };
}
