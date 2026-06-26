// Haxe queue-consumer service (ADR-056 — BullMQ application queue + thin Node consumer).
//
// WHY: the agent pipeline is synchronous from trigger to spine today. There is no priority, no
// admission control against the Managed-Agents concurrency limit, no retry-with-backoff, no
// dead-letter, no idempotency beyond the per-comment claim. ADR-056 adds BullMQ as the
// application-level job queue on the existing Redis, fronted by this thin service: producers POST
// /enqueue and return; this service's BullMQ Worker dequeues BY PRIORITY, enforces concurrency =
// in-flight spine runs, checks idempotency, triggers the spine, and owns retry/backoff/dead-letter.
//
// SCOPE — BLOCK 2 (real processor): the stub Worker is replaced by the production processor:
//   1. PRE-TRIGGER IDEMPOTENCY (ADR-035 role only) — before triggering the spine, look for a
//      COMPLETED agent_runs row for this job's task + trigger kind. If found, succeed the job as a
//      no-op (skip; do not re-draft). A FAILED idempotency read throws RETRYABLE (never proceed blind:
//      a hidden completed run would double-draft). BLOCK-3 DEDUP REFINEMENT: the dedup UNIT is
//      invocation-class-aware. EXPLICIT (interactive) jobs key on the triggering COMMENT (jobId
//      `...:c<comment_id>`) so a distinct follow-up @-mention runs instead of being collapsed by a 24h
//      task+type window; for them the agent_runs check is only a RETRY-after-partial guard (run on
//      attemptsMade>0, bounded to runs created after this job's enqueued_at). AUTONOMOUS jobs keep the
//      dedup_window_h time-bucket jobId + window check (a cron must not reprocess a task in-window).
//   2. TRIGGER THE SPINE via the hardened Spine HTTP Ingress and AWAIT it (held connection up to
//      spine_timeout_ms). The ingress returns a deterministic HTTP 200 with {status, outcome,
//      failure_kind, clickup_task_id, warnings} (Block 0 G2 / Block 1).
//   3. CLASSIFY (ADR-047 / Block 0 G2 contract):
//        transport error / timeout / genuine n8n 5xx     -> throw retryable (BullMQ retries)
//        HTTP 200, status=completed                        -> job done
//        HTTP 200, status=failed (business)               -> throw UnrecoverableError -> DLQ (no retry)
//        non-5xx non-2xx (e.g. 4xx) / unparseable / unknown -> UnrecoverableError -> DLQ
//      Business failures stay 200+status (never auto-retried). Only infra failures retry.
//
// attempts + custom backoff (60/300/900s) are wired here so classification is demonstrable. The
// terminal `failed` -> CRITICAL DLQ alert is Block 4 (the worker `failed` handler below, gated on
// the dead-letter condition). The 30-60s config refresh poll lands in Block 5.
//
// SCHEMA NOTE (load-bearing). The JOB's invocation_type (queue vocab: explicit_mention, due_date,
// ...) is NOT agent_runs.invocation_type (CHECK: autonomous|explicit|conversation_reply). It aligns
// with agent_runs.TRIGGERED_BY. So the idempotency check matches on triggered_by, and the value the
// consumer sends to the ingress as `invocation_type` is the SPINE vocabulary (derived), not the
// job's — sending explicit_mention there would violate the agent_runs.invocation_type CHECK and
// break the spine's own run insert.
//
// CONTRACT
//   POST /enqueue
//     { task_id, caller_user_id, impact, invocation_type, enqueued_at, payload, idempotency_key? }
//     -> 200 { ok:true, jobId, priority, deduped:bool }
//     -> 400 { ok:false, error }   (bad contract)
//     -> 500 { ok:false, error }   (enqueue failure -> CRITICAL alert)
//   GET /health -> 200 { ok:true, redis:'PONG', concurrency, lock_duration_ms, ... } | 503
//
// KEY ISOLATION: BullMQ prefix 'haxeq' (keys haxeq:agent-jobs:*) never collides with n8n queue
// mode's default 'bull:*' on the same Redis.
//
// Reads Supabase (config, agent_runs) via REST with SUPABASE_SERVICE_KEY. No ClickUp creds. Alerts
// ride the reused Storage Watchdog Intake (header-auth X-Watchdog-Key) -> Post Alert (v1) -> ClickUp
// Alerts task (the swappable seam; ADR-025). The Alerts task is dropped by the CU producer's own
// guard, so consumer alerts cannot loop.

