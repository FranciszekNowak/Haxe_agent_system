# ADR-002: Bedrock EU as sole inference provider

## Context

Multiple LLM provider options exist: Bedrock (Claude + others), 
OpenAI direct, Anthropic API direct, Vertex AI (Gemini), Perplexity 
Agent API. Need to choose given:

- GDPR compliance requirement (data must stay in EU)
- Cost sensitivity at SME scale
- Multi-model routing was considered but adds complexity

## Decision

AWS Bedrock in eu-central-1 (Frankfurt) is the sole inference 
provider. Claude Haiku for Low importance, Sonnet for Medium, Opus 
for High and weekly proposer.

No multi-provider routing. No dual-path PII handling. Bedrock EU 
for everything.

## Consequences

Positive:
- Full EU data residency (AWS DPA covers compliance)
- Single credential, single rate limit, single billing
- No conditional routing complexity
- Can swap to Anthropic API directly when EU residency ships there

Negative:
- Locked to Claude family + open-weight models on Bedrock
- No GPT or Gemini access without separate setup
- 30% higher cost vs running non-PII tasks on cheaper providers

The cost penalty is acceptable at our scale. Simplicity wins.

## Date

2026-05-26