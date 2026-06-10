# ADR-037: Fable 5 for the "Krytycznie ważne" tier (non-PD), with a proactive access monitor

## Context

On 2026-06-09 Anthropic released **Claude Fable 5**, the first generally
available model in its "Mythos-class" tier — sitting above Opus 4.8, and on some
benchmarks >10% ahead of it. Pricing is **$10/M input, $50/M output** — actually
*cheaper* than Opus 4.8 (~$15/$75). Franciszek asked to run the highest-impact
tasks ("Krytycznie ważne") on it.

Two constraints shaped the rollout:

1. **GDPR split (ADR-030).** Routing picks a model alias on `(impact,
   personal_data)`. Non-PD tasks go to Anthropic direct (`-direct` aliases);
   PD tasks must stay on Bedrock EU (`-bedrock` aliases) for data residency.
2. **Access is gated and time-boxed.** Fable is free on subscription plans only
   **until 2026-06-23**, then it requires usage credits. After that date, calls
   can start failing (4xx) without any code change — a silent degradation of the
   *most critical* path.

Access was probed from the LiteLLM container on the VPS (2026-06-10):

- **Anthropic direct** (`claude-fable-5`): `200` — account has access.
- **Bedrock EU** (`eu.anthropic.claude-fable-5`): `AccessDeniedException —
  "not available for this account."` Bedrock per-account model access is not yet
  granted (a manual grant in the AWS console, eu-central-1).

## Decision

- Add a LiteLLM alias **`haxe-fable-5-direct` → `anthropic/claude-fable-5`**
  (`n8n/litellm-config.yaml`, deployed to `/opt/haxe-agents/litellm-config.yaml`,
  gateway restarted).
- Point **`model_routing` impact='Krytycznie ważne', personal_data=false** at
  `haxe-fable-5-direct`, prices `0.010 / 0.050` per 1k. The nudge and
  `max_tokens=16000` are retained.
- **Leave the personal_data=true row on `haxe-opus-4-5-bedrock`.** Routing PII to
  the non-GDPR direct endpoint just to reach Fable is not acceptable. The
  `haxe-fable-5-bedrock` alias is documented but commented out in the gateway
  config until Bedrock access is granted. (In practice `personal_data` is
  hardcoded `false` today — the PD verifier is a Phase-3 placeholder — so the
  non-PD row carries effectively all live traffic.)
- Add a **proactive access monitor** — `Fable 5 Access Monitor (v1)` — a daily
  (06:15 Europe/Warsaw) 1-token probe of `haxe-fable-5-direct` through the
  gateway. On any non-2xx it fires a **CRITICAL** via `Post Alert (v1)` whose
  details carry the exact remediation (top up credits, or roll routing back to
  Opus with a ready-to-paste `UPDATE`). This is the layer the reactive handler
  cannot provide: it warns at the credit cliff *before* a real task fails.

## Consequences

- Critically-important non-PD work now runs on the strongest GA model, at lower
  unit cost than Opus.
- **Known follow-up:** request Bedrock model access for
  `eu.anthropic.claude-fable-5` (eu-central-1). Until then PD critical tasks stay
  on Opus 4.5 Bedrock. Re-run the probe after granting; then uncomment the
  bedrock alias and repoint the PD row.
- **Silent-failure coverage:** the 2026-06-23 credit cliff (and any Fable
  outage) is covered on three layers — proactively by the monitor (daily CRITICAL
  with remediation); reactively at the task level by **auto-fallback** (see
  below); and, if the fallback *also* fails, by the existing `Execute LLM Call →
  Alert Invoke Model Failed` CRITICAL on the propagated throw.
- **Auto-fallback to Opus (implemented).** `Invoke Model (v1)`'s `Call LiteLLM`
  uses `onError=continueErrorOutput`; on any non-2xx the request is retried once
  on Opus via a new `Fallback to Opus` node, **GDPR-aware** (non-PD →
  `haxe-opus-4-8-direct`, PD → `haxe-opus-4-5-bedrock` — never routes PII to the
  direct endpoint). `Parse Response` picks whichever branch returned a body and
  sets `fell_back_to_opus`; that flag drives a **WARN** through `Post Alert (v1)`
  so the degradation is never silent, while the task still completes on Opus. If
  Opus also fails, the node throws → CRITICAL. So: single-model blip = WARN +
  task completes; total failure = CRITICAL. Cost stays accurate via LiteLLM's
  `x-litellm-response-cost` header (the model actually used).
- Both layers were verified end-to-end on 2026-06-10: gateway call to
  `haxe-fable-5-direct` returned `200`; the monitor's success path probed clean
  with no alert; a forced-400 self-test drove the error branch → CRITICAL →
  ClickUp comment on the Alerts task (followed by an INFO note clarifying the
  self-test). The auto-fallback was verified via a temporary harness firing
  `Invoke Model`'s real trigger: normal run used Fable with no WARN; a forced
  primary failure (`model_override` = bogus alias) fell back to
  `haxe-opus-4-8-direct`, set `fell_back_to_opus=true`, posted the WARN, and the
  task completed. Harness + test `agent_runs` rows were removed afterward.

## Date

2026-06-10
