# ADR-021: Bedrock model invocation in n8n — native AWS Bedrock node + EU inference profiles

Date: 2026-06-03
Status: Accepted

## Context
Phase 2 needs the generic pipeline to call Claude on AWS Bedrock (eu-central-1)
from n8n. ADR-013 fixes the architecture (one centralized "invoke model"
sub-workflow + a discrete selection step) but leaves the concrete node/credential
implementation open. ADR-019 requires authenticated I/O to live in a
credential-aware node. A live smoke test (`Invoke Model smoke test`) settled how
Bedrock is actually invoked.

## Decision
- **Invoke Bedrock through the native n8n "AWS Bedrock Chat Model" node**
  (`@n8n/n8n-nodes-langchain.lmChatAwsBedrock`), driven by a chain root
  (`Basic LLM Chain`), authenticated by the n8n `aws` credential. This is the
  *internal implementation* of the ADR-013 "invoke model" seam; the seam boundary
  remains the reusable sub-workflow, so a future provider swap (or a self-hosted
  gateway like LiteLLM) is still a single-place change.
- **Use EU cross-region inference profiles, not on-demand foundation-model IDs.**
  Claude 4.x on Bedrock EU rejects on-demand invocation ("Invocation of model ID …
  with on-demand throughput isn't supported. Retry … with an inference profile").
  Invoke via the `eu.`-prefixed profile, e.g. `eu.anthropic.claude-sonnet-4-6`
  (verified returning a completion, 2026-06-03).
- **Do NOT use the generic AWS credential on an HTTP Request node for Bedrock.**
  n8n's generic AWS credential derives the SigV4 signing service from the
  hostname, signing `bedrock-runtime`; Bedrock requires the service to be
  `bedrock`, producing `403 InvalidSignatureException: Credential should be scoped
  to correct service: 'bedrock'`. The credential exposes no service override, so
  the otherwise-preferred inspectable HTTP/SigV4 path is unusable here. (This is
  the one place the "credential-aware HTTP Request node" of ADR-019 is satisfied
  by a dedicated service node instead.)

## Consequences
- The "invoke model" sub-workflow uses LangChain machinery (a chain root + the
  Bedrock model sub-node) rather than a raw HTTP call. Accepted: it signs
  correctly and is still centralized behind the seam.
- The selection step (ADR-013) feeds this node a model/profile string. Today only
  the Sonnet profile is verified; Haiku/Opus EU profiles follow the same `eu.`
  pattern.
- **Model-tier mapping is a pending two-axis design decision, not a default.**
  The live importance field has five levels (current.md §13.2) and — per ADR-013 —
  model choice also depends on **sensitivity** (PII / personal-data presence) set
  by an earlier classifier node. The mapping is therefore
  (importance × sensitivity[, task_type]) → (provider, model, priority), stored as
  data, fail-safe to Bedrock-EU when sensitivity is uncertain.
- Tier-3 AWS credentials remain operator-entered in the n8n UI (ADR-011); the
  credential's own "allowed HTTP request domains" must permit
  `bedrock-runtime.eu-central-1.amazonaws.com` or the signed request is blocked.

Related: ADR-013 (centralized invocation + sensitivity-gated routing), ADR-019
(credential-aware nodes do authenticated I/O), ADR-011 (Tier-3 credential storage),
ADR-018 (Claude Code builds n8n via the MCP control plane).
