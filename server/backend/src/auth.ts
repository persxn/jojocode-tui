/**
 * Connect-time auth for the WS gateway.
 *
 * Two modes:
 *   - control plane wired (JOJOAI_CONTROL_PLANE_URL + JOJOAI_SERVICE_TOKEN):
 *     POST the bearer token to /api/authz/check and honour its verdict. This is
 *     the real path — tokens minted by OTP, `authorize()` run against live
 *     grants/config, revocation effective immediately.
 *   - demo fallback (neither set): accept a single shared access code.
 */
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

export interface AuthResult {
  ok: boolean;
  reason?: string;
  accountId?: string;
  role?: 'USER' | 'ADMIN' | 'SUPERADMIN';
}

const codeEq = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export async function checkAuth(token: string): Promise<AuthResult> {
  if (!token) return { ok: false, reason: 'no_token' };

  if (config.controlPlaneUrl && config.serviceToken) {
    try {
      const r = await fetch(`${config.controlPlaneUrl}/api/authz/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jojoai-service': config.serviceToken },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return { ok: false, reason: `control_plane_${r.status}` };
      const body = (await r.json()) as { allow?: boolean; reason?: string; accountId?: string; role?: AuthResult['role'] };
      if (!body.allow) return { ok: false, reason: body.reason ?? 'denied' };
      const out: AuthResult = { ok: true };
      if (body.accountId) out.accountId = body.accountId;
      if (body.role) out.role = body.role;
      return out;
    } catch (e) {
      // Fail closed: if the control plane is unreachable we do NOT fall back to
      // the demo code.
      return { ok: false, reason: `control_plane_unreachable: ${(e as Error).message}` };
    }
  }

  return codeEq(token, config.demoCode)
    ? { ok: true, role: 'USER' }
    : { ok: false, reason: 'bad access code' };
}

/** Re-check an established session's token (per-message cache + sweep use this). */
export const recheckAuth = checkAuth;
