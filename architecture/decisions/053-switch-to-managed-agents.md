# ADR-053: Switch from bare model calls to Managed Agents

Status: Accepted
Date: 2026-06-16
Supersedes parts of: the single bare-call spine design
References: ADR-035 (cost logging), ADR-043 (GDPR posture), ADR-047 (fallback seam, shape-agnostic Call Model), ADR-048 (input file handling), ADR-049 (file storage and per-user permission fidelity), ADR-050 (Google native AI interplay)
Spec: multimodal-io-and-spine-decomposition-spec.md
Beta surface: Anthropic Managed Agents, header `managed-agents-2026-04-01` (public beta since 2026-04-08)

## Decision (verdict first)

The agent system stops calling bare model endpoints and routes all agent tasks through Anthropic Managed Agents as a single orchestration lane. The managed agent reasons, runs tools and code, and produces output including office documents via Skills. Deterministic input processing stays out of the agent. Image generation is delegated to the existing n8n workflow exposed as a custom tool. The bare LiteLLM path is retained only as a dormant degraded failover.

## Context

A bare inference call (the original spine) has no harness: no tool loop, no code execution, no web search, no document generation. The capability that makes the chatbot useful is the harness around the model, not the model. Replicating that harness in n8n is building a commodity that the model providers now sell.

Managed Agents is a hosted runtime: Anthropic runs the sandbox, the tool harness, and the agent loop. An agent (pre-created, versioned) holds `model`, `system` (up to 100k chars), `tools`, `skills` (up to 64, including anthropic docx/xlsx/pptx/pdf), and `mcp_servers` (up to 20). A session references an agent plus an environment; you send `user.message` events and stream `agent.message` / `tool_use` / `tool_result` until idle. The Files API handles upload and download. Vaults hold MCP credentials (OAuth auto-refresh or bearer), proxied outside the sandbox so generated code cannot reach them.

Two facts unblock a single lane:

1. Residency is not required. DPA, SCCs, and the DPF carry GDPR lawfulness, which is what we consciously require; data residency (a stronger property) we do not. This removes the Bedrock carve-out and lets us use the global Anthropic endpoint with the full tool harness (web search included; web search is absent on Bedrock) for every task, including PII.
2. Latency no longer separates a bare call from a managed session. The decoupled runtime starts inference as soon as the session log is readable and provisions sandboxes lazily (only when code runs), so a text-only task never spins a sandbox and TTFT is dominated by inference. The upfront container cold-start that was the only reason to keep a bare lane has been engineered out (reported p50 TTFT down roughly 60 percent, p95 over 90 percent). Cost delta is also minor: the $0.08 per session-hour runtime is idle-free and near-zero on short tasks, and tool and skill definitions are cached.

The system is async-first (scheduled delivery), so interactive latency is ceded to the chatbot products and is not a design constraint.

## Decision detail

1. Single endpoint. Anthropic Managed Agents is the sole orchestration endpoint for agent tasks. No separate agentic-versus-bare routing decision exists.

2. Residency dropped. Global Anthropic endpoint, full tools, all tasks including PII. Recorded basis: the requirement is lawful processing (DPA, SCCs, DPF), not residency.

3. One lane, routed by impact only. Impact (Niski, Sredni, Wysoki, Krytycznie wazne) selects the agent model variant (Haiku, Sonnet, Opus, Fable) by routing to one of a small set of agent definitions that share system prompt, skills, and tools and differ only in model. Tools are exposed universally; the agent self-selects tool use at runtime. There is no classifier and no new custom field. Mis-set impact degrades to a wrong model tier, not a missing capability, because tools are always present.

4. Read-input stays deterministic and out of the agent. The read-input workflow (fetch, unzip per ADR-048, Docling extraction, classify) is kept and now feeds work-ready content to the managed agent instead of a bare call. Rationale: extraction is deterministic, so paying sandbox runtime plus orchestration tokens every run to redo it non-deterministically is wasteful, and it would lose the `[BRAK]` contract, idempotency, and orphan rollback from ADR-048. Zip handling stays in n8n (Docling does not parse archives). The agent's in-sandbox extraction (Docling installable as a package or MCP) is retained only as a fallback for unexpected formats, never the default path.

5. Image generation as a custom client-side tool. Anthropic has no image model, so generation calls out to Google or OpenAI. The existing n8n image workflow (including the parallel-image Code node) stays intact and is exposed as a tool `generate_image{prompt, reference_file_id?, count?, aspect_ratio?}`. Flow: the agent emits a `tool_use`; n8n, listening to the session stream, fires the image workflow; the result is uploaded to the Files API; n8n returns a `custom_tool_result` with the `file_id`; the agent embeds it; post-reply assembles the ClickUp deliverable. Internal generation is untouched; only an input/output contract and a new trigger entry point are added. The Files-API upload lives in the tool handler so the image workflow stays provider-agnostic. Cost logging (ADR-035) is preserved because n8n executes the tool.

