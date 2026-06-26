// Haxe queue-consumer service (ADR-056 — BullMQ application queue + thin Node consumer).
//
// WHY: the agent pipeline is synchronous from trigger to spine today. There is no priority, no
// admission control against the Managed-Agents concurrency limit, no retry-with-backoff, no
// dead-letter, no idempotency beyond the per-comment claim. ADR-056 adds BullMQ as the
// application-level job queue on the existing Redis, fronted by this thin service: producers POST
// /enqueue and return; this service's BullMQ Worker dequeues BY PRIORITY, enforces concurrency =
// in-flight spine runs, checks idempotency, triggers the spine, and owns retry/backoff/dead-letter.
//
// SCOPE — BLOCK 1 (skeleton): Queue + /enqueue (validate contract, compute 8-level priority,
// queue.add with jobId+priority), a STUB Worker that logs+completes, the fail-safe config reader,
// and /health. The real processor (idempotency check -> spine ingress await -> error
// classification) lands in Block 2; retry/backoff/DLQ in Block 4; the config refresh poll +
// "restart required" WARN in Block 5.
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
// Reads Supabase (config — and agent_runs in Block 2) via REST with SUPABASE_SERVICE_KEY. No ClickUp
// creds. Alerts ride the reused Storage Watchdog Intake (header-auth X-Watchdog-Key) -> Post Alert
// (v1) -> ClickUp Alerts task (the swappable seam; ADR-025). The Alerts task is dropped by the CU
// producer's own guard, so consumer alerts cannot loop.

import express from 'express';
import { Queue, Worker } from 'bullmq';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  REDIS_HOST = 'n8n-redis',
  REDIS_PORT = '6379',
  QUEUE_NAME = 'agent-jobs',
  QUEUE_PREFIX = 'haxeq',
  ALERT_INTAKE_URL,
  ALERT_INTAKE_KEY,
  PORT = '8080',
  STUB_DELAY_MS = '0', // test-only lever: makes priority-ordered pickup observable (default 0 in prod)
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
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

// jobId = idempotency_key = `${task_id}:${invocation_type}:${dedup_window}`. The dedup window is a
// time BUCKET (floor(enqueued_at / dedup_window_h)), so the same task+invocation within one window
// collapses to one job (duplicate enqueues ignored while the job exists), and a later window gets a
// fresh job (re-processing allowed after the window). The CONSUMER derives this — producers read
// only queue.enabled (ADR-056 "Single reader"), so they cannot compute the bucket; any producer-sent
// idempotency_key is therefore advisory and the consumer's derivation is authoritative.
function deriveJobId(task_id, invocation_type, enqueued_at, dedupWindowH) {
  const windowMs = dedupWindowH * 3600 * 1000;
  const t = Date.parse(enqueued_at);
  const enqMs = Number.isFinite(t) ? t : Date.now();
  const bucket = Math.floor(enqMs / windowMs);
  return `${task_id}:${invocation_type}:${bucket}`;
}

// ---- BullMQ wiring ------------------------------------------------------------------------------
// Worker requires maxRetriesPerRequest:null; pass connection OPTIONS (not a shared instance) so
// BullMQ manages its own connections correctly for both Queue and Worker.
const connection = { host: REDIS_HOST, port: Number(REDIS_PORT), maxRetriesPerRequest: null };

const queue = new Queue(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });

let cfg;      // effective config, set at startup by loadQueueConfig()
let worker;   // constructed after cfg is known (needs concurrency / lockDuration / limiter)

function startWorker() {
  // STUB processor (Block 1): log + complete. Real processor lands in Block 2.
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(JSON.stringify({
        level: 'info', evt: 'stub_process', jobId: job.id, priority: job.opts.priority,
        task_id: job.data.task_id, invocation_type: job.data.invocation_type, ts: new Date().toISOString(),
      }));
      const delay = Number(STUB_DELAY_MS) || 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { ok: true, stub: true, jobId: job.id };
    },
    {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: cfg.concurrency,          // live (BullMQ dynamic setter; Block 5 refreshes it)
      lockDuration: cfg.lock_duration_ms,    // restart-only (construction-time)
      maxStalledCount: 1,
      limiter: { max: cfg.rate_limit_per_min, duration: 60000 }, // restart-only (construction-time)
    },
  );

  worker.on('completed', (job) =>
    console.log(JSON.stringify({ level: 'info', evt: 'completed', jobId: job.id, priority: job.opts.priority })));
  worker.on('failed', (job, err) =>
    console.error(JSON.stringify({ level: 'error', evt: 'failed', jobId: job?.id, err: err?.message })));
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
  const jobId = deriveJobId(b.task_id, b.invocation_type, b.enqueued_at, cfg.dedup_window_h);
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
    // and breaks ordering (ADR-056 amendment 2026-06-23b). attempts/backoff are wired in Block 4.
    await queue.add(QUEUE_NAME, jobData, {
      jobId, priority,
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
