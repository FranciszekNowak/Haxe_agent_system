# ADR-054 Block 4 — as-U extraction tool (findings + build plan)

## Pre-flight capability gate — DONE + LIVE-VERIFIED (2026-06-23)

Block 4's extraction tool is a **client-side custom tool on the retained `Execute Agent Session (v1)` loop**:
the agent calls `extract_clickup_task(clickup_task_id)`, the session pauses to n8n, n8n reads the caller's
classic REST token from Supabase and runs `read-input` **as U**, then answers with a
`user.custom_tool_result`. Documents come back as Docling **markdown text** (fits a text tool_result
trivially). The one genuinely unproven assumption was image attachments — so a throwaway spike
(`scripts/ma-spike-block4-toolresult-image.py`) settled it against the live API before any production wiring.

**Q1 — can a `user.custom_tool_result` deliver an IMAGE the agent can SEE (vision)? → YES, both shapes.**
A synthetic solid-green PNG was returned to the agent inside the tool result two ways; the agent named the
colour "Green" both times (so it genuinely received the pixels, not a hallucination):
- **TEST A — Files-API `file_id`** source `{type:image, source:{type:file, file_id}}` → **PASS**.
- **TEST B — inline base64** source `{type:image, source:{type:base64, media_type, data}}` → **PASS**.

**Q2 — does the dormant custom-tool pause/resume cycle still work? → YES.** It has not run in production since
ADR-055 moved `generate_image` to an MCP toolset. In all three sessions the custom tool surfaced as
`agent.custom_tool_use` (pending), our `user.custom_tool_result` was accepted (HTTP 200), and the agent
resumed. **TEST C** (text-only result, no image) → the agent answered `NO_IMAGE_VISIBLE` exactly as
instructed, confirming it does not fabricate seeing an image when none is sent.

**Proven custom-tool declaration shape** (also the live shape ADR-053 Block 4 used before ADR-055):
`{ type:'custom', name:'extract_clickup_task', description, input_schema:{type:'object', properties:{clickup_task_id}, required:['clickup_task_id']} }`.
Declared in the agent's `tools[]` it surfaces as `agent.custom_tool_use`, which Poll Round already detects as
`pending_tool`.

**ClickUp REST auth header (as-U `Get Task`) — settled, not "Bearer".** The block-0 note said
`Authorization: Bearer <token>`; that is wrong. ClickUp REST takes the **raw token** in `Authorization` (no
"Bearer " prefix), proven live by the onboarding webhook's `GET /api/v2/user` (`clickup-onboarding.json`,
node "Get User"). The as-U `Get Task` therefore sets `Authorization: <U's classic REST token>`.

**Design consequences locked by the spike:**
- Extraction delivers **both** document text and image attachments to the agent through the single
  `user.custom_tool_result` channel — no separate `user.message` interleave needed (which would have risked
  the session state machine / pending-detection).
- Image source shape: prefer **Files-API `file_id`** (reuse `Upload Input Images (v1)` — lighter event
  payload, battle-tested, consistent with the input-image path) over base64 inline (works, but ~33% payload
  bloat on the events POST). Base64 stays a documented fallback.

**Spike is throwaway** (created agent/file/sessions all torn down; verified in the run log). Kept under
`scripts/` alongside the other `ma-spike-*` capability gates as the reproducible record.

### Operational note for the operator (not caused by this work)
Sourcing `/opt/haxe-agents/.env` with `set -a; . .env` emitted `line 14: type:: command not found` — a line in
that file is not a clean `KEY=value` (likely a value containing `type:` or an un-`#`-commented note). It did
**not** break the key load (uploads + sessions all 200), and Docker Compose loads `.env` differently
(key=value parsing, not shell sourcing), so containers are unaffected. Worth a glance next time `.env` is
edited; only manual `. .env` sourcing trips on it.

## Build plan (proposed — pending operator go-ahead on the read-input change)

Split mirrors the Block-3 safe-seam approach so each commit leaves a verified working state:

- **Block 4a — `read-input (v1)` as-U mode (in isolation). ✅ DONE + LIVE-VERIFIED (2026-06-23).**
  `read-input` (`zgGpONulGMohQQqI`, 29→32 nodes) gained an `as_user_token` input on `When Called` and an
  **As User?** IF: token present → new **Get Task (as U)** (`Authorization: <raw token>`, no predefined
  credential, `onError:continueErrorOutput`, `retryOnFail` 2×); token absent → the existing bot `Get Task`,
  **byte-identical**. The as-U success output fans to `Explode Attachments` + `Lookup File Processing Config`
  (same downstream as bot). The as-U error output → new **Build Access Denied** (emits a `[BRAK:
  dostep_odmowiony …]` text block + `needs_alert` + `warn_source:'clickup-asU/access-denied'`, carrying the
  real HTTP status/ECODE in `err`) → `Merge Branches` (input 5; 5→6). **No bot fallback in as-U mode.** The
  `Form Trigger` test harness bypasses the IF and still hits the bot `Get Task`.
  - **Live proof (via `scripts/test-subworkflow.mjs`):** (1) bot path — `{clickup_task_id:'869dhad2q'}` (no
    token) → all 20 blocks (images + Docling text + the known `broken.docx` extraction-failed warning),
    identical to prior behaviour. (2) as-U denied — same task id + a bogus token → ClickUp `HTTP 401
    OAUTH_019 "Oauth token not found"` → `blocks=[the BRAK marker]` + `warnings=[clickup-asU/access-denied]`,
    and **critically NOT** the 20 blocks the bot sees → the permission boundary holds, no bot-broad leak.
  - n8n validate `valid:true` 0 errors (the two flags on the new nodes are benign: As User? `main[1]` is the
    normal FALSE branch like every other IF/Switch here; Build Access Denied `$json` in all-items mode is the
    single error item, matching the proven `Build Create/Send Failed` pattern). `binaryMode:separate`
    preserved on live. Drift-clean (full-workflow push via `import-workflow.mjs` avoided the partial-update
    IF/Switch sanitizer). Alerts 0/0.
  - **Deferred to 4b:** the as-U **positive** (a real REST token fetching a task the user can see) — proven
    end-to-end when the handler resolves the real token. The capability is dormant (no agent wired yet).

