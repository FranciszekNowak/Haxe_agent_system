# GDPR processing decisions — Haxe agentic OS

Accountability record (GDPR Art 5(2)) for the agent pipeline. Drafted 2026-06-11 from
ADR-040 (PD-blind global routing) and ADR-041 (erasure & retention); updated 2026-06-22 for the
Anthropic Managed Agents cutover (ADR-053/054/055 — Managed Agents runtime, Files API, sandbox, Skills,
in-harness web search, the self-hosted image MCP endpoint, and the `agent-output-images` carrier);
updated 2026-06-24 for the ADR-054 cutover (ClickUp accessed under per-user OAuth — §3.1). This is an internal
engineering/processing record, not legal advice; figures marked **confirm with counsel**
must be verified before being relied on. Language: English (technical-docs convention); a
Polish version can be produced if a supervisory authority (UODO) requests it.

> Status: schema-ready, not operational. The email channel — the only personal-data-capable
> channel — is **not wired yet**, so `subject_key` population and the erasure runbook are
> dormant. What exists today is the schema (migration 022) and this record.

## 1. Controller & scope

- **Controller:** Haxe (Polish wellness/electronics e-commerce distributor, ~5-person team).
- **System:** internal AI agents that execute routine operational work, governed by process
  knowledge in ClickUp. Since 2026-06-22 (ADR-053 Block 9) the live orchestration lane is **Anthropic
  Managed Agents** — a hosted agent runtime (Anthropic-operated sandbox, tool loop, code execution,
  in-harness web search, office-document Skills, and the Files API for input/output files). The earlier
  bare LiteLLM gateway lane is retained only as a dormant outage failover (text + image). Image
  generation is called out from the agent via a **self-hosted image MCP endpoint** (on our EU VPS) to
  Google/OpenAI image models.
- **Data categories actually processed:**
  - Low-sensitivity operational data — customer-service correspondence, B2B contact details.
  - Employee wage and address data (operational/cost analysis; HR records).
  - **No special-category (Art 9) data.** No biometric, health, or similar data is processed.

## 2. Lawful bases (Art 6)

| Processing | Lawful basis |
|---|---|
| Operational automation over customer-service / B2B data | Art 6(1)(f) legitimate interest (running the business, continuity, the learning system) |
| Processing employee wage/address data for HR + cost analysis | Art 6(1)(c) legal obligation (employment-records duties) + Art 6(1)(f) legitimate interest (cost analysis) |
| Contract-driven processing where an agent acts to perform a contract with the data subject | Art 6(1)(b) performance of a contract (where applicable) |

No processing here relies on consent; no special-category processing occurs.

## 3. International transfers (Chapter V)

Agent tasks run on the **Anthropic Managed Agents global endpoint** (ADR-053), including tasks that may
carry personal data. **Residency is deliberately not required** (ADR-053 decision 2): the recorded basis
for non-EU processing is lawful processing (DPA / SCCs / DPF), not data residency. Within the managed
runtime, processing spans Anthropic's hosted **sandbox / code execution**, **in-harness web search**,
**office-document Skills**, and the **Files API** (input images and produced files transit Anthropic).
The dormant LiteLLM failover lane remains PD-blind, keyed only on `(impact, modality)` (ADR-040). Lawfulness
of non-EU processing rests on the transfer mechanisms below, not on data residency.

Two self-hosted processing surfaces sit on our EU VPS and Supabase (no new non-EU transfer): the
**image MCP endpoint** (receives the agent's image prompt + optional reference-image URLs, then calls the
image providers in §4) and the **`agent-output-images` carrier** (a private EU Supabase Storage bucket
holding agent-produced image bytes for ClickUp delivery — see §6). Input images uploaded to the Anthropic
Files API are also indexed in `agent_input_file_map` (file_id → signed URL) for reference resolution, TTL-pruned.

### 3.1 ClickUp access under per-user OAuth (ADR-054, cutover 2026-06-24)

The managed agent reads ClickUp context **scoped to the triggering user's identity**, enforced by n8n at the
executor — not by the agent and no longer by a post-hoc application-code filter (the former `Check Space Member`
membership filter was retired). This is a **data-minimization and access-control** measure (Art 5(1)(c)): an
agent run for a task triggered by user U can only retrieve what U is permitted to see in ClickUp (e.g. Marketing
cannot reach Purchasing data), so personal/operational data does not cross the departmental boundary into a
deliverable it should not reach. Scope is enforced by the **credential**, so it holds even under prompt
injection. This is **not a new transfer or sub-processor** — ClickUp is the existing operational/process store;
the change is *how tightly* access is scoped.

