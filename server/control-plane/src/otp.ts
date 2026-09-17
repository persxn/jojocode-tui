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
import { config, smtpSettings } from './config.ts';
import { sendMail } from './smtp.ts';

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

/**
 * The message itself.
 *
 * The code is in the subject as well as the body, because that is how most of
 * these are actually read: a phone shows the subject in a notification and the
 * code never needs the message opened at all. In the body it sits alone on its
 * own line, so double-tapping selects the whole thing and nothing else.
 *
 * No link, deliberately. A link that signs somebody in is a link that signs in
 * whoever it is forwarded to, and this is the message most likely to be
 * forwarded by somebody who is stuck.
 */
export function codeMessage(code: string, ttlMinutes: number): {
  subject: string;
  text: string;
  html: string;
} {
  const minutes = `${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}`;
  return {
    subject: `${code} is your JojoAI sign-in code`,
    text: [
      'Signing in to JojoAI.',
      '',
      `    ${code}`,
      '',
      `This code expires in ${minutes} and can be used once.`,
      'Type it into the terminal where you ran `jojo --login`.',
      '',
      'If you did not ask to sign in, you can ignore this — the code is',
      'useless to anybody who does not also have your terminal open.',
      '',
      '-- JojoAI',
    ].join('\n'),
    html: [
      '<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem">',
      '<p style="margin:0 0 18px;color:#111">Signing in to <strong>JojoAI</strong>.</p>',
      `<p style="margin:0 0 18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;letter-spacing:.22em;font-weight:700;color:#111">${code}</p>`,
      `<p style="margin:0 0 18px;color:#444">This code expires in ${minutes} and can be used once. Type it into the terminal where you ran <code>jojo --login</code>.</p>`,
      '<p style="margin:0;color:#777;font-size:13px">If you did not ask to sign in, you can ignore this — the code is useless to anybody who does not also have your terminal open.</p>',
      '</div>',
    ].join(''),
  };
}

/** stderr + a local outbox file. The development path, and the fallback. */
async function toConsole(email: string, code: string, why?: string): Promise<void> {
  const note = why ? `  (${why})` : '';
  const line = `${new Date().toISOString()}  ${email}  code=${code}  (expires in ${config.otpTtlMinutes}m)${note}\n`;
  console.error(`[control-plane] OTP → ${email}: ${code}${note}`);
  try {
    await mkdir(dirname(OUTBOX), { recursive: true });
    await appendFile(OUTBOX, line);
  } catch {
    /* outbox is best-effort */
  }
}

/**
 * Send the code.
 *
 * ── This used to be a stub, and that was the whole bug ─────────────────────
 *
 * In 'smtp' mode it logged "SMTP delivery not wired" and returned, so no email
 * was ever sent — to anyone, in any mode. People signed in with a perfectly
 * good address and waited for a code that was only ever written to the server's
 * stderr. It is wired now.
 *
 * A send that fails falls back to the console outbox rather than throwing: the
 * challenge has already been stored, and losing the code entirely because a
 * relay hiccupped would leave the account unreachable with nothing in the logs
 * to recover it from. The failure is loud in stderr; the caller still answers
 * `{ ok: true }`, which it must, because telling the internet whether an
 * address exists is exactly what the anti-enumeration rule forbids.
 */
export async function deliver(email: string, code: string): Promise<void> {
  if (config.mail !== 'smtp') return toConsole(email, code);

  const settings = smtpSettings();
  if (!settings) return toConsole(email, code, 'JOJOAI_MAIL=smtp but SMTP is not configured');

  const { subject, text, html } = codeMessage(code, config.otpTtlMinutes);
  try {
    await sendMail(settings, { to: email, subject, text, html });
    console.error(`[control-plane] OTP mailed to ${email}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[control-plane] OTP mail to ${email} failed: ${reason}`);
    await toConsole(email, code, `mail failed: ${reason}`);
  }
}
