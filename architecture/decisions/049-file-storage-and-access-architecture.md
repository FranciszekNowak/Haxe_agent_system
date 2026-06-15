# ADR-049: File storage and access architecture

**Status:** Accepted (email path pending one values confirmation; Shared Drive/Group layout is a build-time follow-up)
**Date:** 2026-06-15
**Supersedes:** the file-storage line in `multimodal-io-and-spine-decomposition-spec.md` ("Google Shared Drives as system of record, Synology NAS as optional LAN cache")
**Related:** ADR-043 (GDPR posture: PD-blind, DPA + SCCs), ADR-048 (input file handling; ClickUp attachment-URL TTL noted there)

## Context

The earlier spec already named Google Shared Drives as the system of record with Synology as an optional LAN cache. Two developments reopened it and forced the question to be answered properly rather than assumed:

1. Synology was found to expose a WebAPI (FileStation), which raised the option of connecting the agent directly to the NAS with per-user permissions.
2. A hard permission requirement surfaced that the earlier framing did not account for.

The requirements the architecture must satisfy:

- **Per-user differentiated file access.** Departments must not see each other's files (Marketing must not read Purchasing). A single coarse "everyone can read" share is not acceptable.
- **Permission-scoped agent grounding.** When the agent answers a user's question using files as grounding, it must be confined to what that user could see. A marketing manager must not be able to extract a purchasing price through the agent.
- **Event-driven operation.** No scheduled jobs where avoidable (consistent with the event-driven architecture principle).
- **GDPR** handled through the existing DPA + SCC posture (ADR-043), with the agent PD-blind.
- **Low operational overhead** at five-person scale.

One fact reorders the whole decision: the agent runs in n8n on a cloud VPS, not on the office LAN. Any "the NAS is fast and local" reasoning does not reach a cloud-resident agent, and exposing the NAS to the cloud means either publishing DSM to the internet or running a tunnel.

## Decision

### 1. Google Workspace is the system of record and the sole permission authority

Google Drive holds the durable file corpus and is the single authority for file permissions. Gmail is the mail system. The agent integrates against the Drive API and the Gmail API. This is chosen on engineering merit, and the per-user requirement only strengthens it: Drive provides native per-user ACLs for humans and a clean, audit-logged impersonation primitive (domain-wide delegation) for the agent, neither of which Synology offers.

### 2. Synology is demoted from live store to backup and optional cache

The NAS keeps two real jobs and loses the one that caused problems:

- **Encrypted disaster-recovery and sovereignty backup** of Drive (one-way content sync) and of mail (nightly IMAP pull). This is an admin-only, non-browsed surface, so it needs no per-user ACLs and the differentiation requirement does not apply to it.
- **Optional coarse, broadly-readable LAN media cache** for bulky assets, if local speed for the creative library proves worth a few static department shares. This holds only broadly-readable content, so it needs no per-user ACLs either.

The agent never connects to Synology. The live-file-server role (the only role that would have demanded a duplicated per-user ACL model) is dropped.

### 3. Lifecycle split: one file, one home, one authority

Files live in exactly one system, chosen by lifecycle stage, and that system is their sole permission authority. The three systems hold different stages, not copies, so no cross-system permission sync is required or permitted.

| System | Stage / content | Permission authority |
|---|---|---|
| ClickUp | Live, in-progress, task-bound files | Task visibility |
| Google Drive | Durable, low-churn corpus (legal, purchasing, operational) | Drive ACLs (audience x handling, below) |
| Stockpress | Final, approved marketing assets and B2B distribution | Stockpress roles (human endpoint, no agent integration) |

The governing rule, recorded to prevent future drift: never permission the same file in two systems. That is what would recreate the permission-sync tar pit in a new form.

### 4. Agent file access

The agent integrates with exactly one file system, Drive, in two modes:

- **As its own service-account identity**, a member of the Shared Drives it is meant to read unconditionally (the broadly-shared corpus). Distinct, auditable, revocable identity, treated as a privileged account with a security key.
- **On behalf of a user, via domain-wide delegation.** For permission-scoped grounding the agent impersonates the asking user; the Drive API then returns only what that user can access. Confinement is enforced by Google, not by custom logic.

For the sensitive corpus, which is small and static, prefer **live impersonated fetch** over pre-embedding. This sidesteps the permission-aware retrieval problem entirely (a shared vector index cannot enforce per-user ACLs). Build permission-aware RAG (group-namespaced index plus a query-time impersonated authorization gate) only if keyword-grade Drive search proves insufficient for the questions asked.

### 5. Drive permission model: two orthogonal dimensions

