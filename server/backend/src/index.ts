/**
 * Jojo AI — backend service.
 *
 * Demo-grade walking skeleton: HTTP (/healthz, /status.json) + a WebSocket
 * agent gateway on /agent. Auth is a shared demo code (config.demoCode).
 * The agent loop runs here (D2); tools execute on the CLI (D1).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.ts';
import { health as ollamaHealth } from './ollama.ts';
import { createGateway } from './gateway.ts';
import { PROTOCOL_VERSION } from '@jojoai/shared/protocol';

/**
 * Static routes so `curl https://ai.jojocode.in/install.sh | sh` and the
 * landing page both work off one process:
 *   /                     -> web/index.html
 *   /install.sh|.ps1      -> install/
 *   /ollama-setup.sh      -> install/
 *   /recommend-model.py   -> install/
 *   /dl/<file>            -> dist/ (legacy)
 */
const MIME: Record<string, string> = {
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};
const INSTALL_FILES = new Set(['install.sh', 'install.ps1', 'ollama-setup.sh', 'recommend-model.py']);

async function sendFile(root: string, rel: string, res: import('node:http').ServerResponse, cache: string): Promise<boolean> {
  const path = normalize(join(root, rel));
  if (!path.startsWith(normalize(root))) {
    res.writeHead(403).end();
    return true;
  }
  try {
    const buf = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': cache,
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

async function serveStatic(url: string, res: import('node:http').ServerResponse): Promise<boolean> {
  const clean = (url.split('?')[0] ?? '/').replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '/index.html') {
    if (await sendFile(config.webDir, 'index.html', res, 'no-cache')) return true;
    res.writeHead(200, { 'content-type': 'text/plain' }).end('jojoai-backend — landing page not built\n');
    return true;
  }
  const name = clean.slice(1);
  if (INSTALL_FILES.has(name)) {
    if (await sendFile(config.installDir, name, res, 'no-store')) return true;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    return true;
  }
  if (clean.startsWith('/dl/')) {
    if (await sendFile(config.distDir, join('dl', clean.slice(4)), res, 'no-store')) return true;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    return true;
  }
  return false;
}

/**
 * Hand `/api/auth/*` to the control plane.
 *
 * ── Why the backend proxies instead of the tunnel routing it ───────────────
 *
 * The TUI asks one endpoint for everything: `jojo --remote https://ai.jojocode.in
 * --login` posts to `<endpoint>/api/auth/otp/request`. But that hostname is a
 * dashboard-managed Cloudflare tunnel pointing at this process alone, so those
 * requests reached the backend, matched no route, and returned **404** — which
 * is exactly why nobody ever received a sign-in code, however good their email
 * address was. The other half of that bug was the control plane never actually
 * sending mail; both had to be fixed to get one working login.
 *
 * Routing it here rather than adding a second hostname keeps the login on the
 * same origin the client already trusts, and needs no DNS change to deploy.
 *
 * Only `/api/auth/` is forwarded. `/api/authz/check` is the *service* channel,
 * carries the shared secret, and must never be reachable from the internet
 * through this door.
 */
async function proxyAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (!url.startsWith('/api/auth/')) return false;

  if (!config.controlPlaneUrl) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sign-in is not configured on this server' }));
    return true;
  }

  const body = await new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => {
      data += chunk;
      // A login body is a small JSON object. Anything larger is not one.
      if (data.length > 64_000) data = data.slice(0, 64_000);
    });
    req.on('end', () => resolve(data));
  });

  try {
    const method = req.method ?? 'POST';
    const init: RequestInit = {
      method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      signal: AbortSignal.timeout(30_000),
    };
    // Assigned rather than spread: `body: undefined` is a type error under
    // exactOptionalPropertyTypes, and GET/HEAD may not carry one at all.
    if (method !== 'GET' && method !== 'HEAD') init.body = body;
    const upstream = await fetch(`${config.controlPlaneUrl}${req.url}`, init);
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(text);
  } catch (error) {
    // The control plane being down must not look like "wrong code".
    console.error('[jojoai-backend] control-plane unreachable:', error);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sign-in is temporarily unavailable' }));
  }
  return true;
}

const server = createServer(async (req, res) => {
  if (req.url === '/healthz') {
    const oh = await ollamaHealth();
    res.writeHead(oh.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: oh.ok, service: 'jojoai-backend', protocol: PROTOCOL_VERSION, ollama: oh.detail }));
    return;
  }
  if (req.url === '/status.json') {
    // Feeds the public status page (D5) and the CLI's pre-login check.
    const oh = await ollamaHealth();
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(
      JSON.stringify({
        service: config.serviceLabel ?? 'Jojo AI (demo)',
        online: oh.ok,
        model: config.model,
        modelHealthy: oh.ok,
        modelDetail: oh.detail,
        seats: { total: config.maxSeats, used: mgr.seatsUsed(), free: mgr.seatsFree() },
        protocol: PROTOCOL_VERSION,
        time: new Date().toISOString(),
      }),
    );
    return;
  }
  if (await proxyAuth(req, res)) return;
  if (await serveStatic(req.url ?? '', res)) return;
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('jojoai-backend\n');
});

const mgr = createGateway(server);

server.listen(config.port, config.host, () => {
  console.log(
    `[jojoai-backend] http://${config.host}:${config.port}  ws /agent  ` +
      `model=${config.model} seats=${config.maxSeats} protocol=v${PROTOCOL_VERSION}`,
  );
});

const shutdown = (sig: string): void => {
  console.log(`[jojoai-backend] ${sig} — closing`);
  for (const s of mgr.list()) mgr.end(s, 'server_shutdown');
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