import express from 'express';
import http from 'node:http';
import https from 'node:https';
import { Queue, Worker, UnrecoverableError } from 'bullmq';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  REDIS_HOST = 'n8n-redis',
  REDIS_PORT = '6379',
  QUEUE_NAME = 'agent-jobs',
  QUEUE_PREFIX = 'haxeq',
  SPINE_INGRESS_URL,
  ALERT_INTAKE_URL,
  ALERT_INTAKE_KEY,
  PORT = '8080',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  process.exit(1);
}
if (!SPINE_INGRESS_URL) {
  console.error('FATAL: SPINE_INGRESS_URL is required (the hardened Spine HTTP Ingress webhook)');
  process.exit(1);
}

// ---- contract-shape constants (code, never config — ADR-056 amendment 2026-06-23b) ------------
// Priority = single lexicographic key: explicit vs automatic is PRIMARY, impact SECONDARY.
//   priority = (is_explicit ? 0 : 4) + impact_rank   -> 1..8   (BullMQ: lower number = higher prio)
const IMPACT_RANK = { 'Krytycznie ważne': 1, 'Wysoki': 2, 'Średni': 3, 'Niski': 4 };
const EXPLICIT_INVOCATIONS = new Set(['explicit_mention', 'explicit_command']);
const IMPACTS = new Set(Object.keys(IMPACT_RANK));
const INVOCATION_TYPES = new Set([
  'autonomous_webhook', 'due_date', 'explicit_mention', 'explicit_command', 'email', 'weekly_proposer',
]);

// Spine-vocabulary derivation (contract-shape, code constants). The consumer prefers a producer-
// supplied payload value (source-specific; e.g. the autonomous_webhook -> status-vs-field ambiguity
// can only be resolved by the producer) and falls back to these maps. For the only in-scope producer
// (explicit_mention, Block 3) the derivation is exact, so Block 2 verifies end-to-end without a
// producer.
//   * TRIGGERED_BY: job invocation_type -> agent_runs.triggered_by (the precise idempotency key and
//     the value the spine writes for this run).
//   * SPINE_INVOCATION: job invocation_type -> agent_runs.invocation_type (CHECK: the coarse 3-value
//     set). This is what the ingress's `invocation_type` field MUST carry.
const TRIGGERED_BY = {
  explicit_mention: 'explicit_mention',
  explicit_command: 'explicit_command',
  due_date: 'due_date_daily',
  autonomous_webhook: 'webhook_status_change', // ambiguous (status vs field) — Phase-3 producer overrides via payload.triggered_by
  email: 'gmail_incoming',
  weekly_proposer: 'weekly_proposer',
};
const SPINE_INVOCATION = {
  explicit_mention: 'explicit',
  explicit_command: 'explicit',
  due_date: 'autonomous',
  autonomous_webhook: 'autonomous',
  email: 'autonomous',
  weekly_proposer: 'autonomous',
};

// ---- fail-safe config reader (the load-bearing piece — ADR-056 amendment) ----------------------
// Block-0-corrected defaults (block-0-findings.md G1/G5). MARGIN is the reader's enforced minimum
// gap between the protective caps.
const MARGIN = 120000; // 2 min
const DEFAULTS = {
  enabled: true,
  concurrency: 5,
  env_concurrency_cap: 10,
  max_runtime_ms: 900000,
  spine_timeout_ms: 1200000,
  lock_duration_ms: 1500000,
  retry_attempts: 5,
  backoff_ms: [60000, 300000, 900000],
  rate_limit_per_min: 60,
  dedup_window_h: 24,
  alert_depth_high: 20,
  alert_depth_any: 100,
  alert_failed: 0,
  heartbeat_stale_s: 120,
};
const TYPES = {
  enabled: 'bool', concurrency: 'int', env_concurrency_cap: 'int', max_runtime_ms: 'int',
  spine_timeout_ms: 'int', lock_duration_ms: 'int', retry_attempts: 'int', backoff_ms: 'array',
  rate_limit_per_min: 'int', dedup_window_h: 'int', alert_depth_high: 'int', alert_depth_any: 'int',
  alert_failed: 'int', heartbeat_stale_s: 'int',
};

