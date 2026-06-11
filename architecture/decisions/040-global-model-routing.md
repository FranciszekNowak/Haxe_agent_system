# ADR-040: Global model routing on default DPA/SCCs; remove personal-data residency routing

Status: Accepted. Supersedes ADR-038 and ADR-039 (Vertex AI Gemini GDPR posture) in full, and the Block 6 Cases 1 and 2 guards in ADR-036.
Date: 2026-06-10

## Context

Prior decisions routed personal data to EU-resident models (Vertex EU, Bedrock EU), introduced a `personal_data` classification, added image-stripping guards (Block 6 Cases 1 and 2), and split the model fleet into an EU tier and a global tier. The premise was that EU-region processing is required for GDPR. That premise was wrong.

EU residency is one stricter posture, not a legal requirement. Processing personal data on a US or global provider is lawful under GDPR when three things hold: a controller-processor DPA, a valid transfer mechanism (Standard Contractual Clauses, plus the EU-US Data Privacy Framework where the provider is certified), and no training on the data. Google Cloud / Vertex AI, Anthropic, and OpenAI all provide DPA + SCCs + no-training by default on commercial and API terms. We already hold all three. The cross-border transfer is therefore already covered by paperwork we hold, and the EU-residency apparatus was solving a problem we did not have.

## Decision

1. Use global models for all tasks, chosen purely by capability and modality. There is no EU-residency tier and no sensitivity-based routing.
2. Remove personal data as a runtime factor entirely: no `personal_data` flag, no PD verifier, no PD-conditional routing, no image stripping, no EU-vision routing.
3. Handle the transfer's compliance with static, controller-side documentation maintained outside the repo, not with workflow logic.

## Consequences

Delete:
- The `personal_data` flag and the PD verifier wherever set or read (Stage A assemble-context, orchestrator, invoke-model).
- Block 6 Case 1: the PD image-strip branch, the `pd_images_dropped` field, the "PD Image Notice?" IF node, and the "Post PD Notice" comment node.
- Block 6 Case 2: the Bedrock image-strip branch ("Check Bedrock Stripped", "WARN Bedrock Images", the `[BRAK]` injection in Build Messages).
- EU-vision routing and the `personal_data`/EU **gating** on the model fleet (not the Gemini aliases themselves — see Keep). Drop only the region-pinned alias variants (`europe-west4` / `eu`) that existed solely for in-region residency.
- The EU-vs-global split in `model_routing`, including any `eu_resident` or `personal_data` columns or logic. Migration 014's `multimodal_input` rows are collapsed PD-blind (Block 3 / migration 016): the `personal_data=true` Gemini rows are dropped and image routing keeps the Claude `multimodal_input` rows, with Gemini retained as a callable alias to opt into later.

Keep:
- The `haxe-gemini-*` aliases as **global, non-PD multimodal capability aliases** (cheaper / stronger vision), dormant until opted into — only their PD/EU gating is removed, not the aliases. They stay defined in LiteLLM and remain a callable route a single `model_routing` row can point at later.
- Block 6 Case 3 (generic image-unprocessable 400 to text-only fallback) as ordinary robustness, with all personal-data framing removed from its naming and comments.
- `model_routing` reduced to capability and modality only.
- All non-GDPR architecture: the deterministic context gathering, the subtask-tree read, capability routing, and every robustness guard not tied to personal data. None of this was GDPR machinery and none of it is in scope for removal.

Out of repo (one-time, tracked on a compliance checklist, not in code):
- Privacy notice: name Google, Anthropic, and OpenAI as sub-processors and disclose the non-EU transfer under SCCs.
- A records-of-processing (ROPA) entry for the AI processing.
- A short transfer impact assessment for the SCC transfers.
- Verify each provider account is on commercial or API terms, since no-training and the DPA attach to commercial tiers, not consumer ones.

Caveat (tracked, not code):
- If a B2B partner contract restricts non-EU sub-processors or transfers for data processed on their behalf, that specific flow must honor the contract. Check on review of any partner data-processing clauses.

## Supersedes

- ADR-038 (EU-region GDPR routing): fully superseded.
- ADR-039 (Vertex AI Gemini GDPR posture — DPA+SCCs on global endpoint): fully superseded. Its premise (a `personal_data`/EU axis requiring a GDPR-specific multimodal route) is reversed here; the Gemini aliases it introduced are retained as global, non-PD capability aliases.
- ADR-036 (multimodal I/O and image guards): Block 6 Cases 1 and 2 are removed; the rest of ADR-036 stands.

## Update 2026-06-11 (supersedes the "keep Claude for multimodal_input" consequence)

Block 3 executed the PD-blind collapse with the **opposite** multimodal choice from the one written into the Consequences and Keep sections above. Those sections said image routing would keep the Claude `multimodal_input` rows and leave the Gemini aliases dormant ("a callable route a single `model_routing` row can point at later"). That rested on a premise that turned out to be false — that the Gemini rows had never served a task.

In reality the `n/d` tier already routed to Gemini Flash (migration 019), and ADR-042 (same day) tuned Gemini Flash/Pro `reasoning_effort` and output caps specifically for the multimodal tiers. The operator therefore chose to **activate Gemini as the active `multimodal_input` route for every tier** — `haxe-gemini-flash` for `n/d`/`Niski`/`Średni`, `haxe-gemini-pro` for `Wysoki`/`Krytycznie ważne` (ADR-042). Migration `021` kept the Gemini rows and dropped the Claude vision rows; the Gemini aliases were renamed `-eu`→none (global endpoint, never EU-pinned).

What still stands from the decision above: removing the `personal_data`/EU-residency axis, collapsing the table to `(impact, modality)`, dropping the Bedrock-EU tier, and the static controller-side compliance posture. Only the multimodal *destination* flipped Claude→Gemini — so Gemini is now the **active** multimodal route, not a dormant alias. The migration cited above as "016" landed as **`021`** (015–020 were consumed by intervening work); the erasure migration (ADR-041) is **`022`**.
