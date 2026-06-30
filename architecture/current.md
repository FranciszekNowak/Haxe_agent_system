# Haxe Agents — Architecture (current)

Version: v23
Last updated: 2026-06-18
Supersedes: v22

This is the canonical description of the system being built. When it diverges
from what is actually implemented, that is a bug to fix immediately. Reasoning
behind individual decisions lives in `decisions/` (ADRs); this document
describes the system as it currently stands, not the history of how we got here.

---

## 1. Purpose

An internal, recursively self-improving multi-agent system for Haxe (legal
entity Skalus Sp. z o.o.). It automates routine knowledge work for a ~5-person
team — drafting product descriptions, supplier/customer email drafts, analysing
operational data — and improves its own processes over time by learning from how
humans edit and rate its output.

Design horizon: a system whose structure holds at 10 → 100 → 1000 people,
operating near economic optimality at every scale, self-reinforcing with minimal
senior-management intervention.

---

## 2. The five layers

1. **ClickUp** — source of truth for all operational knowledge. Process
   templates, agent personas, brand voice, rules, and the tasks the agents act
   on all live here. Humans work where they already work.

2. **n8n (self-hosted) + Redis** — orchestration and queue. Runs on an EU VPS
   (Cyberfolks, Poznań). n8n in queue mode: a main process handles webhooks, the
   UI, and scheduling; worker processes pull jobs from Redis and execute
   workflows. Redis provides rate-limiting, decoupling, priority, and retries.

3. **Anthropic Managed Agents (global)** — the live orchestration lane since 2026-06-22 (ADR-053,
   cutover Block 9). A hosted agent runtime — Anthropic-operated sandbox, tool loop, code execution,
   in-harness **web search**, and office-document **Skills** (docx/xlsx/pptx/pdf), with the **Files API**
   for input/output files. One lane, selected by **impact only**: a small set of agent definitions
   sharing `system`/tools/skills and differing only in model tier — Niski→Haiku, Średni→Sonnet,
   Wysoki→Opus, Krytycznie ważne→Opus (repointed from Fable 5, which is gated on the Managed Agents beta —
   ADR-053 amendment; reversible). Routing lives in the `agent_routing` table (impact → agent_id).
   **Residency dropped** (ADR-053): global Anthropic endpoint for all tasks incl. PII; basis is lawful
   processing (DPA/SCCs/DPF), not residency. **Image generation** runs via a self-hosted **MCP server**
   that wraps the existing n8n image lane (Vertex gemini-image + OpenAI gpt-image-2 — ADR-055). The
   **bare LiteLLM lane** (`(impact, modality)` PD-blind routing — Anthropic direct / Vertex Gemini, ADR-043)
   is **retained as the dormant outage failover** (text + image; web research retired), selected by the
   `config.agent_lane` flag (`managed` | `bare`, default `managed`; an unreadable flag fails safe to
   `bare` + WARN). ADR-054 (per-user permission-scoped ClickUp retrieval within the lane) is accepted and
   in progress — locked to Option A (two-token per-user model: MCP-OAuth for discovery in the Anthropic
   Vault, classic REST for extraction in Supabase Vault); Block 1 (store + chained two-consent onboarding)
   landed, not yet wired into sessions. See ADR-053/054/055, and the live summary after §3.

4. **Supabase (eu-west-1, Ireland)** — application database. Operational logs, threaded
   human feedback, process-change proposals, conversation session cache, email
   audit. (n8n's own internal database is a separate Postgres container on the
   VPS — not Supabase.)

5. **Personal layer** — Claude Max for the operator (Franciszek). Claude Code for
   execution/file work; chat for strategy. See §9.

```
┌────────────────────────────────────────────────────────────────┐
│  LAYER 1: ClickUp — Source of Truth for Everything Operational │
│  • Process templates, agent personas, brand voice, rules       │
│  • Custom fields for agent control (Czy dla AI, Ważność, …)   │
│  • Comments as conversation channel                            │
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 2: n8n + Redis on EU VPS — Orchestration + Queue        │
│  n8n main: webhooks, daily crons, session cleanup              │
│  n8n workers: queue consumers (10 concurrent executions)       │
│  Redis: priority queues, rate-limit tokens, retry schedule     │
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 3: Anthropic Managed Agents (global) — LIVE LANE        │
│  hosted runtime: sandbox, tool loop, web search, Skills, Files │
│  one lane, by impact: Haiku/Sonnet/Opus (Krytyczne→Opus)      │
│  image gen → self-hosted MCP → Vertex/OpenAI (ADR-055)        │
│  bare LiteLLM (impact,modality) = dormant failover (agent_lane)│
└────────────────────────────────────────────────────────────────┘
                              ↕
┌────────────────────────────────────────────────────────────────┐
│  LAYER 4: Supabase (eu-central-1) — Logs + Sessions + Learning │
│  agent_runs, agent_run_evaluations                             │
│  agent_proposals, agent_proposal_evaluations                   │
│  conversation_sessions, email_sends, schema_migrations         │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  LAYER 5: Personal (parallel)                                  │
│  Claude Max: strategy / design / research                      │
│  Claude Code: execution / file work / commands                 │
└────────────────────────────────────────────────────────────────┘
```

---

## Core model — one generic pipeline (no per-process agents)

There is exactly ONE agent mechanism, built once in n8n. No per-process, per-task, or per-stage agents. Innate behaviour, identical for every process and person:

1. Trigger — autonomous (ClickUp status/field webhooks + the daily due-date scan, gated by `Czy dla AI`) or explicit pull (@-mention / ~command on a ClickUp task). Both modes are retained; see §3 for the full invocation taxonomy and caller-scoping. (Build order: the Phase 2 spine exercises the pull path first; autonomous triggering follows immediately, Phase 3.)
2. Read ClickUp via universal conventions: task description = checklist of steps; linked doc leaves = detailed/paste-ready guidance; parent chain = context (materials in parent; spec in parent's description; verification in the verification subtask).
3. Read two config inputs (also data, not code): the GLOBAL agent-rules doc (red-team, quality-first, never-invent-specs, self-critique against the task's leaf checklist, conventions, brand non-negotiables) and the invoking PERSON's agent-preferences doc.
4. Assemble → invoke model (routed by importance/sensitivity via the centralized model-invocation sub-workflow).
5. Post output back to ClickUp (material in parent; draft as comment; @-mention reviewer). Never auto-finalize.

All task-specific behaviour is DATA in ClickUp (checklist-in-description + doc leaves); n8n holds only the generic procedure + conventions. A named ~command is data in the same spirit: n8n keeps a command registry (`command_name` → ClickUp prompt-doc link/ID, plus optional metadata) and loads the command's prompt from its ClickUp doc at runtime — never hardcoded in n8n. Adding a capability = authoring a ClickUp checklist + leaf (and, for a named command, one registry row), not writing an agent. This is what scales to every process/person and to 10→100→1000 people with no per-process engineering. KM self-sufficiency is enforced intrinsically (the model sees only ClickUp), and the pipeline's genericity DEPENDS on structural discipline — which is why gap-detection is load-bearing. See the generic-pipeline ADR (ADR-015).

---

## 3. Invocation model

The agent is one generic pipeline (see Core model above), not a set of per-process
personas. Process-specific behaviour comes from ClickUp data; a named `~command`
resolves its prompt from a ClickUp doc via the command registry rather than from a
hardcoded persona. The same single mechanism serves every process and person.

- **Autonomous** invocations (webhooks, daily due-date producer) run only when
  the task's `Czy dla AI` field = `Tak`.
- **Explicit** invocations always work regardless of `Czy dla AI`:
  - `@`-mention of the agent (natural language) → `explicit_mention`
  - `~command` syntax (specific skill) → `explicit_command`
- **Conversation replies** continue an existing session.

Permissions are caller-scoped at two layers: prompt-level (Layer A) and the n8n
MCP gateway (Layer B). An invocation runs with the narrowed permissions of its
effective caller.

Output generation uses a single comprehensive prompt with internal critique
(not a multi-call Builder/Critic/Synthesizer loop), followed by a deterministic
Formatter skill for output structure.

For **due-date triggered** autonomous runs, caller is determined as:
1. Task assignee (primary)
2. Task creator (fallback)
3. Neither present → skip, log to Agent Errors

---

## Extension seams (reserved now, implementation deferred)

Two future capabilities are designed-for but NOT built. Seams are preserved so
they slot in additively. See the corresponding ADRs.

> **Note (2026-06-22):** the bare-lane seams below (`Invoke Model (v1)`, `model_routing`, the fallback
> seam) are no longer the hot path — they now power the **dormant failover lane** selected by
> `config.agent_lane='bare'`. The live default is the Managed Agents lane (see "Managed Agents spine —
> LIVE" after this section). They remain LIVE in the sense that they still work when the lane is selected.

- **Multi-provider routing (failover lane; PD-blind).** Model invocation is centralized behind
  `Invoke Model (v1)`; routing is data-driven via `model_routing (impact, modality)` — capability +
  modality only, no `personal_data`/EU axis (ADR-043, migration 021). `modality='text'` → Anthropic
  direct; `modality='multimodal_input'` → Vertex AI Gemini (flash/pro by tier, ADR-042); `modality='image'`
  → image-gen tiers. The `PD Verifier (v1)` seam was removed in Block 2 and the `personal_data`/`eu_only`
  columns + Bedrock-EU rows were dropped in **Block 3** (migration 021); the table collapsed to one row per
  `(impact, modality)`. Fail-safe preserved: DB-down falls back to `haxe-sonnet-4-6-direct` + WARN.

- **Unified model fallback seam (ADR-047; research + Invoke Model both LIVE 2026-06-13).** Fallback for any model is the
  model **one impact tier below, within the same modality**, derived from `REAL_TIERS =
  ['Niski','Średni','Wysoki','Krytycznie ważne']` — no `fallback_model` column (it would duplicate the
  tiering). Two new shared sub-workflows: `Resolve Lower Tier (v1)` (`GNO6ZsIcSpvYUJDq`, sole owner of the
  step-down) and `Call Model with Fallback (v1)` (`jBqu7znBIOMBF9HI`, a shape-agnostic try-primary-then-fallback
  mechanism with an optional `success_path` payload predicate; returns `{fell_back, model_used, body, headers}`;
  both-down throws → one CRITICAL). **Research** (`research-the-web`) now calls the seam on `/v1/messages` with
  `fallback_model = ResolveLowerTier(task_impact)` (so `Krytycznie ważne` research runs on Opus, not flaky
  Fable — fixes the intermittent research CRITICAL of execs 1868/1910); `decide-research` resolves the two
  research models via the helper and WARNs once if a round fell back; research keeps its leaf-based cost
  logging (ADR-035) but now prices each round against the **served** model. Also fixed a pre-existing defect:
  `Collect Research Results` (a multi-input leaf) was dropping `web_findings`; it now reads the research payload
  from its incoming item, so findings reach the caller. `Niski` stays on Haiku (the cheap-Gemini swap in the
  ADR was not taken — alias not provisioned in LiteLLM). **Invoke Model (ADR-047 Block B, LIVE 2026-06-13):**
  `Invoke Model (v1)` now routes **both** paths through the seam. Text → `Resolve Lower Tier Text` →
  `Call Model Text` (seam, `/v1/chat/completions`, `success_path` empty); on both-down the seam throws and the
  existing `Retry Text-Only` (Opus, images stripped) catches it as the floor safety net. Image → `Resolve Lower
  Tier Image` → `Lookup Fallback Image Prices` → `Call Model Image` (seam, `/v1/images/generations`,
  `success_path = data.0.b64_json` so a 2xx-with-no-image triggers fallback); both-down → `success:false`
  (image stays non-blocking, never a CRITICAL). This **amends ADR-037**: its hardcoded Opus fallback is now the
  top-tier case of one-tier-below (only `Krytycznie ważne`/Fable still lands on Opus). `fell_back_to_opus` was
  renamed to `fell_back` throughout. Image cost layering keys the token-math/per-image-floor backups off the
  **served** model (`Lookup Fallback Image Prices`), with the live cost header still authoritative. Resolved open
  item: `Wysoki` and `Krytycznie ważne` image both resolve to `gpt-image-2`, so one-tier-below gives no real image
  fallback at the top tier — accepted (a top-tier image-model outage yields `success:false`, non-blocking).

- **Multimodal I/O (input + image-gen pipelines LIVE, ADR-036/038/040).** Image attachments from ClickUp
  tasks pass as vision content blocks to the model; Docling extracts text from non-image files
  (PDF/DOCX/XLSX) into the prompt — a PDF therefore routes as `modality='text'` → Claude. Image *input*
  (`modality='multimodal_input'`) routes to **Vertex AI Gemini** for all tasks (the active multimodal
  route — flash for n/d/Niski/Średni, pro for Wysoki/Krytycznie; ADR-043 operator decision + ADR-042).
  Image *generation* providers provisioned & verified live (Block 8, ADR-036, migration 023):
  Niski/__default__ → Vertex `gemini-2.5-flash-image` (Nano Banana), Średni → `gemini-3-pro-image-preview`
  (Nano Banana Pro), Wysoki/Krytycznie → OpenAI `gpt-image-2`. The generation *pipeline* (invoke-image-model,
  resolver, comment_native delivery) is Phase B / Blocks 9–12 — **LIVE** (Phase B / Blocks 9–12 COMPLETE, 2026-06-13): generation folded into `Invoke Model (v1)`,
  `Image Resolver (v1)` walks the drafting model's output-block list (text / `embed_input` / `generate`), and
  Stage C delivers in-memory base64 images inline in the ClickUp comment. Every task now emits the block
  contract (full unification, Block 12); `embed_input` lets the agent place existing attachments inline.

---

## Managed Agents spine — LIVE (ADR-053 / ADR-055; cutover Block 9, 2026-06-22)

The agent system runs all tasks through **Anthropic Managed Agents** as the single orchestration lane
(hosted sandbox, tool loop, code execution, in-harness web search, office-document Skills, Files API).
The orchestrator selects Stage B by the **`config.agent_lane`** flag (`managed` | `bare`, default
**`managed`**; an unreadable/invalid flag fails safe to `bare` + a WARN). The bare LiteLLM lane
(`Execute LLM Call (v1)` + `Image Resolver (v1)`) is retained as the **dormant outage failover** (text +
image only — web research is in-harness now).

**Routing — impact → agent** (`agent_routing` table): Niski→Haiku, Średni→Sonnet, Wysoki→Opus,
**Krytycznie ważne→Opus** (repointed from Fable 5, which is gated behind Anthropic's "Fable Mythos" beta
access — the provider error directs callers to Opus 4.8; reversible when access is granted — ADR-053
amendment). Tools and skills are universal; a mis-set impact degrades to a wrong tier, not a missing
capability.

**Stage B (managed):** `Execute Agent Session (v1)` (resolve tier agent + persistent environment, upload
input images to the Files API, create/send the session, poll to idle, service the client-side custom-tool
loop — retained for ADR-054's future Google tool, dormant for image — and compute the session USD cost) →
`Render Agent Output (v1)` (consume the agent's structured `deliver_output` block array → `rendered_delta`
+ `image_manifest`, fetching produced-image bytes from the `agent-output-images` carrier) → `Post Reply (v1)` (text + inline
images + office-doc attachments). **Image generation** runs via the self-hosted **image MCP server**
(ADR-055: `Haxe Image MCP (v1)` → `Image MCP Tool Handler (v1)` → `Image Tool Handler (v1)` → `Generate
Images Parallel (v1)`); the client-side `generate_image` custom tool is the documented rollback.
**Generated-image bytes are embeddable in office documents (ADR-067):** `generate_image` returns, per
image, a `file_id` **and** a short-TTL (1h) signed `download_url` to the `agent-output-images` carrier
object. Inline rendering still uses `file_id`; to embed an image **inside** a `.pptx`/`.docx`/`.xlsx`/`.pdf`
the agent downloads the bytes from `download_url` into the session sandbox (sandbox egress to the carrier
verified GO, 2026-06-30) and embeds them — a `purpose=agent` Files-API upload is not downloadable, so a
`file_id` alone cannot be embedded. Persona contract `CONV=16`. Reliability: signing failure → `file_id`-only
+ an `image-tool/sign-failed` WARN (inline still renders); sandbox download failure → agent falls back to
vector visuals.

**Verified live across modalities** (Block 9): text, web research (in-harness, no n8n research workflows),
image generation (MCP → carrier → inline ClickUp image), image input / vision (Files API), and
office-document output (xlsx via a Skill → ClickUp attachment, attachment id recorded on `agent_runs`). One
session `agent_runs` cost row per run (plus per-image rows); `Log Model Run (v1)` keeps sole FX/PLN
ownership. The managed output adapter now consumes the agent's **structured `deliver_output` block array**
directly (ADR-063): the drafting model submits its final answer by *calling* the `deliver_output` custom
tool, the Anthropic API returns that input as validated parsed JSON (captured by `Execute Agent Session (v1)`
as `output_blocks` + `delivered_via_tool`), and `Render Agent Output (v1)` → *Parse Blocks* reads it with no
parsing or repair. The fragile free-text JSON contract and its hand-rolled `parseBlockArray` helper (fence
strip / preamble narrowing / schema-aware quote-and-control-char repair, ADR-059) are **deleted** —
structurally eliminating the routine, alert-less collapse of image/doc comments to plain text. The only
remaining fallback fires a loud `output-adapter/no-deliver-output` WARN and text-renders `output_message`
when the agent did not call the tool (a protocol violation, never a silent drop). The bare lane has the same
treatment (ADR-063 Block 4): `Invoke Model (v1)` forces a `deliver_output` tool call on the LiteLLM
`/v1/chat/completions` completion (`tool_choice`), `Parse Response` captures the block array from
`message.tool_calls[].function.arguments` (the provider serializes the tool input as validated JSON — one
`JSON.parse`, no hand-repair), and `Image Resolver (v1)` → *Resolve & Explode Blocks* consumes it directly;
the bare lane's `parseBlockArray` twin **and** `Execute LLM Call (v1)`'s tolerant `Parse Output Blocks` node
are **deleted**, with the same loud `multimodal/no-deliver-output` WARN + text fallback. The adapter also supports `embed_input` (re-embedding an image already attached to the task)
by resolving the agent's attachment ref against the input image refs into a `{type:attachment}` op inline —
no re-upload, mirroring the bare lane. **Cutover: DONE and LIVE (ADR-063 Block 5, 2026-06-27).** All five
workflows (`render-agent-output.json`, `agent-orchestrator.json`, `invoke-model.json`, `execute-llm-call.json`,
`image-resolver.json`) are deployed, and the persona output-format contract was flipped from the free-text JSON
block-array to *"call `deliver_output`"* in `sync-agent-definitions.json → Build System` (CONV 13→14), re-synced
to all agents (version 19). **Amendment (2026-06-27, CONV 14→15, agents v19→v20):** Sonnet sometimes calls
`deliver_output` with `blocks` as a **JSON string** (`{"blocks":"[…]"}`) rather than an array — valid JSON, wrong
shape — which both lane capture points (`Poll Round` managed, `Parse Response` bare) read as empty, producing a
**silent empty comment** (real task `869dwgmfb`). Both capture points now coerce a string `blocks` to an array,
`Build Final Output` fires a loud `output-adapter/deliver-output-empty` WARN on a delivered-but-empty result, and
the `blocks` description gained the steer *"Przekaż blocks jako tablicę JSON, nie jako string."* (both lanes).
Verified end-to-end on a realistic image+document task (managed lane, full spine):
the agent called `deliver_output`, returned structured `output_blocks` (text + `mode:generate` image + `doc`),
`outcome=delivered`, render produced an inline image manifest with **zero** warnings, and Post Reply posted the
threaded comment with the inline image and the `Analiza_produktu.xlsx` attachment — **no `parse-fallback` path
exists to take, and zero alerts fired**. (The forced-tool-call round-trip was also verified live against LiteLLM
for the bare lane; note the bare lane's upstream `ANTHROPIC_API_KEY` in the VPS `.env` is currently stale — all
`haxe-*-direct` Claude models 401 — and must be refreshed before any bare-lane go-live. The dormant bare lane
masks this today; the managed lane uses separate Anthropic Agent API creds and is unaffected.) **Doc-block note:**
the renderer **skips** `doc` blocks — office docs attach via the authoritative `doc_files[]` enumeration
(`Execute Agent Session → Build Final Output` → orchestrator → Post Reply), so a produced document is never
dropped; the `doc` block is an optional placement/caption marker whose ordering is **not yet honored** (ADR-063
documents this as deferred). **Amendment 2 (2026-06-27):** a second silent drop lived in the orchestrator's
`Session OK?` gate, which tested only `output_message` (the agent's free-text trailing message). Under
`deliver_output` that field is empty whenever the agent delivers cleanly via the tool with no chatter (the
normal path) — so a valid answer sitting in `output_blocks` was discarded with a `agent-orchestrator/managed-session`
"no content to publish" WARN and **no reply posted** (real task `869dwjc4a`, session exec 4730). **Amendment 3 —
ADR-066 Block 1 fail-loud guard (2026-06-30):** the `Session OK?` gate was re-cut to discriminate on `outcome`, not
text presence. It now passes **only** for a publishable answer: (`delivered_via_tool` AND `output_blocks` non-empty)
**OR** (`outcome === 'done'` AND `output_message` non-empty). A non-delivery outcome (`deadline` / `terminated` /
`max_rounds` / `poll_error` / `send_failed` / `create_failed`, or a `delivered` with an empty block array) is FALSE
**even when `output_message` carries the agent's mid-work narration** — closing the 2026-06-30 pptx-run failure where
a deadline's narration was published as the answer. The FALSE branch now posts a Polish incomplete-status notice via
the new **`Call Post Reply (Incomplete)`** (flips status off "W trakcie" to Zakończono; surface-aware — passes
`surface`/`surface_ref` and carries the message in both `rendered_delta` and `completion` so a chat non-delivery is
delivered to chat) and fires a **CRITICAL `managed-agents/non-delivery`** alert (the repurposed former `Alert Session
Empty` → `Alert Non-Delivery`). `output_message` is **never** rendered as the deliverable on this path. The legit
degrade-to-text path (`outcome === 'done'` + free text → existing `output-adapter/no-deliver-output` WARN) is kept.
Verified end-to-end (2026-06-30, temporary 20 s deadline): a `deadline` run and a `delivered`-empty run each posted
the canned notice (no narration), flipped status, fired CRITICAL; a normal `done`+free-text run still published.
File: `agent-orchestrator.json` (`Session OK?`, `Alert Non-Delivery`, `Call Post Reply (Incomplete)`).

**Reliability:** an auth dead-man's-switch (`Managed Agents Auth Monitor (v1)`), the CU-rules sync +
freshness dead-man's-switch (`Sync Agent Definitions (v1)` / `Agent Rules Freshness Check (v1)`), and the
image-MCP health monitor (`Image MCP Health Monitor (v1)`), all every 6h via `Post Alert (v1)`. The
freshness check's `>24h` liveness branch reads `agent_routing.synced_at` as a heartbeat, so the sync's
idempotent **skip** path (the normal steady state when the doc is unchanged) also stamps `synced_at = now()`
via its `Touch Checked` node — not only the writeback path. Without that, a doc stable for >24h left
`synced_at` ageing and produced a false "sync nie wykonał się od ponad 24h" WARN every 6h even while sync
ran fine and content matched; `synced_at` now means "last time sync confirmed agents current" (actual
rewrites are still tracked by `agent_version` + Anthropic's version history).

**ADR-054 — permission-scoped context retrieval (built + cutover landed 2026-06-24 — ClickUp-only:
caller-scoped discovery + as-U attachment extraction live; scope-correctness gate passed).** The direction: the managed agent gathers context **under the triggering user's identity, enforced
by n8n at the executor** (scope lives in the credential, never trusted to the agent). This build is **scoped
to ClickUp only** (operator decision 2026-06-22); Google (Drive + Gmail) is deferred to a follow-up ADR.
**Architecture locked to Option A** after three live probes proved the tokens are not interchangeable: ClickUp's
hosted MCP is its *own* OAuth 2.1 server and rejects classic-app tokens; the MCP-issued token is in turn 401 on
ClickUp REST; and n8n cannot read a harness-injected bearer. So each user holds **two** non-expiring ClickUp
tokens from two OAuth servers: (1) an **MCP-OAuth token** for *discovery* (held as a `static_bearer` in a
**per-user** Anthropic Vault — one vault per user, since credentials are keyed by `mcp_server_url`; a session
attaches only the triggering user's vault, scoping every hosted-MCP call to what that human can see), and (2) a
**classic REST token** for *identity + Block-4 as-U extraction* (the hosted MCP returns no attachment content),
held in **Supabase Vault** and read back by `caller_user_id`. **Built (Block 1):** the credential store —
`user_data_and_config` (migration 039 as `user_clickup_credentials`; **renamed in migration 047** and
extended with `daily_spend_limit_pln` for ADR-064 per-user spend caps — it now holds per-user data *and*
config, not credentials only; RLS-enabled); the OAuth app-secret getter `get_clickup_oauth_app()`
(migration 040); a CSRF-state table extended for the second consent (migrations 041 + 043, the latter adding the
PKCE verifier / DCR client_id / carried identity for the MCP phase); the REST-token store + getter
`set_clickup_rest_token()` / `get_clickup_rest_token()` (migration 042, Supabase Vault); and a **self-serve
hosted consent flow** — the n8n workflow `ClickUp OAuth Onboarding (v1)` (`FKfVEyB62swT2FFN`), which **chains
both consents in one link**: `/webhook/clickup-oauth-start` → classic consent → `/webhook/clickup-oauth-callback`
(exchange code, identify user via REST `GET /user`, store the REST token in Supabase Vault) → DCR + PKCE →
hosted-MCP consent → `/webhook/clickup-mcp-callback` (exchange, create the per-user Anthropic Vault +
`static_bearer` MCP credential, upsert the mapping row). A local-loopback script
(`scripts/onboard-clickup-user.mjs`) is retained as a dev fallback. ClickUp OAuth tokens don't expire (no refresh
machinery). **Built (Block 2 — session-to-user binding, 2026-06-23):** `Execute Agent Session (v1)` now resolves
the triggering `caller_user_id` → that user's per-user ClickUp Vault id (the `Resolve Agent` query joins
`user_data_and_config` on status `active`) and attaches it to the session's `vault_ids` alongside the
image-MCP vault (`Build Setup` → `Create Session`). The binding is set by n8n from `caller_user_id` only, so the
agent cannot spoof whose scope it runs under. An un-onboarded caller **degrades, not breaks**: the ClickUp vault
is simply omitted (`clickup_scope: 'degraded'`) and one consolidated WARN (`managed-agents/clickup-scope-degraded`)
fires through the existing `Post Alert (v1)` seam, while the run still proceeds on deterministic pre-gather.
Verified live both ways (onboarded session's `vault_ids` carries the user's vault; un-onboarded session is
image-vault-only + exactly one WARN; both sessions create and complete). **Built (Block 3a — scoped discovery
live, 2026-06-23):** `Sync Agent Definitions (v1)` now registers the hosted ClickUp MCP (`mcp.clickup.com/mcp`,
`{type:"url"}`) + a paired **READ-ONLY `mcp_toolset` allowlist** (14 read/discovery tools, each with its own
`always_allow` — the API defaults `default_config` to `always_ask`, so the per-tool grant is load-bearing;
`default_config.enabled:false` blocks every write tool, since ClickUp OAuth has no read-only scope so read-only
is enforced in software) + Polish discovery steering on the **3 routed tier agents** (Haiku/Sonnet/Opus) at
`CONV=5`. (The "4 tier agents" of earlier planning is now 3 distinct model agents: the critical tier
`Krytycznie ważne` routes to **Opus**, not the un-routed **orphan** `Haxe Agent — Fable` — flagged for cleanup,
harmless.) The managed-lane Poll Round now treats a ClickUp MCP `mcp_authentication_failed_error` as
**NON-fatal** — the run degrades and completes rather than `terminate`-ing; a mid-run WARN fires **only** for an
onboarded user whose scope genuinely fails (`clickup_scope==='scoped'`), suppressed for un-onboarded (Block 2
already WARNs). A `ClickUp MCP Health Monitor (v1)` (`hrtNkFFL4iMVn9J9`) dead-man's-switch probes the hosted
endpoint every 6h (`/.well-known/oauth-authorization-server`; 2xx healthy, else CRITICAL). **Verified live:** an
onboarded run performed in-harness scoped discovery (the agent called `clickup_get_workspace_hierarchy` and
returned the caller's real Spaces, `status:completed`, 0 warnings); an un-onboarded run completed cleanly
(`outcome:done`, not terminated) with exactly one WARN; Alerts 0 CRITICAL / 1 expected WARN. **Built (Block 3b —
software filter retired, 2026-06-23):** now that scoped discovery is proven live, the open-ended search-as-bot
path **and** the `Check Space Member` post-hoc membership filter (the ADR-054 R3 violation) are removed from
`Assemble Task Context (v1)`. The sub-workflow went from 36 nodes to **12**: dropped query extraction (Haiku),
ClickUp task search, the `Space Loop`/`Check Space Member`/`Layer B Filter` membership gate, the artifact
read-back, and the selective-condense Haiku pass. It now fetches **only the triggering task's own comments +
threaded replies** on the bot token (U already has access — no cross-department leak) and returns the
**unchanged** `{task_comments, additional_context, sources_used, sources_filtered_out}` contract with
`additional_context` always `''`, so `assemble-context` callers don't break. Open-ended related-context
discovery is now entirely the agent's in-harness, per-user-scoped ClickUp MCP (Block 3a). **Verified live:**
driving `Assemble Task Context (v1)` on a disposable task returned the top-level comment + interleaved threaded reply
with `additional_context` empty; the full Stage A (`Assemble Context and Build Prompt (v1)`) reported
`workspace_search_ok: true` with the comments in the built prompt and **no** "Dodatkowy kontekst" search section;
0 CRITICAL / 0 WARN. **Built (Block 4 — as-U attachment extraction live, 2026-06-23):** the agent can now pull a
discovered task's **attachment content** (document text + images) under the caller's own permissions, via a
client-side custom tool on the retained `Execute Agent Session` loop (the hosted MCP returns task text but **no
attachment content**, and n8n cannot read the harness-injected discovery bearer — so extraction must run where
n8n knows `caller_user_id`). **Block 4a:** `Read Input (v1)` gained an as-U fetch mode — a new `as_user_token`
input routes through an **As User?** IF to a **Get Task (as U)** node that sets `Authorization: <raw OAuth
token>` (no predefined credential, so **no bot fallback**); an out-of-scope/denied fetch (401/403/404) routes to
**Build Access Denied** (a `clickup-asU/access-denied` warning, never the bot's view). The bot path is unchanged
when no token is supplied (Stage-A pre-gather + the Form-Trigger harness bypass the IF). **Block 4b:** a new
sub-workflow **`ClickUp Extract Tool Handler (v1)`** (`y985MgyA5lCxOFCH`) reads the caller's classic REST token
from Supabase Vault (`get_clickup_rest_token(caller_user_id)`), runs Read Input **as U** on the requested task
id, uploads any extracted images to the Files API (reusing `Upload Input Images (v1)`), and returns a
`user.custom_tool_result` content array (document text + image `file_id` blocks the agent **sees** via vision).
`Execute Agent Session (v1)` routes a pending `extract_clickup_task` custom tool (a new `Is extract_clickup_task?`
branch beside the dormant image branch) to the handler; `Post Tool Result` posts the content array verbatim. The
`extract_clickup_task` tool + inspect-then-extract steering are registered on the 3 routed agents via
`Sync Agent Definitions (v1)` (`CONV=6`). Token-presence guard: an un-onboarded caller gets an "unavailable"
tool result (no extraction), WARNing only when the user **has** discovery but is **missing** the REST token
(half-onboarded). The handler sets `saveDataSuccessExecution:none` so the REST token is not persisted in its
execution data. Delivered images are filtered to vision-supported raster formats (png/jpeg/gif/webp). **Verified
live (end-to-end):** an agent driven as the onboarded user called `extract_clickup_task` on a disposable task
holding a text note + a green PNG, and correctly reported **both** the secret marker from the document text
**and** the image colour ("zielony") — `status:completed`, 0 warnings; the access-denied mechanism is proven by
Block 4a (a bogus token → ClickUp 401 → access-denied, not the bot's blocks). **Known limitation:** a *corrupt*
source raster image still terminates the session (Managed Agents `"Could not process image"` is a terminal
error — a pre-existing fragility shared with the input-image path; the mime filter catches bad *formats*, not
corruption). **Residual:** Read Input's own success executions still record the `as_user_token` input — a
log-hygiene follow-up. **Built (Block 5 — scope-correctness gate passed, 2026-06-24):** the mandatory
cross-department negative matrix ran across **both** paths with two real cross-dept users (Patryk Marzec /
Marketing `2604220`; Beniamin Gawlik / Purchasing `8722303`). Discovery: an agent driven as Patryk cannot see
Purchasing data — the hosted MCP returns only his 3 Spaces (enforcement on the credential, not the model).
Extraction: `ClickUp Extract Tool Handler (v1)` driven as Patryk on an out-of-scope Purchasing task id returns
`denied` + a `managed-agents/extract-access-denied` audit WARN. A mis-mapped credential fails **loud**
(a bogus `vault_id` → `sessions.create` HTTP 400 → the `Create Session` CRITICAL path; there is **no** broad
fallback, since Block 3b retired the bot path) — "silently broad" is architecturally precluded, not merely
tested. See `block-5-findings.md`. **Built (Block 6 — cutover landed, 2026-06-24):** the per-user-scoped path
is the live default for the managed lane (it has been since Block 3a — there was no flag to flip, so cutover is
the documentation/ops reconciliation, not a switch). **Onboarding (operator-gated, browser consent):** 3 of 5
members onboarded for discovery (Franciszek/CEO, Patryk, Beniamin); REST/extraction tokens for 2 (Franciszek,
Patryk — Beniamin is discovery-only / half-onboarded). Onboarding the remaining members runs via
`scripts/onboard-clickup-mcp-user.mjs` (discovery) + `scripts/onboard-clickup-rest-token.mjs` (extraction),
one browser consent each. **Rollback (reconciled — the plan's "config flag → bot-only" is moot):** Block 3b
deleted the bot-broad path, so there is nothing bot-broad to revert to. Two existing levers cover incident
rollback: the **whole-lane** switch `config.agent_lane='bare'` (reverts to the LiteLLM gateway lane, which has
no managed-lane scoped tools at all — fast/nuclear, but drops images/Skills/web-search), and a **targeted**
re-run of `Sync Agent Definitions (v1)` with ClickUp removed (CONV bump → every managed user degrades to the
proven deterministic-pre-gather floor). No dedicated scoping flag was built (operator decision 2026-06-24 — a
new code path is unjustified for a 5-person system already covered by two proven levers). **Revoke ops:** revoke
= delete the user's Anthropic Vault credential/vault + delete the Supabase REST token (`clickup_rest_token_<id>`)
+ flip the `user_data_and_config` row to `revoked`; the next session then degrades + WARNs (the proven Block-2
path). Documented as a runbook; no revoke script built (operator decision 2026-06-24). **Proactive onboarding-coverage dead-man's-switch (built 2026-06-24):**
`ClickUp Onboarding Coverage Monitor (v1)` (`0hj3LDSEe1R3JJ5w`) runs weekly (Mon 08:00 Europe/Warsaw) and WARNs
via `Post Alert (v1)` for any ClickUp member who is (1) a **full member** (`role_key` owner/admin/member — guests
and `limited_member` excluded), (2) **active in the last 30 days** (ClickUp's `last_active`), and (3) **missing
either** per-user token (MCP discovery and/or REST extraction), naming which token each person lacks; the agent
bot account is hard-excluded. It reads onboarding state via `get_clickup_onboarding_state()` (migration 044,
SECURITY DEFINER, ids only — never token values). This catches a member who would otherwise be silently
un-scoped, since the per-session degrade WARN (Block 2/3a) only fires once they actually trigger the agent. Note
`last_active` reflects any ClickUp activity, not comment-posting specifically (ClickUp exposes no per-user comment
history without the Enterprise audit log); an exact comment-activity signal would require capturing
`taskCommentPosted` events into a table, deferred. **Deliberately NOT built** (operator decision 2026-06-24): the
revoke script and the rollback scoping flag (revoke is a runbook; rollback uses the two existing levers above).
**Google deferred** to a
follow-up ADR (Drive + Gmail per-user scoping out of scope). Per-block build history:
`architecture/Build plans/adr-054-clickup-scoped-retrieval/`.

Per-block build history: `architecture/Build plans/adr-053-managed-agents/` (`master-plan.md` +
`block-*-findings.md`).

## 4. The learning system

Two parallel feedback systems with identical machinery, different subject:

### 4.1 Artifacts (Tier 0)
- `agent_runs` — one row per agent execution (context, trigger, model, cost, status).
  Also the **erasure hub** (ADR-044, migration 022): nullable `subject_key` (the
  channel-natural counterparty id, populated only once the email channel is wired),
  `clickup_comment_id` (the id of the comment the run posted — recorded live by
  Post-back's `Record Artifact`), and a reserved `drive_file_id`. Nothing reads
  `subject_key` yet; the schema is ready at zero behavioral cost.
  **Observability (migration 025, ADR-036 Block 10):** nullable `run_payload_bytes` (UTF-8 byte
  size of the delivered payload — rendered comment + any image base64 — written once per delivering
  run by `Record Artifact`, for text and image runs alike; a **proxy + lower bound** for n8n
  execution-data weight, true ≈ this × nodes traversed; null if the run failed before delivery) and
  `n8n_execution_id` (the run's n8n execution id, for exact-size backfill + run→execution debugging).
- `agent_run_evaluations` — append-only threaded human feedback on a given
  output. Each row = one timestamped contribution carrying an optional thumbs
  rating and/or comment. Same user may appear many times; current stance = their
  most recent row. The GM agent's verdicts appear here too (commenter
  `gm_agent`).

### 4.2 Proposals (Tier 1+)
- `agent_proposals` — structured process-change proposals. Self-referencing to
  support recursive tiers:
  - **Tier 1 (`artifact`)** — synthesizes `agent_run_evaluations`; sets
    `source_agent_run_id`.
  - **Tier 2+ (`meta`)** — synthesizes other proposals' evaluations; sets
    `source_proposal_id` (self-reference). Depth is unbounded.
  - Broad synthesis (many sources, no single parent) — both FKs null;
    `proposal_tier` still records the kind.
- `agent_proposal_evaluations` — append-only threaded human feedback on a
  proposal. Same shape as `agent_run_evaluations`.

### 4.3 What is NOT stored (derived instead)
- **Acceptance status** — there is no `evaluation_status` column. Whether a
  proposal was accepted/rejected/contested is derived by the GM agent from the
  evaluation thread at analysis time. The GM agent records its verdict as a
  `gm_agent` row in the thread, so its decision is part of the same record it
  analyses (enabling recursive self-reflection on its own past calls).
- **Application tracking** — there is no `applied` column. Implementing an
  accepted change leaves no trace in any thread and would require unreliable
  manual marking; an unmaintained status field misleads. Failure to implement
  surfaces naturally as recurring patterns in artifact evaluations (a culture
  signal, not a schema concern).

### 4.4 Activation policy
The schema permits unbounded recursion; the workflow gates it. Tier-1 proposing
runs on the weekly cadence (manual per-task proposing via `~zaproponuj-zmiane-procesu`
only). Meta-analysis (Tier 2) runs monthly/quarterly once enough Tier-1 volume
exists. Tier 3+ is rare and human-triggered. This avoids navel-gazing
("turtles all the way up").

---

## KM maintenance — human-only edits; AI proposes, monitors, nudges

A chief goal of the system is to monitor and maintain the quality and scope of the internal KM system (docs cascade with paste-ready leaves + Why-toggles; templates with checklist-in-description + doc-links + self-links; rules). AI never edits the KM system — humans are the sole writers; AI is proposer + monitor + nudger only (preserves ownership, deliberate friction, anti-bloat).

Loop: (1) exercise — every run consumes leaves; heavy correction ⟺ deficient leaf; (2) propose — runs/evaluator emit Tier-1/2/3 proposals into Supabase; (3) human curates + implements the leaf edit themselves; (4) measure implementation — a logs column records whether a doc/description edit occurred within ~20–60 min of acceptance, and (conditionally) whether it corresponds to the accepted proposal (lightweight-model diff-compare IF the ClickUp API exposes diffs; else timestamp-only); (5) nudge — the evaluator/GM agent surfaces accepted-but-unimplemented proposals + gap-audit findings. Gap-detection: a periodic KM-audit flags missing Why-toggles, dead/empty links, undocumented processes, stale leaves — proposes, never fixes. Why-toggles are a Chesterton's-fence guardrail, required on contested/judgment rules.

Abandoned: AI write-back to docs; self-sufficiency as a separate probe; compounding-by-correlation (insufficient n). This whole layer is DEFERRED until the generic pipeline is proven end-to-end. See ADR-016.

---

## 5. Database

Supabase (eu-west-1, Ireland). Seven live tables, plus two added by migrations 002/003
(decided in ADR-024, **applied 2026-06-03**). Authoritative DDL: `supabase/migrations/`.
Note: architecture originally specified eu-central-1 (Frankfurt); the live project is
eu-west-1 (Ireland). Both are EU/GDPR-compliant; this is a documentation correction, not
a data location change.

- `agent_runs`, `agent_run_evaluations`
- `agent_proposals`, `agent_proposal_evaluations`
- `conversation_sessions` (mutable working state; expired, not deleted, after 24h idle)
- `email_sends` (Gmail audit)
- `schema_migrations`
- `model_routing` (migration 002, ADR-024) — data-driven routing: impact → LiteLLM
  model alias + temperature + max_tokens + nudge + USD token prices; a `__default__`
  row is the fail-safe. Replaces the in-n8n routing table of ADR-023.
- `fx_rates` (migration 003, ADR-024) — daily USD/PLN from the NBP Web API (official
  Polish rate); `cost_pln = usd_cost × latest fx`. Token counts come exact from the
  LiteLLM gateway.

> Repo gap (ADR-024): `001_initial_schema.sql` is applied to the live DB but was
> never committed (only `.gitkeep`). It must be back-filled from the live schema so
> `supabase/migrations/` reflects reality.

> Migration `004_agent_runs_importance_check.sql` (2026-06-08, **applied**) realigns the
> `agent_runs.importance` CHECK from the stale English `Low/Medium/High` set to the live
> 5-level Polish taxonomy. Before it, a run on a real impact tier failed the `agent_runs`
> insert (run still returned + WARN, but cost wasn't logged) — found via fault injection;
> now fixed.

> Migrations `005` (rename `agent_runs.importance` → `impact`, **applied**) and `007`
> (enable RLS on all 9 tables, no policies, **applied** — ADR-028) landed 2026-06-08.
> RLS closes the PostgREST "Unrestricted" exposure; the pipeline's `postgres` role bypasses
> RLS so it's unaffected (verified). `agent_runs` now also populates `caller_user_id` and
> `process_type`.

> Migration `008_model_routing_composite.sql` (2026-06-08, **applied**) restructures
> `model_routing` to a composite PK `(impact, personal_data)` and seeds all 12 routing
> rows: 6 impact tiers × 2 `personal_data` values (`false` → Anthropic direct,
> `true` → Bedrock EU). Versioned aliases replace the old unversioned names (ADR-030).

> Migration `009_triggered_by_search_step.sql` (2026-06-08, **applied**) adds
> `search_step` to the `agent_runs.triggered_by` CHECK (ADR-031).

> Migration `010_model_routing_nullable_temperature.sql` (**applied**) allows NULL `temperature` for
> models that don't support the parameter. Sets `temperature=null` for `haxe-opus-4-8-direct`
> (Opus 4.8 deprecated the parameter 2026-06-08).

> Migration `011_research_parameters.sql` (**applied**, ADR-035) adds the `research_parameters` table
> keyed by `impact`: `max_research_rounds` and `tavily_max_results` knobs for the agentic web-search
> loop (Model Turn v1). Separate from `model_routing` — research effort scales with importance only,
> not GDPR routing.

> Migrations `012_multimodal_image_tiers.sql` then `013_image_tiers_match_clickup.sql` (**applied in that
> order**, ADR-036): extend `model_routing` with `modality`, `eu_only`, `fallback_price_per_unit` columns;
> add `image_gen_params` and `config` tables; seed image generation routes (Stability/Vertex AI/DALL-E 3
> tiers). Migration 013 promotes the PK to `(impact, personal_data, modality)`, rekeys image rows from
> English to Polish impact names (was `low/medium/high`, now matches ClickUp field values), and adds
> `Krytycznie ważne` and `__default__` image rows. Also adds `image_gen` to `agent_runs.triggered_by`.

> ⚠ **Migration naming conflict:** Two files share the `013_` prefix (`013_gemini_multimodal_routing.sql`
> and `013_image_tiers_match_clickup.sql`), produced in separate build sessions. The `013_image_tiers…`
> file is the one applied above. The `013_gemini_multimodal_routing.sql` file must be **renamed to
> `014_gemini_multimodal_routing.sql`** before application — see below.

> Migration `014_gemini_multimodal_routing.sql` (pending rename + application; ADR-038): drops the
> `(impact, modality)` partial unique index (`model_routing_impact_modality_key`) and recreates it as
> `model_routing_non_text_unique` on `(impact, modality, personal_data) WHERE modality != 'text'`; seeds
> 8 `multimodal_input` rows — 4 GDPR (Gemini EU, `personal_data=true`) + 4 non-GDPR (Anthropic direct,
> `personal_data=false`). Apply AFTER `013_image_tiers_match_clickup.sql`.

> **Block 1 — repo↔live re-sync + targeted fixes (2026-06-11, ADR-043/044).** The repo
> `n8n/workflows/*.json` were re-baselined against the running graph (ADR-038's multimodal deploy had
> never been exported). Drift was **bidirectional** — see `architecture/workflow-repo-live-reconciliation.md`
> for the per-workflow tracker (what is reconciled vs deferred to Block 2). Behaviour changes landed this
> block (not behaviour-neutral): **(1)** invoke-model fix-forward — multimodal request now built as a
> `messages` content-array in Resolve Routing and reused by the Opus fallback, so **images are preserved
> on fallback** (live previously dropped them); modality routing + a Gemini provider label retained.
> **(2)** execute-llm-call return path made a single branch-free terminal (`Return LLM Result` sole leaf;
> cost-sync funnels into it) — fixes a non-deterministic sub-workflow return that intermittently dropped
> the answer and posted no reply. **(3)** Data hotfix: `model_routing` `temperature` set NULL for the
> `Krytycznie ważne` × `multimodal_input` Fable 5 row (Fable 5 now rejects `temperature` → 400); the
> `text` row was already NULL. Codified as **migration `015_fable5_multimodal_temperature_null.sql`**
> (so the migrations stay the source of truth, not a forward-note); Block 3's routing migration (landed as
> `021`) preserved `temperature = NULL` for that row (the `text` Fable 5 row survives; the `multimodal_input`
> Fable 5 row was replaced by Gemini Pro). The `personal_data`/EU apparatus removal itself is
> still pending (Blocks 2–3).

> **Block 2 — strip PD plumbing, behaviour-neutral (2026-06-11, ADR-043).** The `PD Verifier (v1)`
> sub-workflow (`hzwmak7UBpuHaiTO`) was **deleted** (workflow + repo file), and `personal_data` is no
> longer threaded through context assembly, workspace search, or the research gate: removed from
> `assemble-context` (the `Call PD Verifier` node + rewire `Assemble Parent Context → Assemble Task Context`, the
> `personal_data` mappings to Assemble Task Context/Decide-Research, the `personal_data`/`pd_verifier_ok` outputs of
> `Build Prompt`, the `r4` rule + `pd_verifier=` token of the context-health check), `assemble-task-context`
> (input + both Invoke-Model mappings), `decide-research` (input, gate `model_override` and research
> fallback hard-set to the non-PD `-direct` aliases, gate mapping), `execute-llm-call` and
> `agent-orchestrator` (the `personal_data` passthrough). `fable-access-monitor`'s runbook SQL dropped
> `AND personal_data=false`. **Behaviour-neutral:** the PD verifier was a stub always returning `false`,
> and every surviving consumer that still sees `personal_data` (Invoke Model's `Lookup Routing`, decide-
> research's `Lookup Research Routing`) guards with `=== true`, so an absent value resolves to `false` =
> today's routing. **Deliberately left for Block 3:** the routing-row selection itself — `Invoke Model`
> and `Lookup Research Routing` still carry `personal_data = $2` in SQL (inert; resolves `false`), and the
> `model_routing` `personal_data`/`eu_only` columns + Gemini-EU rows remain. Verified end-to-end: a
> `multimodal_input` smoke task routed unchanged to `haxe-gemini-flash-eu`, vision intact, reply posted,
> no `personal_data`/`pd_verifier_ok` in the Build-Prompt output, no alerts. Re-exported all six edited
> workflows; `check-workflow-drift.mjs` reports all 17 match live (assemble-context + agent-orchestrator
> reconciled — they already carried the ADR-038 context-health/modality work).

> **Block 3 — routing cutover to PD-blind global (2026-06-11, ADR-043/042).** `model_routing` collapsed
> to one row per `(impact, modality)` via migration `021_global_model_routing.sql`: dropped the Bedrock-EU
> `text` rows and the Claude `multimodal_input` rows, **kept Gemini as the active multimodal route**
> (operator decision — this *inverts* ADR-043's original "keep Claude, Gemini stays dormant" line; see the
> ADR-043 Update note), renamed the Gemini aliases `-eu`→none (now global, not EU-pinned), re-keyed the PK
> `(impact, personal_data, modality)` → `(impact, modality)`, and dropped the `personal_data`/`eu_only`
> columns + the now-redundant `model_routing_non_text_unique` index. Result: 16 rows — 6 `text` (Claude
> direct), 5 `image` (gen tiers), 5 `multimodal_input` (Gemini flash×3 / pro×2 per ADR-042). Workflows made
> PD-blind: `Invoke Model` (`Lookup Routing` filter + queryReplacement, `Fallback to Opus`/`fbAlias` →
> literal `haxe-opus-4-8-direct`, provider/price logic, `When Called` input) and `decide-research`
> (`Lookup Research Routing`). LiteLLM deployed in **two passes** for a zero-gap cutover: (1) additive — new
> `haxe-gemini-flash`/`-pro` aliases added alongside the `-eu` ones; (2) after the migration repointed the
> rows — cleanup removing the `-eu` Gemini aliases + the three `*-bedrock` aliases. Verified: the live
> PD-blind query returns exactly one correct row per `(impact, modality)` across all tiers; an image smoke
> (task 869dm1z8y) routed to `haxe-gemini-flash`, vision correct, threaded reply posted, no degradation,
> zero alerts on the clean run. Bedrock EU is now unused (AWS creds in `.env` are dead — a deployment
> cleanup, intentionally not done here).

> **Block 4 — erasure schema readiness + artifact recording (2026-06-11, ADR-044).** Migration
> `022_agent_runs_erasure_ready.sql` adds three nullable `text` columns to `agent_runs` —
> `subject_key` (partial-indexed `where subject_key is not null`), `clickup_comment_id`,
> `drive_file_id` — making `agent_runs` the **erasure hub** at zero behavioral risk (nothing reads
> or writes `subject_key`/`drive_file_id`; the pipeline stays PD-blind). `Post Reply (v1)` gains a
> `Record Artifact` Postgres node on a **side branch off `Set Status Zakończono` success**: it writes
> the just-posted ClickUp comment id onto the task's latest `agent_runs` row (`order by id desc`),
> via a CTE that always returns one row (`target_id`, `updated 0/1`) so a 0-row write is detectable,
> not a silent drop → `Recorded?` IF fires a WARN (`post-reply/record-artifact`) on miss/error. The
> WARN posts to the Alerts task (disjoint from the answer task → no webhook loop) and never blocks
> reply/status. Referential audit (report-only, no FKs/cascades added): PD-capable stores either FK
> `agent_runs` (`email_sends.agent_run_id` **nullable, no cascade**; `agent_run_evaluations` **ON
> DELETE CASCADE**; `agent_proposals.source_agent_run_id` nullable; `agent_proposal_evaluations`
> transitive) or — `conversation_sessions` — link only by `clickup_task_id`/`comment_root_id` text
> (**no FK back**). Retention + lawful-basis posture is recorded in `compliance/gdpr-processing-decisions.md`.

> **Block 8 — image-gen providers refreshed (2026-06-12, ADR-036).** Migration
> `023_image_gen_block8_providers.sql` repoints the five `modality='image'` rows off the dated/dead seeds
> (SD3.5 / Imagen@006 / dall-e-3 — Imagen shutting down ~2026-06-24, dall-e-3 deprecated) to the live map:
> Niski/__default__ → `vertex_ai/gemini-2.5-flash-image`, Średni → `vertex_ai/gemini-3-pro-image-preview`,
> Wysoki/Krytycznie → `openai/gpt-image-2`; and sets a static `fallback_price_per_unit` floor per row
> (0.038703 / 0.134422 / 0.210805 USD, live-measured). PK/columns unchanged (no `personal_data`/`eu_only`).
> All three verified live through the LiteLLM gateway with accurate cost headers. The generation *pipeline*
> (Blocks 9–12) is still unbuilt — these rows have no caller yet.

> **Block 9 — image token prices filled (2026-06-12, ADR-036/045).** Migration `024_image_token_prices.sql`
> UPDATEs the five `modality='image'` rows' `price_out_usd_per_1k` (flash 0.030 / pro 0.120 / gpt-image-2
> 0.030 — each = Block 8's measured cost ÷ output tokens) + a small `price_in` backup, so the **shared cost
> path (Log Model Run) prices an image by token-math identically to text** when the live header is absent
> (header still primary; `fallback_price_per_unit` is the last-resort floor). PK/columns unchanged. This is
> the data half of Block 9, which folded image generation into `Invoke Model (v1)` as an output modality
> (see §15.4); the rows now have a caller. Migration 023's "Blocks 9–12 unbuilt / no caller" note is
> superseded for Block 9.

> **Block 10 — `agent_runs` payload-weight observability (2026-06-12, ADR-036).** Migration
> `025_agent_runs_payload_bytes.sql` adds two nullable columns to `agent_runs`: `run_payload_bytes`
> (bigint — UTF-8 byte size of the delivered payload, rendered comment + any image base64; a proxy +
> lower bound for n8n execution-data weight) and `n8n_execution_id` (text). Written once per delivering
> run by Post Reply's `Record Artifact` (no new writer). Additive, nullable; PK/columns otherwise
> unchanged; PD-blind. Supports the Block-10 in-memory base64 delivery pivot (see §15.6) — base64 rides
> n8n execution data, so per-run weight is now observable.

Principles: store facts, never derivations; constrain (CHECK) where downstream
automation depends on consistency, leave free-form where only semantic meaning
is needed; append-only threaded feedback with "current stance" derived via
`DISTINCT ON`.

`agent_runs` carries trigger attribution and queue tracking:

```sql
triggered_by TEXT CHECK (triggered_by IN (
  'webhook_status_change', 'webhook_field_change',
  'due_date_daily', 'gmail_incoming', 'gmail_sent_analysis',
  'weekly_proposer', 'per_task_proposer',
  'explicit_mention', 'explicit_command',
  'conversation_reply', 'reset_restart',
  'search_step'
)),
invocation_type TEXT CHECK (invocation_type IN (
  'autonomous', 'explicit', 'conversation_reply'
)),
queue_priority  INTEGER,
queue_wait_ms   INTEGER,
retry_attempt   INTEGER DEFAULT 0
```

These enable: what % of work is proactive (`due_date_daily`) vs reactive (webhook)
vs explicit? Do explicit invocations produce higher satisfaction ratings? Where
do retries cluster?

---

## Spend limits — LIVE (ADR-064, 2026-06-27)

Daily spend caps with a pre-execution gate and an end-of-message warning. Per-user
**40 PLN/day** (default; overridable per user via `user_data_and_config.daily_spend_limit_pln`)
and company-wide **100 PLN/day** across all users. A run is **blocked** once already-incurred
spend reaches a cap; users are **warned** at message-end past 60% (own cap) / 70% (company cap).
Day boundary is the **Europe/Warsaw calendar day** (resets at 00:00 Warsaw).

- **One measurement, one place:** `get_spend_status(p_user_id)` (migration 047) computes both
  `SUM(cost_pln)` aggregates over today's rows, the limits, ratios, and block/warn flags in a
  single SQL function. Both consumers call it.
- **The gate** runs at the single spine chokepoint — the Agent Orchestrator's `When Called`
  entry, which both the synchronous mention producer and the queued Spine HTTP Ingress invoke.
  Checking at execution time (not enqueue time) bounds queue overshoot to one in-flight run.
  Blocked → a Polish notice is posted to the user (which cap, resets at midnight) + a WARN via
  `Post Alert (v1)`, and the spine never runs (no model spend). The manual Form Trigger path is
  left ungated.
- **The warning** is appended inside `Post Reply (v1)` (covers both lanes) from a post-run
  `get_spend_status` read, so the just-finished run's cost is already counted.
- **Soft cap, by design:** cost is logged after a run completes, so the gate sees only
  already-incurred spend; one run may overshoot by its own cost (~1–3 PLN vs a 40 PLN cap).
- **Config:** `spend.company_daily_limit_pln`, `spend.user_daily_limit_pln_default`,
  `spend.user_warn_pct`, `spend.company_warn_pct`, and `spend.enabled` (kill-switch) in the
  `config` table. **Fail-open:** a `get_spend_status` error lets the run through + WARNs (a DB
  hiccup must not freeze all agent work). Migration 047 also renamed `user_clickup_credentials`
  → `user_data_and_config` (it now holds per-user data *and* config).

---

## 6. Email

Gmail-native. The agent creates Gmail **drafts**; a human reviews and sends. No
autonomous sending. `email_sends` records the audit trail (draft_created / sent /
discarded), linked to the originating `agent_run`.

---

## 7. Conversation sessions

Multi-turn agent conversations cache their base context (task hierarchy +
relevant CU content) in `conversation_sessions` to avoid recomputing it each
turn. At most one active session per (task, comment thread, caller), enforced by
a partial unique index. Sessions expire after 24h inactivity, on `~zresetuj-sesje`,
or on significant underlying data change.

---

## 8. Skills (invocable commands)

Each named `~command` maps to a ClickUp doc that holds its prompt; the prompt content
lives in CU Docs (version-controlled mirror under `skills/`), never hardcoded in n8n.
n8n holds a **command registry** — a table keyed by `command_name` → CU prompt-doc
link/ID, plus optional metadata — which the generic pipeline reads at runtime to load
the right prompt. Adding a command = author the CU doc + add one registry row: data,
not code (see ADR-015). There is no per-command agent and no hardcoded persona-dispatch.

| Skill | Type | Description | Human gate |
|---|---|---|---|
| `~wykonaj-zadanie` | Agent | Main orchestrator: single Claude call (draft+critique+synthesize internally) → Formatter applies output structure | None — output is suggestion in comment |
| `~napisz-maila` | Agent | Email orchestrator: single Claude call → Formatter → Gmail Draft | Gmail's send button |
| `~stwórz-zadanie` | Agent | Proposes structured task creation | 👍 reaction required |
| `~zaproponuj-zmianę-procesu` | Agent | Per-task or weekly: proposer posts structured proposal | IC reaction → org reaction |
| `~zresetuj-sesję` | Operational | Expire sessions, archive, restart | None (already explicit) |
| **Formatter** | **Deterministic** | Post-processing: parse model output, apply markdown structure, add metadata, validate schema | None |

The Formatter runs after every Claude call with no AI involvement — pure parsing
and template application. Rules live in the `Formatter Skill` doc in CU; each
`process_type` can have its own formatting variant (NPD uses product-spec
structure, emails use 6-section format, etc.).

---

## 9. Operator workflow (chat vs Claude Code)

- **Chat (Opus):** strategy, design deliberation, web research, decisions.
- **Claude Code (Opus):** execution, file/repo work, running commands. Also the
  **n8n builder** — it creates, validates, and deploys workflows directly via the
  n8n MCP server (REST API control plane), with the operator inspecting/correcting
  rather than doing the mechanical wiring. See ADR-018.
- Both read the repo; only the repo is durable. Decisions made in chat must be
  written back to this document + `decisions/` before they count as real (see §10).

---

## 10. Documentation discipline (write-back ritual)

High-bandwidth reasoning happens in chat, but chat context is ephemeral. To
prevent this document from drifting from reality:

After any significant chunk of design work, before moving on:
1. Update this `current.md` to reflect new decisions.
2. Write an ADR in `decisions/` for each significant decision (append-only;
   supersede, never edit, past ADRs).
3. Commit both. The repo — not the chat — is the source of truth.

Claude Code prompts are disposable execution instructions; they reference these
durable docs rather than re-explaining context.

current.md is updated via targeted diffs, not full-file rewrites, to avoid silently dropping accumulated detail. New ADRs are added as complete files.

---

## 11. Build phases

- **Phase 0** — infrastructure (git, AWS, 1Password, Supabase, VPS, Docker stack, Nginx + TLS). **COMPLETE** (infra hardened, password auth disabled, both machines keyed).
- **Phase 1** — ClickUp foundation. **IN PROGRESS** — see *Phase 1 status* below. The agent CU account, the six `[AI]` custom fields, and the global agent-rules + operator-preferences docs are live; research is complete (NPD process mapped; observations doc) and the core model + KM-maintenance design confirmed. Remaining: full Agent System Space build-out (process templates with checklist-in-description + doc leaves) and the rest of the team's preference docs.
- **Phase 2** — the spine. **IN PROGRESS (core path COMPLETE)** — the generic read→route→infer→post-back pipeline (thin `Agent Orchestrator (v1)` → Stage A `Assemble Context and Build Prompt` → B `Execute LLM Call` → C `Post Reply`; ADR-036), signature-verified @-mention triggering (`CU Webhook Producer (v1)`, ADR-029), thread-aware replies via `conversation_sessions`, and `Assemble Task Context (v1)` + Layer-B caller-scoped reads (ADR-031) are all live and verified end-to-end. See *Phase 2 status* below and §15. Remaining: selective `linked_doc_leaves`; autonomous status/due-date triggers (Phase 3).
- **Phase 3** — email + due-date triggering + queue tuning.
- **Phase 4** — learning loop (proposers).
- **Phase 5** — team rollout.

Target: 7–9 weeks to v1.

---

## Infrastructure status (Phase 0 — COMPLETE)

- **VPS**: Cyberfolks vroot_SPRINT, AlmaLinux 10, 185.25.149.174 (KVM, 4 vCPU / 8 GB / 100 GB, hostname vps57524999).
- **Access**: key-based SSH (ed25519). Separate keypair per machine — home and office desktops each have their own key installed for `franciszek` (private keys passphrase-free, for non-interactive automation). Non-root sudo user `franciszek` (wheel + docker + NOPASSWD sudoers); root reserved for exceptions. firewalld: ssh/http/https open. See ADR-010.
- **Password auth: DISABLED.** Both workstations (home + office) have key-based SSH access; with both keyed, password authentication was turned off (`PasswordAuthentication no`) as the final hardening step. Access is now key-only.
- **Docker stack**: `/opt/haxe-agents/`, eight containers on private bridge network `n8n-internal`, queue mode. Image versions pinned. See ADR-011.
  - `n8n-postgres` (postgres:16) — n8n's internal DB; named volume; healthcheck-gated.
  - `n8n-redis` (redis:7-alpine) — queue backing; AOF persistence enabled; named volume.
  - `n8n-main` (n8nio/n8n:2.22.5) — UI, webhooks, scheduler; binds to 127.0.0.1:5678 only.
    Memory-capped `mem_limit: 1024m` + `NODE_OPTIONS=--max-old-space-size=768` (ADR-051 Block 6).
  - `n8n-worker` (n8nio/n8n:2.22.5) — queue consumer; concurrency 5.
    **Memory-capped** `mem_limit: 1024m` + `NODE_OPTIONS=--max-old-space-size=768` (ADR-051 Block 6).
    Image generation runs here (the parallel batch's base64 images ride execution data), and Node's
    default heap ceiling on this 8 GB box is ~2.2 GB — unbounded, two n8n processes could crowd Docling
    (which wants ≥4 GB when loaded) off the host. The heap ceiling sits *below* the cgroup limit so a
    runaway hits a JS-heap OOM (fails its own execution, container restarts) instead of the kernel
    OOM-killing Docling. Verified: a 5-image concurrent `gpt-image-2` batch peaked the worker at ~228 MiB
    (image heap is trivial); the cap is a safety valve against a pathological runaway, not a tight fit.
  - `litellm` (ghcr.io/berriai/litellm, v1.87.0 pinned by digest) — **deployed + active** (ADR-024/030).
    Internal-only LLM gateway (127.0.0.1:4000): signs Bedrock, returns exact token usage + USD cost header,
    multi-provider. **IS the production model-call path** (§15). Chat aliases (PD-blind — ADR-043, migration 021):
    four Anthropic direct (`haxe-haiku-4-5-direct`, `haxe-sonnet-4-6-direct`, `haxe-opus-4-8-direct`,
    `haxe-fable-5-direct`) + two Gemini global (`haxe-gemini-flash`, `haxe-gemini-pro`). The three Bedrock EU
    (`*-bedrock`) aliases were **removed in Block 3** (no routing row references them); the Gemini aliases were
    renamed from `-eu` (they run on the global endpoint, never EU-pinned). `ANTHROPIC_API_KEY` in `.env` and
    passed through via `docker-compose.yml`. Config in committed `n8n/litellm-config.yaml`; credentials in `.env`
    (never committed). **`litellm_settings.num_retries: 3` (ADR-051 Block 6):** the router retries retryable
    errors (429/500/timeout) with exponential backoff and respects upstream `Retry-After` before returning to
    n8n — so a transient OpenAI gpt-image-2 429 from a concurrent image burst is absorbed at the gateway and the
    image stays on its top-tier model instead of silently tier-downgrading; only a sustained overload that
    exhausts the retries reaches n8n's per-image fallback (loud, via `warnings[]`). Native Bedrock node retained in n8n **disabled** (legacy). Gemini (ADR-038/040):
    `haxe-gemini-flash` (`vertex_ai/gemini-3.5-flash`) and `haxe-gemini-pro`
    (`vertex_ai/gemini-3.1-pro-preview`), both `vertex_location: global` (ADR-039/042). Auth: ADC via
    `GOOGLE_APPLICATION_CREDENTIALS=/secrets/vertex-key.json`; the key file is mounted read-only from
    `/opt/haxe-agents/vertex-key.json` (service account `litellm-vertex@haxe-agent-system-499018.iam.gserviceaccount.com`,
    `roles/aiplatform.user`). `VERTEX_PROJECT=haxe-agent-system-499018` in VPS `.env`. Never commit
    `vertex-key.json` — source from 1Password.
  - `docling` (`quay.io/docling-project/docling-serve`, digest-pinned `sha256:c7ba482f…`) — **deployed +
    active** (ADR-036). Internal-only document extractor (127.0.0.1:5001, loopback). The single extractor for
    the multimodal input pipeline: converts docx/xlsx/csv/txt/pdf/pptx + images (OCR) → markdown with
    layout/tables via `POST /v1/convert/file`; `GET /health`. n8n reaches it at `http://docling:5001`. No
    provider fallback — a file that defeats it surfaces as `[BRAK: extraction_failed <file>]` + WARN, run
    continues. **Verified live 2026-06-10** on the HBG Sharp.docx / Karta Techniczna HX705.pdf / Wzorcowa
    specyfikacja.xlsx fixtures (markdown at `document.md_content`; xlsx → 260 pipe-table rows). ⚠ Default
    `image_export_mode=embedded` inlines page images as base64 (one PDF → 242 KB vs 1.3 KB in `placeholder`
    mode); the readers (Blocks 2–3) must pass `image_export_mode=placeholder`.
    > **Docling tuning (ADR-048 Block 5, 2026-06-15):** the reader now calls Docling with `do_ocr=false` +
    > `table_mode=fast` + `document_timeout=120` (measured: OCR off is 50–67 % faster and byte-identical on
    > digital PDFs; `fast` is byte-identical to `accurate` on real Haxe PDF/XLSX tables). Because OCR only
    > affects scanned/image-only PDFs, a **two-pass fallback** preserves them: an empty first pass re-runs that
    > one doc with `do_ocr=true` (`OCR Empty?` → `Restore Doc Binary` → `Docling OCR Retry`, converged through
    > `Merge OCR Result`). The service is pinned to a deliberate concurrency bound —
    > `DOCLING_SERVE_ENG_LOC_NUM_WORKERS=2` + `OMP_NUM_THREADS=2` (2 workers × 2 threads = the box's 4 cores, no
    > oversubscription; excess conversions queue server-side) in **both** the repo and VPS `docker-compose.yml`
    > so a multi-document zip burst can't saturate the box and an image bump can't silently revert it.
    > **CSV encoding fix (2026-06-27):** Docling decodes text input as UTF-8 **strict**, so *any* non-UTF-8 CSV
    > made it return `200 status=failure, md_content=null`, which the reader degraded to
    > `[BRAK: extraction_failed]` (the service handles CSV fine; the bug was the byte encoding, and CSV is
    > uniquely exposed — raw plaintext with no encoding declaration, unlike HTML/XML or the UTF-8 zips DOCX/XLSX).
    > Verified empirically: Docling fails on `cp1250`, `iso-8859-2`, `cp1252`, **and** `utf-16` LE/BE; only
    > `utf-8` / `ascii` / `utf-8-BOM` pass. `Read Input (v1)` gained a **`Transcode Text to UTF-8`** Code node at
    > the shared `Merge Extractable → Docling Convert` seam (covers loose *and* zip-inner docs). For plaintext
    > exts (`csv/txt/tsv/tab`) it normalises encoding: (1) **BOM wins deterministically** — UTF-8 BOM (stripped),
    > UTF-16 LE (`FF FE`), UTF-16 BE (`FE FF`) are decoded and re-encoded UTF-8; (2) else valid strict UTF-8
    > (incl. ASCII) passes through untouched; (3) else single-byte legacy → **Windows-1250** (Polish Windows ANSI
    > default). Binary formats (pdf/docx/xlsx/img) are skipped *before* any binary read, so they're never
    > corrupted. Verified end-to-end on CP1250, UTF-16-LE, and UTF-8-BOM Polish CSVs (all extract, ś/ź/ż/ł
    > diacritics intact, clean headers, 0 WARN). **Known residual:** a BOM-less `cp1252`/`iso-8859-2` *foreign*
    > export can't be auto-distinguished from `cp1250` without a charset-detection library (unavailable in the
    > n8n Code sandbox), so it falls back to Windows-1250 — acceptable for a Polish/Windows shop where CP1250 is
    > the only realistic BOM-less single-byte source. If genuine CP1252/ISO traffic ever appears, the right fix
    > is a detector library in a service, not a heuristic in the sandbox.
    > **Config drift incident (2026-06-08):** The VPS `docker-compose.yml` predated ADR-030 and lacked the
    > `ANTHROPIC_API_KEY` passthrough. LiteLLM's router surfaced the resulting 401 as a 429 cooldown, causing
    > ~8 h of misdiagnosis. Fixed by redeploying `docker-compose.yml` via scp. See ADR-033 for the deploy
    > model and mitigations.
  - `queue-consumer` (Node 20, `services/queue-consumer/`) — **deployed + active** (ADR-056). Thin BullMQ
    application-queue consumer: `POST /enqueue` (priority 1–8) + Worker (`concurrency=5`) triggering the spine
    via `Spine HTTP Ingress (v1)`, with idempotency, retry/backoff, dead-letter, `/health`, `/metrics`, and a
    Redis heartbeat key. `expose:8080` internal only; `mem_limit: 256m`; reads Supabase `config`/`agent_runs`
    (no ClickUp creds). BullMQ keys are prefixed `haxeq:*` so they never collide with n8n queue mode's `bull:*`
    on the shared `n8n-redis`.
  - `zip-extractor` (Node, `services/zip-extractor/`) — internal helper service (ADR-058); see that ADR for detail.
  - `session-waiter` (Node 20, `services/session-waiter/`, v1.1.0-block6) — **ADR-066, deployed (Block 4
    skeleton; Block 5 orchestrator handoff; Block 6 event loop LIVE)**. External async waiter for the
    **managed-agent** lane: decouples a long Anthropic Managed-Agents session from any single n8n execution (the
    840 s / single-Code-node ceiling that abandoned the 2026-06-30 `.pptx` run). `/health` (the dead-man's-switch
    target) + `/handoff` (persist a `waiter_sessions` row, return 202, then **drive the session in the
    background**). The driver re-derives the managed key via `get_anthropic_key()` RPC (A6), **long-polls**
    `GET /events` (truth) + session status — porting `Poll Round`'s `analyze()` — services pending client tools
    by POSTing the `Session Waiter Tool Bridge (v1)` (which delegates to the SSOT tail/extract handlers), captures
    `deliver_output` blocks, and POSTs the finish callback (Block 7) on terminal. Crash recovery: re-adopts any
    `handed_off`/`running` row on startup. (Chose long-poll over SSE — A1's proven n8n-independent fallback, far
    simpler than SSE reconnect/reconcile.) `expose:8080` internal only; `mem_limit: 256m`; reuses `SUPABASE_*` +
    `ALERT_INTAKE_KEY` (no new secrets; the managed key is handed at handoff per A6, never in env/.env/DB —
    in fact Block 5's handoff does **not** send the key at all; the waiter re-derives it from
    `get_anthropic_key()`). Reliability seam: `Session Waiter Health Monitor (v1)` (pings `/health` every
    10 min → CRITICAL if down) + `Session Waiter Freshness Monitor (v1)` (`check_stuck_waiter_sessions()`
    every 15 min → CRITICAL for a handed-off-but-not-finished session).
    - **Orchestrator split (Block 5).** The managed lane forks on `config.session_waiter.enabled` (seeded
      `false` → prod runs the synchronous poll loop unchanged): `agent-orchestrator.json` reads the flag
      (`Read Waiter Flag`) and passes `mode` to `Execute Agent Session (v1)`. `mode='handoff'` runs only the
      **front half** (resolve agent/key → create session → send first message) via a new `Mode = handoff?` IF
      → `Build Handoff Output` (returns `outcome='handed_off'` + carry-state, **no** managed key), then the
      orchestrator's `Handoff?` IF routes to `Post Handoff to Waiter` (`POST /handoff`) and returns with **no
      synchronous hold and no comment** (status stays "W trakcie"; the Block-7 finish callback posts the real
      answer later; POST failure → CRITICAL `session-waiter/handoff-post`). `mode='sync'` (the prod default)
      → `Handoff?` FALSE → the unchanged `Session OK?` publish/incomplete gate. Both paths verified live
      2026-06-30 (handoff persists a keyless row + returns fast; sync still delivers via Post Reply).
- **Public endpoint**: `https://agents.haxe.ai` — Nginx reverse proxy + Let's Encrypt TLS (certbot, auto-renewing, 90-day). HTTP → HTTPS redirect active. See ADR-012.
- **Build control plane**: Claude Code drives infrastructure via two MCP servers in `.mcp.json`:
  - **`n8n-mcp`** (`n8n-mcp@2.56.0`) — n8n REST API (`https://agents.haxe.ai/api/v1`); key from `N8N_API_KEY` (setx; expiry 2026-08-31). See ADR-017/018.
  - **`@supabase/mcp-server-supabase`** — Supabase Management API; key from `SUPABASE_ACCESS_TOKEN` (setx, no expiry set). Enables direct SQL execution + migrations without the Supabase dashboard.
  Both servers use `cmd /c npx` wrapper (Windows shim requirement — CLAUDE.md).
- **AWS**: account 000500193947 (tax reg. Skalus). Root MFA via passkey. IAM user `haxe-agents-bedrock`. Billing alert 50 USD/mo. Region eu-central-1.
- **Supabase**: project `hkeslnosxibeuesxndnz`, eu-west-1 (Ireland). Migrations 001–009 applied. Schema managed via Supabase MCP from the operator desktop.
- **Secrets**: all in 1Password (Cyberfolks account / Solus / root / franciszek / n8n encryption key / UI creds — separately labeled); `.env` on VPS only, never committed. `N8N_ENCRYPTION_KEY` rotated after initial deploy. The **ClickUp webhook HMAC secret** lives in the n8n `crypto` credential "ClickUp Webhook HMAC".
- **VPS deployment model**: `/opt/haxe-agents/` is NOT a git repo. Infra files (`docker-compose.yml`,
  `litellm-config.yaml`) live flat there; canonical copies are in the repo under `n8n/`. After any
  change to either file in the repo, run `infrastructure/scripts/deploy-infra.bat` to push to VPS, then
  `docker compose up -d <service>` to recreate. **Never** `restart` to pick up env var changes —
  it does not re-read `.env`. See ADR-033.
- **Next**: Phase 1 — ClickUp foundation (Agent System Space, custom fields, first personas).

### Credential architecture

```
YOUR LAPTOP                         THE VPS (185.25.149.174)
-----------                         ------------------------
SSH private key  ──key auth──────►  franciszek account (NOPASSWD sudo)
(no passphrase)                       │
                                      ├─ /opt/haxe-agents/          ← flat; NOT a git repo (ADR-033)
                                      │    ├─ docker-compose.yml  (canonical: n8n/docker-compose.yml)
                                      │    ├─ litellm-config.yaml (canonical: n8n/litellm-config.yaml)
                                      │    ├─ vertex-key.json     (Vertex AI SA key — never committed; source: 1Password)
                                      │    └─ .env                (VPS ONLY, never git)
                                      │
                                      ├─ Docker containers (private bridge network):
                                      │    ├─ n8n-main    127.0.0.1:5678  (localhost only)
                                      │    ├─ n8n-worker  (no public port)
                                      │    ├─ n8n-postgres  port 5432, internal only
                                      │    │    └─ stores n8n workflows + ENCRYPTED Tier-3 creds
                                      │    └─ n8n-redis     port 6379, internal only
                                      │
                                      └─ Nginx  0.0.0.0:443  (public, TLS)
                                           ├─ agents.haxe.ai → localhost:5678
                                           └─ Let's Encrypt cert, auto-renewing via certbot

1PASSWORD (off-server source of truth):
  - SSH key (no passphrase — keep key only on trusted machines) (Tier 1)
  - N8N_ENCRYPTION_KEY, Postgres pw, n8n UI owner login (Tier 2)
  - Bedrock / Supabase / ClickUp / Gmail keys (Tier 3, entered in n8n UI)

OPERATOR DESKTOP (Windows, per machine):
  - n8n API key for Claude Code's build control plane — stored via setx in the
    user registry, read as ${N8N_API_KEY} by the n8n MCP server. Control-plane
    scope (full workflow read/write over the public API); expiry 2026-08-31.
    See ADR-017 / ADR-018.

GIT REPO (no secrets ever):
  - docker-compose.yml, .env.example, nginx-agents.conf, .mcp.json (key via
    env-var reference only), architecture docs
```
### Docker architecture
═══════════════════════════════════════════════════════════════════════════════
  THE VPS (one physical-ish machine, one Linux KERNEL, one real filesystem)
  AlmaLinux 10 @ 185.25.149.174
═══════════════════════════════════════════════════════════════════════════════

  REAL HOST FILESYSTEM (everything actually exists here)
  ├── /opt/haxe-agents/
  │     ├── docker-compose.yml        ← describes the structure below
  │     └── .env                      ← secrets, read at startup, injected as env vars
  │                                      (NOT a volume — in-memory only)
  ├── /var/lib/docker/volumes/        ← WHERE VOLUMES REALLY LIVE (persistent)
  │     ├── n8n-postgres-data/_data/  ──────────┐
  │     ├── n8n-redis-data/_data/     ────────┐ │
  │     └── n8n-main-data/_data/      ──────┐ │ │
  └── /home/franciszek/  /root/  ...        │ │ │   (invisible to containers)
                                            │ │ │
        the KERNEL presents each process    │ │ │  mounted
        a private VIEW via namespaces:      │ │ │  into
                                            │ │ │  containers
  ┌─────────────────────────────────────── │ │ │ ──────────────────────────────┐
  │ DOCKER private bridge network "n8n-internal"                                │
  │ (containers resolve each other by NAME, like DNS)                           │
  │                                            │ │ │                            │
  │  ┌──────────────────────┐                  │ │ │                            │
  │  │ n8n-main             │   port mapping:   │ │ │                            │
  │  │  image: n8nio/n8n    │   127.0.0.1:5678 ─┼─┼─┼──► reachable ONLY on host  │
  │  │  (pinned version)    │                  │ │ │     loopback (private);     │
  │  │  sees: /home/node/.n8n ◄────volume──────┘ │ │     SSH-tunnel to use it    │
  │  │  namespaces: own fs/net/PID                │ │                            │
  │  └──────────┬───────────┘                    │ │                            │
  │             │ enqueues jobs                   │ │                            │
  │             ▼                                 │ │                            │
  │  ┌──────────────────────┐                     │ │                           │
  │  │ n8n-redis            │                      │ │                           │
  │  │  image: redis (pin)  │                      │ │                           │
  │  │  port 6379           │   AOF persistence    │ │                           │
  │  │  (internal only)     │   /data ◄──volume────┘ │                           │
  │  └──────────┬───────────┘                        │                           │
  │             │ workers pull jobs                  │                           │
  │             ▼                                     │                           │
  │  ┌──────────────────────┐                         │                          │
  │  │ n8n-worker           │   no port mapping        │                          │
  │  │  image: n8nio/n8n    │   (nothing exposed)      │                          │
  │  │  executes workflows  │                          │                          │
  │  └──────────┬───────────┘                          │                          │
  │             │ reads/writes                          │                         │
  │             ▼                                        │                         │
  │  ┌──────────────────────┐                            │                         │
  │  │ n8n-postgres         │   n8n's INTERNAL db         │                        │
  │  │  image: postgres(pin)│   (workflows, exec history, │                        │
  │  │  port 5432           │    encrypted credentials)   │                        │
  │  │  (internal only)     │   /var/lib/postgresql/data ◄┘ volume                 │
  │  └──────────────────────┘                                                      │
  │                                                                                │
  │  startup order enforced by depends_on + healthchecks:                          │
  │    postgres healthy AND redis healthy  ──►  THEN n8n-main / n8n-worker start    │
  └────────────────────────────────────────────────────────────────────────────────┘

  cgroups (not drawn): cap each container's CPU / RAM share of the host's 8 GB.

  THREE KERNEL MECHANISMS AT WORK:
   • namespaces → each container sees its own filesystem/network/process world
   • volumes    → deliberate holes connecting a container path to persistent host storage
   • cgroups    → resource ceilings per container

---

## Phase 1 status (ClickUp foundation — IN PROGRESS)

The ClickUp substrate the generic pipeline reads from. State as of 2026-06-09:

- **Agent CU account — DONE.** `agent@haxe.com` is a ClickUp **Member** (only Members can mint
  the personal API token the pipeline needs); its token drives all ClickUp I/O and reads CU
  Docs via the Docs v3 API. Caller-scoping was historically enforced in software (Layer A prompt
  + Layer B Space-membership in `Assemble Task Context (v1)`), not by the account; ADR-054 **retired the Layer B
  software filter** (Block 3b) and moves managed-lane scope onto the caller's own per-user ClickUp
  OAuth credential instead. See §13.3, §15.5, ADR-004, ADR-026, ADR-054.
- **Workspace custom fields — DONE** (verified 2026-06-03). Six live `[AI] …` fields drive
  agent control: `Czy zadanie dla AI` (autonomous gate), `Wpływ zadania na wynik firmy`
  (5-level impact → model tier + queue priority), `Finalny, zaakceptowany efekt`
  (approval/quality signal), `Status agenta` (reset/lifecycle), `Typ procesu`, `Koszt akcji
  [PLN]`. Full set + values in §13.2.
- **GLOBAL agent-rules doc — DONE (working version).** Lives in CU Docs (`q7wz-16892`); loaded
  on every run so output follows firm rules + brand non-negotiables (core-model step 3). The
  content keeps evolving; the loading seam is live.
- **Per-person agent-preferences docs — PARTIAL.** The operator's prefs doc exists and is
  loaded live alongside the rules doc; docs for the rest of the team are authored as they
  onboard (Phase 5).
- **Agent System Space scaffolding — PARTIAL.** The alerting channel (Alerts task `869dj2z2c`)
  and a test surface (`Lista testy AI`, task `869dhad2q`) are live and exercised end-to-end.
  The full Space content in §13.1 — process templates with checklist-in-description +
  paste-ready doc leaves (starting with the mapped NPD process), the proposer/email persona
  docs, the Formatter Skill doc, and the landing-zone tasks (Process Improvements, Agent
  Errors, GM Weekly Reports) — is built out incrementally as each capability lands.

Research is complete (NPD process mapped; observations doc) and the core model + KM-maintenance
design confirmed (see *Core model* and *KM maintenance*). Remaining to close Phase 1: author
the canonical NPD process template in CU (checklist-in-description + doc leaves) so the pipeline
exercises a real structured process beyond the test list.

## Phase 2 status (the agent spine — core path COMPLETE)

The generic read→route→infer→post-back pipeline plus automatic @-mention triggering — built and
verified end-to-end on `869dhad2q`. Per-workflow detail, n8n IDs, and node names are in §15.
State as of 2026-06-10:

- **Core pipeline — DONE (decomposed).** A thin `Agent Orchestrator (v1)` (id `a8XKaijkMFNBpRBa`,
  8 nodes) sets status then calls three stage subworkflows in sequence — **A** `Assemble Context and
  Build Prompt (v1)` → **B** `Execute LLM Call (v1)` → **C** `Post Reply (v1)` — each with its own
  execution log and a shared **Reset Status + Alert** on any stage failure (ADR-032/036). Stage A
  composes `Assemble Parent Context (v1)` → `Assemble Task Context (v1)` → `Build Prompt`; B runs
  `Invoke Model (v1)`; C posts the thread-aware draft and owns the ClickUp side-effects. (The earlier
  monolithic 26-node `agent-spine.json` was decomposed in place — `a8XKaijkMFNBpRBa` is now the
  orchestrator.)
- **Model layer — DONE.** Self-hosted LiteLLM gateway, **PD-blind** data-driven routing on `(impact,
  modality)` — `text` → Anthropic direct, `multimodal_input` → Vertex Gemini, `image` → gemini-image + gpt-image-2 tiers (Block 8)
  (ADR-043, migration 021; image tiers refreshed in migration 023) — exact USD × daily NBP FX → `cost_pln`, logged to `agent_runs` and summed
  into `[AI] Koszt akcji [PLN]`.
- **Output — DONE.** Draft comment @-mentions the reviewer and renders full markdown (headings,
  lists, code, tables) via a deterministic markdown→Quill-Delta converter; soft
  Wyniki/Pytania/Decyzje/Sugestie structure. **Never finalizes** (no agent-done status, no
  `Finalny…` write); `[AI] Status agenta` flips W trakcie → Zakończono around the run.
- **Automatic triggering — DONE (@-mention).** `CU Webhook Producer (v1)` receives
  workspace-wide `taskCommentPosted`, **verifies the `X-Signature` HMAC**, detects the agent
  tag from the payload (zero extra API calls for non-mentions), and calls the spine with
  `explicit_mention`. Agent→agent chaining allowed, bounded by an 8-runs-per-10-min circuit
  breaker; caller/reviewer = the mentioner.
- **Conversation continuity — DONE.** Thread-aware replies via `conversation_sessions`.
- **Monitoring — DONE.** Reactive (`Error Handler (v1)` as `errorWorkflow` → CRITICAL) +
  proactive WARNs (routing-default, cost-missing, insert-failed, FX-freshness, bad-signature,
  loop-breaker) via `Post Alert (v1)`. Failure paths fault-injected and proven (ADR-025).

Remaining in Phase 2: selective `linked_doc_leaves` (only the current step's leaf). Deferred:
autonomous status/field-change + daily due-date triggers (Phase 3); the ADR-026 identity split
(read-only telemetry vs. edit-capable token).

---

## 12. Design principles

Nine principles in priority order. Every architectural decision traces back to one.

1. **Process knowledge in ClickUp.** All operational knowledge — process templates, stage instructions, step checklists, agent personas, brand voice — lives in ClickUp Docs and task descriptions. Team members edit it directly without git knowledge.

2. **Agents run as a ClickUp Member account, with caller-scoped permissions enforced in software.** The agent was intended as a least-privilege Guest, but ClickUp only lets **Members** generate the personal API token the pipeline needs — so `agent@haxe.com` is a Member with broad base permissions. Because the account itself is over-privileged, the agent's effective scope is constrained to the calling user's permissions at the application layers (prompt Layer A + the n8n MCP gateway Layer B), not by the CU account, and the LLM holds no write capability at all (ADR-026). See ADR-004.

3. **Recursive self-improvement via structured proposals.** All proposals tracked in a structured database. The GM agent analyses evaluations and records its verdicts in the same thread it analyses, enabling recursive self-reflection on its own past calls.

4. **Context retrieval via MCP, not custom infrastructure.** Claude reads ClickUp directly via the MCP connector — no sync jobs, no intermediate store.

5. **Conversation sessions cache context across turns.** Multi-turn discussions cache the expensive part (task hierarchy, examples, persona docs) and reuse it across turns.

6. **Single comprehensive prompt over multi-step agent loops.** Builder/Critic/Synthesizer separation is unnecessary with Opus-class models. One well-engineered persona prompt performs draft+critique+revision internally. Deterministic Formatter Skill handles output structure. ~3× cost reduction, ~60% latency reduction, comparable quality.

7. **Proactive autonomous triggers + always-available explicit invocation.** Agents activate autonomously on tasks marked `Czy dla AI = Tak` (webhooks + daily due-date scan). Team members can always explicitly invoke the agent on any task via @-mention or `~command`, regardless of the field value.

8. **All AI execution flows through a queue.** Rate limiting, priority scheduling, retries with exponential backoff, and decoupling of triggers from execution. The queue is the operational backbone.

9. **Gmail-native email integration.** Agent creates Gmail Drafts; human reviews and sends from Gmail directly. No autonomous sending.

---

## 13. ClickUp setup

### 13.1 "Agent System" Space

Dedicated Space containing:

**Docs:**
- `General Agent Rules`
- `Agent Persona` — comprehensive persona with draft+critique+synthesis instructions
- `Org Proposer Persona`, `Task Proposer Persona`, `Email Persona`
- `Formatter Skill` — deterministic output formatting rules per `process_type`
The format of the comment should be:
(1) Results,
(2) Questions to the user,
(3) Decisions made, tradeoffs taken, why the result is done the way it is done,
(4) [In a section marked separately, perhaps under a block of "---------": ] Suggested changes to the process, comments on the execution, etc.
NOTE TO FUTURE BUILDER SELF: The agent's thinking shouldn't be forced into this structure, but he should know from the start that he will eventually need to pass the output in this format (this will guide the reasoning while allowing it to explore the solutions non-linearly, not strictly following the steps)

**Tasks:**
- `Process Improvements` — landing zone for org-level proposals
- `Agent Errors` — error notifications from n8n
- `GM Weekly Reports` — operator review notes

### 13.2 Workspace custom fields

| Field (live name) | Type | Values | Purpose |
|---|---|---|---|
| `[AI] Czy zadanie dla AI` | Dropdown | Nie / Tak | Gates autonomous agent behavior |
| `[AI] Wpływ zadania na wynik firmy` | Dropdown | n/d - zadanie nie jest dla AI / Niski / Średni / Wysoki / Krytycznie ważne | Importance → routes model tier + queue priority (was `Ważność`) |
| `[AI] Finalny, zaakceptowany efekt` | Attachment | (plik) | Quality signal — populated only on approval |
| `[AI] Status agenta` | Dropdown | Zresetuj agenta / W trakcie / Zakończono / Nie rozpoczęto | `Zresetuj agenta` triggers session expiry + restart |
| `[AI] Typ procesu` | Dropdown | Nowy produkt / Nowy pracownik / Nowy kontraktor zewnętrzny | Process identifier |
| `[AI] Koszt akcji [PLN]` | Number | (PLN) | Aggregated cost per task |

> Live field set as built (verified 2026-06-03). The doc historically calls the
> importance field `Ważność`; it now has **five** levels (+ an `n/d` opt-out),
> not the old Low/Medium/High three. Consequently the model-tier and queue-priority
> mappings (§3, §14.3) and the routing selection step (ADR-013) must map five
> importance levels — and, per ADR-013/ADR-021, a **second axis: sensitivity
> (PII / personal data)** set by an earlier classifier node — to (provider, model,
> priority). That mapping is a pending design decision, not a default.

`[AI] Czy zadanie dla AI` gates autonomous behavior only. Explicit invocations
(@-mention, `~command`) always work regardless of this field.

### 13.3 Agent CU account

Single base account `agent@haxe.com`. Intended as a comment-write-only Guest, but
ClickUp won't let guests mint an API token, so it is a **Member** (broad edit/delete
rights) — see ADR-004 (2026-06-02 update). Runtime scope narrows to the calling user's
permissions (see §3, ADR-004). **Layer A** (prompt-level) is enforced by the persona
prompt system. **Layer B** (the software space-membership filter that `Assemble Task Context (v1)` ran via
`GET /space/{id}/member`, ADR-031) was **retired in ADR-054 Block 3b (2026-06-23)**: post-hoc
filtering of bot-retrieved results is exactly what ADR-054 R3 rejects. On the **managed lane**,
scope is now enforced by the **credential** — the agent's open-ended ClickUp discovery runs
in-harness under the caller's own per-user OAuth token (Block 3a), so it can never see another
department's data to begin with. `Assemble Task Context (v1)` no longer does open-ended discovery at all; it now
returns only the triggering task's own comments (see §15.5).

> **Least-privilege model (ADR-026).** The durable control is *capability containment*:
> the LLM holds no credentials and no tools (`Invoke Model` is pure prompt→completion),
> so the agent can only do what deterministic, version-controlled n8n nodes are wired to
> do — default **read + draft-comment only**. The Member token is over-privileged
> (defense-in-depth gap): it is the one identity used for all ClickUp I/O. **Custom-field
> writes are permitted** (resolved 2026-06-08) but **only via deterministic nodes/code,
> never a capability exposed to the LLM** — the Agent-Spine `[AI] Koszt akcji [PLN]` write
> (a fixed `SUM(agent_runs.cost_pln)` set-field call) satisfies this. A separate
> telemetry identity was considered and decided against (ADR-026); the single agent
> token is used, scoped by Space membership.

### 13.4 Process knowledge hierarchy

```
Process template (main task)
├── Description: "What this process is, end-to-end flow, success criteria"
├── Stage 1 subtask grouping
│   ├── Description: "Stage rules: tone, constraints, departmental specifics"
│   ├── Step 1 (subtask)
│   │   └── Description: "What to do, checklist, references to docs"
│   └── Step 2 (subtask)
└── Stage 2 subtask grouping
    └── …
```

---

## 14. Queue infrastructure

> **✅ LIVE (ADR-056, 2026-06-26) — BullMQ application queue + thin `queue-consumer` service.**
> §14.2–§14.6 below describe the **as-built** design (they previously described an n8n-queue-mode plan,
> reconciled in Block 6). The application queue is **BullMQ on the existing Redis** (key prefix `haxeq`,
> never colliding with n8n queue mode's `bull:*` — n8n stays in queue mode, the two coexist), fronted by
> the always-on Node service **`queue-consumer`** (`services/queue-consumer/`, container `queue-consumer`
> on `n8n-internal`, `expose:8080` internal only; mirrors `zip-extractor`). Producers `POST /enqueue` and
> return; a BullMQ Worker dequeues by an 8-level priority, enforces concurrency/idempotency, triggers the
> spine via the hardened **Spine HTTP Ingress (v1)** webhook, and owns retry/backoff/dead-letter. All
> `queue.*` knobs live in Supabase `config` behind a fail-safe reader that clamps three silent-failure
> invariants. **Cut over: the one live producer (`CU Webhook Producer`, @-mention) behind
> `config.queue_enabled`** with a synchronous fallback; the daily due-date cron, Gmail watcher, and
> status/field producers are Phase-3/unbuilt and adopt the `/enqueue` contract when built.
>
> **Status:** built and verified across Blocks 0–6 (full record: the master plan + `block-N-findings.md`
> alongside it, and the ADR-056 amendments). Migrations `045`/`046` seed `queue.*` + a write-side
> validating trigger; the `queue-consumer` service (`/enqueue` + priority + fail-safe reader + `/health` +
> `/metrics`), the deterministic-return `Spine HTTP Ingress (v1)`, the real processor (idempotency →
> held-connection spine trigger over `node:http` → ADR-047 classification → retry/backoff/DLQ), the
> `CU Webhook Producer` cutover behind `config.queue_enabled`, and the monitoring layer (depth cron +
> heartbeat dead-man's-switch + daily config-refresh poll) are all live. Block 6 acceptance passed: the
> priority formula computes 8/8 buckets correctly and BullMQ drains them in rank order (explicit 1–4
> before automatic 5–8); a 52-job burst held in-flight at the concurrency cap (no 429/529 storm) with two
> explicit jobs jumping the batch despite being enqueued last; and the negative-config test confirmed all
> three coupled invariants clamp + WARN at startup (concurrency 99→10, lock_duration 120 k→1.02 M,
> spine_timeout 1.2 M→900 k) so bad values never reach the worker. Idempotent-skip and exactly-once
> dead-letter were verified live in Blocks 2–4.

### 14.1 Why a queue

Four problems solved simultaneously:

- **Rate limiting.** Bedrock and ClickUp APIs have per-minute limits. Uncontrolled bursts (50 tasks due at midnight) cause cascading failures. Queue paces execution.
- **Decoupling.** Webhooks must return 200 OK in seconds or ClickUp retries and creates duplicates. Queue lets triggers enqueue and return immediately; workers process at sustainable pace.
- **Priority scheduling.** High-importance work jumps the line. Background batch work (weekly proposer, analysis) never blocks urgent user-triggered work.
- **Retry with backoff.** Transient failures don't kill a run permanently.

### 14.2 Stack — BullMQ application queue + thin `queue-consumer` service

The application queue is **BullMQ on the existing Redis** (`n8n-redis`, redis:7), fronted by a small
always-on Node service **`queue-consumer`** (`services/queue-consumer/`, container `queue-consumer` on
`n8n-internal`, `expose:8080` internal only; mirrors `zip-extractor`). Producers `POST /enqueue` and
return; the consumer's BullMQ **Worker** dequeues by priority, enforces concurrency (= in-flight spine
runs), checks idempotency, triggers the spine via the **`Spine HTTP Ingress (v1)`** held connection, and
owns retry/backoff/dead-letter.

**n8n stays in queue mode; BullMQ coexists on the same Redis by key prefix.** The two queues are at
different layers and do **not** replace each other: **n8n queue mode** (`N8N_EXECUTIONS_MODE=queue`,
`n8n-main` + `n8n-worker`) distributes *n8n executions* for infra/memory isolation (ADR-058); **BullMQ**
admits *agent jobs* (priority, Managed-Agents concurrency, retry/DLQ, idempotency). BullMQ cannot execute
n8n workflows, only trigger them. They never collide: BullMQ uses `prefix: 'haxeq'` (keys
`haxeq:agent-jobs:*`) while n8n queue mode uses the default `bull:*`. The earlier ADR-056 "n8n goes
regular mode" line is **superseded** — regular mode would collapse all executions into `n8n-main`'s heap
(the base64 image path included), a reliability regression, and only becomes clean once image generation
is also containerized (deferred by ADR-055).

All `queue.*` knobs live in Supabase `config` behind the consumer's **fail-safe reader** (single reader;
producers read only `queue.enabled`). The reader clamps + WARNs three coupled invariants at startup and on
the (daily) refresh poll: `concurrency ≤ env_concurrency_cap`, `lock_duration_ms ≥ max_runtime_ms + MARGIN`,
`spine_timeout_ms ≤ lock_duration_ms − MARGIN` (MARGIN = 120 s). Seeds (migrations 045/046, Block-0-measured):
`concurrency=5`, `env_concurrency_cap=10`, `max_runtime_ms=900000` (15 min real ceiling), `spine_timeout_ms=1200000`,
`lock_duration_ms=1500000`.

### 14.3 Priority — 8-level, explicit primary / impact secondary

Priority is a single lexicographic key computed at `/enqueue` (ADR-056 amendment 2026-06-23b), **always
set 1–8** (an unset BullMQ priority breaks ordering; lower number = higher priority):

```
priority = (is_explicit ? 0 : 4) + impact_rank
impact_rank = { Krytycznie ważne:1, Wysoki:2, Średni:3, Niski:4 }   (from [AI] Wpływ)
is_explicit = invocation_type ∈ { explicit_mention, explicit_command }
```

So **every** explicit (interactive) job (1–4) outranks **every** automatic one (5–8); within each class,
higher `[AI] Wpływ` wins. This is contract-shape — a code constant in the consumer, **not** a `config`
knob. Within one priority level: FIFO. (Block 6 verified the formula 8/8 and a scrambled add `[5,2,8,1,6,3,7,4]`
drains `[1..8]`; an automatic `Krytycznie ważne` (5) waits behind an explicit `Niski` (4).)

### 14.4 Admission control — Anthropic Managed Agents limits

The binding constraint is the **Anthropic Managed Agents** capacity, not a per-integration RPM. The live
system uses a single shared pooled environment (`config.managed_agent_environment_id`); the "5 concurrent
environments" limit is on the Environments resource-group, **not** running sessions, which are bounded by
create-session RPM (≈300/min) + ITPM/OTPM — both slack at our scale (ADR-056 Block 0 G1). So BullMQ's
**`concurrency` (C=5, conservative)** caps in-flight spine runs; `env_concurrency_cap=10` is a software
safety-rail the read-side clamp enforces (a fat-finger `concurrency` is clamped, not honored). A BullMQ
token-bucket **`limiter` (`rate_limit_per_min`, default 60)** bounds enqueue→start rate. The 50-tasks-at-midnight
burst is therefore paced at C in-flight, never a 429/529 storm (Block 6 verified max-in-flight held at the
cap). ClickUp/Gmail/Supabase per-call limits are handled inside the spine, not here.

### 14.5 Retry policy

BullMQ `attempts = retry_attempts` (5) with a custom per-attempt backoff `backoff_ms = [60000, 300000,
900000]` (60 s / 5 min / 15 min, last value repeats). Classification (ADR-047), decided by the consumer
from the ingress's deterministic 200 response or the transport outcome:

| Outcome | Action |
|---|---|
| transport error / held-connection timeout / genuine n8n 5xx | **retryable** throw → BullMQ backoff |
| HTTP 200 `status=completed` | job done |
| HTTP 200 `status=failed` (business) / 4xx / unknown status | **`UnrecoverableError`** → dead-letter (no retry) |

The BullMQ `failed` set (`removeOnFail` age 24 h) **is** the dead-letter store; `worker.on('failed')`
posts **exactly one** CRITICAL to the Alerts task on the terminal failure (gated on `UnrecoverableError ||
attemptsMade >= attempts`, so a 5-attempt job alarms once, not per attempt). Business failures stay
`200 + status` (never HTTP 5xx) so the client/BullMQ don't auto-retry a known-bad outcome (double-draft
guard). Idempotency (pre-trigger `agent_runs` check, invocation-class-aware `jobId`) covers the
connection-drops-after-write edge: a retry skips if the prior attempt already drafted.

### 14.6 Queue monitoring

Two layers, both live (ADR-056 Block 5):

- **Depth/health cron** — `Queue Depth Monitor (v1)` (`M48svwpdhDg8l6An`, 5-min) GETs the consumer's
  `GET /metrics` (`getJobCounts` + a consumer-**computed** alert, so thresholds stay in the single reader)
  and forwards a present alert to `Post Alert (v1)`. Backlog alarm is **targeted** so the designed burst
  doesn't false-alarm: CRITICAL at `waiting+delayed ≥ alert_depth_any` (100); WARN at `waiting ≥
  alert_depth_high` (20) **and** `active == 0` (queued but not draining = wedged). Failed-set alarm is
  **edge-triggered** (only on a rise) so it backstops the DLQ alarm without re-firing for the 24 h a
  dead-letter lingers.
- **Heartbeat dead-man's-switch** — the consumer SETs `haxeq:consumer:heartbeat` (TTL = `heartbeat_stale_s`
  = 300 s); a **host** systemd timer (`consumer-heartbeat.{service,timer}`, 5-min, reusing the ADR-046
  `watchdog.env` + Storage Watchdog Intake) checks the key every 5 min and fires CRITICAL if it (or Redis)
  is gone. It lives outside the container, so it survives the consumer dying.

---

## 15. n8n workflows

The system is one generic pipeline (the **Agent Spine**, see *Core model*) plus supporting
crons and a global error handler. This section is the canonical state of what is built in
n8n. Names ending in `(v1)` are live n8n workflows (IDs given); they are **composed**, not
monolithic. Everything below was verified live on the `Lista testy AI` test task `869dhad2q`
unless noted. The build control plane is Claude Code → n8n MCP (ADR-018).

### 15.1 Workflow set and build state

The original design named the core engine a single **"Main Orchestrator"** worker workflow. It is
now realized as a **thin `Agent Orchestrator (v1)`** that runs **Stage A `Assemble Context and Build
Prompt (v1)`**, then **selects the Stage B lane by `config.agent_lane`** (ADR-053 Block 8), then **Stage C
`Post Reply (v1)`** — each with its own execution log and a shared status-reset + alert on failure. Since
the **2026-06-22 cutover (Block 9) the default is the managed lane**: Stage B = **`Execute Agent Session
(v1)` → `Render Agent Output (v1)`** (Anthropic Managed Agents). The earlier **bare** Stage B
(**`Execute LLM Call (v1)`**, the LiteLLM path, commit `ff14622`, ADR-036) is retained as the **dormant
failover** lane, selected by `config.agent_lane='bare'`. The monolithic `Agent Spine (v1)` it replaced is gone.

| Workflow | Role | State |
|---|---|---|
| **`Agent Orchestrator (v1)`** (was "Agent Spine"/"Main Orchestrator", id `a8XKaijkMFNBpRBa`) | Thin orchestrator: set status → **surface router (`Surface = chat?` → task XOR chat Stage-A reader, converge on the surface-agnostic `Call Assemble Context` Merge, ADR-068)** → A → **lane switch (`config.agent_lane`)** → B → C + shared Reset+Alert | **LIVE** |
| **`Assemble Context and Build Prompt (v1)`** (Stage A) | Assemble Parent Context + Assemble Task Context + Build Prompt (research call retired, Block 8) | **LIVE** |
| **`Execute Agent Session (v1)`** (id `Rtb1cZbmUqmfGD98`, Stage B — **managed**) | Anthropic Managed Agents session: resolve tier agent (`agent_routing`) + env → upload input images (Files API) → create/send → poll to idle → service custom-tool loop → session USD cost + enumerate produced docs | **LIVE — default Stage B** |
| **`Render Agent Output (v1)`** (id `vPbbN4UQj0LAAtiV`, managed) | Output adapter: consume the agent's structured `deliver_output` block array (`output_blocks` + `delivered_via_tool`) → `rendered_delta` + `image_manifest` (produced-image bytes from the `agent-output-images` carrier); no parser/repair — loud `no-deliver-output` WARN + text fallback only if the tool was not called (ADR-063) | **LIVE (ADR-063 deployed 2026-06-27)** |
| **`Execute LLM Call (v1)`** (id `9qdJA4xnAGbxqkt9`, Stage B — **bare failover**) | Invoke Model → drafted reply + cost (LiteLLM lane; selected by `config.agent_lane='bare'`). ADR-063 Block 4: consumes the structured `deliver_output` block array (`output_blocks_json` + `delivered_via_tool`) straight from Invoke Model; the tolerant `Parse Output Blocks` free-text parser is **deleted** | **LIVE (dormant failover; ADR-063 deployed 2026-06-27 — bare go-live still gated on refreshing the stale VPS `ANTHROPIC_API_KEY`)** |
| **`Post Reply (v1)`** (Stage C) | Post draft comment, status flip, office-doc + image attachments (owns CU side-effects). The cost-field write moved to the shared `Write Cost Field (v1)` (ADR-057). **Surface router (ADR-068): `surface=='chat'` → `Build Chat Markdown` → threaded chat reply (text/md only, no task status/artifact writes); task surface unchanged.** | **LIVE** |
| **`Write Cost Field (v1)`** (id `GoFPwWsSQOHnrClH`, ADR-057) | Shared cost-field writer called by **both** Stage-B lanes: `SUM(agent_runs.cost_pln)` for the task → write CU `[AI] Koszt akcji [PLN]` → return `{total}` (the cumulative task total for the CU field; the managed footer no longer uses it — it shows the per-execution cost, ADR-060). Fail-soft (DB/CU error → WARN, returns 0) | **LIVE** |
| **`Sync Agent Definitions (v1)`** (id `4K1w78hJ7JhsUwdN`) + **`Agent Rules Freshness Check (v1)`** (id `7lakbgmrH93ygiyZ`) | Bake CU global-rules into the four tier agents' `system` (idempotent create/version-update) + a freshness dead-man's-switch (stale rules → WARN/CRITICAL). Both every 6h | **LIVE** |
| **`Upload Input Images (v1)`** (id `2VkZN5UeqVk6MDLW`) | Fetch task/zip-inner image refs → Anthropic Files API (`purpose=agent`) → `{file_id→url}` map; upserts `agent_input_file_map` for MCP reference resolution | **LIVE** |
| **`Haxe Image MCP (v1)`** (id `c4vnNLb9usfHJWg3`) → **`Image MCP Tool Handler (v1)`** (id `zxY41zZWRbXon2Eq`) → **`Image Tool Handler (v1)`** (id `vpGswBj2kR2D85hl`) | Self-hosted image MCP (n8n MCP Server Trigger, bearer) the agents call in-harness for `generate_image` (ADR-055) → resolves `reference_file_ids` against `agent_input_file_map` by **`file_id` OR `source_ref`** (the agent is only ever shown `source_ref`s, incl. zip-inner `<uuid>.zip:N` — ADR-059) → `Generate Images Parallel (v1)` unchanged → Files-API upload + carrier persist + per-image cost. Client-side `generate_image` custom tool is the dormant rollback | **LIVE** |
| **`Managed Agents Auth Monitor (v1)`** (id `X3GEjMgmByZgDJnt`) + **`Image MCP Health Monitor (v1)`** (id `Er1JlLYAQLkIk7yB`) + **`Fable 5 Access Monitor (v1)`** (id `Moh1coo5pPmuSTmD`) | Dead-man's-switches: Anthropic auth probe (6h), image-MCP `initialize` probe (6h), bare-lane Fable reachability (daily) — all alert via `Post Alert (v1)` | **LIVE** |
| **`Assemble Parent Context (v1)`** | Assemble labelled task context (task + ancestor chain + fields) | **LIVE** |
| **`Invoke Model (v1)`** | Centralized model-call seam: route → LiteLLM → exact PLN cost → log. **Text + multimodal-INPUT only** since ADR-051 Block 5 (image generation moved to `Generate Images Parallel`). ADR-063 Block 4: forces a `deliver_output` tool call on the completion (`tools`+`tool_choice` on the primary/fallback/retry bodies) and `Parse Response` captures the block array from `message.tool_calls[].function.arguments` → `output_blocks_json` + `delivered_via_tool` (one `JSON.parse`, no free-text repair) | **LIVE** |
| **`Generate Images Parallel (v1)`** (id `2keb6XVWq5PG0leK`, ADR-051) | Concurrent image-gen batch: `Promise.all` over a bounded pool (cap `config.image_concurrency_cap`=4) fires all of a run's `generate` images at once (wall-clock ≈ slowest single, not the sum); inline image-resolution (ADR-045) + per-image one-tier-below fallback; reuses `Log Model Run` for per-image cost; returns per-image results + `warnings[]`. Auth via the image-scoped LiteLLM key in Supabase Vault (`get_litellm_image_key()`). Cap raised 4→5 (migration 033). **Block 7 (2026-06-16): timeout is non-blocking** — `Fire Images Concurrently` carries an internal **840 s soft-deadline** (`Promise.race`) that returns partial results (un-generated images → `success:false` + an `image-batch/timeout-partial` WARN, never a CRITICAL) below the raised global **`N8N_RUNNERS_TASK_TIMEOUT=900 s`** (15 min, fits 2 `gpt-image-2` waves); per-call HTTP timeout 240→300 s clamped to remaining budget; a failed/not-generated image now bills **0** (`Explode Results` applies the floor only on success). | **LIVE — the sole image-gen path: `Image Resolver`'s generate branch calls it (Block 4), and `Invoke Model`'s dead image branch was deleted (Block 5, 2026-06-15)** |
| **`Assemble Task Context (v1)`** | Triggering-task comment + threaded-reply fetch (open-ended search + Layer-B retired, ADR-054 Block 3b) | **LIVE** |
| **`CU Webhook Producer (v1)`** | Comment-webhook trigger → verify → detect mention → dedup/loop-breaker → **`queue.enabled`? enqueue (`POST /enqueue`, impact fetched) : synchronous `Run Agent Spine` fallback** (ADR-056 Block 3) | **LIVE (@-mention, queue cutover)** |
| **`Post Alert (v1)`** | Centralized alert seam → ClickUp Alerts task | **LIVE** |
| **`Error Handler (v1)`** | Global `errorWorkflow`: throws → CRITICAL + status rollback | **LIVE** |
| **`FX Rates Daily (v1)`** + **`FX Freshness Monitor (v1)`** | Daily NBP USD/PLN upsert + staleness WARN | **LIVE** |
| **`Storage Watchdog Intake (v1)`** (id `iMJrbyPD7UroQZ1W`) | Header-auth webhook → Post Alert; receives the host disk/DB dead-man's-switch (ADR-046) **and the queue-consumer heartbeat watchdog (ADR-056 Block 5)** | **LIVE** |
| **`Queue Depth Monitor (v1)`** (id `M48svwpdhDg8l6An`, ADR-056 Block 5) | 5-min cron → GET `queue-consumer:8080/metrics` → forwards the consumer-computed depth/health alert to `Post Alert (v1)` (source `queue-consumer/depth`). Backlog CRITICAL at `waiting+delayed ≥ alert_depth_any`, wedged-worker WARN at `waiting ≥ alert_depth_high && active==0`, edge-triggered failed-set WARN; HTTP-unreachable → WARN (the host heartbeat owns the consumer-down CRITICAL). Paired with the **host `consumer-heartbeat.timer`** dead-man's-switch (`infrastructure/systemd/` + `consumer-heartbeat-watchdog.sh`, 1-min, checks the `haxeq:consumer:heartbeat` Redis TTL key) | **LIVE** |
| **`Read Input (v1)`** (id `zgGpONulGMohQQqI`) | Unified multimodal input reader (Blocks 2+3, ADR-036 "Input readers unified"), pure/branch-free: self-fetches `{ clickup_task_id }` → `Classify Attachment` (Switch) → **image** = URL passthrough (skips Docling) / **extractable** = Docling → `Merge` → `{ blocks(text+image, ordered), clickup_task_id, warnings }`. Reader owns ordering; Stage A (Block 5) fires `warnings` via `Post Alert (v1)`. Router + visual reader retired. **ADR-048 Block 1:** a `Lookup File Processing Config` Postgres node (global file limits `config.zip_max_entries`=50 / `zip_max_file_mb`=25 / `zip_max_total_uncompressed_mb`=250, migration 027 seeded 500, lowered to 250 by migration 028 after gate B; see Block 3) hangs off `Get Task` and converges through `Merge`; `Aggregate Blocks` filters it out (no `block` field), so the branch-free terminal is preserved. Block 1 only **surfaced** the limits; **Block 3 enforces them** (the zip guards in `Explode Zip Entries`). **ADR-048 Block 2:** a `Store Zip Image` step (`Zip Image Key` → `Upload Zip Image` → `Sign Zip Image URL` → `Compose Signed URL`) uploads each zip-inner image's **original bytes** to a **private EU Supabase bucket `zip-inner-images`** (project `haxe-agent-prod`, `eu-west-1`) and emits a **6h-TTL signed URL** as the block `ref` — never base64 (the OOM fix: heavy bytes never enter execution data). It is **only for zip-inner images**; loose images keep their ClickUp URL. **Build gate D passed (2026-06-15):** a Supabase signed URL is fetched and read by the provider through LiteLLM end-to-end (Gemini, 1089 image tokens, correct description). **ADR-048 Block 3 (zip unpacking, 2026-06-15):** a `Zip? Switch` after `Explode Attachments` routes a real `.zip` (ext/mime zip, not the no-attachment sentinel) into the zip branch and everything else to `Classify Attachment` unchanged. Zip branch: `Fetch Zip Binary` → `Stamp Zip Filename` (stamps `fileExtension=zip`/`mimeType` so `Decompress` never fails a valid archive for missing metadata — the compression node otherwise throws `File extension not found`, which `continueRegularOutput` would have silently degraded to a `zip_extraction_failed` drop) → `Decompress` (compression node; adm-zip, in-memory per gate B) → `Explode Zip Entries` (fan out each inner file; interleave `order = parentOrder + (i+1)/1000`; `att_id = <parentAttId>:<i>`; apply the global guards — junk silently skipped, nested-zip/oversize/too-many/over-total/corrupt → a pre-tagged `route:drop` item with a `multimodal/zip-*` warn_source). Inner files classify: **image** → the `Store Zip Image` step → `Build Zip Image Block` (same envelope as `Build Image Block`, ref = the Supabase signed URL; drop+warn if storage failed); **document** → a `Merge Extractable` (append) so **one** `Docling Convert` serves both loose and zip docs; **drop** → `Build Dropped Zip Block` (`[BRAK: <reason> <title>]` + warn). `Build Text Block` recovers per-item order/title source-agnostically (`Explode Zip Entries` first, else `Explode Attachments`). `Merge Branches` widened to 5 inputs (image, text, config, zip-image, zip-drop) and still converges into the branch-free `Aggregate Blocks`. **Verified end-to-end (2026-06-15):** a real ClickUp `.zip` (2 docs + 2 images + nested `inner.zip` + `.DS_Store`), run through the reader via the production `When Called` path, produced correctly interleaved blocks — docs as Docling markdown, images as fetchable Supabase signed URLs, the nested zip dropped+warned (`multimodal/zip-nested-skipped`), junk silently skipped. The 24h purge of bucket objects lands in Block 4; Docling tuning in Block 5. Loose image/document paths and `invoke-model.json` are unchanged. **ADR-054 Block 4a (as-U fetch mode, 2026-06-23):** an optional `as_user_token` input routes through an `As User?` IF to a `Get Task (as U)` node (raw-token `Authorization`, no predefined credential → no bot fallback); a denied/out-of-scope fetch → `Build Access Denied` (`clickup-asU/access-denied` warning) → `Merge Branches` (now 6 inputs). Token absent → the bot `Get Task`, byte-identical | **LIVE (Phase 2, input)** |
| **`ClickUp Extract Tool Handler (v1)`** (id `y985MgyA5lCxOFCH`, ADR-054 Block 4b) | Agent-facing **as-U attachment extraction**: reads the caller's classic REST token from Supabase (`get_clickup_rest_token`) → `Read Input (v1)` **as U** on a task id → uploads images via `Upload Input Images (v1)` → returns a `user.custom_tool_result` content array (doc text + image `file_id` blocks). `Execute Agent Session` routes a pending `extract_clickup_task` custom tool here; token-presence guard degrades + WARNs the half-onboarded; `saveDataSuccessExecution:none` (token hygiene). Out-of-scope id → access-denied, never the bot | **LIVE** |
| **`Daily Due-Date Producer (v1)`** (id `Ubwr6fRmStFwwJfP`, ADR-065) | 01:00 Europe/Warsaw cron (+ Form harness): scan ClickUp team tasks, enqueue (`invocation_type=due_date`) one autonomous run per task **due today (Warsaw) AND exactly one assignee AND `Czy dla AI=Tak` AND not closed/done AND no `agent_runs` row yet today (any trigger)**; caller=the single assignee (ADR-054 scope + ADR-064 spend gate free); top-level comment; per-night batch summary + heartbeat via `Post Alert (v1)`; synchronous-spine fallback + WARN if `/enqueue` fails | **BUILT — verified live end-to-end (enqueue + dedup + sync fallback + summary + heartbeat), INACTIVE pending operator activation** |
| **`Due-Date Producer Freshness Monitor (v1)`** (id `q98HgAuUlqxg1CF4`, ADR-065) | Daily 09:00 Warsaw dead-man's switch: WARN if `config.due_date_producer.last_run_at` is missing or older than 26h. **Activate together with the producer** | **BUILT — verified live (fresh + stale paths), INACTIVE** |
| Gmail Email Workflow | Incoming mail → Gmail draft; sent-folder post-send analysis | **Planned (Phase 3)** |
| Weekly Org Proposer | Mon 09:00 cron: synthesize evaluations → org proposals | **Planned (Phase 4)** |
| Session Cleanup | Hourly cron: expire idle `conversation_sessions` | **Planned** |

### 15.2 `Agent Orchestrator (v1)` + Stages A/B/C — the generic engine

`n8n/workflows/agent-orchestrator.json`, n8n id `a8XKaijkMFNBpRBa` (thin; expanded in Block 8 with the
lane-resolution + managed-branch nodes). Entry is
either a Form Trigger (`taskId`, manual testing) or a `When Called` Execute-Workflow trigger (from
the webhook producer). After Stage A + the `Context OK?` guard, **`Read Agent Lane` → `Resolve Lane` →
`Lane = managed?`** routes Stage B: **true** → the managed chain (**ADR-061 Block 2b:** `Build Floor File
Map` → `Upsert File Map (Managed)` first — rebuilds `agent_input_file_map` (`source_ref`→`url`, synthetic
`file_id`) from the floor's `image_blocks_json` so `reference_refs` still resolves now that the eager Files-API
upload is dropped; a write failure routes to `Alert File Map Failed` (WARN) and reconverges, never blocking
the session — then `Call Execute Agent Session` (with `input_images_json='[]'`) → `Session
OK?` → `Call Render Agent Output` → `Call Write Cost Field` → `Sum Execution Image Cost` → `Call Post Reply
(Managed)`, passing `doc_attachments`/`session_id` through to Post Reply's office-doc branch; the comment
footer shows the **per-execution** cost — the session's text cost plus the windowed per-execution image cost
from `Sum Execution Image Cost` (ADR-060), while `Call Write Cost Field` still writes the cumulative CU cost
field (ADR-057 closed the gap where the managed footer + cost field were never written); **false**
→ the bare `Call Execute LLM`. An unreadable/invalid
flag fails safe to bare + `Alert Lane Unreadable` (WARN); a managed session that returns a **non-publishable
outcome** (deadline/terminated/max_rounds/poll_error/empty `delivered`) → `Call Post Reply (Incomplete)`
(Polish incomplete notice, status → Zakończono) + **CRITICAL** `Alert Non-Delivery` (ADR-066 Block 1, never
posts the agent's narration); adapter degradation → `Alert Render Warnings` (WARN) — all via `Post Alert (v1)`. It sets status **W trakcie** on a **parallel fire-and-forget side-branch off
the trigger itself** — so the requester sees "W trakcie" within ~1 s of webhook receipt, not after the
~30 s context build (repositioned 2026-06-11; a status-write failure routes to `Alert Status Failed`
and never blocks the run). In parallel it calls three stage subworkflows in sequence — each a
Call-Workflow node with its own execution log; any stage's `onError` routes to one shared **Reset
Status + Alert** path (ADR-032), replacing the earlier per-node alert sprawl. A **`Context OK?` guard**
sits between Stage A and Stage B: Stage A runs with `alwaysOutputData`, so if it returns no `prompt`
the run stops loudly at **`Alert Context Empty` (CRITICAL)** instead of silently skipping the model +
reply; likewise the `If LLM Succeeded?` false branch now fires **`Alert LLM Failed` (CRITICAL)** on an
empty completion (both added 2026-06-11 after a zero-attachment task silently produced no reply — see
ADR-036 Block-5 follow-up). The five Core-model steps are distributed across the stages:

- **Stage A — `Assemble Context and Build Prompt (v1)`** (`n8n/workflows/assemble-context-and-build-prompt.json`,
  id `GGTBvFBgGSNbtUR6`, 15 nodes): **`Read Lane (Stage A)`** (reads `config.agent_lane`, fail-safe to `bare`) →
  `Assemble Parent Context (v1)` → Assemble Task Context
  (now also fetches **threaded comment replies** — `GET /comment/{id}/reply` per top-30 comment with
  `reply_count>0` — and interleaves them under their parent in `task_comments`, ADR-040) →
  Load Agent Rules → **`Read Input (v1)`** → `Build Prompt` (the `Decide Research` web-research call was
  retired in ADR-053 Block 8 — web search is in-harness on the managed lane). Returns the prompt payload +
  assembled context, plus **`image_blocks_json`** (input image refs for the vision model, non-PD) and
  `input_warnings_*`. **ADR-061 Block 1 — lane-aware floor (managed lane):** `Build Prompt` now emits only the
  bounded **floor** (personal prefs + triggering comment + impact line + task title — **ADR-061 Block 2c follow-on:
  the task DESCRIPTION is no longer eager on the managed lane; the floor shows the title plus a hint to call
  `get_task_details`, which pulls the full description on demand**; input images stay
  eager) and **drops the unbounded tail** — comment thread, ancestor bodies, linked-doc leaves, semantic-search
  context, attachment **text**, and the per-run global-rules fold (which duplicated the rules already baked verbatim
  into the cached agent `system`; the managed agent still gets them, kept current by Sync Agent Definitions + the
  Freshness Check). The **bare** failover lane is unchanged (full assembly), gated on the lane read. **ADR-061 Block 2**
  turned that dropped tail into four pull-on-demand custom tools the managed agent calls on the retained session loop
  (`get_task_comments`, `get_parent_chain`, `list_attachments`, `get_attachment` — see Stage B). **ADR-061 Block 2b — lazy attachments floor (Option E):** on the managed lane `Build Prompt` no longer
  calls `Read Input`/Docling at all — a new **`Is Managed? (Stage A)`** IF routes managed to **`Fetch Attachment
  Index (Stage A)`** (bot `GET /task` — ClickUp's native attachment index; no extraction, no eager Files-API
  upload) and bare to `Read Input` (unchanged), reconverging at **`Merge Input Source`**. The managed
  `image_blocks_json` is built from that index (top-level images only); the `# Załączone obrazy` section lists
  them (ref + name) but no longer preloads them as vision — the agent calls `get_attachment` to see one.
  `embed_input` (render) and `reference_refs` (image generation) still resolve round-trip-free: the orchestrator
  writes `agent_input_file_map` (`source_ref`→`url`, synthetic `file_id`) from the same floor metadata and sets
  the session's `input_images_json='[]'` (so the in-session eager Files-API upload becomes a no-op). The **bare**
  failover keeps full eager assembly. zip-internal images remain an accepted *output*-path regression (Block 2c made
  them seeable as vision via `get_attachment("<zip>:<idx>")` and browsable via the nested `list_attachments` manifest,
  but they are still not wired into `embed_input`/`reference_file_ids`). Folds attachment **text** into the prompt (bare lane only) and fires the reader's `warnings` via
  `Post Alert (v1)` on a reconverging side branch (`Return Context` stays the sole terminal). Multimodal
  input (ADR-036/038/040 Block 5): images present → `modality='multimodal_input'` set on the context payload →
  routing returns the **Gemini** alias for all multimodal tasks (`haxe-gemini-flash`/`-pro` by tier; ADR-043
  made Gemini the active multimodal route, superseding both the former "PD guard drops images" stance and the
  Claude-direct vision path).
- **Stage B (managed, default) — `Execute Agent Session (v1)` → `Render Agent Output (v1)`** (ADR-053/055):
  resolve the tier agent from `agent_routing` (Niski→Haiku, Średni→Sonnet, Wysoki→Opus, Krytycznie ważne→Opus
  — Fable repointed) bound to the persistent environment; upload input images to the Files API (**ADR-061
  Block 2b: a no-op on the managed lane — the orchestrator now passes `input_images_json='[]'`, so input-image
  vision is pulled lazily via `get_attachment` instead of preloaded**); create + send
  the session; poll to idle (web search, code execution, Skills run in-harness; the client-side custom-tool
  loop services `extract_clickup_task` (ADR-054) and, **ADR-061 Block 2 + 2c**, the five triggering-task **tail tools**
  — `get_task_comments`, `get_parent_chain`, `list_attachments`, `get_attachment`, and `get_task_details` (the last
  added by the Block 2c follow-on: a bot `GET /task` returning the task's own title/description/status, so the floor
  can drop the eager description) — routed by a new `Is tail tool?`
  branch to **`Triggering Task Tail Handler (v1)`** (`Ouo0BlYOw92DUXIh`). That one handler switches on the tool name
  to the right reused reader (`Assemble Task Context`/`Assemble Parent Context`/a bot `GET /task` index/`Read Input`
  single-attachment + `Upload Input Images`), all on the **bot token** and **pinned to the carried `clickup_task_id`**
  (the agent supplies only `limit`/`since`/`depth`/`attachment_id`, never a task id — so it cannot widen scope past the
  triggering task; other-task discovery stays on the per-user scoped `clickup_*` MCP). A failed pull WARNs via
  `Post Alert (v1)` on a side branch and returns a structured error to the agent (never a silent empty); the handler's
  return path is a single branch-free terminal. **ADR-061 Block 2c (progressive zip disclosure):** `list_attachments`
  now nests each ZIP attachment's inner manifest inline — one `manifest_only` `zip-extractor` call per zip (central-
  directory walk: names/sizes/types, **no** byte read / Docling / upload) — listing every inner file as
  `attachment_id="<zip>:<idx>"`; `get_attachment("<zip>:<idx>")` materializes **exactly that one** inner file (the
  extractor's `only_index` mode, via `Read Input`'s `only_att_id` base-id+inner-index parse) and returns it as text
  (Docling) or vision. Entry `index` is assigned to every non-junk entry **before** the size caps, so it is stable
  between the cheap manifest and the single-entry pull. A zip-inner **image** is thus seeable as vision, but is still
  **not** wired into `embed_input`/`reference_file_ids` (those resolve only against the floor's top-level
  attachment metadata). The image branch stays dormant (image generation runs via the MCP
  server); compute the session USD cost; enumerate produced office-docs. `Render Agent Output (v1)` then turns the
  agent's structured `deliver_output` block array (`output_blocks`, ADR-063) into the Post Reply contract
  (`rendered_delta` + `image_manifest`, fetching produced images from the carrier). Verified live across text /
  web-research / image-gen / vision / office-doc (Block 9).
  **ADR-061 Block 3 — end-to-end + scope verified (2026-06-26, ADR-061 Accepted):** the full spine was
  driven via the orchestrator `When Called` with the producer's exact inputs on the heavy test task
  `869dux9ne`. A **trivial-on-heavy** "2+2" run produced a **floor-only** Stage A prompt (~5.4k chars /
  ~1.35k tok — prefs + triggering comment + impact + title + `get_task_details` hint, no description/
  comments/attachment text), ran a **single session turn with zero tail tools** (`input_tokens=2`,
  `cache_read=0`), and answered correctly — the 100k→floor win realized (the rules live in the cached
  `system`, so only **2 uncached input tokens**). A **heavy** 4-part request drove **four** agent-chosen
  tail round-trips through `Triggering Task Tail Handler (v1)` — `get_task_details`, `list_attachments`
  (zip manifests nested), `get_task_comments`, and `get_attachment("<zip>:<idx>")` (exactly one inner
  PNG as vision) — answered all parts correctly with `cache_read=98299` re-read across the loop
  (the cached prefix benefits every tool round-trip). Other-task discovery stayed per-user scoped
  (the bot-token triggering-task tools take `clickup_task_id` from n8n, never agent input, so scope can't
  widen); 0 CRITICAL / 0 WARN, drift clean (38/38), cost rows attributed via `Log Model Run`. The
  **tier-additive cached system prefix** (ADR-061 decision detail 3) is deferred to **ADR-062** (Proposed).
- **Stage B (bare, dormant failover) — `Execute LLM Call (v1)`** (`n8n/workflows/execute-llm-call.json`, id `9qdJA4xnAGbxqkt9`,
  9 nodes): `Invoke Model (v1)` → drafted reply + cost; forwards `image_blocks_json` to Invoke Model.
  **Structured output (ADR-063 Block 4, supersedes the Block-12 free-text protocol):** `Invoke Model (v1)` forces a
  `deliver_output` tool call and returns the block array as `output_blocks_json` + `delivered_via_tool`, so
  Stage B runs `Call Invoke Model → Call Image Resolver (znDqcfgXK6CNte20) → Call Write Cost Field (GoFPwWsSQOHnrClH, the shared field writer) →
  [Has Warnings? → Alert Resolver Warnings] → Return LLM Result` (sole terminal). The resolver is called
  **before** the cost write so per-`generate` `image_gen` rows are counted; `Return LLM Result` carries
  `rendered_delta` / `image_manifest` /
  `image_models` / `total_image_cost_pln` to Stage C; resolver `warnings[]` fire a WARN (`multimodal/resolver`)
  on a reconverging branch. A resolver throw propagates to the global Error Handler (CRITICAL, no partial post).
  The return path stays a single branch-free terminal (fixes the ADR-036 Block-5 return-determinism bug, where
  the parallel cost-sync branch's empty output could be returned instead, silently dropping the draft).
- **Stage C — `Post Reply (v1)`** (`n8n/workflows/post-reply.json`, id `t17moGs7Vxo5ZcFv`, 9 nodes):
  posts the thread-aware draft comment, writes the cost field, flips status **W trakcie → Zakończono**.
  C owns every ClickUp side-effect (comment, cost, status, and — once multimodal lands, ADR-036 —
  image upload + temp cleanup).

- **Input file handling v2 — `.zip` unpacking + zip-inner-image object storage (ADR-048; all blocks
  landed 2026-06-15).** `Read Input (v1)` now unpacks a `.zip` attachment
  instead of degrading it to `[BRAK]` (supersedes the ADR-036 `.zip`-unsupported note). **Extraction runs
  off the n8n worker (ADR-058, rewired 2026-06-24).** After `Explode Attachments` a `Zip?` switch routes
  archives through `Zip Caps → Call Extractor → Fan Manifest`: `Call Extractor` POSTs the zip's pre-signed
  URL to the **`zip-extractor` container** (`http://zip-extractor:8080/extract`), which streams the archive
  to disk and walks it **one entry at a time** — the n8n worker never decompresses anything, so the
  in-memory-decompress OOM (the 2026-06-24 07:30 worker-kill cascade) is impossible by construction. The
  extractor uploads each accepted entry to the bucket and returns a manifest; `Fan Manifest` fans it into one
  item per entry at the parent zip's interleaved ordinal, feeding the **unchanged** `Classify Zip Entry`
  three-way fan; everything else (including the no-attachment sentinel) flows to `Classify Attachment`
  unchanged. **ADR-061 Block 2c** added two cheaper `POST /extract` modes sharing the same entry walk: `manifest_only`
  (central-directory walk — names/sizes/types/`<zip>:<idx>` att_ids, no read/upload/sign; used by the tail handler's
  `list_attachments` to nest a zip's inner index) and `only_index=N` (materialize just one inner entry; used by
  `get_attachment("<zip>:<idx>")` via `Read Input`'s `only_att_id`). An entry's `index` is assigned before the caps,
  so it is identical across all three modes — a manifest-listed `<zip>:<idx>` is a valid single-pull argument. The
  full materialize-all contract (this bare-lane / `extract_clickup_task` / Stage-A path) is unchanged. The caps come from **live `config`**: an `Await Caps` merge barrier on the spine
  (`Explode Attachments → Await Caps → Zip? Switch`, with `Lookup File Processing Config` as its second
  input) forces `Lookup` to execute before the zip branch — n8n's v1 order otherwise defers that parallel
  side-branch to last, so `Zip Caps` would read an unexecuted node, throw, and silently fall back to
  defaults. `Zip Caps` reads the now-guaranteed config (emitting `caps_source: 'config'`; a `'default'`
  50/25/250 fallback remains only for a genuine DB-read failure, and is visible in the execution data). Inner **images** become a **private EU Supabase Storage bucket
  `zip-inner-images`** (`haxe-agent-prod` / `eu-west-1`) object referenced **only by a short-TTL signed
  URL** — the heavy bytes never enter execution data (the rejected v1 inlined base64). Inner **documents**
  are fetched from their signed URL one at a time (`Fetch Zip Doc Binary → Stamp Zip Doc Filename`, the
  latter restoring the extension-less object's filename so Docling detects PDF/DOCX/XLSX/HTML) and join the
  shared Docling path; junk is silently skipped; nested-zip / oversize / too-many / over-total degrade to
  `[BRAK]` blocks carrying `multimodal/zip-*` WARNs through `Post Alert (v1)`. The old in-workflow chain
  (`Fetch Zip Binary → Stamp Zip Filename → Decompress → Explode Zip Entries`) and the per-image
  upload/sign nodes (`Zip Image Key → Upload Zip Image → Sign Zip Image URL → Compose Signed URL`) were
  **removed** — the extractor does upload+sign server-side.
  **Loose images and loose documents are byte-for-byte unchanged** (loose images keep their ClickUp URL — no
  Supabase involvement), and **`invoke-model.json` is untouched**: a Supabase URL is a drop-in for the existing
  image ref. File limits live in the **global `file_processing_config`** keys (migration 027): `zip_max_entries`
  50, `zip_max_file_mb` 25, `zip_max_total_uncompressed_mb` **250** (migration 028 lowered it 500 → 250 when extraction
  was in-memory; now a forwarded bound the off-worker extractor enforces per-entry, so the value is a policy
  cap, no longer a memory constraint). **Retention (Block 4; ADR-058 Block 3):** the bucket holds **both**
  zip-inner images **and** zip-inner documents (same extension-less key shape, indistinguishable by key), and
  both are purged by the **pg_cron job `purge-zip-inner-images`** (migrations 029 → 030) — which selects by
  bucket + age with **no object-type filter**, so documents and images are covered identically — that deletes
  through the **Storage REST API so the bytes are freed, not orphaned** — a bare `delete from storage.objects` would drop the metadata row but
  leave the S3 object (and the personal data) behind. The job reads its key from **Supabase Vault** (a legacy
  `service_role` JWT or a new `sb_secret_…` key both work); a missing/invalid key writes a `SKIPPED` row to
  `storage_purge_runs` rather than silently no-op'ing. Schedule (operator decision, 2026-06-15): runs **once
  daily at 05:00 Europe/Warsaw**, deleting objects older than **12h** — the 12h floor guarantees an in-flight
  run's attachment is never deleted mid-process; pg_cron has no per-job timezone, so the job fires at 03:00 and
  04:00 UTC and an in-function `Europe/Warsaw` hour-gate makes exactly one fire act (DST-correct). Consequence:
  once-daily + a 12h floor lets evening/overnight files live up to **~36h** (documented in the GDPR record;
  ≤24h would need more than one run/day). A **dead-man's-switch independent of pg_cron** — the n8n
  **`Zip Image Purge Watchdog (v1)`** (`2L4W4OQ7Qmmnl1Z1`), every 6h — WARNs through `Post Alert (v1)` if any
  object exceeds **40h** (healthy ceiling ~36h; catches cron-stopped, function-errored, or Vault-key-missing/invalid
  alike). **Docling tuning (Block 5):** the shared Docling path runs `do_ocr=false` + `table_mode=fast` (measured
  byte-identical to the heavy defaults on real digital PDFs/XLSX, ~50–67 % faster), with a **two-pass OCR fallback**
  (`OCR Empty? → Restore Doc Binary → Docling OCR Retry`, converged via `Merge OCR Result`) so scanned/image-only
  PDFs still extract; `docling:5001` is pinned to a 2-worker × 2-thread concurrency bound (repo + VPS compose) so a
  multi-document zip burst can't saturate the box. See ADR-048.

- **`Build Prompt`** (Code, stub assembler) composes one prompt string, **lane-aware** (ADR-061 Block 1).
  On the **bare** lane it folds, in order: the **GLOBAL agent-rules doc + the caller's personal
  agent-preferences doc** (CU Docs v3, `q7wz-16892`); the **triggering comment** ("Wiadomość wywołująca tę
  akcję", placed *before* task context so the agent acts on what was written, not a cold re-run of the task
  description); the **`Assemble Task Context (v1)`** context (the triggering task's own comments + threaded
  replies); then the **task context** (task + ancestor chain) and attachment text. On the **managed** lane it
  folds only the **floor**: the **personal** prefs (per-caller — cannot be cached in the shared `system`), the
  triggering comment, an **impact line** (`# Waga zadania`), the task title (**the description is pulled lazily via
  `get_task_details` — Block 2c follow-on; only the title stays eager**), and the input image **list** (lazy vision
  via `get_attachment` — Block 2b). The **global rules are dropped**
  on the managed lane because Sync Agent Definitions already bakes the same `q7wz-44812` page verbatim into the
  cached agent `system` (provenance `source=clickup:q7wz-44812`); folding them per-run was a pure ~3.5k-tok
  duplicate. **Consequence:** post-ADR-061 the managed lane's rules currency relies entirely on Sync Agent
  Definitions + the **Agent Rules Freshness Check (v1)** (which WARNs on doc↔`system` hash drift *or* a stalled
  sync) — the per-run fold no longer provides a fresh-every-run safety net. The lane is read by the new
  `Read Lane (Stage A)` Postgres node (fail-safe to `bare`/full on any DB error, so a managed run is never
  starved of context). Measured floor on a real task (exec 3835, task `869dux9ne`): ~3.4k tok vs ~9.6k before.
  It emits a soft output structure — **Wyniki / Pytania / Decyzje / Sugestie** (§13.1) — as guidance, not a hard template.
- **Status lifecycle:** `[AI] Status agenta` flips **W trakcie → Zakończono** around the run —
  **W trakcie** is set immediately off the trigger (up-front feedback to the requester),
  **Zakończono** by Stage C on completion. The pipeline **never finalizes** — it never sets a done
  status on the task itself nor writes
  `[AI] Finalny, zaakceptowany efekt`.
- **Cost field:** writes `[AI] Koszt akcji [PLN]` = `SUM(agent_runs.cost_pln)` for the task
  (idempotent, drift-free) via the shared **`Write Cost Field (v1)`** sub-workflow, called by **both**
  Stage-B lanes — the bare lane in-workflow, the managed lane from the orchestrator after the session
  (ADR-057; before that the managed lane wrote neither the field nor the footer, so moodboard/image
  runs showed `0.0000`/blank). Managed **image-gen**
  cost rows are now attributed to the task: the agent passes `clickup_task_id` as a `generate_image` MCP
  tool argument (the only channel — the MCP boundary exposes no session context, ADR-055/Block 5.1), so
  the image cost is included in this per-task SUM. If the model omits the id, that image's cost falls back
  to a `null` task id and an `image-mcp/missing-task-id` WARN fires (ADR-057 Amendment, closed 2026-06-24).
- **Comment footer (per-execution, ADR-060):** the managed footer shows **this execution's** cost,
  not the task cumulative. It is `cost_pln` (the session's own text/runtime/web-search PLN cost, surfaced
  out of `Execute Agent Session`) **plus** the per-execution image cost — a windowed
  `SUM(agent_runs.cost_pln)` over `triggered_by='image_mcp'` rows for the task with `created_at >= since_ts`
  (a timestamp the orchestrator captures in `Resolve Lane` **before** the session runs), computed by the
  `Sum Execution Image Cost` node and passed to Post Reply as `total_image_cost_pln`. This **supersedes**
  ADR-057's choice to source the managed footer from the cumulative task `SUM` (which made every reply show
  the running total). A reliability guard (`Img Cost Missing?` → `agent-orchestrator/image-cost` WARN) fires
  if images were delivered but the windowed image cost summed to 0. Known limit: two concurrent runs on the
  **same** task overlap windows and can cross-count (rare; ADR-060).
  ⚠ This uses the
  edit-capable agent **Member** token via a fixed deterministic node (never an LLM-exposed capability,
  per ADR-026) — flagged for the ADR-026 identity split.
- **Reliability:** post-back, cost-sync, and session-upsert failures fire a WARN on a side
  branch and **do not abort the run** (the completion is still returned). `Error Handler (v1)`
  is set as the `errorWorkflow` on the orchestrator and each stage subworkflow.

See ADR-027 (post-back) and ADR-015 (generic pipeline).

### 15.3 `Assemble Parent Context (v1)`

> Renamed 2026-06-23 from **`Context Gather (v1)`** (display name + repo file
> `context-gather.json` → `assemble-parent-context.json`; n8n id and callers — which reference it
> by id — are unchanged). Historical ADRs (e.g. ADR-020) keep the old name/path.

`n8n/workflows/assemble-parent-context.json`, n8n id `qgM37HdQj78Rn090`. Callable via Form Trigger
(`taskId`) or an Execute-Workflow trigger. Reads a ClickUp task and assembles a labelled
context object: `current_task`, ordered `ancestor_chain`, stub `linked_doc_leaves`,
`truncated_at_depth`. Shape = a bounded unroll of native ClickUp `Task→Get` fetches gated by
IF nodes → a pure Code shaping node (authenticated I/O in credential-aware nodes; Code only
shapes data — ADR-019). It also resolves the **impact** custom field to its label and returns
the task **assignee/creator** (data-ready for the autonomous caller = assignee→creator→skip
rule). Verified: a 3–4-level subtask returns an ordered ancestor chain; a root task returns
`[]`; `markdown_description` flows through (`includeMarkdownDescription`). Read-only. See
ADR-020 (shape).

**Agent Doc access (resolved, ADR-004 2026-06-03 update):** the agent `clickUpApi` token reads
CU Docs via the **Docs v3 API** (`GET /api/v3/workspaces/{ws}/docs/{doc_id}/pages`, full
content) — config docs and leaf docs alike. Embedded doc links arrive in a task's
`markdown_description` as parseable `[Label](…/docs/{doc_id}/{page_id})` URLs, so
`linked_doc_leaves` resolves by regex-extract → Docs v3 GET → flatten (the earlier "no access"
was a task-node link-rendering / pre-grant artifact).

> **Block 13 — model-inferred image resolution (DONE 2026-06-13, ADR-045).** Extraction surface = the
> drafting model emits an optional per-block `size:"WxH"` in the output-block contract (no new `[AI]` field,
> no inline command); Build Prompt instructs it to do so only when the user asks for a specific resolution,
> the resolver threads `size`→`requested_size`, and `Resolve Routing` validates against **gpt-image-2's real
> constraints** (edges ÷16, aspect 1:3–3:1, ≤3840 px edge, 655 360–8 294 400 px) — honoring a valid explicit
> size **exactly**, snapping to nearest-valid only on a real violation (+ an honest Polish note rendered inline
> + `invoke-model/size-snapped` WARN). Verified live: `1280x512` on Krytycznie → gpt-image-2 returned an exact
> 1280×512 (decoded), priced row, posted inline, no snap/WARN.
> **Gemini tiers + shape intent → model upgrade (Block 13b/c).** Vertex gemini image (Niski/Średni) can't honor
> `size` *or* `aspect` through the gateway (LiteLLM drops `imageConfig` → ~1:1 1K; a non-square probe returned
> 1024×1024). So whenever a request carries **shape intent — an explicit `size` OR a non-square `aspect`** — on a
> gemini tier, `Resolve Routing` **upgrades the image model to gpt-image-2** (which honors both), keeps the tier's
> low `image_quality` for cost, and informs the user inline + `invoke-model/resolution-adjusted` WARN. So explicit
> resolution **and** aspect are now honored on **every tier**. Verified: Niski 1280×512 → exact 1280×512 ($0.0024);
> Niski `16:9` with no pixels → 1104×624 widescreen ($0.0036) — not the square gemini would return. A 1:1/no-shape
> request correctly stays on the cheaper gemini default. An interim *reverse* design (reroute gpt→gemini) was built
> and **reversed** once probing proved gpt-image-2 is the resolution-flexible model. *Follow-up (optional, cost):* a
> native Vertex `generateContent` path would let the gemini tiers honor aspect directly, avoiding the gpt-image-2
> upgrade cost on low-tier shaped images.

### 15.4 `Invoke Model (v1)` — routing + exact cost

`n8n/workflows/invoke-model.json`, n8n id `XcOIVdZnVCCWNPeb`. The ADR-013 model-call seam,
running on the self-hosted **LiteLLM gateway** (`litellm` container, `127.0.0.1:4000`, v1.87.0
pinned by digest; ADR-024/030). **Text + multimodal-INPUT only** — since ADR-051 Block 5 (2026-06-15)
image OUTPUT generation lives solely in `Generate Images Parallel (v1)`, so this workflow's dead
`requested_modality_of_output='image'` branch (`Output Is Image?` fork, `Resolve Lower Tier Image` →
`Lookup Fallback Image Prices` → `Call Model Image` → `Parse Image`, and the `Image Degraded?` /
`Cost Header Missing?` image alerts) was deleted. Typed Execute-Workflow contract (`prompt` / `impact` /
`modality` / `task_type`; `image_blocks_json` for input image refs; the `requested_modality_of_output` /
`requested_size` / `aspect` inputs remain on the `When Called` node but are **inert** — no caller sends
`image` any more). Node chain:

`Lookup Routing` (Supabase `model_routing`, composite PK `(impact, modality)`, `__default__` fail-safe row,
DB-error tolerant) → `Resolve Routing` (in-code Sonnet last-resort + deliberation-nudge prepend; builds the
`messages` array — text plus any `image_url` input parts) → `Resolve Lower Tier Text` → `Call Model Text`
(the shared fallback seam `Call Model with Fallback (v1)`, `/v1/chat/completions`, `success_path` empty;
ADR-047 Block B — tries the routed model then one tier below) → `Parse Response`, with the seam's both-down
throw routed to `Retry Text-Only` (Opus text-only safety net, Block 6). → **`Normalize Model Result`**
(one uniform schema) → `Call Log Model Run` (the sole `agent_runs` writer + FX/PLN, ADR-035) → degradation
chain (`Image Unprocessable?` — the multimodal-INPUT degradation WARN, see below — then `Routing Missing?`
and `Check Degradation`, each WARN reconverging) → **`Shape Output`** (sole branch-free leaf; union return
`{ completion, output_modality:'text', model, provider, cost_pln, usd_cost, … }`; the vestigial image fields
`b64_json`/`size`/`degraded` are always null/empty/false now).
The native AWS Bedrock node + `Basic LLM Chain` are **retained disabled** as a fallback path (a generic AWS
credential + HTTP Request cannot sign Bedrock — only the native node can; ADR-021).

- **Provider routing (PD-blind — ADR-043/042):** one row per `(impact, modality)`, three legs by modality:
  - `modality='text'` → **Anthropic direct**: `haxe-haiku-4-5-direct`, `haxe-sonnet-4-6-direct`,
    `haxe-opus-4-8-direct`, `haxe-fable-5-direct`. Auth: `ANTHROPIC_API_KEY`. (A PDF/DOCX task is read as
    text via Docling, so it routes here, not to multimodal_input.)
  - `modality='multimodal_input'` → **Vertex AI Gemini (global)**: `haxe-gemini-flash`
    (`vertex_ai/gemini-3.5-flash`) for `n/d`/`Niski`/`Średni`, `haxe-gemini-pro`
    (`vertex_ai/gemini-3.1-pro-preview`) for `Wysoki`/`Krytycznie ważne` (ADR-042). This is the **active**
    multimodal route (operator decision, ADR-043). Auth: ADC via `/secrets/vertex-key.json`. Transfer
    basis: Vertex AI DPA+SCCs (ADR-043). `Parse Response` detects Gemini aliases → sets provider
    `'litellm/vertex'`. ⚠ Gemini 3.x uses **thinking tokens** billed on top of text: ~65 reasoning + 1 text
    tokens per one-word reply (Flash), ~133 + 1 (Pro); bounded per-model via `reasoning_effort` (ADR-042).
    Real task cost will exceed text-token count alone.
  - `modality='image'` → **image-generation tiers, now consumed by `Generate Images Parallel (v1)` (ADR-051),
    not Invoke Model.** The `model_routing` image rows stay the source of truth — Niski/__default__
    `vertex_ai/gemini-2.5-flash-image`, Średni `vertex_ai/gemini-3-pro-image-preview`, Wysoki/Krytycznie
    `openai/gpt-image-2` (ADR-036 Block 8, migration 023) — and the batch reads them per `(impact, modality)`,
    owning the `/v1/images/generations` HTTP call, per-image one-tier-below fallback, and cost (live header →
    token-math via migration 024's `price_out` — flash 0.030 / pro 0.120 / gpt-image-2 0.030 — → per-image
    `fallback_price_per_unit` floor). The old `invoke-model/image-degrade` and
    `invoke-model/image-cost-header-missing` alerts left with the deleted branch; the batch now surfaces these
    as per-image `warnings[]` that the resolver folds in (ADR-051 Blocks 3–4). gpt-image-2 high ≈ 176 s;
    gemini ≈ 5 s. `agent_runs.model_used` stores the versioned model ID from the LiteLLM response body.
    Migrations 008 (composite PK), 013 (image tiers), 014 (Gemini multimodal), 020 (max_tokens by tier),
    **021 — PD-blind collapse to `(impact, modality)`, Bedrock rows dropped, Gemini aliases renamed `-eu`→none**,
    **023 — image-gen tiers refreshed to gemini-image + gpt-image-2 (Block 8)**, **024 — image token prices for
    token-math**, **031/033 — `config.image_concurrency_cap` (=5)**, **032 — Vault image-key getter
    `get_litellm_image_key()`** — all applied.
- **Impact → tier (ADR-023):** `Niski`→Haiku 4.5, `Średni`→Sonnet 4.6, `Wysoki`→Opus,
  `Krytycznie ważne`→Opus at temp 0.2 / 16k tokens with a prepended deliberation nudge;
  `n/d`/empty/unknown→Sonnet (fail-safe).
- **0-row routing guard (ADR-041):** `Lookup Routing`'s `onError:continueErrorOutput` catches DB
  *errors* but **not** an empty result (0 rows is a success) — which previously let `Resolve Routing`
  skip on 0 items and silently null the whole chain (no reply, no alert). Now `Lookup Routing` has
  `alwaysOutputData:true` (so `Resolve Routing` always runs its safety-net) and a `routing_row_missing`
  flag fires **`Alert Routing Missing` (CRITICAL, `invoke-model/routing`)** naming the unmatched
  impact×modality combo — loud but non-blocking (it reconverges to `Check Degradation`;
  `Shape Output` stays the sole leaf). Migration 019 closed the specific gap that triggered it: the
  `n/d - zadanie nie jest dla AI` tier had no `multimodal_input` row, so a not-for-AI task *with an
  image* matched nothing. It now routes to `haxe-gemini-flash` (Gemini, the active multimodal route). The PK is
  `(impact, modality)` after migration 021.
- **`max_tokens` by tier (migration 020):** `max_tokens` is the **output/completion** cap only — it
  does **not** limit input/context (the context window does). Reasoning models (Gemini 3.x, Fable 5)
  count thinking tokens against it, which is why the former 4000 truncated gemini-flash to an empty
  completion. Re-baselined per impact tier: **Niski 8k, Średni 16k, Wysoki + Krytycznie ważne 32k**;
  `n/d` and `__default__` default to 8k; image-generation rows (`modality='image'`) untouched. NB the
  in-code last-resort fallback in `Resolve Routing` (no row matched / DB down) is still hard-coded to 4000.
- **Gemini thinking level (ADR-042):** Gemini 3.x are reasoning models whose **thinking tokens count as
  output** and against `max_tokens`, and Flash **defaults to `thinkingLevel=high`** — which burned
  3.8k–7.7k tokens and truncated the answer to empty at the 8k cap. Bounded via `reasoning_effort` in
  `litellm-config.yaml` `litellm_params`: **flash → `low`** (lower tiers), **pro → `high`** (higher
  tiers). LiteLLM maps `reasoning_effort` → `thinkingLevel`. Config is mounted into the `litellm`
  container; deploy via `scp` + `docker compose up -d litellm`.
  "Max effort" is approximated via temperature +
  max-tokens + the nudge (the native node exposes no reasoning-budget parameter). **Caveat:**
  newer Opus (4.6/4.7/4.8) is granted on Anthropic direct (`opus-4-8`) but **not** on the
  Bedrock account, so the Bedrock Opus tier uses 4.5 until access is requested on the Bedrock
  Model-access page (then bump one constant). All profiles are EU-resident.
- **Cost:** `x-litellm-response-cost` USD header × latest `fx_rates.rate` (daily NBP USD/PLN) =
  `cost_pln`; if the header is missing, fall back to `model_routing` USD prices and fire a
  `cost-missing` WARN. Token counts come exact from the gateway. Logged to `agent_runs` (live
  cols: `model_used`, `impact`, `input/output_tokens`, `cost_pln`, …; no `provider` col;
  `triggered_by` NOT NULL). Fail-safe: DB-down → `haxe-sonnet-4-6-direct` + WARN.
- **Multimodal input (ADR-036 Block 5):** `Resolve Routing` builds the `messages` array with content as
  **one shape — always an array**: `[{type:'text', text:prompt}]` plus `{type:'image_url', image_url:{url:
  <clickup_url>}}` parts when the caller passes `image_blocks_json` (input image refs from `Read Input
  (v1)`). LiteLLM fetches the URLs (no bytes cross workflow boundaries; ADR-036 reference-not-bytes). The
  routed multimodal model is **Gemini** (flash/pro by tier, ADR-042/043); the text seam (`Call Model Text`)
  sends the image-bearing messages with the primary model, and one-tier-below as the seam fallback.
- **Unprocessable-image robustness (ADR-036 Block 6, PD-blind per ADR-043) — DONE; reached via the seam
  (ADR-047 Block B).** A corrupt/1×1 input image (or a hypothetical non-vision routed model) 4xxs the whole
  request. A **final text-only safety net** closes it: `Call Model Text` (the seam tries the routed model
  **then one tier below**, both with images) →both-down throw→ **`Retry Text-Only`** (Opus, images
  **stripped** + a `[BRAK: obraz nieczytelny na bieżącym providerze]` marker). The chain discriminates by
  construction (no HTTP-status parsing): a transient error on a good image is recovered with the image (by the
  seam's fallback); a genuinely-bad image fails both image-bearing calls and is rescued text-only
  (`Parse Response` sets `image_unprocessable=true` when images were present, fires a
  WARN `multimodal/image-unprocessable`, the draft still posts); a real non-image failure fails all three →
  CRITICAL (not masked). `Retry Text-Only` success still flows through `Call Log Model Run` (one priced
  Opus row); the WARN reconverges into `Routing Missing?` so `Shape Output` stays the sole leaf. Decision:
  **whole-set drop** (all images dropped on a 4xx, not per-image isolation) and **no `vision_capable`
  column** (reactive 4xx catches the non-vision case too). Verified live on `869dhad2q` (3 junk+real
  images → Gemini/Opus 4xx → text-only Polish draft + one WARN, no CRITICAL, cost logged).

See ADR-022 (shape), ADR-023 (routing), ADR-024 (LiteLLM/cost), ADR-030 (multi-provider), ADR-036 (Block 6),
ADR-051 (image generation moved out to the parallel batch).

### 15.5 `Assemble Task Context (v1)`

> Renamed 2026-06-23 from **`Workspace Search (v1)`** (and the **`Search (v1)`** shorthand;
> display name + repo file `workspace-search.json` → `assemble-task-context.json`; n8n id and
> id-based callers unchanged). The old names/path appear in historical ADRs (e.g. ADR-031) and commits.

`Assemble Task Context (v1)` sits between Assemble Parent Context and Build Prompt (ADR-031). (The former `PD Verifier (v1)`
seam — id `hzwmak7UBpuHaiTO`, a stub always returning `personal_data: false` — was **deleted in Block 2**,
ADR-043; the pipeline is PD-blind.)

- **`Assemble Task Context (v1)`** (id `eL3fJuRMpzVRuVUT`, **12 nodes** since ADR-054 Block 3b, 2026-06-23) — now
  fetches **only** the triggering task's last **30 comments + their threaded replies** on the bot
  token (U already has access to U's own task — no cross-department leak) and returns the unchanged
  `{task_comments, additional_context, sources_used, sources_filtered_out}` contract with
  `additional_context` **always `''`**, `sources_used: []`, `sources_filtered_out: 0`. `Build Prompt`
  injects `task_comments` before the task context; with `additional_context` empty it simply omits the
  "Dodatkowy kontekst (wyszukiwanie semantyczne)" section.
  > **Doc-link serialization + the inline-serializer reuse exception (ADR-066 Block 2, 2026-06-30).** `Build
  > Output` (top comments) and `Collect Replies` (threaded replies) now serialize each comment's ops via the
  > canonical `serializeCommentOps(ops, flat)` helper, with a link-safe `truncateKeepingLinks(text, 600)` — the
  > 600-char cap is kept but never severs a `[dokument ClickUp: …]`/`[link: …]` marker. This is the managed
  > `get_task_comments` tail-tool path (via `Triggering Task Tail Handler → Call Assemble Task Context`) **and**
  > the bare-lane inline comments, so a `doc_mention` now reaches the agent as a fetchable URL instead of a blank
  > gap. Verified live against the original failing task `869dxn3d8` (real `doc_mention` op → URL in `task_comments`).
  > **Reuse decision:** the identical helper is inlined at **three** sites (here ×2 + the producer's `Detect
  > Mention`, §15.7). Extracting one shared `executeWorkflow` serializer was rejected: n8n Code nodes share no
  > module, and a sub-workflow on the producer's webhook hot path would add an execution row **per comment**
  > (Insights-flood risk) plus a synchronous failure surface to mention-detection — worse long-run fragility than
  > three copies of a pure, stable string transform. The copies are pinned by an identical provenance header
  > ("KEEP serializeCommentOps IDENTICAL across 3 sites"); this is the unification rule's documented exception.
  > **Retired in Block 3b (ADR-054 R3):** the former open-ended **search-as-bot** path — the Haiku
  > query-extraction sub-call (`triggered_by=search_step`), the ClickUp task/doc search, the
  > `Check Space Member` / `Layer B Filter` post-hoc membership gate, the up-to-5 artifact read-back,
  > and the selective-condense Haiku pass — was all removed. Software-side membership filtering of
  > open-ended results is exactly the post-hoc filtering ADR-054 R3 rejects; open-ended related-context
  > discovery now happens **in-harness** via the agent's per-user-scoped ClickUp MCP (Block 3a), where
  > the credential enforces scope. **Lane impact:** Stage A is shared, so this removes the bot-driven
  > `additional_context` for **both** lanes; the agent-driven scoped-MCP replacement currently exists
  > **only on the managed lane** (`Execute Agent Session`), so the bare `Agent Orchestrator` spine no
  > longer receives open-ended semantic enrichment (it keeps the triggering task's own comments + the
  > deterministic Assemble Parent Context / Read Input pre-gather). Migration `009`'s `search_step`
  > `triggered_by` value is now unused but harmless (append-only; left in place).

### 15.6 Post-back — draft comment, rendering, thread-aware replies

Core-model step 5 (ADR-027 + update, ADR-028). The spine posts the model output as a ClickUp
**draft comment** that **@-mentions the reviewer** (real ClickUp tag) and **renders full
markdown** — headings, bold/italic/code, bullet/numbered lists, links, code blocks,
blockquotes, and **tables** — via a deterministic markdown→ClickUp-Quill-Delta converter
(`Build Comment`). A "do weryfikacji — nie finalizuje zadania" footer marks it non-final; the
post never sets status or `[AI] Finalny…`.

> Update 2026-06-12 (ADR-036 Block 11): the attribution footer now lives in **`Finalize Comment`**
> (the convergence of the text + image paths), not `Build Comment`, and names the model **per modality**
> with **aggregate** cost — text-only: `(model: X, koszt: …)`; multimodal: `(tekst: X, obraz: Y; koszt
> łączny: text+image …)`. It reads two new `Post Reply` inputs, `image_models` + `total_image_cost_pln`,
> from the resolver (below). `Build Comment` now renders only the body + web-sources (so web-sources
> precedes the footer on the text path). The reviewer @mention is also added to the image path
> (`Rewrite Delta`), reaching parity with the text path.

- **Reviewer** = the **mentioner** (webhook path) / the manual triggerer (operator default,
  optional `reviewer_user_id` form field). The automatic assignee→creator rule is data-ready
  (Assemble Parent Context returns assignee/creator) and applies when the autonomous triggers land.
- **Thread-aware (`conversation_sessions`):** `Check Session` (Postgres) looks up an active row
  for `(clickup_task_id, caller_user_id)`. If found, the reply nests in the thread via `POST
  /api/v2/comment/{comment_root_id}/reply` (on failure → new top-level comment + WARN); if not,
  a new top-level comment is posted and its returned ID anchors the thread as `comment_root_id`
  (`Upsert Session New`). Both paths upsert via `ON CONFLICT (clickup_task_id, comment_root_id,
  caller_user_id) WHERE is_active = true`; upsert failure → WARN side branch, run continues.

  > Update 2026-06-11 (supersedes, ADR-040): the **live** `Post Reply (v1)` does **not** use
  > `conversation_sessions`/`Check Session` (that mechanism above is aspirational / never deployed).
  > It nests via `POST /api/v2/comment/{triggering_comment_id}/reply`, where `triggering_comment_id`
  > is the **thread root** computed by the producer's `Detect Mention` as `reply_to_comment_id`
  > (§15.7) — replying to a reply is impossible (ClickUp threads are single-level → `Unsupported
  > Entity`), so the root is the only valid target. On reply failure → new top-level comment + WARN,
  > unchanged.

- **Artifact recording (ADR-044, migration 022; extended Block 10, migration 025):** after the status
  field is set, a `Record Artifact` Postgres node (side branch off `Set Status Zakończono` success) writes
  the posted comment id onto the task's latest `agent_runs.clickup_comment_id` — and, since Block 10, also
  `run_payload_bytes` + `n8n_execution_id` on the same row (no second `agent_runs` writer). Best-effort +
  observable: a 0-row write or DB error fires a `post-reply/record-artifact` WARN; reply and status still
  complete. Erasure-readiness + payload-observability plumbing — see the §4/§5 `agent_runs` notes.

- **Multimodal image delivery — in-memory base64, Option A (ADR-036 Block 10, 2026-06-12).** When the caller
  passes `image_manifest` (base64 entries `{placeholder_id,b64,mime,caption,alt}`) + `rendered_delta` (ops with
  `{type:'image_ref',placeholder_id}` placeholders), Stage C forks an image path off `Has Images?`:
  `Parse Manifest → To Binary (convertToFile, base64→binary) → Upload Attachment (multipart POST
  /task/{id}/attachment → {id,url}) → Aggregate Uploads → Rewrite Delta`, which replaces each placeholder with
  the **ClickUp inline-image op `{type:'attachment', attachment:{id,url}}`** — the *only* form that renders
  inline (a bare `{image:url}` op or markdown does not; proven by the Block-10 spike). Both paths converge at
  `Finalize Comment` (computes `run_payload_bytes` + appends the Polish `rozmiar danych przebiegu` footer), then
  the existing reply/draft post. **No disk, no temp, no shell, no shared volume** — the disk-temp design
  (spec §3.6) was impossible on this n8n (`Execute Command` + file-delete unavailable) and is superseded by
  in-memory base64 (matches Block 9's `b64_json` output). **Two invariants:** (1) **base64 never reaches the
  DB** — `Record Artifact`/`Log Model Run` get only scalar fields, never the manifest; (2) **execution pruning
  is required** (base64 rides n8n execution data) — currently n8n defaults (prune on, 336 h / 10 000). **Failure
  handling:** there is no delete-attachment API, so a post-failure after upload leaves the uploaded images as
  free-floating task attachments (persistence accepted — mockups are legitimate content) and fires a
  `post-reply/post-back` WARN listing the orphaned ids; per-image upload failure → `[obraz niedostępny]` +
  `post-reply/image-upload` WARN, the comment still posts. Verified live on `869dhad2q` (2 generated images
  rendered inline). The base64 manifest is the Stage-B→C contract Blocks 11/12 build on.

- **Multimodal assembler — `Image Resolver (v1)` (ADR-036 Block 11, 2026-06-12; n8n `znDqcfgXK6CNte20`).** The
  sub-workflow upstream of Stage C that *produces* the `image_manifest` + `rendered_delta` above from the drafting
  model's output-block list. Inputs: `output_blocks_json` (text / `embed_input` / `generate` blocks), `impact`,
  `input_image_refs_json` (from Read Input, for embed resolution), `clickup_task_id` + passthrough; it also forwards
  `model`/`cost_pln` (the text-run attribution) to the caller. **ADR-063 Block 4:** `output_blocks_json` is now the
  agent's **structured `deliver_output` block array** (captured by `Invoke Model (v1)` from a forced tool call), and
  two new inputs `delivered_via_tool` + `output_message` ride alongside; `Resolve & Explode Blocks` consumes the
  blocks directly — the hand-rolled `parseBlockArray` repair routine (fence/preamble/quote-repair) is **deleted**,
  with a loud `multimodal/no-deliver-output` WARN + `output_message` text fallback only if the tool was not called.
  Graph: `When Called → Lookup Image Config → Resolve
  & Explode Blocks → Classify Block (Switch: text/embed/generate/drop) → {text↦Merge | Resolve Embed | Build Batch
  Request → Call Generate Batch | Build Dropped Block} → Merge Branches → Assemble Output` (the sole branch-free
  terminal). It returns `{image_manifest, rendered_delta, total_image_cost_pln, image_models, warnings}`.
  `embed_input` resolves to an existing attachment → `{type:'attachment'}` op directly (no re-upload); text → same
  markdown→ops logic as `Build Comment`. **Generate is now a parallel batch (ADR-051, Block 4, 2026-06-15):** the
  generate branch collects ALL active generate blocks into one array (`Build Batch Request`) and calls `Generate
  Images Parallel (v1)` **once** (`Call Generate Batch`), which fires the N image calls concurrently (bounded by
  `config.image_concurrency_cap`); `Handle Gen Result` maps the batch results back to blocks **by `placeholder_id`**
  (the old per-image `Call Invoke Model` `mode=each` + `task_type` `block_meta::{…}` smuggling are gone) and folds
  each image's `warnings[]` into the resolver `warnings[]`. **Image count is governed by a single global safety
  ceiling** (`config.image_count_ceiling=20`, migration 026) — a runaway guard only, **not** a per-impact cap; the
  old per-impact `image_gen_params.max_images` is dead for counting (impact still drives model + resolution).
  `Lookup Image Config` reads both the ceiling and the concurrency cap in one row. Degradations (embed miss / gen
  failure / ceiling) become placeholder ops + a `warnings[]` entry (Block 12 routes these to Post Alert). Verified
  live (Block 4): a Krytycznie-ważne @-mention producing text + 2 generate rendered both `gpt-image-2` images inline
  in order with the correct per-modality footer cost (2.0332 PLN), the batch firing them concurrently (`max_in_flight=2`,
  158.7 s ≈ one image vs ~317 s sequential); the text + 2 generate + 1 embed interleave order was verified in
  isolation. **DONE (Block 12, 2026-06-13):**
  Stage B now auto-calls the resolver (the drafting model emits the block list — see §15.2/§15.4) and forwards
  its outputs into Post Reply; resolver `warnings[]` route to Post Alert. Stage C's prose `Build Comment` renderer
  was **retired** — every reply now renders through the resolver's `rendered_delta`; the `Has Images?` FALSE branch
  feeds a new `Pass Delta` node (rendered_delta + reviewer @mention, no upload) and the web-sources `Źródła` section
  moved into `Finalize Comment`. Verified live end-to-end: generate, text-only regression, Gemini-vision + embed,
  multi-image interleave, and a forced embed-miss degrade (WARN + `[Obraz niedostępny]`, comment still posts).

### 15.7 `CU Webhook Producer (v1)` — automatic triggering

n8n id `eS66Sk6fweQ0EOPa` (ADR-029 + updates). A **workspace-wide** (team-level, no
list/space/folder filter — employees can mention the agent from any task) `taskCommentPosted`
webhook, `responseMode: onReceived` → instant 200. Flow:

`Not Telemetry Task?` guard → signature verification → `Detect Mention` → dedup claim +
loop-breaker → **`Read Queue Flag` → `Queue Enabled?`**: if true → `Fetch Task Impact` →
`Build Enqueue Job` → `Enqueue Job` (`POST /enqueue`); if false / enqueue fails → synchronous
`Run Agent Spine` (`triggered_by=explicit_mention`). See **ADR-056 Block 3** for the cutover.

- **`Not Telemetry Task?`** drops webhooks for the Alerts task `869dj2z2c` *before* anything
  else — a WARN comment on that watched task would otherwise re-fire the webhook into an
  infinite loop (observed and fixed).
- **Signature verification:** webhook `rawBody:true` → native `Verify Signature` Crypto node
  computes `HMAC-SHA256(secret, rawBody)` → `Signature Valid?` (pass → proceed; fail → `Alert
  Bad Signature` WARN, no run). The secret lives in an n8n **`crypto` credential** ("ClickUp
  Webhook HMAC", id `NY5wM3VKKC1jZtQY`) — encrypted in n8n's DB, never in the repo (this
  instance blocks `require('crypto')` and `$env` in Code nodes, so a credential is the only
  repo-safe option). **Rotation:** if ClickUp regenerates the webhook secret, update the same
  credential's `hmacSecret` (no redeploy). Proven live: a genuine ClickUp-signed delivery passed
  the gate; a forged/unsigned POST was rejected with a WARN.
- **`Detect Mention`** reads the just-posted comment **from the webhook payload**
  (`body.history_items[].comment`) and matches the **Agent Haxe** tag (`99811284`). Because the
  webhook fires on *every* comment, a non-mention comment is dropped in-memory with **zero
  ClickUp API calls** (~12 ms; no `Get Comments`). It also extracts `triggering_comment_id` +
  `triggering_comment_text`, passed through to the spine and into `Build Prompt`. Caller/reviewer
  = the **mentioner**.
  > **Doc-link serialization (ADR-066 Block 2, 2026-06-30).** `triggering_comment_text` is now built by a
  > canonical `serializeCommentOps(ops, flat)` helper, not the old `text_content || ops.map(.text).join`. ClickUp's
  > flat `comment_text`/`text_content` silently **drops** rich-entity ops (`doc_mention`/`bookmark`/`link`), whose
  > `.text` is empty or a bare id — so a doc reference embedded in the triggering comment vanished and the agent
  > fell back to `clickup_search` (the 2026-06-30 pptx run). The helper rebuilds from ops when any rich op is
  > present, emitting for a `doc_mention` the canonical URL `app.clickup.com/{teamId}/docs/{viewId}/{pageId}` (the
  > agent parses `document_id`/`page_id` from it for `clickup_get_document_pages`); ordinary comments are byte-for-byte
  > unchanged (flat text still wins). The **same** helper is inlined in `Assemble Task Context`'s `Build Output` +
  > `Collect Replies` (§15.5) — see the reuse-exception note there.
- **Thread-root reply target (ADR-040).** `Detect Mention` also computes **`reply_to_comment_id`**
  — the comment the spine should reply *into*. ClickUp threads are **single-level**, so replying to a
  comment that is itself a reply returns `Unsupported Entity` and `Post Reply` would fall back to a
  **new top-level comment** (answer lands in a new thread — the observed bug). For a reply,
  `comment.parent` is the top-level (repliable) comment; for a top-level comment it is the task id —
  so `reply_to_comment_id = parent ≠ taskId ? parent : own id`. `Run Agent Spine` feeds this into the
  downstream `triggering_comment_id` channel (the reply target), while the comment's **own** id stays
  the **webhook-dedup key** (`Claim Comment`, ADR-029) — they must differ so distinct mentions in one
  thread aren't de-duplicated.
- **Agent→agent chaining** is enabled (the `author != agent` skip was removed), bounded by a
  **circuit breaker**: `Recent Runs` counts `agent_runs` for the task in the last 10 min;
  `Under Limit?` blocks (+WARN via `Alert Loop Breaker`) at ≥ 8, preventing runaway self-mention
  loops.
- This path does **not** gate the autonomous `Czy dla AI = Tak` flow — that is a separate
  trigger (daily due-date cron + Phase-3 status/field-change webhooks), never mention-gated.
  Future guardrail: route by event/field first, then apply the right gate per route — never a
  single global "must be a mention" filter.
- **Private-space note:** the agent is a Member (reads all public spaces, suiting workspace-wide
  mentions); a mention in a private space the agent isn't a member of triggers but Assemble Parent Context
  403s → WARN.

- **Queue cutover (ADR-056 Block 3, 2026-06-26).** After the dedup claim + loop-breaker, the
  producer reads `config.queue_enabled`. **Flag on (live default):** `Fetch Task Impact` GETs the task
  and `Build Enqueue Job` resolves the `[AI] Wpływ` impact (same field id `55c7ff79…` + option map as
  `Assemble Parent Context`; default `Średni` if absent/unreadable), then builds the ADR-056 job
  (`invocation_type=explicit_mention`; spine-context fields — `reviewer_user_id`, `caller_username`,
  `triggered_by`, `triggering_comment_id` = the **thread-root** reply target, `triggering_comment_text`,
  and `dedup_comment_id` = the comment's **own** id for the consumer's comment-keyed `jobId`) into
  `payload` and `POST`s it to `http://queue-consumer:8080/enqueue`. **Flag off, or enqueue non-200 /
  unreachable:** `Enqueue Job`'s error output falls back to the unchanged `Run Agent Spine`
  `executeWorkflow` **and** fires a WARN (`cu-webhook/enqueue`) — the run is never silently dropped
  (ADR-056 §9 failover). The instant-200 (`responseMode:onReceived`) is unchanged on both paths, so
  webhook latency is unaffected.

The producer returns 200 immediately. The synchronous `Run Agent Spine` (`When Called` trigger) is now
the **fallback** path; the queue is the primary path when `queue.enabled=true`.

### 15.8 Monitoring, alerting & FX (ADR-025)

- **`Post Alert (v1)`** (id `YSCdHlmdf3p9XEUx`) → ClickUp **Alerts task `869dj2z2c`** — the
  single seam every alert routes through (severity / source / message / details).
- **`Error Handler (v1)`** (id `81eplXMD1v5ONhzs`) — set as `errorWorkflow` on Invoke Model /
  Agent Spine / Assemble Parent Context (and the producer); throws surface as **CRITICAL** with status
  rollback. Proven by a real failure raising a CRITICAL alert.
- **Proactive WARNs** (non-blocking side branches), all via `Post Alert`: routing-default-used,
  cost-missing, agent_runs-insert-failed, cost-sync-failed, FX-freshness, bad-signature,
  loop-breaker.
- **FX:** `FX Rates Daily (v1)` (id `b7A3y6bXwOj1G3XR`, active) — Schedule 06:00 + manual
  harness → NBP `rates/a/usd` → upsert `fx_rates` (seeded USD/PLN 3.6392, 2026-06-05). `FX
  Freshness Monitor (v1)` (id `XTP16Hb5aMe2Mp5Z`, active) — daily WARN if the latest rate is
  > 4 days old (tolerates NBP weekend/holiday gaps; verified quiet at age 3).
- **Infra glue:** Supabase Postgres credential `EjK3iACTbSNRDhVz` (SSL=require +
  Ignore-SSL-Issues); migrations 002 (`model_routing`, seeded) + 003 (`fx_rates`) applied.
  `N8N_EDITOR_BASE_URL` and `WEBHOOK_URL` (both `https://agents.haxe.ai`) are wired into the VPS
  containers, so alert execution links are clickable and webhook/form URLs generate correctly.

### 15.9 Verification & fault injection

- **End-to-end (2026-06-08), test task `869dhad2q`:** mention → spine run → rules + prefs loaded
  → Sonnet (default, `personal_data=false`) → 4640/1197 tokens → usd 0.0350625 × 3.6392 =
  `cost_pln` **0.127599** → `agent_runs` row written → `[AI] Koszt akcji [PLN]` set → rendered
  Polish draft posted and @-mentioning the mentioner; nothing finalized. Routing matrix correct
  for all five impact tiers (haiku / sonnet / opus + critical nudge/16k).
- **Failure paths fault-injected & proven:** LiteLLM unreachable → CRITICAL via Error Handler;
  routing-default-used (real tier downgraded) → WARN + run completes; cost-missing → fallback
  cost + WARN; agent_runs-insert-failed → WARN + completion still returned. All non-blocking.
- **KM data-quality observation:** test-task descriptions repeat the same guideline block several
  times, bloating the prompt — a signal for the future gap-detection layer, not a pipeline
  defect.
- **Backlog:** tidy test-noise alert comments on `869dj2z2c` (no delete-comment API available).

### 15.10 Planned-workflow design (not yet built)

The canonical design intent for the workflows still to build. **All producers adopt the ADR-056
`/enqueue` contract** (`POST http://queue-consumer:8080/enqueue` over the internal network with
`{task_id, caller_user_id, impact, invocation_type, enqueued_at, payload}`); the consumer computes the
8-level priority from `invocation_type` + `impact` (§14.3) — these are **automatic** invocations, so they
land in priority band 5–8 (always behind interactive @-mentions), ranked by `[AI] Wpływ`. Producers read
only `queue.enabled` and need no BullMQ knowledge.

> **Surface dimension (ADR-066, Block 1 — LIVE).** The job contract now carries an optional `surface`
> (`task` | `chat`, default `task`) and `surface_ref`, ridden **inside `payload`** as an opaque carrier so
> the consumer's priority/contract logic is otherwise untouched. `task_id` is **required for `surface=task`
> but may be null for `surface=chat`** (a chat job keys its idempotency jobId on `c:{channel_id}:{message_id}`
> instead of the task id). The consumer forwards `surface` + `surface_ref` to the spine; the **Spine HTTP
> Ingress (v1)** and the **Agent Orchestrator (v1) `When Called`** thread them through (restored across the
> spend gate in `Resume After Gate`), defaulting to `surface=task` / `surface_ref.task_id=taskId`. Note the
> ingress's `convertFieldsToString` delivers `surface_ref` to the orchestrator as a **JSON string**, so the
> chat read/delivery adapters `JSON.parse` it.
>
> **Block 2 (ADR-066) — BUILT, verified, INACTIVE pending go-live.** The chat surface is now end-to-end:
> the orchestrator routes Stage A on `surface` (a `Surface = chat?` IF → `Call Assemble Chat Context`
> (`BppZsqTi46Bz5dsG`) for chat, the unchanged task reader otherwise) and **converges both into a Merge node
> that keeps the name `Call Assemble Context`**, so every downstream `$('Call Assemble Context')` reference is
> surface-agnostic and the task path stays byte-for-byte unchanged (regression verified: task @-mention runs
> through the new Merge + cost gate, posts its comment, no new alerts). The chat reader returns the SAME
> contract shape as the task reader (`clickup_task_id:''`, `image_blocks_json:'[]'`, floor = global rules
> (bare lane only) + caller personal rules + triggering message + thread replies; everything else pulled via
> the in-harness scoped ClickUp MCP — the "Doc-via-Chat" path). The task-bound writes are gated to
> `surface=task`: `Set Status W trakcie`, `Call Write Cost Field` (a `Skip Cost If Chat?` IF bypasses it for
> chat), and the render no-deliver-output WARN. Delivery: `Post Reply (v1)` gains a `Surface = chat?` branch
> that builds markdown from the agent's block array and POSTs a **threaded reply under the invoking message**
> (`/api/v3/.../messages/{message_id}/replies`, bot token), then dead-ends (no status flip / artifact record).
> Chat delivery is **text/markdown only** in Block 2 (inline chat images deferred). Verified end-to-end via a
> real poll → enqueue → consumer (priority 3) → spine → clean threaded reply (`agent_runs` logs with
> `clickup_task_id=null`).

- **Daily Due-Date Producer — BUILT (ADR-065, 2026-06-27), INACTIVE pending activation.** Built as
  `due-date-producer.json` (`Ubwr6fRmStFwwJfP`). Final shape diverges from this original sketch on three
  operator decisions: (1) "today" + the dedup window use **Europe/Warsaw** day boundaries (in-memory
  Warsaw-date gate, DST-safe), not UTC; (2) the per-task rule is **exactly one assignee** (no
  creator fallback) + not closed/done; (3) the **"already actioned today" dedup lives in the producer**
  (a batched `agent_runs` query over *any* trigger since Warsaw midnight) — the consumer's time-bucket
  + `dedup_window_h` check only matches a completed `due_date_daily` run, so it would miss a same-day
  @-mention. Enqueues `invocation_type=due_date` (priority 5–8) with the task's impact; synchronous-spine
  fallback + WARN on `/enqueue` failure. The batch summary + a `config` heartbeat go through the
  centralized `Post Alert (v1)` seam at INFO (no dedicated GM Reports task exists; unification rule),
  and a paired `Due-Date Producer Freshness Monitor (v1)` (`q98HgAuUlqxg1CF4`) WARNs if the producer
  stops. Target: overnight drafts ready by morning. See ADR-065 for the full record.
- **CU Chat Poll Producer — BUILT (ADR-066 Block 2, 2026-06-29), INACTIVE pending go-live.** Built as
  `cu-chat-poll.json` (`euFWZ1fKGcRFPrv3`). Chat fires **no webhook**, so this is a **poll** producer
  (latency ≈ the poll interval), not a webhook fast-path. Every 60s it stamps a `config` heartbeat, lists
  the channels the **bot is a member of** (`GET /api/v3/.../chat/channels` as the bot — membership = token
  scope), fetches each channel's recent messages, and keeps those **newer than a per-channel last-seen
  cursor** (`chat_poll_cursor`, migration 049). New non-bot-authored messages are gated by the **tagged-users
  endpoint** (the authoritative @-mention signal — message text `@Name` is unreliable; the id field is read
  defensively against bot id `99811284`), claimed once in `agent_chat_dedup` (migration 049), and enqueued
  `invocation_type=explicit_mention` (priority band 3, behind nothing but live task @-mentions) with
  `surface=chat`, `surface_ref={channel_id,message_id}`, `caller_user_id`=author. **Cold start** (no cursor
  row) seeds the cursor to the newest message **without** enqueuing (no history replay); the cursor advances
  every poll so a message is never re-enqueued, and the bot's own (threaded, API-posted) replies neither
  appear in the channel message list nor self-tag — triple self-trigger guard. Synchronous-spine fallback +
  WARN on `/enqueue` failure (no dropped mention). A paired `CU Chat Poll Freshness Monitor (v1)`
  (`Bg11rVUJXgvDabgn`, every 5 min, 10-min threshold) WARNs if the poll cron stops. **Docs route through
  Task/Chat** (ClickUp exposes no notifications/mentions API and no Doc-comments API — ADR-066 Block 0); a
  Doc mention is a Task/Chat mention referencing the Doc, which the agent reads via the ADR-054 MCP. See
  ADR-066 for the full record.
- **Gmail Email Workflow** — watches incoming mail → `POST /enqueue` with `invocation_type=email`;
  the spine reads the mail, calls Claude with caller-scoped context, creates a Gmail **draft**.
  Sent-folder watcher (every 15 min) enqueues post-send analysis (`invocation_type` per the contract).
- **Weekly Org Proposer** — cron Monday 09:00 (after the morning rush), `invocation_type=weekly_proposer`.
  Synthesizes recent `agent_run_evaluations` across processes → posts structured proposals to the Process
  Improvements task.
- **Session Cleanup** — hourly cron; expires `conversation_sessions` idle > 24 h.
- **Queue note:** producers will enqueue to Redis and return 200 OK in < 200 ms, priority from
  impact (+1 boost for explicit). The current webhook path calls the spine synchronously; the
  Redis producer/worker split per §14 is inserted as the autonomous producers land in Phase 3.

### 15.11 Remaining in / beyond Phase 2

- **In Phase 2:** selective `linked_doc_leaves` resolution (Docs v3) — only the **current step's
  leaf**, to avoid context pollution.
- **Phase 3:** autonomous **status/field-change webhooks + the daily due-date producer** (both
  gated by `Czy dla AI = Tak`); the **Gmail Email Workflow**. (The PD/sensitivity-classifier seam is
  retired — ADR-043 made the pipeline PD-blind; no classifier is planned.)
- **Phase 4:** the **Weekly Org Proposer** and the learning-loop proposers generally.
- **`Session Cleanup`** hourly cron.
- **ADR-026 identity split:** a read-only telemetry identity vs. the edit-capable agent token
  (the `[AI] Koszt akcji` write currently uses the Member token).

---

## 16. Operating procedures

### 16.1 Daily (10–15 min)

Morning, after overnight batch:

1. Open GM Reports task → read overnight batch summary (due-date task count, distribution by `process_type`).
2. Spot-check 5–10 overnight outputs in their tasks.
3. Check Agent Errors task → any failures or dead-letter items?
4. Query cost from last 24h:
   ```sql
   SELECT triggered_by, COUNT(*), SUM(cost_pln)
   FROM agent_runs
   WHERE created_at > NOW() - INTERVAL '24 hours'
   GROUP BY triggered_by;
   ```
5. Note patterns: is due-date triggering producing useful work or noise?

If overnight runs produce unhelpful outputs: adjust which `process_type` categories
have `Czy dla AI = Tak` by default, or set `Status agenta = Paused` on specific tasks.

### 16.2 Weekly (Monday, 1–2 hours)

1. **Review IC-approved proposals** (15–30 min).
2. **Review weekly org proposer output** (15–30 min).
3. **Apply accepted proposals** to persona / process docs in CU (30–60 min).
4. **GM review with Claude** (30 min) — pull last week's `agent_runs` grouped by `triggered_by`; analyse proactive vs reactive split; assess if due-date triggered runs need tuning.
5. **Queue health** (5 min):
   - Average wait by priority: target < 1 min (p1), < 5 min (p5), < 30 min (p10).
   - Dead letter count: target 0.
   - Retry rate: target < 5% of total jobs.

### 16.3 Monthly (2–3 hours)

- Review trigger-source distribution: what % of work is proactive vs reactive vs explicit?
- Review which `process_type` values benefit most from due-date triggering.
- For process_types where overnight runs consistently produce noise: adjust `Czy dla AI` defaults with the team.
- Queue capacity review: approaching worker concurrency limits?

### 16.4 Adding a new process

1. Create process template in CU with subtask hierarchy.
2. Write or adapt Agent Persona doc in Agent System Space.
3. Decide default `Czy dla AI`:
   - **Tak** — for processes where overnight autonomous runs reliably produce useful drafts.
   - **Nie** — for strategic, sensitive, or real-time judgment work. (Team can still explicitly invoke anytime.)
4. Add `process_type` variant to the Formatter Skill doc.
5. If a new `~command` is needed: author its prompt doc in CU and add a row to the command registry (`command_name` → CU doc).

---

## 17. Mitigations

| Mitigation | Setup time | Purpose |
|---|---|---|
| Auto-restart n8n containers nightly via systemd | 30 min | Memory leak prevention |
| Daily Supabase backup → S3 EU bucket | 1 hour | Disaster recovery |
| Error Trigger workflow → Agent Errors task | 30 min | Silent failure detection |
| Git pull cron every 5 min on VPS | 15 min | Workflow JSON sync |
| Session cleanup hourly | 30 min | Data hygiene, Supabase bloat prevention |
| Queue depth monitoring every 5 min | 30 min | Detect backups before they cascade |
| Storage dead-man's-switch (host systemd timer, every 6h) → Post Alert | done (ADR-046) | VPS disk + n8n execution-DB growth (base64 images) caught early, external to n8n |
| Redis persistence enabled (AOF) | 15 min | Survive container restarts without queue loss |

Total one-off setup: ~4 hours during Phase 0.

---

## 18. Scaling analysis

### 18.1 At 2× team (10 people)
- **Operating:** daily 15 min, weekly 90 min.
- **Architecture:** unchanged.
- **Queue:** handles increased volume without tuning.
- **Cost:** ~800–1,100 PLN/month.

### 18.2 At 5× team (25 people)
- **Operating:** department leads handle dept-specific iterations; AI ops ~1 day/week.
- **Architecture:** possibly 4–5 worker processes.
- **Queue:** may need rate-limit tuning if hitting Bedrock TPM ceilings.
- **Cost:** ~2,000–3,500 PLN/month.

### 18.3 At 10× team (50 people)
- **Operating:** AI ops full-time role.
- **Architecture:** multiple n8n main processes (HA), 6–10 workers, Redis Sentinel, Supabase read replicas, real monitoring dashboards.
- **Queue:** without it this scale would be unmanageable; with it, scaling is capacity tuning.
- **Cost:** ~6,000–12,000 PLN/month.

### 18.4 At 50× team (250 people)
- Different company, probably on an enterprise platform. Queue patterns (priority, retry, rate limiting) map directly to enterprise equivalents — migration is clean, no business logic rewrite.
