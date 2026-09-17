/**
 * A minimal SMTP submission client — enough to deliver a login code, and
 * nothing more.
 *
 * ── Why this is hand-written rather than a dependency ──────────────────────
 *
 * The control plane is the always-on half of the system and deliberately
 * carries no runtime dependencies beyond `@jojoai/shared`. It issues login
 * tokens; its supply chain is worth keeping boring. The subset of SMTP needed
 * to submit one short message to a relay is small and stable — EHLO, STARTTLS,
 * AUTH LOGIN, MAIL FROM, RCPT TO, DATA — so it is written out here where it can
 * be read, rather than pulled in.
 *
 * What it deliberately does NOT do: connection pooling, retries, queueing,
 * DSNs, attachments, or 8BITMIME negotiation. One message, one connection, then
 * QUIT. Retrying is the caller's business — and for an OTP the right retry is
 * the user pressing "resend", not this holding a socket open.
 *
 * ── The three things that break naive SMTP clients ─────────────────────────
 *
 * 1. **Multiline replies.** `250-PIPELINING\r\n250-SIZE\r\n250 AUTH LOGIN` is
 *    ONE reply. Reading a line at a time and acting on the first is how a
 *    client ends up sending AUTH into the middle of an EHLO response. The
 *    reader below waits for the line whose 4th character is a space.
 * 2. **Dot-stuffing.** A body line that is exactly "." ends the DATA stage. Any
 *    line *starting* with "." must be sent doubled, or a message containing one
 *    is silently truncated at that point (RFC 5321 §4.5.2).
 * 3. **The TLS upgrade is a new stream.** After STARTTLS the socket is
 *    replaced, and anything buffered from the plaintext side must be dropped —
 *    keeping it is a downgrade bug, not a parsing quirk.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Envelope + From header, e.g. `Jojo AI <no-reply@jojocode.in>`. */
  from: string;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | undefined;
}

/** Wire timeout. A relay that has not answered in this long is not going to. */
const TIMEOUT_MS = 20_000;

class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpError';
  }
}

/**
 * One SMTP conversation, held open only as long as it takes.
 *
 * `read()` resolves with a complete reply — see note 1 in the header.
 */
class Session {
  private socket: Socket | TLSSocket;
  private buffer = '';
  private waiter: ((reply: string) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    this.socket.setEncoding('utf8');
    this.socket.setTimeout(TIMEOUT_MS);
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    this.socket.on('timeout', () => this.fail(new SmtpError('the mail server stopped responding')));
    this.socket.on('error', (error: Error) => this.fail(error));
  }

  private fail(error: Error): void {
    const reject = this.failed;
    this.waiter = null;
    this.failed = null;
    this.socket.destroy();
    reject?.(error);
  }

  /** Hand over a reply once its final line has arrived. */
  private drain(): void {
    if (!this.waiter) return;
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // The final line of a reply has a space in the 4th column; a hyphen there
      // means "more to come". This is the whole of note 1.
      if (/^\d{3} /.test(line)) {
        const reply = lines.slice(0, i + 1).join('\r\n');
        this.buffer = lines.slice(i + 1).join('\r\n');
        const resolve = this.waiter;
        this.waiter = null;
        this.failed = null;
        resolve!(reply);
        return;
      }
    }
  }

  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.failed = reject;
      this.drain();
    });
  }

  write(line: string): void {
    this.socket.write(line + '\r\n');
  }

  /** Send a command and insist on the status code it must answer with. */
  async expect(command: string | null, code: number): Promise<string> {
    if (command !== null) this.write(command);
    const reply = await this.read();
    if (!reply.startsWith(String(code))) {
      // The command is named but never echoed with its arguments: AUTH lines
      // carry the password, and this message reaches logs.
      const verb = command ? command.split(' ')[0] : 'greeting';
      throw new SmtpError(`${verb} refused: ${reply.split('\r\n')[0]}`);
    }
    return reply;
  }

  /** Replace the plaintext socket with its TLS upgrade — see note 3. */
  upgrade(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket as Socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('timeout');
      plain.removeAllListeners('error');
      // Anything still buffered arrived before the upgrade and must not be
      // trusted as part of the secured conversation.
      this.buffer = '';

      const secure = tlsConnect({ socket: plain, servername: host }, () => {
        if (!secure.authorized && secure.authorizationError) {
          reject(new SmtpError(`TLS refused: ${secure.authorizationError}`));
          return;
        }
        this.socket = secure;
        this.attach();
        resolve();
      });
      secure.once('error', reject);
    });
  }

  close(): void {
    try {
      this.write('QUIT');
    } catch {
      /* the connection is going away regardless */
    }
    this.socket.destroy();
  }
}

/** RFC 5321 §4.5.2 — see note 2. */
export function dotStuff(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n');
}

/** The address inside `Name <addr>`, or the string itself if it is bare. */
export function addressOf(from: string): string {
  const angled = /<([^<>]+)>/.exec(from);
  return (angled ? angled[1]! : from).trim();
}

/**
 * A MIME body: plain text alone, or multipart/alternative when HTML is given.
 *
 * Text is written first and is never optional. It is the half that carries the
 * code, it is what a phone shows in a notification preview, and a multipart
 * message is measurably less suspicious to a spam filter than an HTML-only one
 * — which matters most for the one message telling somebody how to sign in.
 */
export function buildMessage(config: SmtpConfig, message: SmtpMessage): string {
  const headers = [
    `From: ${config.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    // A stable, unique id keeps threads from collapsing in Gmail: two codes
    // sent minutes apart are two messages, not one conversation to collapse.
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@jojocode.in>`,
  ];

  if (!message.html) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    return headers.join('\r\n') + '\r\n\r\n' + dotStuff(message.text);
  }

  const boundary = `jojo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    dotStuff(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    dotStuff(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return headers.join('\r\n') + '\r\n\r\n' + body;
}

/**
 * Deliver one message. Throws on any refusal, so the caller can log the reason
 * and tell the user something true.
 */
export async function sendMail(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  const implicitTls = config.port === 465;

  const socket: Socket | TLSSocket = implicitTls
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port });

  await new Promise<void>((resolve, reject) => {
    socket.once(implicitTls ? 'secureConnect' : 'connect', () => resolve());
    socket.once('error', reject);
    socket.setTimeout(TIMEOUT_MS, () => reject(new SmtpError(`could not reach ${config.host}:${config.port}`)));
  });

  const session = new Session(socket);
  try {
    await session.expect(null, 220);
    await session.expect(`EHLO jojocode.in`, 250);

    if (!implicitTls) {
      // Submission on 587 is required to be upgraded. A relay that refuses
      // STARTTLS is one this must not send a password to.
      await session.expect('STARTTLS', 220);
      await session.upgrade(config.host);
      await session.expect(`EHLO jojocode.in`, 250);
    }

    await session.expect('AUTH LOGIN', 334);
    await session.expect(Buffer.from(config.user, 'utf8').toString('base64'), 334);
    await session.expect(Buffer.from(config.pass, 'utf8').toString('base64'), 235);

    await session.expect(`MAIL FROM:<${addressOf(config.from)}>`, 250);
    await session.expect(`RCPT TO:<${message.to}>`, 250);
    await session.expect('DATA', 354);

    session.write(buildMessage(config, message));
    await session.expect('.', 250);
  } finally {
    session.close();
  }
}
