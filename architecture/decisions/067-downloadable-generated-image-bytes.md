# ADR-067: Downloadable generated-image bytes for in-document embedding

## Context

`generate_image` (the in-harness MCP tool, ADR-055) generates an image, uploads the bytes to
the Anthropic Files API with `purpose=agent`, and returns only a `file_id`. A `purpose=agent`
upload is **not downloadable**, and on the MCP path the produced bytes never return to n8n.
That `file_id` is enough to render the image **inline** in a ClickUp comment (the output adapter
fetches the bytes from the `agent-output-images` Supabase carrier the handler already writes —
ADR-053/055 Block 6), but it is **useless for embedding the image inside an office document**
(`.pptx`/`.docx`/`.xlsx`/`.pdf`): a skill building a deck in the agent sandbox has no way to get
the raw bytes onto the session filesystem.

This caused a concrete failure (the 2026-06-30 `.pptx` task, ClickUp `869dxn3d8`): the agent
generated images, then spent ~4 minutes probing the sandbox filesystem for bytes that were never
there, and finally fell back to vector-only visuals. The picture the user asked for never made it
into the deck.

The carrier already holds the bytes — they are written to the private Supabase Storage bucket
`agent-output-images` keyed by `file_id` (24h TTL, migration 037). What was missing was a way for
the **agent sandbox** to fetch them.

## Decision

Return a **short-TTL signed download URL** for each generated image alongside its `file_id`, and
teach the agent to download from it when embedding into an office document.

**Server (`image-tool-handler.json`, shared core).** After the existing carrier write
(`Has Carrier Bytes? → Convert Carrier File → Upload Output Image to Storage`), a new
`Sign Output Image URL` node mints a signed read URL via Supabase Storage REST
(`POST /storage/v1/object/sign/agent-output-images/<file_id>` with `{expiresIn: 3600}`, auth =
the predefined `supabaseApi` service-role credential). `Build Stored OK` turns the returned
relative `signedURL` into an absolute `download_url` and attaches it to the OK entry; `Aggregate`
surfaces `images[].download_url`.

**MCP result (`image-mcp-tool-handler.json`).** `Build MCP Output` now returns
`images: [{ file_id, download_url }]` to the agent. It **still drops `b64_json`** — base64 in the
tool result is context pollution; inline rendering is by `file_id`, office-doc embedding is by
`download_url`.

**Contract (`sync-agent-definitions.json → Build System`, `CONV=16`).** The `generate_image`
guidance now states the tool returns, per image, a `file_id` **and** a `download_url`; to show an
image **inline** use `file_id`; to embed an image **inside** an office document, download the
bytes from `download_url` into the session and embed (the `file_id` alone cannot be embedded
because the Files-API upload is not downloadable). The office-document guidance carries the same
note.

**TTL.** 1 hour — short relative to the 24h bucket purge, but long enough to survive a long agent
session (including the future waiter era, ADR-066, where a session may run ~45 min).

This amends ADR-055. It does **not** change the inline-comment path (still `file_id` → carrier →
inline op).

### Sandbox egress (A4) — probed GO

The design assumes the managed-agent sandbox can make outbound HTTPS to the Supabase carrier.
Verified live (2026-06-30): a managed task ran `curl` against
`hkeslnosxibeuesxndnz.supabase.co/storage/v1/...` and reported HTTP 400 (request reached Supabase
— expected for an unsigned/nonexistent object) with the network egressing successfully. The
sandbox is not network-blocked from the carrier.

## Consequences

- **Generated images embed in office documents.** Verified end-to-end (2026-06-30, disposable task
  `869dxun5g`): the agent generated a 1024×1024 PNG, downloaded it from `download_url`, and the
  `.pptx` attached to the ClickUp comment contains `ppt/media/image-1-1.png` (a valid PNG
  1024×1024, byte-verified). The wasted filesystem probing and the false "attached" implication are
  gone.
- **No base64 in the tool result.** The agent receives `file_id` + `download_url` only; bytes stay
  out of the model's context.
- **Reliability (silent-degradation guards).**
  - *Signing failure* → `Build Stored OK` still emits the OK entry **without** `download_url` and
    sets `sign_failed`; `Aggregate` fires an `image-tool/sign-failed` **WARN**. The image still
    renders inline by `file_id`; only office-doc embedding may fall back to vector visuals.
  - *Sandbox download failure* → the contract instructs the agent to fall back to vector visuals
    and continue.
  - The signing node is on a side branch with `onError=continueErrorOutput`; it can never break the
    tool return. No new alert channel; reuses the handler's existing `Post Alert` seam.
- **New short-lived bearer URL.** The signed URL grants read to one ephemeral generated image that
  the bucket purges at 24h; the URL itself expires in 1h. Low sensitivity, bounded exposure.
- **Inline path unchanged.** `file_ids` and the inline render path (`image_manifest`) are
  untouched; ADR-067 only **adds** `download_url`.

## Date

2026-06-30
