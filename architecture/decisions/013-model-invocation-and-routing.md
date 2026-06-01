# ADR-013: Centralized model invocation and sensitivity-gated, data-driven routing

Date: 2026-06-01
Status: Accepted (implementation DEFERRED until after Phase 2)

## Context
All inference currently goes to AWS Bedrock (eu-central-1), routed by importance
(Ważność) across Haiku/Sonnet/Opus. Two future capabilities must be possible
without rearchitecting:
1. Routing non-sensitive tasks to non-Bedrock providers for capability/cost
   (e.g. image generation, web-augmented research), while sensitive (PII/PI)
   tasks remain on EU-resident, GDPR-compliant Bedrock.
2. Adding providers/models over time.

We are NOT building these now. We are preserving the seams so they slot in later.

## Decision
1. **Centralized model invocation (seam).** Every model call goes through ONE
   reusable n8n sub-workflow ("invoke model"). No scattered direct provider
   calls. Adding a gateway (e.g. self-hosted LiteLLM) or a provider is then a
   single change in one place.

2. **Discrete selection step (seam).** Model/provider choice is computed in its
   own step taking inputs (importance, sensitivity, task_type) → output
   (provider, model). Today only importance is used; adding sensitivity and
   task_type later does not ripple downstream. This step is also the chokepoint
   where the compliance rule lives.

3. **Routing as data, not code.** The (task_type, sensitivity) → (provider,
   model) mapping is stored in Supabase (e.g. a `model_routing` table), not
   hardcoded — configurable without redeploys, consistent with the
   definitions-as-data pattern used elsewhere.

4. **Sensitivity classification (deferred), hybrid design.** A discrete
   classification step, run early in the pipeline, produces a sensitivity
   verdict consumed by the selection step. Hybrid:
   - **Deterministic rules** for structured PII: non-@haxe email addresses,
     phone numbers, postal addresses, ID-like patterns (regex; cheap, exact,
     no tokens).
   - **Lightweight model** only for fuzzy/contextual PII: personal names NOT on
     the intrateam allowlist, free-text personal references. (Intrateam names
     are a known small allowlist; any name off it = potential external person =
     treat as PII.)
   - **The name/email allowlist must be self-maintaining, not hand-curated.**
     A static list rots the moment someone joins or leaves and silently
     degrades classification (a departed member's name still treated as
     internal; a new hire's flagged as external). Source it from the ClickUp
     workspace user list via a daily refresh into a cached table (e.g. the
     same Supabase `model_routing` / definitions-as-data layer). The cache —
     not a hardcoded constant — is the allowlist the classifier reads.
     Fail-safe applies here too: if the refresh is stale or unavailable, an
     unknown name falls through to "treat as PII," which only over-flags
     (routes to Bedrock-EU), never under-flags.

5. **Asymmetric fail-safe (the backbone).** When classification is uncertain OR
   unavailable, default to Bedrock-EU. The error types are not equal:
   - false negative (PII routed to non-EU provider) = GDPR breach — severe.
   - false positive (clean task routed to Bedrock) = mildly suboptimal — trivial.
   Bias the system toward "treat as sensitive when in doubt." This principle
   overrides any optimization that would route ambiguous content off Bedrock.

## Implementation status
DEFERRED until after Phase 2. Today everything routes to Bedrock-EU — the safe,
compliant-for-everything default. Phase 2 establishes seams 1 and 2 (centralized
invocation + discrete selection step) while building the first agent. The
classification step (4), provider expansion, and the routing table (3) are built
later, on demand. During Phase 1–2, do NOT build the classifier or add
providers; only preserve the chokepoint and the discrete selection step.

## Consequences
- Multi-provider, sensitivity-gated routing becomes an additive change, not a
  rewrite.
- The fail-safe default means a missing/broken classifier degrades to "compliant
  but unoptimized," never to "non-compliant."
- Watch for scope creep at Phase 2: writing classification logic "while in there"
  is the trap — stop at the seam.