Policy is one choice from each axis, not a bespoke per-file setting. This is what keeps it scalable and low-overhead.

**Audience** (who can see it), each implemented as one Shared Drive whose membership is one Google Group:

| Tier | Who |
|---|---|
| A0 Public | Anyone, incl. external (catalogs, leaflets) |
| A1 Company | All staff; external sharing blocked |
| A2 Departmental | One department group (Purchasing, Legal, Ops, Marketing). The Marketing-cannot-read-Purchasing boundary |
| A3 Restricted | Named people or owner only |

**Handling** (what members may do), layered on top:

| Tier | Effect | Mechanism (Business Standard) |
|---|---|---|
| B0 Full | View/edit/download/share | Default |
| B1 No external | Usable internally, cannot leave the org | Org + per-Drive "no sharing outside members" |
| B2 No extraction | Viewers/commenters cannot download/print/copy | Per-Drive or per-file toggle; restrict those users to Viewer/Commenter, since editors bypass it |
| B3 Rule-locked | Content-triggered, device/geo-gated, applies even to editors | Enterprise DLP + Context-Aware Access (not adopted, see rejected R9) |

A file's policy is an (audience, handling) pair. Membership changes are the only routine operation; onboarding a hire is one group change.

### 6. The grounding-versus-extraction-lock interaction

B2 download-lock also blocks the Drive API from serving content to a restricted viewer (`canDownload` becomes false), so an impersonated agent acting as a viewer cannot read a download-locked file. Therefore, per corpus:

- Files the agent must ground on stay at B0 or B1 and rely on audience membership (A2) for confidentiality, not on download-locking.
- Files that are human-facing and must never be extracted go B2, and the agent does not ground on them.

One file cannot cleanly be both agent-grounded and download-locked. This is decided per corpus, not globally.

### 7. Email: Gmail API

The agent's email role is heavy (draft, thread, send, attachments in and out), which is exactly where IMAP/SMTP is expensive, and IMAP additionally forces polling, which fights the event-driven principle. Gmail's API provides native threading, a drafts endpoint, structured attachments, and push via watch + Pub/Sub. Continuity (the operative half of the sovereignty concern) is met by a nightly encrypted IMAP pull of all mail into the NAS. GDPR is satisfied through the DPA, SCCs, and the Data Privacy Framework as the current transfer basis, consistent with ADR-043.

### 8. Stockpress: no agent integration

Stockpress has no public API (programmatic access is partner-integration or a private enterprise API only), and its value is downstream of where the agent works, so a direct agent integration is not built. If the agent needs approved assets, they are bridged into Drive via Stockpress's native Google Drive integration and the agent reads them from Drive. The agent never writes to Stockpress (publishing is a human approval gate). Permissions here are low-stakes because final marketing assets are broadly readable, so a flat agent read of an approved-assets Drive folder is acceptable, unlike the purchasing case.

### 9. Admin and identity

Minimal Super Admins (two, for bus-factor), each protected with a physical security key and not used for daily work, plus one secured break-glass account. All other admin needs use scoped custom roles. All Shared Drive membership is managed through Google Groups, never per-user grants. System-of-record files live in Shared Drives (org-owned), never in personal My Drive.

## Rejected alternatives

**R1. Synology as primary live store, agent connecting directly via FileStation API.** Rejected. The cloud agent is not on the LAN, so there is no speed benefit and reaching DSM requires internet exposure or a tunnel. Per-user impersonation has no delegation primitive in DSM, so it requires hoarding every user's password and either disabling or defeating their 2FA, a security regression. Estimated 40 to 80 hours to build plus ongoing fragility (DSM API version drift, credential rotation, session caps), producing something strictly less secure than Drive delegation. The per-user requirement makes this strictly worse, not better.

**R2. Drive and Synology both live, with synced permissions.** Rejected. Two permission authorities means continuous reconciliation, drift, and two sources of truth. There is no off-the-shelf bidirectional ACL sync; content sync (Cloud Sync) moves bytes, not permissions.

**R3. Coarse "staff can read" NAS live share.** Rejected. Violates per-user differentiation; Marketing would see Purchasing.

**R4. Abandon LAN entirely, treated as a major loss.** Rejected framing. The speed-need and the differentiation-need apply to disjoint file sets (bulky shared media versus small sensitive docs), so the collision is illusory. The NAS survives as backup (no ACLs) plus an optional coarse media cache, and Drive for Desktop covers everyday multi-file speed by caching the working set locally.