6. Web research subworkflow retired. Web search is a built-in in-context server tool in the harness, strictly better than an out-of-context n8n subworkflow. Tasks needing research route to the harness. The standalone web-research subworkflow is deleted.

7. Layered provider independence.
   - Image layer: full independence, essential. Google and OpenAI both sit behind the image tool; swap freely because image generation is a stateless call and the models leapfrog (Nano Banana, GPT image, Imagen).
   - Bare-text failover layer: full independence, retained via LiteLLM including the Gemini family.
   - Agentic-harness layer: single-provider commitment to Anthropic. The three managed-agent harnesses differ in API shape and pricing model, not capability; normalizing them is high-cost, low-swap-frequency work; Anthropic Skills fit the document need and its one gap (images) is already delegated.

8. Normalized output contract. One internal contract `{text, files[], cost, status}` is consumed by the post-reply sub-workflow, with one Anthropic adapter implemented now (shape-agnostic seam, per ADR-047). This decouples downstream nodes from the provider and bounds any future agentic-provider swap to a single adapter. OpenAI and Google agentic adapters are not built speculatively.

9. Beta posture and failover. Managed Agents is public beta; treat as production-with-a-seatbelt. The bare LiteLLM text path plus the image tool are retained as a degraded outage failover: during an Anthropic incident, text and images keep flowing on the provider-agnostic paths while agentic tasks pause or run degraded. For async work this is acceptable. Full agentic failover to another provider is not preserved unless the second adapter (point 8) is pre-built. Apply ADR-047 discipline: retry on 529, degrade gracefully.

## Rejected alternatives

- R1. Keep bare model calls as the primary endpoint. A bare call has no harness; it cannot do multi-step tool use, file production, or research, which are the core needs.
- R2. Two routing lanes (bare for Niski, Managed Agents for Sredni and up). Latency no longer separates them and cost delta is minor; impact is the wrong axis for lane selection because a Niski task can require a tool (a low-impact competitor price check needs web search); two hot paths are not worth an immaterial saving. Bare path demoted to dormant failover.
- R3. A classifier LLM call to detect agentic need. Re-derives what impact already carries and pre-empts the runtime tool-selection the agent does for free; adds latency, cost, and non-determinism; mis-routing toward the harness is cheap, so precision is not worth buying.
- R4. A new custom field to flag agentic need. Field bloat; unnecessary given one lane plus impact.
- R5. Offload input extraction to the sandbox and delete read-input. Extraction is deterministic; redoing it in the agent costs runtime plus orchestration tokens each run and loses ADR-048 determinism. Sandbox extraction kept only as an unknown-format fallback.
- R6. Keep EU residency via Bedrock. DPA, SCCs, and the DPF give the required lawfulness; residency is not required; Bedrock lacks the web search tool, crippling the harness.
- R7. Build cross-provider agentic independence now. Harnesses differ in API shape and pricing model; high-cost, low-swap-frequency; the output contract gives a bounded exit instead.
- R8. Image generation via direct sandbox HTTP or a hosted MCP. Direct HTTP bypasses the workflow, the parallel executor, and cost logging, and needs unrestricted sandbox networking; an MCP exposes an inbound endpoint. The custom client-side tool keeps the lane and logging in n8n.
- R9. Generate images natively. Anthropic has no image model.

## Consequences

- Deleted: the orchestration loop, the output-format adapters, and the web-research subworkflow. Office-document output is handled by Skills. Within-task parallelism (for example N images) runs inside the sandbox; across-task parallelism uses the Code-node Promise.all session fan-out, replacing fragile in-n8n branch parallelism.
- Retained and concentrated: the differentiating layer (ClickUp integration, agent definitions encoding domain rules, GRACE, brand, never-invent, governance and routing, post-reply delivery).
- Accepted trades: Niski runs on Haiku inside the harness, not Gemini Flash; the Flash cost lever is abandoned as immaterial (single-digit dollars per month at realistic email volume). Beta dependency; agentic capability is not preserved through an Anthropic outage unless the second adapter is pre-built. The harness adds a minor, nonzero per-run cost on trivial tasks (cached definitions plus negligible runtime).
- Cost-optimization surface moves to the agentic lane: prompt caching, right-sizing the model tier to impact, the Batch API for non-urgent runs, avoiding gratuitous tool calls, and web search at $10 per 1,000 calls. The email lane is cost noise.
- Open follow-ups: a Docling fidelity check only if the unknown-format fallback is ever exercised; confirmation that the second adapter is worth pre-building if Anthropic agentic quality ever slips.
