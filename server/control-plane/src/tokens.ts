/**
 * Opaque bearer tokens (decision D14): 32 random bytes, base64url. Only the
 * SHA-256 hash is ever stored, so a database leak does not yield usable tokens
 * and revocation is a single column write.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function mintToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare for shared secrets (service token, etc.). */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
