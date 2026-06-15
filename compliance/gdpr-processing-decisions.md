# GDPR processing decisions — Haxe agentic OS

Accountability record (GDPR Art 5(2)) for the agent pipeline. Drafted 2026-06-11 from
ADR-040 (PD-blind global routing) and ADR-041 (erasure & retention). This is an internal
engineering/processing record, not legal advice; figures marked **confirm with counsel**
must be verified before being relied on. Language: English (technical-docs convention); a
Polish version can be produced if a supervisory authority (UODO) requests it.

> Status: schema-ready, not operational. The email channel — the only personal-data-capable
> channel — is **not wired yet**, so `subject_key` population and the erasure runbook are
> dormant. What exists today is the schema (migration 022) and this record.

## 1. Controller & scope

- **Controller:** Haxe (Polish wellness/electronics e-commerce distributor, ~5-person team).
- **System:** internal AI agents that execute routine operational work, governed by process
  knowledge in ClickUp, with inference via the LiteLLM gateway.
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

Inference runs through the LiteLLM gateway to model providers. The PD/EU-pinned routing apparatus
was **removed** (ADR-040): routing is PD-blind, keyed only on `(impact, modality)`. Lawfulness of
non-EU processing rests on the transfer mechanisms below, not on data residency.

- **Mechanism:** controller→processor **Data Processing Agreements** with each provider, incorporating
  the EU **Standard Contractual Clauses (SCCs)**; where the provider is **Data Privacy Framework
  (DPF)**-certified, the DPF adequacy route also applies. **Confirm with counsel** that the executed
  DPAs/SCCs are on file for each active sub-processor.
- **No-training commitment:** provider API tiers used here are configured so that submitted content is
  **not used to train provider models**. **Confirm** the contractual no-training term per provider.

## 4. Sub-processors

| Sub-processor | Role | Transfer basis |
|---|---|---|
| Anthropic (Claude family) | LLM inference (text, multimodal reasoning) | DPA + SCCs / DPF — **confirm** |
| Google (Vertex AI — Gemini) | LLM inference (multimodal route) **+ image generation** (gemini-image: Nano Banana / Nano Banana Pro, Block 8) | DPA + SCCs / DPF — **confirm** |
| OpenAI | **Image generation** (`gpt-image-2`, Block 8 — top image tiers). No text/multimodal LLM route currently uses OpenAI. | DPA + SCCs / DPF — **confirm**. ZDR + EU data residency available but **sales-gated** (not enabled) |

Supabase (Postgres, EU region) and the self-hosted n8n/LiteLLM VPS hold the operational data and are
processors/infrastructure under their respective DPAs. Keep this table in sync with the live LiteLLM
alias set and `model_routing`. (Stability AI was evaluated for image generation but **dropped** in
Block 8 — not a sub-processor; Vertex Imagen was retired ahead of Google's ~2026-06-24 shutdown.)

## 5. Erasure (Art 17)

- **Hub model:** `agent_runs` is the erasure hub. Every personal-data-capable store either references
  `agent_runs` by foreign key, or has its external artifact ids (ClickUp comment id, Drive file id)
  recorded on the `agent_runs` row (`clickup_comment_id` recorded live; `drive_file_id` reserved).
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
| Zip-inner input images (Supabase Storage bucket `zip-inner-images`, `haxe-agent-prod` / `eu-west-1`, **private**) | **24h** — a daily pg_cron job purges objects older than 24h via the storage-delete path (frees the bytes, not just the row). Bucket **provisioned** in ADR-048 Block 2 (2026-06-15) and the write path **wired live** in Block 3 (2026-06-15) — zip-inner images now actually flow to this bucket when a `.zip` is processed. The automated purge job **lands in ADR-048 Block 4** — until then, treat 24h retention as enforced manually. | Art 5(1)(e) data-minimization; ADR-048 / ADR-044 |

Processing note (ADR-048): a `.zip` attached to a task may contain photos of people, so the bucket is
treated as potentially personal-data-bearing even under the PD-blind posture (ADR-043). Mitigations:
EU-only bucket, private (no public URLs — only short-lived signed URLs), 24h purge, and the same
provider egress base64 would have produced (no new residency surface). No new sub-processor: it is the
same Supabase EU project already listed in §4 for the database.

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