function parseValue(type, raw) {
  if (type === 'bool') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error('not a boolean');
  }
  if (type === 'int') {
    if (!/^-?\d+$/.test(String(raw).trim())) throw new Error('not an integer');
    return parseInt(raw, 10);
  }
  if (type === 'array') {
    const v = JSON.parse(raw);
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && x >= 0)) {
      throw new Error('not an array of non-negative numbers');
    }
    return v;
  }
  throw new Error(`unknown type ${type}`);
}

async function supabaseSelect(table, select, filter) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${filter ? `&${filter}` : ''}`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

// Read queue.* once, clamp + WARN the three silent-failure invariants, default+WARN on any
// missing/unparseable key. A bad edit degrades to a safe value plus an alert — never a silent break.
async function loadQueueConfig() {
  const warnings = [];
  let rows = null;
  try {
    rows = await supabaseSelect('config', 'key,value', 'key=like.queue.*');
  } catch (e) {
    warnings.push(`config read failed (${e.message}); using ALL defaults`);
  }
  const readOk = Array.isArray(rows);
  const raw = readOk ? Object.fromEntries(rows.map((r) => [r.key.replace(/^queue\./, ''), r.value])) : {};

  const cfg = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!(k in raw)) {
      cfg[k] = def;
      if (readOk) warnings.push(`queue.${k} missing; using default ${JSON.stringify(def)}`);
      continue;
    }
    try {
      cfg[k] = parseValue(TYPES[k], raw[k]);
    } catch (e) {
      cfg[k] = def;
      warnings.push(`queue.${k} unparseable ("${raw[k]}"): ${e.message}; using default ${JSON.stringify(def)}`);
    }
  }

  // The three runtime-derived invariants (each a known silent-failure mode from ADR-056):
  const cap = cfg.env_concurrency_cap;
  if (cfg.concurrency > cap || cfg.concurrency < 1) {
    const clamped = Math.max(1, Math.min(cfg.concurrency, cap));
    warnings.push(`concurrency ${cfg.concurrency} out of [1,${cap}] -> clamped to ${clamped} (429-storm guard)`);
    cfg.concurrency = clamped;
  }
  const floor = cfg.max_runtime_ms + MARGIN;
  if (cfg.lock_duration_ms < floor) {
    warnings.push(`lock_duration_ms ${cfg.lock_duration_ms} < max_runtime_ms+MARGIN (${floor}) -> raised to ${floor} (stalled-job-rerun / double-draft guard)`);
    cfg.lock_duration_ms = floor;
  }
  const ceil = cfg.lock_duration_ms - MARGIN;
  if (cfg.spine_timeout_ms > ceil) {
    warnings.push(`spine_timeout_ms ${cfg.spine_timeout_ms} > lock_duration_ms-MARGIN (${ceil}) -> lowered to ${ceil} (premature-abort / double-draft guard)`);
    cfg.spine_timeout_ms = ceil;
  }

  for (const w of warnings) {
    console.warn(`[config][WARN] ${w}`);
    postAlert('WARN', `queue config: ${w}`, { detail: w }, 'queue-consumer/config').catch(() => {});
  }
  return cfg;
}

// ---- alert seam (reused Storage Watchdog Intake) -----------------------------------------------
async function postAlert(severity, message, details, source = 'queue-consumer') {
  if (!ALERT_INTAKE_URL || !ALERT_INTAKE_KEY) {
    console.warn('[alert] ALERT_INTAKE_URL/KEY not configured — alert dropped:', severity, message);
    return;
  }
  try {
    const r = await fetch(ALERT_INTAKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Watchdog-Key': ALERT_INTAKE_KEY },
      body: JSON.stringify({
        severity, source, message,
        details: typeof details === 'string' ? details : JSON.stringify(details || {}),
      }),
    });
    if (!r.ok) console.error(`[alert] intake HTTP ${r.status}`);
  } catch (e) {
    console.error('[alert] post failed:', e.message);
  }
}

// ---- priority + idempotency derivation ---------------------------------------------------------
function computePriority(invocation_type, impact) {
  const isExplicit = EXPLICIT_INVOCATIONS.has(invocation_type);
  return (isExplicit ? 0 : 4) + IMPACT_RANK[impact]; // 1..8
}

// jobId = idempotency_key. The dedup UNIT depends on invocation class (Block 3):
//   * EXPLICIT (interactive: explicit_mention/explicit_command) -> keyed on the TRIGGERING COMMENT:
//     `${task_id}:${invocation_type}:c${dedup_comment_id}`. Each distinct @-mention/command is a
//     distinct request, so a follow-up on the same task gets its OWN job; a 24h task+type time bucket
//     would silently collapse it (the regression Block 3 fixes). The producer's permanent Claim Comment
//     (agent_webhook_dedup PK on the comment id) already guarantees one enqueue per comment, so this
//     comment-keyed jobId only ever collapses a true duplicate enqueue of the SAME comment.
//   * AUTONOMOUS (due_date/webhook/email/...) -> keyed on a time BUCKET (floor(enqueued_at /
//     dedup_window_h)): a cron must not reprocess the same task+trigger within the window. There is no
//     triggering comment for these.
// The CONSUMER derives this — producers read only queue.enabled (ADR-056 "Single reader"); the
// dedup_comment_id rides in payload, any producer-sent idempotency_key is advisory.
function deriveJobId(b, dedupWindowH) {
  const { task_id, invocation_type, enqueued_at, payload = {} } = b;
  if (EXPLICIT_INVOCATIONS.has(invocation_type) && payload.dedup_comment_id) {
    return `${task_id}:${invocation_type}:c${payload.dedup_comment_id}`;
  }
  const windowMs = dedupWindowH * 3600 * 1000;
  const t = Date.parse(enqueued_at);
  const enqMs = Number.isFinite(t) ? t : Date.now();
  const bucket = Math.floor(enqMs / windowMs);
  return `${task_id}:${invocation_type}:${bucket}`;
}

// ---- processor (Block 2) -----------------------------------------------------------------------
// Resolve the spine-vocabulary trigger fields for a job: prefer producer-supplied payload values,
// fall back to the derivation maps. `triggeredBy` is BOTH the idempotency key and the value the
// spine will write, so the same value is used in the agent_runs check and the ingress POST — the
// check asks exactly "did a run that looks like the one I'm about to trigger already complete?".
function resolveSpineFields(job) {
  const { task_id, invocation_type, caller_user_id, payload = {} } = job.data;
  const triggeredBy = payload.triggered_by || TRIGGERED_BY[invocation_type] || invocation_type;
  const spineInvocation = payload.invocation_type || SPINE_INVOCATION[invocation_type] || 'autonomous';
  return {
    taskId: task_id,
    reviewer_user_id: payload.reviewer_user_id ?? caller_user_id,
    caller_username: payload.caller_username ?? '',
    triggered_by: triggeredBy,
    invocation_type: spineInvocation,
    triggering_comment_id: payload.triggering_comment_id ?? '',
    triggering_comment_text: payload.triggering_comment_text ?? '',
  };
}

// Pre-trigger idempotency (ADR-035 role only). Returns the most recent COMPLETED run for this task +
// trigger kind created after `cutoffIso`, else null. The caller sets the cutoff per invocation class
// (Block 3): the dedup_window_h window for autonomous jobs; the job's own enqueued_at for explicit
// retries. Throws on read failure so the caller can treat it as RETRYABLE (never proceed blind -> a
// hidden completed run would double-draft).
async function findCompletedRun(taskId, triggeredBy, cutoffIso) {
  const filter =
    `clickup_task_id=eq.${encodeURIComponent(taskId)}` +
    `&triggered_by=eq.${encodeURIComponent(triggeredBy)}` +
    `&status=eq.completed` +
    `&created_at=gt.${encodeURIComponent(cutoffIso)}` +
    `&order=created_at.desc&limit=1`;
  const rows = await supabaseSelect('agent_runs', 'id,created_at,status', filter);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Trigger the spine via the hardened ingress and await it (held connection up to spine_timeout_ms).
// Returns { httpStatus, ok, body, raw } where body is the parsed deterministic outcome (or null if
// unparseable). Rejects on network failure / timeout (err.isTimeout=true for a timeout) — the caller
// maps that to a retryable infra throw.
//
// Uses node:http directly, NOT global fetch: the ingress holds the connection open with no response
// for the WHOLE spine run (up to 15 min, G5), and undici/fetch's default ~300s headersTimeout would
// abort a HEALTHY long run at 5 min as a false transport error. node:http's socket-inactivity
// `timeout` is the only timer here, set to spine_timeout_ms — exactly the held-connection cap.
function callSpine(spineBody, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(SPINE_INGRESS_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(spineBody));
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        timeout: timeoutMs, // socket-inactivity cap = held-connection lifetime (no other timer)
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { /* leave null; classified below */ }
          resolve({ httpStatus: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body, raw });
        });
      },
    );
    req.on('timeout', () => {
      const e = new Error(`held connection idle > ${timeoutMs}ms`);
      e.isTimeout = true;
      req.destroy(e);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function processJob(job) {
  const { task_id, invocation_type } = job.data;
  const spine = resolveSpineFields(job);
  const logBase = { jobId: job.id, task_id, invocation_type, triggered_by: spine.triggered_by, attempt: job.attemptsMade };

  // 1. Pre-trigger idempotency check (ADR-035 role only).
  // EXPLICIT (interactive) jobs dedup on the comment via jobId, so a distinct follow-up @-mention is a
  // distinct job and MUST run — running the task+trigger agent_runs check on its FIRST attempt would
  // falsely skip it against an earlier mention's completed run. So for explicit the agent_runs check is
  // ONLY a retry-after-partial guard: run it solely on a RETRY (attemptsMade>0), bounded to runs created
  // AFTER this job was enqueued (a completed run appearing post-enqueue, on a retry, is this job's own
  // prior attempt that drafted then lost its held connection). AUTONOMOUS jobs keep the dedup_window_h
  // window on every attempt (a cron must not reprocess a task already done within the window).
  const isExplicit = EXPLICIT_INVOCATIONS.has(invocation_type);
  const runIdempotencyCheck = !isExplicit || job.attemptsMade > 0;
  let prior = null;
  if (runIdempotencyCheck) {
    const enqMs = Date.parse(job.data.enqueued_at);
    const cutoffIso = (isExplicit && Number.isFinite(enqMs))
      ? new Date(enqMs).toISOString()
      : new Date(Date.now() - cfg.dedup_window_h * 3600 * 1000).toISOString();
    try {
      prior = await findCompletedRun(task_id, spine.triggered_by, cutoffIso);
    } catch (e) {
      // A failed read could hide a completed run -> proceeding would double-draft. Retry instead.
      console.warn(JSON.stringify({ level: 'warn', evt: 'idempotency_read_failed', ...logBase, err: e.message }));
      throw new Error(`idempotency check failed (retryable): ${e.message}`);
    }
    if (prior) {
      console.log(JSON.stringify({ level: 'info', evt: 'idempotent_skip', ...logBase, prior_run_id: prior.id, prior_at: prior.created_at }));
      return { skipped: true, reason: 'idempotent', prior_run_id: prior.id };
    }
  }

  // 2. Trigger the spine and await it.
  console.log(JSON.stringify({ level: 'info', evt: 'spine_call', ...logBase, timeout_ms: cfg.spine_timeout_ms }));
  let res;
  try {
    res = await callSpine(spine, cfg.spine_timeout_ms);
  } catch (e) {
    // transport error or held-connection timeout -> RETRYABLE infra (ADR-047)
    const kind = e?.isTimeout ? `timeout after ${cfg.spine_timeout_ms}ms` : (e?.message || 'transport error');
    console.warn(JSON.stringify({ level: 'warn', evt: 'spine_transport_error', ...logBase, err: kind }));
    throw new Error(`spine call transport/timeout (retryable): ${kind}`);
  }

  // 3. Classify from the response.
  // Genuine n8n-level 5xx -> retryable infra.
  if (res.httpStatus >= 500) {
    console.warn(JSON.stringify({ level: 'warn', evt: 'spine_5xx', ...logBase, http: res.httpStatus, body: res.raw?.slice(0, 300) }));
    throw new Error(`spine ingress HTTP ${res.httpStatus} (retryable): ${res.raw?.slice(0, 300)}`);
  }
  // Any other non-2xx (e.g. 4xx) -> won't fix on retry -> DLQ.
  if (!res.ok) {
    console.error(JSON.stringify({ level: 'error', evt: 'spine_4xx', ...logBase, http: res.httpStatus, body: res.raw?.slice(0, 300) }));
    throw new UnrecoverableError(`spine ingress HTTP ${res.httpStatus} (non-retryable): ${res.raw?.slice(0, 300)}`);
  }
  // HTTP 200 but body didn't parse -> the deterministic contract is broken; treat as retryable infra
  // (a transient proxy/HTML page is more likely than a permanent contract break, and retry is safe —
  // idempotency will skip if the spine in fact ran).
  if (!res.body || typeof res.body !== 'object') {
    console.warn(JSON.stringify({ level: 'warn', evt: 'spine_unparseable', ...logBase, body: res.raw?.slice(0, 300) }));
    throw new Error(`spine ingress 200 but unparseable body (retryable): ${res.raw?.slice(0, 200)}`);
  }
  const { status, outcome, failure_kind, warnings } = res.body;
  if (status === 'completed') {
    console.log(JSON.stringify({ level: 'info', evt: 'spine_completed', ...logBase, outcome, warnings: warnings || [] }));
    return { skipped: false, status: 'completed', outcome, warnings: warnings || [] };
  }
  if (status === 'failed') {
    // Business failure -> straight to DLQ, no retry (retrying would double-draft a known-bad outcome).
    console.error(JSON.stringify({ level: 'error', evt: 'spine_business_failure', ...logBase, failure_kind, outcome }));
    throw new UnrecoverableError(`spine business failure (${failure_kind || 'unknown'}): ${outcome || ''}`);
  }
  // Unknown status -> conservative: DLQ rather than loop on a contract we don't understand.
  console.error(JSON.stringify({ level: 'error', evt: 'spine_unknown_status', ...logBase, status, outcome }));
  throw new UnrecoverableError(`spine returned unknown status "${status}"`);
}

// ---- BullMQ wiring ------------------------------------------------------------------------------
// Worker requires maxRetriesPerRequest:null; pass connection OPTIONS (not a shared instance) so
// BullMQ manages its own connections correctly for both Queue and Worker.
const connection = { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null };

const queue = new Queue(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });

let cfg;      // effective config, set at startup by loadQueueConfig()
let worker;   // constructed after cfg is known (needs concurrency / lockDuration / limiter)

function startWorker() {
  worker = new Worker(
    QUEUE_NAME,
    processJob,
    {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: cfg.concurrency,          // live (BullMQ dynamic setter; Block 5 refreshes it)
      lockDuration: cfg.lock_duration_ms,    // restart-only (construction-time)
      maxStalledCount: 1,
      limiter: { max: cfg.rate_limit_per_min, duration: 60000 }, // restart-only (construction-time)
      settings: {
        // Custom per-attempt backoff (60/300/900s); jobs are added with backoff:{type:'custom'}.
        // attemptsMade counts attempts already made (1 after the first failure) -> index attemptsMade-1,
        // clamped to the last element so a shorter array repeats its tail. The terminal exhaustion ->
        // CRITICAL DLQ alert is the worker `failed` handler below (Block 4).
        backoffStrategy: (attemptsMade) => {
          const arr = cfg.backoff_ms;
          return arr[Math.min(Math.max(attemptsMade - 1, 0), arr.length - 1)];
        },
      },
    },
  );

  worker.on('completed', (job) =>
    console.log(JSON.stringify({ level: 'info', evt: 'completed', jobId: job.id, priority: job.opts.priority })));

  // Dead-letter alert (Block 4). The `failed` event fires once PER failed attempt; BullMQ only
  // dead-letters (stops retrying) when the error is an UnrecoverableError OR all attempts are
  // exhausted (attemptsMade >= opts.attempts). We mirror exactly that terminal condition so the
  // CRITICAL alert fires EXACTLY ONCE — on the dead-letter, never on a retryable interim failure
  // (those are logged at error level and left to the backoff schedule). The BullMQ `failed` set
  // (removeOnFail age 24h) IS the dead-letter store; this handler is its alarm (ADR-056 §6 / §14.5).
  worker.on('failed', async (job, err) => {
    const unrecoverable = err instanceof UnrecoverableError;
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const terminal = !!job && (unrecoverable || attemptsMade >= maxAttempts);
    console.error(JSON.stringify({
      level: 'error', evt: 'failed', jobId: job?.id, attempts: attemptsMade,
      max_attempts: maxAttempts, unrecoverable, terminal, err: err?.message,
    }));
    if (!terminal) return; // retryable interim failure: BullMQ will retry on the backoff schedule.
    const d = job.data || {};
    const message = unrecoverable
      ? `agent job ${job.id} dead-lettered (non-retryable) after ${attemptsMade} attempt(s)`
      : `agent job ${job.id} dead-lettered: exhausted ${attemptsMade}/${maxAttempts} attempts`;
    // postAlert swallows its own errors (never throws) — a failed alert must not crash the worker.
    await postAlert('CRITICAL', message, {
      jobId: job.id, task_id: d.task_id, invocation_type: d.invocation_type,
      priority: job.opts?.priority, attempts_made: attemptsMade, max_attempts: maxAttempts,
      unrecoverable, error: err?.message, failed_reason: job.failedReason,
    }, 'queue-consumer/dlq');
  });
  worker.on('error', (err) =>
    console.error(JSON.stringify({ level: 'error', evt: 'worker_error', err: err?.message })));
  worker.on('stalled', (jobId) =>
    console.warn(JSON.stringify({ level: 'warn', evt: 'stalled', jobId })));
}

// ---- HTTP surface ------------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', async (_req, res) => {
  try {
    const client = await queue.client;
    const pong = await client.ping();
    return res.json({
      ok: pong === 'PONG', redis: pong, queue: QUEUE_NAME, prefix: QUEUE_PREFIX,
      concurrency: cfg?.concurrency, lock_duration_ms: cfg?.lock_duration_ms,
      spine_timeout_ms: cfg?.spine_timeout_ms, rate_limit_per_min: cfg?.rate_limit_per_min,
    });
  } catch (e) {
    return res.status(503).json({ ok: false, error: e.message });
  }
});

app.post('/enqueue', async (req, res) => {
  const b = req.body || {};
  const required = ['task_id', 'caller_user_id', 'impact', 'invocation_type', 'enqueued_at', 'payload'];
  const missing = required.filter((f) => b[f] === undefined || b[f] === null || b[f] === '');
  if (missing.length) return res.status(400).json({ ok: false, error: `missing required fields: ${missing.join(', ')}` });
  if (!IMPACTS.has(b.impact)) return res.status(400).json({ ok: false, error: `invalid impact "${b.impact}"` });
  if (!INVOCATION_TYPES.has(b.invocation_type)) return res.status(400).json({ ok: false, error: `invalid invocation_type "${b.invocation_type}"` });
  if (typeof b.payload !== 'object' || Array.isArray(b.payload)) return res.status(400).json({ ok: false, error: 'payload must be an object' });

  const priority = computePriority(b.invocation_type, b.impact);
  const jobId = deriveJobId(b, cfg.dedup_window_h);
  const jobData = {
    task_id: b.task_id,
    caller_user_id: b.caller_user_id,
    impact: b.impact,
    invocation_type: b.invocation_type,
    priority,
    idempotency_key: jobId, // canonical (consumer-derived)
    enqueued_at: b.enqueued_at,
    payload: b.payload,
  };

  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      console.log(JSON.stringify({ level: 'info', evt: 'enqueue_dedup', jobId, priority }));
      return res.json({ ok: true, jobId, priority, deduped: true });
    }
    // ALWAYS set an explicit priority 1..8 — an unset BullMQ priority falls into a separate FIFO path
    // and breaks ordering (ADR-056 amendment 2026-06-23b). attempts + custom backoff (60/300/900s)
    // are wired so error classification is demonstrable (Block 2 DoD); the terminal DLQ alert fires from
    // the worker `failed` handler on the dead-letter condition (Block 4).
    await queue.add(QUEUE_NAME, jobData, {
      jobId, priority,
      attempts: cfg.retry_attempts,
      backoff: { type: 'custom' },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    });
    console.log(JSON.stringify({ level: 'info', evt: 'enqueued', jobId, priority, task_id: b.task_id, invocation_type: b.invocation_type }));
    return res.json({ ok: true, jobId, priority, deduped: false });
  } catch (e) {
    console.error('[enqueue] failed:', e);
    postAlert('CRITICAL', `/enqueue failed for task ${b.task_id}`, { error: e.message, task_id: b.task_id }, 'queue-consumer/enqueue').catch(() => {});
    return res.status(500).json({ ok: false, error: 'enqueue failed' });
  }
});

// ---- startup / shutdown ------------------------------------------------------------------------
async function main() {
  cfg = await loadQueueConfig();
  console.log('[config] effective:', JSON.stringify(cfg));
  startWorker();
  app.listen(Number(PORT), () =>
    console.log(`queue-consumer listening on :${PORT}, queue=${QUEUE_NAME}, prefix=${QUEUE_PREFIX}, concurrency=${cfg.concurrency}`));
}

async function shutdown() {
  console.log('[shutdown] closing worker + queue');
  try { await worker?.close(); } catch {}
  try { await queue.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((e) => { console.error('FATAL startup error:', e); process.exit(1); });
