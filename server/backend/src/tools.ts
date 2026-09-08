/**
 * The tool set the model sees. Execution happens on the CLI (D1); the backend
 * only defines the contract and decides which calls are `destructive` (→ the
 * CLI must get explicit user approval regardless of its allowlist).
 *
 * Demo set. Phase 1/3 add apply_patch, path-jail metadata, a richer policy.
 */
import type { OllamaTool } from './ollama.ts';

export const TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List entries in a directory within the current project.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path relative to the project root. Default "."' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file within the current project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          max_bytes: { type: 'integer', description: 'Optional cap; default 100000.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a UTF-8 text file within the current project. Destructive: the user is asked to approve.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          content: { type: 'string', description: 'Full new file contents.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the project root and return stdout/stderr/exit code. Destructive: the user is asked to approve.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The command line to run.' },
          timeout_ms: { type: 'integer', description: 'Optional; default 120000.' },
        },
        required: ['cmd'],
      },
    },
  },
];

/** Which tools always need explicit user approval on the client. */
const DESTRUCTIVE = new Set(['write_file', 'run_command']);
export const isDestructive = (name: string): boolean => DESTRUCTIVE.has(name);

export const SYSTEM_PROMPT = `You are Jojo AI, a coding agent. You work on the user's local project by calling tools; the tools run on the user's machine.

Rules:
- Prefer reading before writing. Inspect the project with list_dir and read_file before proposing changes.
- Make the smallest change that solves the task. Explain what you did in a sentence or two.
- write_file and run_command require the user's approval each time — expect that and don't loop on a rejection.
- Never invent file contents you haven't read. Never run destructive commands (rm -rf, disk formatting, curl | sh) — ask the user to do those themselves.
- When the task is done, say so plainly and stop.`;
