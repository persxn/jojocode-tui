/**
 * Phase 0 spike client — the thin CLI stand-in.
 *
 * Executes streamed tool_requests locally (D1). The "tool" here is: append one
 * line to SIDE_EFFECT_LOG. Exactly-once means that file has exactly one line
 * per tool id no matter how many times we crash and resume.
 *
 * Journal (JOURNAL_FILE): resumeToken + sessionId + per-tool-id recorded result.
 * On a tool_request whose id is already in the journal, we return the stored
 * result and DO NOT run the side effect again.
 *
 *   node client.mjs [--port 7777] [--journal j.json] [--sideeffect s.log]
 *                   [--turn "hello"] [--crash-after-exec] [--crash-before-exec]
 *
 * Exit codes: 0 = turn_done reached; 7 = deliberate crash; 1 = error.
 */
import WebSocket from 'ws';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && (i + 1 >= process.argv.length || process.argv[i + 1].startsWith('--'))) return true; // bool flag
  return i === -1 ? def : process.argv[i + 1];
};
const PORT = Number(arg('port', 7777));
const JOURNAL_FILE = arg('journal', './journal.json');
const SIDE_EFFECT_LOG = arg('sideeffect', './sideeffect.log');
const TURN = arg('turn', 'hello world');
const CRASH_AFTER_EXEC = arg('crash-after-exec', false) === true;
const CRASH_BEFORE_EXEC = arg('crash-before-exec', false) === true;

const journal = existsSync(JOURNAL_FILE)
  ? JSON.parse(readFileSync(JOURNAL_FILE, 'utf8'))
  : { sessionId: null, resumeToken: null, results: {} };
const saveJournal = () => writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));

const log = (...a) => console.log(new Date().toISOString(), 'client:', ...a);

/** The actual side effect. In the real CLI this is fs/exec in the user's project. */
function executeTool(id, name, args) {
  appendFileSync(SIDE_EFFECT_LOG, `EXEC ${id} ${name} ${JSON.stringify(args)} @ ${Date.now()}\n`);
  return { ok: true, exitCode: 0, stdout: 'spike\n' };
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let sentTurn = false;

ws.on('open', () => {
  const hello = {
    t: 'hello',
    protocol: 1,
    token: 'spike-token',
    client: { version: '0.0.0', os: 'linux', arch: 'arm64' },
  };
  if (journal.resumeToken) {
    hello.resumeToken = journal.resumeToken;
    log(`reconnecting with resumeToken ${journal.resumeToken.slice(0, 8)}`);
  } else {
    log('fresh connect');
  }
  ws.send(JSON.stringify(hello));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  switch (msg.t) {
    case 'session_ready': {
      journal.sessionId = msg.sessionId;
      journal.resumeToken = msg.resumeToken;
      saveJournal();
      log(`session_ready id=${msg.sessionId.slice(0, 8)} seat=${msg.seatNo} resumed=${msg.resumed}`);
      // Only start a new turn on a fresh session. On resume, wait for replay.
      if (!msg.resumed && !sentTurn) {
        sentTurn = true;
        log(`-> user_turn "${TURN}"`);
        ws.send(JSON.stringify({ t: 'user_turn', text: TURN }));
      }
      break;
    }
    case 'replay_begin':
      log(`replay_begin (${msg.count})`);
      break;
    case 'replay_end':
      log('replay_end');
      break;
    case 'tool_request': {
      const { id, name, args } = msg;
      if (journal.results[id]) {
        log(`tool_request ${id} — ALREADY IN JOURNAL, returning stored result (no re-exec)`);
        ws.send(JSON.stringify({ t: 'tool_result', id, ...journal.results[id] }));
        break;
      }
      if (CRASH_BEFORE_EXEC) {
        log(`tool_request ${id} — crashing BEFORE exec (simulated)`);
        process.exit(7);
      }
      log(`tool_request ${id} — executing`);
      const result = executeTool(id, name, args);
      journal.results[id] = result;
      saveJournal();
      if (CRASH_AFTER_EXEC) {
        log(`tool_request ${id} — executed + journalled, crashing BEFORE sending result (simulated)`);
        process.exit(7);
      }
      ws.send(JSON.stringify({ t: 'tool_result', id, ...result }));
      break;
    }
    case 'turn_done':
      log(`turn_done stopReason=${msg.stopReason} toolCalls=${msg.usage.toolCalls}`);
      ws.close(1000);
      process.exit(0);
    case 'closing':
      log(`closing code=${msg.code} reason="${msg.reason}"`);
      ws.close(msg.code);
      process.exit(1);
    case 'error':
      log(`error ${msg.code}: ${msg.message}`);
      process.exit(1);
    default:
      log(`?? ${msg.t}`);
  }
});

ws.on('error', (e) => {
  log(`ws error: ${e.message}`);
  process.exit(1);
});
