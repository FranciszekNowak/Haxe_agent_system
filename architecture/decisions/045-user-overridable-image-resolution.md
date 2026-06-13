# ADR-045: User-overridable image resolution

## Context

Block 9 (ADR-036) added image generation as an output modality of `Invoke Model (v1)`. By default an
image's size is derived from the impact tier's `image_gen_params.resolution`, and a per-block `aspect`
may be emitted by the drafting model (frozen output-block contract: `{"mode":"generate","aspect":"1:1",…}`).

Operators also want to request a **specific resolution** for a given image — overriding both the tier
default and the model's choice — e.g. a wide hero banner or a tall PDP shot. The full feature has two
halves:

1. **Model-end (the size actually used by the API call).** Cheap, self-contained in `Invoke Model`.
2. **Extraction (where a human expresses the desired resolution, and how it reaches the model call).**
   Unresolved: the surface could be a new `[AI]` ClickUp field, an inline `~command`/mention syntax, or
   simply the model's per-block `aspect`. This depends on context-gathering and the Block 11 resolver,
   neither of which is built yet.

Leaving a bare "TODO: user resolution" note in `current.md` is exactly the kind of forward-note that rots
into drift (CLAUDE.md warns against this). So the model-end is **built now** and the extraction half is
**captured here + tracked as a master-plan block**, not left as a buried note.

## Decision

**Build the model-end override seam in Block 9 (done).** `Invoke Model (v1)` accepts optional inputs
`requested_size` (an explicit `"WxH"` string, e.g. `1024x1536`) and `aspect` (`"W:H"`). `Resolve Routing`
applies a fixed **precedence**:

> **`requested_size` (user) > model-emitted `aspect` (per generate block) > tier default `resolution`.**

Base edge is 1024 px (safe across `gpt-image-2` and gemini at 1K); the tier `resolution` value `'max'`
maps to `gpt-image-2`'s `quality=high` parameter, **not** a 1536² size (which the API rejects). An
explicit override sets `size_overridden=true` for observability. Verified live: `requested_size=1024x1536`
reached the provider call and produced a portrait image.

**Defer + track the extraction half.** How a human specifies the resolution and how context-gathering
surfaces it is **not** decided here. It is tracked as **Block 13** in the multimodal master plan
("resolution extraction in context-gathering"), so it is scheduled work rather than a rotting note. The
likely shapes (to be decided when Block 13 is taken): a new `[AI]` ClickUp custom field read by
`Context Gather (v1)`; or inline syntax parsed at assembly; or simply relying on the model's per-block
`aspect`. Whichever is chosen, it threads the value down to `Invoke Model`'s already-built `requested_size`
input — no further model-end work needed.

## Consequences

- The seam is real today: the moment any upstream stage passes `requested_size`, it is honored — Block 13
  only has to decide the human-facing surface and wire context-gathering to the existing input.
- `size_overridden` is carried through `Normalize Model Result` for audit/observability (not yet persisted
  to a column; persistence, if wanted, is part of Block 13).
- No new migration, no routing change — purely an input + precedence in `Resolve Routing`.
- `current.md` §context-gathering carries a one-line pointer to this ADR + Block 13 (a pointer, not a TODO).

## Update — Block 13 done, with a corrected design (2026-06-13)

The extraction half is built, but the live verification **reversed** the collision design first attempted.

**Extraction surface chosen: model-inferred.** The drafting model emits an optional per-block `size:"WxH"`
in the output-block contract; Stage A's Build Prompt instructs it to do so only when the user asks for a
specific resolution (otherwise omit `size` and use `aspect`). The Image Resolver threads `size` →
`Invoke Model.requested_size`. No new `[AI]` ClickUp field, no inline command — per operator decision.

**The guard is gpt-image-2 constraint validation, not a fixed enum.** `gpt-image-2` accepts arbitrary
`WxH` within real limits (edges divisible by 16, aspect ratio 1:3–3:1, longest edge ≤ 3840, pixel count
655 360–8 294 400). `Resolve Routing` honors a valid explicit size **exactly** and snaps to the nearest
valid size only on an actual violation, with an honest Polish note (`Żądana rozdzielczość … nie jest
obsługiwana … wygenerowano w najbliższej zgodnej: …`) rendered inline by the resolver and an
`invoke-model/size-snapped` WARN through the existing resolver-`warnings[]` → Post Alert seam.

**Reversed design (recorded for the why).** An interim build rerouted high-impact + specific-resolution
requests off `gpt-image-2` onto `gemini-3-pro-image-preview` (premise: gemini is "resolution-flexible").
A live probe disproved both halves of that premise: (a) `gpt-image-2` returned an **exact 1280×512** for a
1280×512 request (decoded from the PNG) — it is the resolution-flexible model; (b) Vertex **gemini image via
LiteLLM ignores `imageConfig`/`size`** and returned a **1024×1024 square** for a non-square request — a known
LiteLLM limitation (it does not map/forward gemini's `imageConfig`). The reroute therefore moved work onto the
one model that *cannot* honor resolution. It was dropped.

**Scope + the gemini-tier upgrade (Block 13b).** `gpt-image-2` is the only model that honors `size` through the
gateway, so explicit-resolution control works natively on its tiers (Wysoki / Krytycznie ważne). For a **gemini
tier (Niski / Średni)** size/aspect would otherwise be silently ignored (~1:1 1K), so `Resolve Routing`
**upgrades the image model to `gpt-image-2`** whenever a request carries **shape intent — an explicit `size` OR a
non-square `aspect`** — on a non-gpt tier, keeping the tier's low `image_quality` (cost stays minimal) and informing
the user with an inline Polish note plus an `invoke-model/resolution-adjusted` WARN.

**Honored on every tier (Block 13b explicit size, 13c aspect).** The trigger is shape intent, so both halves work:
verified live — Niski explicit 1280×512 → gemini→gpt-image-2, exact 1280×512 (decoded), $0.0024 (exec 1948); Niski
`aspect:"16:9"` with no pixels → gemini→gpt-image-2, returned 1104×624 widescreen (decoded, ≈16:9), $0.0036, note
posted inline (exec 1974). A 1:1 / no-shape request correctly stays on the cheaper gemini default. *Follow-up
(optional, cost only):* a native Vertex `generateContent` path would let the gemini tiers honor `aspect`/`size`
directly, avoiding the gpt-image-2 upgrade cost on low-tier shaped images — a cost optimization, not a correctness
gap (correctness is now closed).

## Date

2026-06-12
2026-06-13 (Block 13 — extraction surface built; reroute design reversed after live probe)
