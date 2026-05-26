# ADR-003: Single comprehensive prompt instead of Builder/Critic/Synthesizer

## Context

Early designs used a Builder → Critic → Synthesizer pattern with 
three sequential LLM calls. With Opus-class models in 2026, this 
explicit role separation may no longer be necessary - a single 
well-engineered prompt can produce equivalent quality.

## Decision

Use a single comprehensive prompt that instructs the model to:
1. Draft an initial response
2. Critique that draft (factual accuracy, brand voice, completeness)
3. Revise based on the critique
4. Output the final version

All in one API call. A deterministic Formatter Skill handles output 
structure as post-processing.

## Consequences

Positive:
- 3x cost reduction vs three Opus calls
- ~60% latency reduction
- The critic and synthesizer share complete context vs serialized handoff

Negative:
- Slight observability loss (can't see internal critique step easily)
- Higher quality bar for the persona prompt itself
- If single-prompt quality regresses on specific process types, 
  fallback to multi-step variant per-process

## Date

2026-05-26