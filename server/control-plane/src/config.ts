/**
 * Control-plane config. The control plane is the always-on half: it issues and
 * revokes tokens, holds accounts/grants/audit, and answers the backend's
 * authz checks — so it must run even when the backend host is powered off.
 *
 * Everything is env-driven; see server/.env.example. No secret has a usable
 * default — a missing service secret in production is a hard error.
 */
const env = process.env;
const bool = (v: string | undefined, d: boolean) => (v == null ? d : v === '1' || v === 'true');

export const config = {
  host: env.JOJOAI_CP_HOST ?? '127.0.0.1',
  port: Number(env.JOJOAI_CP_PORT ?? 7460),

  /** 'memory' (default, no DB — dev/CI) or 'prisma' (needs JOJOAI_DATABASE_URL). */
  store: (env.JOJOAI_CP_STORE ?? 'memory') as 'memory' | 'prisma',
  databaseUrl: env.JOJOAI_DATABASE_URL ?? '',

  /** Shared secret the backend presents on /api/authz/check. */
  serviceToken: env.JOJOAI_SERVICE_TOKEN ?? (isProd() ? '' : 'dev-service-token'),

  otpTtlMinutes: Number(env.JOJOAI_OTP_TTL_MIN ?? 10),
  otpLength: Number(env.JOJOAI_OTP_LENGTH ?? 6),
  otpMaxAttempts: Number(env.JOJOAI_OTP_MAX_ATTEMPTS ?? 5),
  otpRequestsPerHour: Number(env.JOJOAI_OTP_RPH ?? 5),

  sessionMaxTtlHours: Number(env.JOJOAI_SESSION_TTL_HOURS ?? 12),

  /** How OTP codes leave the building. 'console' + a dev outbox file, or 'smtp'. */
  mail: (env.JOJOAI_MAIL ?? 'console') as 'console' | 'smtp',
  /**
   * Discrete SMTP settings, which is what a relay actually gives you.
   *
   * `JOJOAI_SMTP_URL` came first and is still read as a fallback, but a URL is
   * the wrong shape for this: a Brevo SMTP key is 90 characters and lands in
   * the password position, where it has to be percent-encoded by hand and is
   * silently truncated at the first `@` or `/` if it is not. Four plain
   * variables cannot be got wrong that way.
   */
  smtpHost: env.JOJOAI_SMTP_HOST ?? '',
  smtpPort: Number(env.JOJOAI_SMTP_PORT ?? 587),
  smtpUser: env.JOJOAI_SMTP_USER ?? '',
  smtpPass: env.JOJOAI_SMTP_PASS ?? '',
  smtpUrl: env.JOJOAI_SMTP_URL ?? '',
  mailFrom: env.JOJOAI_MAIL_FROM ?? 'Jojo AI <no-reply@jojocode.in>',

  /** Seeded on boot as SUPERADMIN if set (owner account). */
  ownerEmail: env.JOJOAI_OWNER_EMAIL ?? '',
  /** Optional JSON array of accounts to seed (memory store / first run). */
  seedJson: env.JOJOAI_SEED ?? '',
};

export function isProd(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}

export function assertConfig(): void {
  // Outside production too: a store named 'prisma' with nowhere to connect is
  // a misconfiguration, and silently falling back to memory would be the exact
  // "everybody signed out on restart" surprise the durable store exists to end.
  if (config.store === 'prisma' && !config.databaseUrl) {
    throw new Error('JOJOAI_DATABASE_URL is required when JOJOAI_CP_STORE=prisma');
  }
  if (isProd()) {
    if (!config.serviceToken) throw new Error('JOJOAI_SERVICE_TOKEN is required in production');
    if (config.store === 'prisma' && !config.databaseUrl) {
      throw new Error('JOJOAI_DATABASE_URL is required when JOJOAI_CP_STORE=prisma');
    }
    if (config.mail === 'smtp' && !smtpSettings()) {
      throw new Error(
        'JOJOAI_MAIL=smtp needs JOJOAI_SMTP_HOST/USER/PASS (or JOJOAI_SMTP_URL)',
      );
    }
  }
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/**
 * The SMTP settings, or null when mail is not fully configured.
 *
 * Null rather than a throw, because "not set up" is the ordinary state of a
 * fresh install and each caller says so in its own words: boot warns, and
 * `deliver` falls back to the console outbox rather than losing the code.
 */
export function smtpSettings(): SmtpSettings | null {
  let { smtpHost: host, smtpPort: port, smtpUser: user, smtpPass: pass } = config;

  if ((!host || !user || !pass) && config.smtpUrl) {
    try {
      const url = new URL(config.smtpUrl);
      host = host || url.hostname;
      port = url.port ? Number(url.port) : port;
      user = user || decodeURIComponent(url.username);
      pass = pass || decodeURIComponent(url.password);
    } catch {
      return null;
    }
  }

  if (!host || !user || !pass) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port, user, pass, from: config.mailFrom };
}

export type Config = typeof config;