- **Block 4b — the agent-facing extraction tool. ✅ DONE + LIVE-VERIFIED (2026-06-23).**
  New sub-workflow **`ClickUp Extract Tool Handler (v1)`** (`y985MgyA5lCxOFCH`, 9 nodes): `When Called`
  (clickup_task_id, caller_user_id, clickup_scope) → `Get REST Token` (`get_clickup_rest_token`) → `Has Token?`
  → (token) `Read Input as-U` → `Upload Images` (`Upload Input Images`, images filtered to png/jpeg/gif/webp) →
  `Build Extract Result` → `Merge Result` → `Return`; the no-token branch → `Build No Token Result`. Returns
  `{ status, tool_result_content_json (text + image file_id blocks), new_warnings_json, new_images_json:'[]' }`.
  `saveDataSuccessExecution:none` so U's REST token is not persisted in its execution data.
  - **`Execute Agent Session (v1)`** (33 nodes): added `Is extract_clickup_task?` on the `Is generate_image?`
    FALSE branch → `Call Extract Tool Handler` → `Build Extract Result Text` → `Merge Result` (2→3 inputs).
    `Post Tool Result` now posts `tool_result_content_json` as the content array verbatim (falls back to the
    single-text `tool_result_text` for the dormant image path — backward-compatible).
  - **`Sync Agent Definitions (v1)`** (`CONV` 5→6): registered the `extract_clickup_task` custom tool
    (`{type:'custom', input_schema:{clickup_task_id}}`) + inspect-then-extract steering on the 3 routed agents.
  - **Two build bugs caught + fixed during verification:** (1) `$json` chaining is unreliable across consecutive
    Execute Workflow nodes — switched the downstream reads to explicit `$('NodeName').first().json` (the pattern
    that already worked); (2) `Upload Input Images`' aggregated `file_map` entries carry no `ok` field (it
    already drops failures), so the `f.ok && f.file_id` gate rejected every upload → gate on `f.file_id` only.
  - **Token-presence guard:** un-onboarded caller → an "unavailable" tool result (no extraction, never the bot),
    WARN only when `clickup_scope==='scoped'` (half-onboarded: discovery present but REST token missing),
    suppressed for un-onboarded (Block 2 already WARNs — mirrors Block 3a).
  - **End-to-end proof:** an agent driven as the onboarded user (`caller_user_id` 2521617) called
    `extract_clickup_task` on a clean disposable task (a text note + a green PNG); it returned
    *"Sekretny znacznik … EKSTRAKCJA-OK-7741, a obraz ma zielony kolor"* — proving document text **and** image
    vision both reached the agent through the as-U tool. `status:completed`, 0 warnings, alerts 0 CRITICAL.

### Known limitation + residual (flagged, not silently accepted)
- **Corrupt source raster terminates the session.** A first e2e attempt on the junk test task `869dhad2q` (which
  holds a deliberately broken doc + a corrupt image) hit `session.error "Could not process image"` with
  `retry_status:terminal` — the Managed Agents API kills the session irrecoverably on an unprocessable image.
  This is a **pre-existing fragility shared with the input-image path** (documented on `Create Session`), not
  introduced by extraction. Mitigation added: delivered images are filtered to vision-supported raster formats
  (png/jpeg/gif/webp), catching bad *formats* (svg/tiff/heic/unknown). A corrupt-but-valid-format raster can
  still terminate. **Follow-up worth considering:** validate/transcode each image before delivery (a shared
  hardening for both the extraction and input-image paths).
- **`read-input` logs the `as_user_token`.** The handler suppresses its own execution data, but `read-input`'s
  own success executions still record the `as_user_token` When-Called input (the token is U's ~10y ClickUp OAuth
  token). Low risk on a single-tenant team-only n8n, but a log-hygiene follow-up (e.g. set `read-input`
  success-saving off, or a dedicated as-U reader) is worth weighing.

### Still pending (not Block 4)
The cross-department **negative** matrix (a Marketing user denied a Purchasing-only task via *both* discovery and
extraction) is **Block 5's** mandatory gate and needs 1 Marketing + 1 Purchasing onboarded test user (still
outstanding from Block 1's DoD). Block 4 proved the access-denied **mechanism** (4a: bogus token → ClickUp 401 →
access-denied, never the bot) and the full positive path; the exhaustive cross-dept proof is Block 5.

**Verification reach:** the positive path and the access-denied *mechanism* (garbage/denied id) are testable
now with Franciszek. The true **cross-department negative** ("extract a Purchasing-only task as a Marketing
user → access-denied") needs the 1 Marketing + 1 Purchasing test users that are **still outstanding from
Block 1's DoD** — that exhaustive matrix is **Block 5's** gate, not 4b's.
