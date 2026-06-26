# ADR-062: Tier-additive cached system prefix (deferred follow-up to ADR-061)

Status: Proposed (deferred — not scheduled)
Date: 2026-06-26
Depends on: ADR-061 (dynamic context loading — floor/tail split, accepted), ADR-053 (Managed Agents lane + `Sync Agent Definitions`)
Supersedes/refines: ADR-061 decision detail 3 ("additive system prompt by impact tier, in the cached prefix"), which ADR-061 deferred out of its own scope.

## Context

ADR-061 split context into a bounded **floor** (pre-loaded) and an unbounded **tail** (pulled on
demand). It also proposed, as decision detail 3 / its "Block 3", that the **system prompt** become
**additive by impact tier** — base rules, then `+medium`, then `+high` stacked as strict supersets —
placed in the **cached static prefix above any dynamic context**, so each tier yields one stable,
cacheable prefix.

ADR-061 was explicit that this layering is **for correctness and clarity (right rules per tier,
impact stated in-context), not for token savings** — the entire token win is the floor shrink, which
the ADR-061 Block 3 end-to-end test confirmed (a trivial-on-heavy run now costs **2 uncached input
tokens**, because the single `q7wz-44812` rules page already lives in the cached agent `system`). So
the additive-prefix work earns its keep only on **rule correctness per tier**, not on cost.

It was deferred from the ADR-061 build for three concrete reasons, recorded here so the follow-up
starts from the real state, not the original ADR text:

1. **It needs four tier-specific agent `system` variants.** Today `Sync Agent Definitions (v1)` bakes
   one rules page into every routed agent's `system` (all five tiers share the same rules text). The
   additive design needs base / `+medium` / `+high` supersets authored and synced per tier, plus the
   in-context tier declaration ("this task is of high importance") placed above all dynamic context.
2. **An unconfirmed harness cache-semantics gate (ADR-061 G1).** ADR-061's Block 3 e2e *practically*
   answered the **re-use** half of G1 — a heavy run re-read `cache_read_input_tokens=98299` across its
   tool round-trips, so the cached prefix is reused on every turn. It did **not** confirm the half this
   ADR depends on: that **four distinct per-tier prefixes** each cache **independently and stably**
   (i.e. that interleaving the tier declaration does not break the cache boundary and re-bill the
   prefix at full rate, the load-bearing invariant ADR-061 decision detail 3 calls out).
3. **A rules-doc duplication to reconcile.** Stage A historically folded CU doc `q7wz-16892` into the
   per-run prompt while `Sync Agent Definitions` bakes `q7wz-44812` into `system`. ADR-061 Block 1
   already dropped the per-run fold on the managed lane (the two overlapped); a tier-additive design
   must decide the single authoritative source for each tier layer and keep the
   `Agent Rules Freshness Check (v1)` honest across four variants instead of one.

## Decision

**Deferred. Not scheduled.** No tier-additive prefix is built yet. The current single-rules-page
`system` (one page, all tiers) stands. When/if revived, this ADR is the entry point; the design is
ADR-061 decision detail 3, with the three gates above resolved first (author the four supersets,
prove per-tier prefix cache stability empirically, and settle the single rules source per tier).

## Consequences

- **No cost impact from deferring.** The token win is already fully realized by ADR-061's floor shrink;
  this ADR was never a savings lever. Deferring it leaves only the *correctness/clarity* refinement on
  the table (uniform rules across tiers today, rather than tier-tailored supersets).
- **Today every tier carries the same rules text.** A `Niski` task and a `Krytycznie ważne` task get
  identical baked rules. This is acceptable (the rules are written to apply broadly) but is the precise
  thing the additive design would improve.
- **Revival is gated, not free.** The three gates above (four `system` variants + per-tier cache-prefix
  stability proof + rules-source reconciliation) are real work and a measurable harness-caching risk;
  do not treat this as a quick follow-up.

## Date

2026-06-26
