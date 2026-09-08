/**
 * Phase 0 spike — minimal server-side agent loop with reconnect/resume.
 *
 * Goal: prove the D2 architecture's riskiest bit (R7) — a client that drops
 * mid-tool-call can reconnect and the tool is NOT executed twice.
 *
 * Deliberately in-memory and tiny. The real backend persists AgentSession +
 * AgentTurn to Postgres (see shared/prisma/schema.prisma) and has auth, seats,
 * queue, heartbeats, a reaper. None of that is needed to test exactly-once.
 *
 *   node server.mjs [--port 7777] [--resume-window-ms 600000]
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const PORT = Number(arg('port', 7777));
const RESUME_WINDOW_MS = Number(arg('resume-window-ms', 10 * 60 * 1000));

/** sessionId -> session */
const sessions = new Map();
/** resumeToken -> sessionId */
const byResume = new Map();

const log = (...a) => console.log(new Date().toISOString(), ...a);

function newSession() {
  const id = randomUUID();
  const resumeToken = randomUUID();
  const s = {
    id,
    resumeToken,
    seatNo: sessions.size + 1,
    ws: null,
    transcript: [], // {role, text}
    // exactly-once bookkeeping
    pendingTools: new Map(), // id -> {name, args, sentAt}
    toolResults: new Map(), // id -> result
    turnActive: false,
    disconnectTimer: null,
  };
  sessions.set(id, s);
  byResume.set(resumeToken, id);
  return s;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function attach(ws, s, resumed) {
  s.ws = ws;
  if (s.disconnectTimer) {
    clearTimeout(s.disconnectTimer);
    s.disconnectTimer = null;
  }
  send(ws, {
    t: 'session_ready',
    protocol: 1,
    sessionId: s.id,
    seatNo: s.seatNo,
    resumeToken: s.resumeToken,
    resumed,
  });

  // On resume: re-send every tool_request we never got a result for.
  const unanswered = [...s.pendingTools.entries()].filter(([id]) => !s.toolResults.has(id));
  if (resumed && unanswered.length) {
    log(`session ${s.id.slice(0, 8)} resume: replaying ${unanswered.length} unanswered tool_request(s)`);
    send(ws, { t: 'replay_begin', count: unanswered.length });
    for (const [id, req] of unanswered) {
      send(ws, { t: 'tool_request', id, name: req.name, args: req.args, timeoutMs: 30000, destructive: false });
    }
    send(ws, { t: 'replay_end' });
  }
}

/** The "agent loop", stubbed: one user_turn => emit exactly one tool_request. */
function runTurn(s, text) {
  s.transcript.push({ role: 'user', text });
  s.turnActive = true;
  const id = `${s.id}:t${s.pendingTools.size + 1}`;
  const req = { name: 'run_command', args: { cmd: 'echo spike', markerTurn: text }, sentAt: Date.now() };
  s.pendingTools.set(id, req);
  log(`session ${s.id.slice(0, 8)} -> tool_request ${id}`);
  send(s.ws, { t: 'tool_request', id, name: req.name, args: req.args, timeoutMs: 30000, destructive: false });
}

function onToolResult(s, msg) {
  const { id } = msg;
  if (!s.pendingTools.has(id)) {
    log(`session ${s.id.slice(0, 8)} !! tool_result for unknown id ${id} — ignoring`);
    return;
  }
  if (s.toolResults.has(id)) {
    // Idempotent: a replayed result for something we already recorded. No-op.
    log(`session ${s.id.slice(0, 8)} == duplicate tool_result ${id} (already recorded) — ignored`);
    return;
  }
  s.toolResults.set(id, { ok: msg.ok, exitCode: msg.exitCode, stdout: msg.stdout });
  s.transcript.push({ role: 'tool', text: `[${id}] exit ${msg.exitCode}` });
  log(`session ${s.id.slice(0, 8)} <- tool_result ${id} (ok=${msg.ok})`);

  // All pending tools answered => finish the turn.
  const outstanding = [...s.pendingTools.keys()].filter((k) => !s.toolResults.has(k));
  if (outstanding.length === 0) {
    s.turnActive = false;
    s.transcript.push({ role: 'assistant', text: 'done' });
    send(s.ws, {
      t: 'turn_done',
      usage: { tokensIn: 0, tokensOut: 0, modelMs: 0, toolCalls: s.pendingTools.size },
      stopReason: 'model_done',
    });
    log(`session ${s.id.slice(0, 8)} turn_done`);
  }
}

const wss = new WebSocketServer({ port: PORT });
log(`spike server listening on ws://127.0.0.1:${PORT}  (resume window ${RESUME_WINDOW_MS}ms)`);

wss.on('connection', (ws) => {
  let s = null;
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', code: 'bad_message', message: 'not JSON' });
      return;
    }

    switch (msg.t) {
      case 'hello': {
        if (msg.resumeToken && byResume.has(msg.resumeToken)) {
          s = sessions.get(byResume.get(msg.resumeToken));
          log(`hello: RESUME session ${s.id.slice(0, 8)}`);
          attach(ws, s, true);
        } else if (msg.resumeToken) {
          // Unknown/expired resume token.
          send(ws, { t: 'closing', code: 4410, reason: 'resume window expired; start a fresh session', resumable: false });
          ws.close(4410);
        } else {
          s = newSession();
          log(`hello: NEW session ${s.id.slice(0, 8)}`);
          attach(ws, s, false);
        }
        break;
      }
      case 'user_turn':
        if (s) runTurn(s, msg.text);
        break;
      case 'tool_result':
        if (s) onToolResult(s, msg);
        break;
      case 'heartbeat':
        send(ws, { t: 'heartbeat_ack', serverTime: Date.now() });
        break;
      case 'bye':
        if (s) {
          sessions.delete(s.id);
          byResume.delete(s.resumeToken);
          log(`session ${s.id.slice(0, 8)} bye — discarded`);
        }
        ws.close(1000);
        break;
      default:
        send(ws, { t: 'error', code: 'bad_message', message: `unknown t=${msg.t}` });
    }
  });

  ws.on('close', () => {
    if (!s) return;
    // Keep the session alive for the resume window; then GC it.
    log(`session ${s.id.slice(0, 8)} disconnected — holding for resume (${RESUME_WINDOW_MS}ms)`);
    s.ws = null;
    s.disconnectTimer = setTimeout(() => {
      if (s.ws) return; // reconnected in time
      sessions.delete(s.id);
      byResume.delete(s.resumeToken);
      log(`session ${s.id.slice(0, 8)} resume window elapsed — GC'd`);
    }, RESUME_WINDOW_MS);
  });
});

// Clean shutdown so the harness can stop us deterministically.
process.on('SIGTERM', () => { wss.close(() => process.exit(0)); });
process.on('SIGINT', () => { wss.close(() => process.exit(0)); });