**R5. Self-host everything (the sovereignty-and-cost case).** Rejected as the default, with its valid core preserved as insurance. The strong form of the sovereignty concern (custody and access-denial under conflict) is real and current in 2026 but low-probability for a small, non-strategic distributor, and the EU's own framing is "reduce dependency, not autarky." It is resolved by cheap insurance (encrypted backup plus a documented exit), not by in-housing the commodity. On cost, self-host undercuts Workspace only for dumb storage with admin time priced at zero; for the agentic stack the integration tax dominates and reverses the comparison.

**R6. Sovereign Polish email plus IMAP.** Rejected. No mainstream Polish host offers JMAP (Zenbox and cyber_Folks are IMAP-only), so sovereign mail means the full compose/thread/send tax plus forced polling. Sovereignty here is low-risk and GDPR is satisfied regardless through DPA/SCC/DPF. Reopen only if mail-content confidentiality from US jurisdiction (not mere continuity) becomes a hard line.

**R7. Pre-embed the sensitive corpus into shared pgvector for RAG.** Rejected for now. A shared vector index cannot enforce per-user ACLs, so a semantic query can leak a chunk the asking user may not see. Live impersonated fetch is both simpler and correct for a small, static corpus. The permission-aware RAG design (namespace partition plus impersonated authorization gate) is held in reserve for if retrieval quality forces it.

**R8. Direct agent-to-Stockpress integration.** Rejected. No public API; the value is downstream and largely redundant with the upstream corpus. Bridge via the native Drive integration instead.

**R9. Enterprise upgrade for DLP and Context-Aware Access.** Deferred. Drive DLP and Context-Aware Access require Enterprise (not Business Standard, and not even Business Plus). At five-person scale the structural controls cover the realistic threats. Upgrade triggers: a need for automated content-pattern DLP or device/geo gating (Enterprise), or legal-hold retention and eDiscovery (Vault, on Business Plus).

## Consequences

Positive:

- One permission authority (Drive), native per-user ACLs for humans, clean impersonation for the agent, all audit-logged.
- Mature, stable APIs (Drive, Gmail) with low build and maintenance cost; no credential hoarding; no exposed file server.
- Event-driven email via Gmail push.
- The NAS keeps genuine value (DR/sovereignty backup, optional media cache) without being an access surface that needs ACLs.
- One file, one authority, three systems by lifecycle stage: no permission sync, no drift.
- The agent integrates with exactly one file system.

Costs and limits, accepted knowingly:

- Workspace seat cost (Business Standard, roughly 59 PLN per user per month net of reclaimable VAT). Easily justified on human productivity alone.
- WAN latency for uncached multi-file work, mitigated by Drive for Desktop caching and by the rarity of such work (most multi-file work already happens on local disk and in ClickUp).
- US-jurisdiction exposure (CLOUD Act is legal compulsion of a US provider, not trade sanctions): low for this data, insured by the encrypted backup and exit plan.
- Platform dependency and lock-in on Google, mitigated by the documented exit plan and portable formats.
- Enterprise-only controls (rule-based DLP, Context-Aware Access, CSE) are unavailable at the current tier.

Security ceiling, stated explicitly: the guardrails are anti-bulk-extraction and anti-accident, not anti-determined-insider. They stop mass extraction and accidental oversharing, the failure modes that actually occur at this size; they do not stop screenshots, a phone camera, or an editor downloading a file they may edit. This is the correct posture for the scale.

Migration is bounded and phaseable: move the corpus into department Shared Drives, deploy Drive for Desktop on machines, point Cloud Sync Drive-to-NAS for backup, and stand up the nightly mail backup. The NAS is repurposed, not torn out.

## Open questions and follow-ups

1. Email values confirmation: verify the remaining concern is continuity (then Gmail plus backup, the chosen path) and not hard confidentiality from US jurisdiction (which would reopen R6). Current lean: Gmail.
2. Confirm the Workspace data region is set to the EU.
3. Produce the concrete Shared Drive and Google Group layout for the actual departments, plus the exact admin-console sharing settings per drive (build-time artifact).
4. Confirm live impersonated fetch as the default grounding mechanism per corpus; introduce a vector store only if keyword search is insufficient, and only with the namespace-plus-gate design.
5. Verify ClickUp attachment-URL TTL (carried from ADR-048; separate, pre-existing).
6. Write the sovereignty exit plan: portable formats, an EU-hosted or self-hosted target (Nextcloud is the documented 2026 destination), and a target migration window.

---

*Pre-commit checks: confirm 049 is the next free ADR number in `architecture/decisions/` before committing. This is an architecture decision record only; the Shared Drive/Group layout and admin-console settings are a separate build-time artifact, not part of this ADR.*