Two non-expiring per-user ClickUp OAuth tokens are held per onboarded member (consented once each, via the
onboarding flow): a **discovery (MCP-OAuth) token** stored as a `static_bearer` credential in the **Anthropic
Vault** (proxied, outside the sandbox; attached to a session by `vault_ids` so the hosted ClickUp MCP runs as U),
and a **classic REST token** for as-U attachment extraction stored in **Supabase Vault** (EU; read back by
`caller_user_id` via a `SECURITY DEFINER` getter, never exposed to the agent). These tokens are personal
access credentials; they are deletable on revocation (delete the Vault credential + the Supabase secret + flip
the `user_clickup_credentials` row to `revoked`). No token-refresh processing occurs (the tokens do not expire).
The mapping table `user_clickup_credentials` holds the ClickUp user id, username, email, vault id, and status —
ordinary contact/identity data already processed under §2, no special-category data.

- **Mechanism:** controller→processor **Data Processing Agreements** with each provider, incorporating
  the EU **Standard Contractual Clauses (SCCs)**; where the provider is **Data Privacy Framework
  (DPF)**-certified, the DPF adequacy route also applies. **Confirm with counsel** that the executed
  DPAs/SCCs are on file for each active sub-processor.
- **No-training commitment:** provider API tiers used here are configured so that submitted content is
  **not used to train provider models**. **Confirm** the contractual no-training term per provider.

## 4. Sub-processors

| Sub-processor | Role | Transfer basis |
|---|---|---|
| Anthropic (Claude family) | **Managed Agents hosted runtime** — LLM inference (text + multimodal/vision reasoning), agent tool loop, sandbox/code execution, **in-harness web search**, office-document **Skills**, and the **Files API** (input + produced files). The live orchestration lane for all agent tasks incl. PII. | DPA + SCCs / DPF — **confirm** (incl. that the no-training term covers the Managed Agents / Files API / Skills / web-search surfaces) |
| Google (Vertex AI — Gemini) | LLM inference (multimodal route) **+ image generation** (gemini-image: Nano Banana / Nano Banana Pro, Block 8) | DPA + SCCs / DPF — **confirm** |
| OpenAI | **Image generation** (`gpt-image-2`, Block 8 — top image tiers). No text/multimodal LLM route currently uses OpenAI. | DPA + SCCs / DPF — **confirm**. ZDR + EU data residency available but **sales-gated** (not enabled) |

