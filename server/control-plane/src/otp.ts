/**
 * One-time codes for login (decision D9 — email + OTP every time, no password).
 *
 * - code: N digits, generated with a CSPRNG, never stored (only its SHA-256).
 * - verify: constant-time compare, per-challenge attempt cap, single use.
 * - delivery: 'console' writes to stderr + a dev outbox file; 'smtp' is left as
 *   a deployment task (wire your provider in `deliver`).
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from './config.ts';

export function generateCode(length = config.otpLength): string {
  let s = '';
  for (let i = 0; i < length; i++) s += randomInt(0, 10).toString();
  return s;
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function codeMatches(code: string, codeHash: string): boolean {
  const a = Buffer.from(hashCode(code), 'hex');
  const b = Buffer.from(codeHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const OUTBOX =
  process.env.JOJOAI_OTP_OUTBOX ?? join(homedir(), '.local', 'share', 'jojoai', 'otp-outbox.log');

/** Send the code. In 'console' mode: stderr + append to a local outbox file. */
export async function deliver(email: string, code: string): Promise<void> {
  if (config.mail === 'smtp') {
    // Deployment task: POST to your SMTP/API provider here (config.smtpUrl).
    console.error(`[control-plane] SMTP delivery not wired; code for ${email}: ${code}`);
    return;
  }
  const line = `${new Date().toISOString()}  ${email}  code=${code}  (expires in ${config.otpTtlMinutes}m)\n`;
  console.error(`[control-plane] OTP → ${email}: ${code}`);
  try {
    await mkdir(dirname(OUTBOX), { recursive: true });
    await appendFile(OUTBOX, line);
  } catch {
    /* outbox is best-effort */
  }
}
