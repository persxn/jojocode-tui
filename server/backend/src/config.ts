/**
 * Backend config. Demo-grade: a single shared access code instead of OTP/accounts.
 * Real auth (D9) lands in Phase 1 proper.
 */
export const config = {
  host: process.env.JOJOAI_HOST ?? '127.0.0.1',
  port: Number(process.env.JOJOAI_PORT ?? 7420),

  ollamaUrl: (process.env.JOJOAI_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  model: process.env.JOJOAI_MODEL ?? 'gpt-oss:120b',
  serviceLabel: process.env.JOJOAI_SERVICE_LABEL ?? 'Jojo AI (demo)',

  /** Directory holding legacy dl/<binaries>, served over HTTP. */
  distDir: process.env.JOJOAI_DIST_DIR ?? new URL('../../../dist', import.meta.url).pathname,
  /** The static landing/docs/status site (web/index.html …). */
  webDir: process.env.JOJOAI_WEB_DIR ?? new URL('../../../web', import.meta.url).pathname,
  /** The installer scripts (install.sh, ollama-setup.sh, recommend-model.py …). */
  installDir: process.env.JOJOAI_INSTALL_DIR ?? new URL('../../../install', import.meta.url).pathname,

  /** DEMO auth: `jojo login --code <this>`. Used only when the control plane is not wired. */
  demoCode: process.env.JOJOAI_DEMO_CODE ?? 'jojo-demo',

  /** Real auth: the always-on control plane that mints/validates tokens (T10). */
  controlPlaneUrl: (process.env.JOJOAI_CONTROL_PLANE_URL ?? '').replace(/\/+$/, ''),
  /** Shared secret presented to the control plane on /api/authz/check. */
  serviceToken: process.env.JOJOAI_SERVICE_TOKEN ?? '',

  /** Seats. Matches OLLAMA_NUM_PARALLEL guidance from phase0/FINDINGS.md F1. */
  maxSeats: Number(process.env.JOJOAI_MAX_SEATS ?? 4),

  /** Idle release (ms). D6a. */
  idleReleaseMs: Number(process.env.JOJOAI_IDLE_MS ?? 15 * 60 * 1000),

  /** How long a disconnected session is held for resume (ms). */
  resumeWindowMs: Number(process.env.JOJOAI_RESUME_MS ?? 10 * 60 * 1000),

  /** Orchestrator guards. 32K context/slot at NUM_PARALLEL=4 → keep it lean. */
  maxToolIterations: Number(process.env.JOJOAI_MAX_ITERS ?? 24),
  maxTranscriptChars: Number(process.env.JOJOAI_MAX_TRANSCRIPT ?? 90_000), // ~28K tok budget
  turnWallclockMs: Number(process.env.JOJOAI_TURN_MS ?? 10 * 60 * 1000),
  toolTimeoutMs: Number(process.env.JOJOAI_TOOL_MS ?? 120_000),
};

export type Config = typeof config;
