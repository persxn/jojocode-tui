/**
 * Role-based access control for the control plane + admin panel.
 *
 * Three roles, strictly ranked. A capability check is `can(role, action)`;
 * a "at least this role" gate is `atLeast(role, min)`. Pure, no I/O — the
 * HTTP layer resolves the caller's role from their session and calls these.
 */

export type Role = 'USER' | 'ADMIN' | 'SUPERADMIN';

export const ROLE_RANK: Record<Role, number> = { USER: 0, ADMIN: 1, SUPERADMIN: 2 };

export type Capability =
  | 'session.start' // open an agent session
  | 'account.read'
  | 'account.approve' // approve / reject / suspend
  | 'account.delete'
  | 'grant.create' // create / extend / shorten
  | 'grant.revoke'
  | 'session.list' // the live-sessions view
  | 'session.kill' // force-disconnect
  | 'config.read'
  | 'config.write'
  | 'role.assign' // promote / demote another account
  | 'audit.read';

const BY_ROLE: Record<Role, Capability[]> = {
  USER: ['session.start'],
  ADMIN: [
    'session.start',
    'account.read',
    'account.approve',
    'grant.create',
    'grant.revoke',
    'session.list',
    'session.kill',
    'config.read',
    'audit.read',
  ],
  SUPERADMIN: [
    'session.start',
    'account.read',
    'account.approve',
    'account.delete',
    'grant.create',
    'grant.revoke',
    'session.list',
    'session.kill',
    'config.read',
    'config.write',
    'role.assign',
    'audit.read',
  ],
};

export function atLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function can(role: Role, action: Capability): boolean {
  return BY_ROLE[role]?.includes(action) ?? false;
}

/** Capabilities a role holds — handy for surfacing what a session may do. */
export function capabilitiesOf(role: Role): readonly Capability[] {
  return BY_ROLE[role] ?? [];
}

/** Staff (ADMIN+) connect without an AccessGrant; ordinary users need one. */
export function isStaff(role: Role): boolean {
  return atLeast(role, 'ADMIN');
}