Supabase (Postgres, EU region) and the self-hosted n8n/LiteLLM VPS hold the operational data and are
processors/infrastructure under their respective DPAs. Keep this table in sync with the live LiteLLM
alias set and `model_routing`. (Stability AI was evaluated for image generation but **dropped** in
Block 8 — not a sub-processor; Vertex Imagen was retired ahead of Google's ~2026-06-24 shutdown.)

## 5. Erasure (Art 17)

- **Hub model:** `agent_runs` is the erasure hub. Every personal-data-capable store either references
  `agent_runs` by foreign key, or has its external artifact ids (ClickUp comment id, ClickUp attachment
  ids, Drive file id) recorded on the `agent_runs` row (`clickup_comment_id` and `clickup_attachment_ids`
  — image + office-doc attachments, ADR-053 Block 7 — recorded live; `drive_file_id` reserved).
- **Key:** nullable, indexed `subject_key` = the channel-natural counterparty id from envelope metadata
  (e.g. counterparty email), **never** content-derived. Populated only by PD-capable channels (email)
  once wired. Identity resolution happens **at erasure time** (match against any identifier the
  requester provides), not at ingestion.
- **Procedure (runbook, activates with the email channel — not yet built):** query `agent_runs` by
  `subject_key` → cascade/delete linked rows → delete recorded external artifacts via API → write an
  erasure-log entry as evidence (the one record kept after deletion is proof it happened).
- **Referential map (audit 2026-06-11, no FKs/cascades added):**
  - `email_sends.agent_run_id` — FK, **nullable, no ON DELETE CASCADE** (a future cascade is blocked by
    linked emails; handle in the runbook).
  - `agent_run_evaluations.agent_run_id` — FK **ON DELETE CASCADE** (clean).
  - `agent_proposals.source_agent_run_id` — nullable FK (weak link).
  - `agent_proposal_evaluations` — transitive via `agent_proposals`.
  - `conversation_sessions` — **no FK**; links only by `clickup_task_id` / `comment_root_id` text. The
    one PD-capable store that does not link back — the runbook must match it by task/thread id.
- **Deliberately not built:** no body-text PII classifier, no cross-table forensic deletion of incidental
  mentions. Disproportionate under the Art 17 reasonable-effort standard for low-sensitivity data; the
  residual is bounded by retention. The learning corpus holds generalized learnings, not raw identifiable
  personal data; if erasure ever requires it, traverse from `agent_runs` to the linked rows manually.

## 6. Retention (Art 5(1)(e))

| Data | Retention | Basis |
|---|---|---|
| Operational low-sensitivity data (customer service, B2B) | Long retention under a documented purpose (operations, learning system, continuity); **periodic review** ("do we still need records this old") as the backstop — no fixed cadence | Art 5(1)(e) purpose-bound |
| Employee wage & address data | Statutory employment-records period — **~10 years** post-employment for employees hired from 2019; **~50 years** for pre-2019 hires (Polish Labour Code post-2019 reform). **Confirm exact figure with counsel.** Erasure is overridden during this period (Art 17(3)(b)) | Art 6(1)(c) legal obligation |
| Permanent learning store | No raw identifiable personal data is stored, so storage limitation does not bite | n/a |
| Zip-inner input files — **images and documents** (Supabase Storage bucket `zip-inner-images`, `haxe-agent-prod` / `eu-west-1`, **private**) | **Purged daily, ≤~36h — enforced automatically by pg_cron** (ADR-048 Block 4, landed 2026-06-15; schedule revised the same day per operator). Since the off-worker extractor (ADR-058, 2026-06-24) the bucket holds **both** zip-inner images **and** zip-inner documents (PDF/DOCX/XLSX/CSV) — both uploaded with the same extension-less key shape `<task_id>/<att_id>`, indistinguishable by key. The `purge-zip-inner-images` job (migrations 029 → 030) runs **once daily at 05:00 Europe/Warsaw** and deletes objects older than **12h** **through the Storage REST API** with **no object-type filter** (it selects by bucket + age only), so it covers documents and images identically; the underlying **bytes are freed, not just the metadata row** (a bare `delete from storage.objects` would orphan the personal data in S3). The 12h floor guarantees an in-flight agent run's attachment is never deleted mid-process (documents are read by Docling within the run, minutes after upload). The trade-off of a *single* daily run plus a 12h floor: an evening/overnight file can live up to **~36h** (it is <12h old at one 05:00 run, so it is deleted at the next). A strict ≤24h guarantee would require running more than once per day; ~36h for EU-private, signed-URL-only files is an accepted, documented minimisation posture (24h was a self-imposed target, not a legal limit). A pg_cron-independent dead-man's-switch (n8n `Zip Image Purge Watchdog (v1)`, every 6h) WARNs via the alert channel if any object exceeds **40h** (healthy ceiling ~36h), so a stalled purge cannot silently let data accumulate. Bucket **provisioned** in Block 2 and the write path **wired live** in Block 3 (both 2026-06-15); document storage added under ADR-058 Block 3 (2026-06-24), covered by the same unified purge. | Art 5(1)(e) data-minimization; ADR-048 / ADR-058 / ADR-044 |
| Agent-produced image bytes (Supabase Storage bucket `agent-output-images`, `haxe-agent-prod` / `eu-west-1`, **private**) | **Purged at 24h by pg_cron** (migration 037, ADR-053 Block 6 / ADR-055), via the Storage REST API so the bytes are freed (mirrors the zip-inner purge). Holds images the agent generated, keyed by their Anthropic Files-API `file_id`, only long enough for `Render Agent Output (v1)` to fetch them for ClickUp delivery (Files-API uploads are `purpose=agent`, not downloadable, and on the MCP path the bytes never return to n8n — hence the carrier). Same EU Supabase project as the database; no new transfer surface. | Art 5(1)(e) data-minimization; ADR-053 / ADR-055 / ADR-044 |
| Files-API reference map (`agent_input_file_map`, file_id → signed URL / mime / source_ref) | Append-only, **TTL-pruned by pg_cron** (migration 036, ADR-055). Lets the image MCP resolve a `reference_file_id` to its image bytes without session context. No image bytes stored here — only the file_id and a short-lived signed URL into the EU buckets above. | Art 5(1)(e) data-minimization; ADR-055 |
| Anthropic Files API uploads (input images + produced office-docs / images), `purpose=agent` | Held by Anthropic for the working lifetime of the agent session; not relied on as a store of record (the ClickUp deliverable is). Covered by the Anthropic DPA (§4). Erasure of a delivered artifact is via the ClickUp attachment id recorded on `agent_runs` (§5), not the Files-API object. | Art 5(1)(e); Anthropic DPA |

Processing note (ADR-048 / ADR-058): a `.zip` attached to a task may contain photos of people **and
documents carrying more concentrated personal data** (e.g. a PDF/DOCX/XLSX/CSV with names, addresses, or
wage data), so the bucket is treated as potentially personal-data-bearing even under the PD-blind posture
(ADR-043). Both file kinds share the one bucket and the one unified purge (no separate, shorter document
retention: the keys carry no type marker so a key-selective purge is impossible without added surface, and
documents are consumed by Docling within the run — ADR-058 Block 3). Mitigations: EU-only bucket, private
(no public URLs — only short-lived signed URLs), the daily ≤~36h purge, and the same provider egress
base64 would have produced (no new residency surface). No new sub-processor: it is the same Supabase EU
project already listed in §4 for the database.

Optional future: pseudonymize the historical wage series past the statutory period to keep analytical
value without indefinite raw-identity retention. Not now.

## 7. What is explicitly out of scope (today)

No `subject_key` population, no erasure-runbook execution, no retention-deletion job, no body-text PII
classifier, no foreign keys or cascades (the referential graph was audited, not modified). These
activate with the email channel and a future erasure block.

## 8. Open confirmations

- Executed DPAs/SCCs (and DPF status) on file per active sub-processor (§3, §4).
- No-training contractual term per provider (§3).
- Exact Polish employment-records retention figure for our population (§6).
