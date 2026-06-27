# ADR-063 Block 0 — assumption verification (findings)

Date: 2026-06-27
Outcome: **GO** (tool-call delivery is feasible on the live lane; bare lane feasible with more surface).

## What Block 0 had to prove

The plan replaces the fragile free-text JSON block-array output with a `deliver_output`
**custom tool** whose input schema *is* the block array, so the Anthropic API hands us a
validated JSON object instead of prose we hand-parse. Block 0 verifies the three load-bearing
assumptions before any build.

## Finding 1 — where custom tools are declared (CONFIRMED, proven pattern)

Custom tools are declared in **`sync-agent-definitions.json` → `Build System`** node, in the
`tools[]` array, and pushed to the managed agent via `POST /v1/agents` (`Upsert Agent`,
body includes `tools`). There are already **six live client-side custom tools** of the exact
shape we need:

```
extract_clickup_task, get_task_comments, get_parent_chain,
list_attachments, get_attachment, get_task_details
```

each `{ type: 'custom', name, description, input_schema: { type:'object', properties:{…}, required:[…] } }`.

⇒ Registering `deliver_output` is **one more entry in this array** (mirror `extract_clickup_task`),
then bump `CONV` to force a re-sync. No new machinery.

The **root-cause instruction lives in this same node** — the `contract` string that mandates
"Twoją finalną wiadomością zwróć WYŁĄCZNIE tablicę JSON bloków… PIERWSZY znak to „[", OSTATNI „]"".
The change-log even records the whack-a-mole prompt-patch: *CONV=7 (2026-06-24): wzmocniono zakaz
tekstu/preambuły poza tablicą bloków — model na zadaniu 869dux9ne dodał zdanie wprowadzające przed
[...], przez co render odrzucił blok obrazu (parse-fallback)*. Block 2/5 replaces this contract text
with "call `deliver_output`".

## Finding 2 — tool input round-trips intact (CONFIRMED from production)

`execute-agent-session.json → Poll Round` already captures a pending custom tool's input as a
native object: `pending_tool_input_json = JSON.stringify(picked.input || {})`. Inspected five real
production sessions (no throwaway runs):

| exec | tool | captured input |
|------|------|----------------|
| 4011 | extract_clickup_task | `{"clickup_task_id":"869ak3bbk"}` |
| 3994 | get_attachment | `{"attachment_id":"6966c837-…zip:5"}` |
| 3914 | get_attachment | `{"attachment_id":"66015fa1-…png"}` |
| 3715 | extract_clickup_task | `{"clickup_task_id":"869ceezp9"}` |
| 3347 | extract_clickup_task | `{"clickup_task_id":"869duxta6"}` |

All clean, well-formed JSON — no fence, no prose, no repair. A `deliver_output` call's block-array
input arrives the same way. **This is the entire fix:** there is no parse step left to fail.

Terminal-detection change (Block 2): today the loop routes a pending custom tool to a handler and
recurses (`Is generate_image?` / `Is extract_clickup_task?` … else "unknown tool"). `deliver_output`
must instead be treated as the **terminal** — capture its `input` as `output_blocks`, stop, and
(optionally) post a `user.custom_tool_result` ack so the session closes cleanly rather than idling.

## Finding 3 — bare lane (CONFIRMED feasible, heavier; dormant)

Live lane is **`config.agent_lane = 'managed'`** (queried). The bare lane (`Execute LLM Call (v1)`
`9qdJA4xnAGbxqkt9` → `Invoke Model (v1)` `XcOIVdZnVCCWNPeb` → `Image Resolver (v1)`) is a
config-gated **fallback, currently dormant**. It makes a single LiteLLM completion
(`model_routing.litellm_model`) with an Anthropic **Bedrock fallback tier**
(`eu.anthropic.claude-sonnet-4-6`). LiteLLM/Anthropic support `tools` + `tool_choice`, so forcing a
`deliver_output` tool call and reading `tool_use.input` is feasible — but it touches the multi-tier
fallback + Bedrock path, so it carries more surface than the managed change. It does **not gate** the
live fix; handle in Block 4 with its own verification. `Execute LLM Call → Parse Completion` and
`Image Resolver → Resolve & Explode Blocks` carry the bare-lane twin of the same fragile parser to be
deleted.

## Go / no-go

- **Managed lane (live): GO.** Registration pattern proven (6 live tools); structured input capture
  proven in production. No fallback to the plaintext+side-channel alternative is needed.
- **Bare lane (dormant fallback): GO**, lower priority, more surface — Block 4.

## Workflow IDs (for later blocks)

- Execute Agent Session (v1): `Rtb1cZbmUqmfGD98`
- Render Agent Output (v1): (managed output adapter)
- Invoke Model (v1): `XcOIVdZnVCCWNPeb`
- Execute LLM Call (v1): `9qdJA4xnAGbxqkt9`
- Sync Agent Definitions (v1): declares `tools[]` in `Build System`
- Post Alert (v1): `YSCdHlmdf3p9XEUx`

## Incidental cleanup noted (not actioned)

An **active leftover** test workflow `_TMP test-subworkflow Execute Agent Session (v1)`
(`haA2t9yQ9YJWznKN`) is live — litter from a prior `test-subworkflow.mjs` run. Should be deleted
(harness normally tears these down; this one survived). Flagged, not touched.
