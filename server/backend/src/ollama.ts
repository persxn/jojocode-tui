/**
 * Ollama streaming chat client with tool-calling + cancellation.
 *
 * gpt-oss:120b returns native `message.tool_calls` via /api/chat (verified
 * 2026-09-07), plus a `thinking` stream. We surface both.
 */
import { config } from './config.ts';

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown> | string };
  }>;
  tool_call_id?: string;
}

export interface ChatDelta {
  thinking?: string;
  content?: string;
}

export interface ChatResult {
  message: OllamaMessage;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage: { promptTokens: number; evalTokens: number; modelMs: number };
  stoppedBy: 'stop' | 'length' | 'load' | 'other';
}

let toolCallSeq = 0;

/**
 * One streamed model call. `onDelta` fires as tokens arrive; the promise
 * resolves with the assembled message + parsed tool calls. Abort via `signal`.
 */
export async function chat(
  messages: OllamaMessage[],
  tools: OllamaTool[],
  onDelta: (d: ChatDelta) => void,
  signal: AbortSignal,
): Promise<ChatResult> {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: tools.length ? tools : undefined,
      stream: true,
      options: { temperature: 0 },
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`ollama /api/chat ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let thinking = '';
  const rawToolCalls: NonNullable<OllamaMessage['tool_calls']> = [];
  let usage = { promptTokens: 0, evalTokens: 0, modelMs: 0 };
  let stoppedBy: ChatResult['stoppedBy'] = 'other';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as {
        message?: OllamaMessage;
        done?: boolean;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
        total_duration?: number;
      };
      const m = msg.message;
      if (m?.thinking) {
        thinking += m.thinking;
        onDelta({ thinking: m.thinking });
      }
      if (m?.content) {
        content += m.content;
        onDelta({ content: m.content });
      }
      if (m?.tool_calls?.length) rawToolCalls.push(...m.tool_calls);
      if (msg.done) {
        usage = {
          promptTokens: msg.prompt_eval_count ?? 0,
          evalTokens: msg.eval_count ?? 0,
          modelMs: Math.round((msg.total_duration ?? 0) / 1e6),
        };
        stoppedBy =
          msg.done_reason === 'stop'
            ? 'stop'
            : msg.done_reason === 'length'
              ? 'length'
              : msg.done_reason === 'load'
                ? 'load'
                : 'other';
      }
    }
  }

  const toolCalls = rawToolCalls.map((tc) => {
    const args =
      typeof tc.function.arguments === 'string'
        ? safeJson(tc.function.arguments)
        : tc.function.arguments;
    return {
      id: tc.id && tc.id.length ? tc.id : `call_${Date.now()}_${toolCallSeq++}`,
      name: tc.function.name,
      args: (args ?? {}) as Record<string, unknown>,
    };
  });

  return {
    message: { role: 'assistant', content, thinking, tool_calls: rawToolCalls },
    toolCalls,
    usage,
    stoppedBy,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** For /healthz — is Ollama reachable and is our model present? */
export async function health(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, detail: `ollama /api/tags ${r.status}` };
    const body = (await r.json()) as { models?: Array<{ name: string }> };
    const names = (body.models ?? []).map((m) => m.name);
    return names.includes(config.model)
      ? { ok: true, detail: `${config.model} available` }
      : { ok: false, detail: `${config.model} not pulled (have: ${names.join(', ') || 'none'})` };
  } catch (e) {
    return { ok: false, detail: `ollama unreachable: ${(e as Error).message}` };
  }
}
