-- 038_agent_runs_attachment_ids.sql
-- ADR-053 Block 7: record the ClickUp ATTACHMENT ids the managed lane creates on the
-- erasure hub (`agent_runs`, ADR-044). When the agent produces an office document
-- (xlsx/docx/pptx/pdf via Skills/code-exec), `Post Reply (v1)` downloads it from the
-- Anthropic Files API, validates it, and uploads it to the ClickUp task as an attachment.
-- Those attachments are free-floating artifacts that may hold personal data (a customer
-- spreadsheet, an invoice), so — like `clickup_comment_id` (migration 022) — the ids must
-- be recorded on the run row so an erasure request (Art 17) can delete them via API.
--
-- ClickUp v2 has NO delete-attachment endpoint today (CLAUDE.md), so recording the id is
-- the erasure-readiness hook regardless; if/when a delete path exists the runbook has the
-- ids it needs. We record BOTH office-doc task attachments AND inline image-comment
-- attachments here (both are deletable ClickUp artifacts created by the run); `Post Reply`
-- folds the image attachment ids (from Rewrite Delta) and the doc attachment ids together.
--
-- Append-only (CLAUDE.md): one nullable jsonb array column, written by Post Reply's
-- Record Artifact node (the sanctioned post-delivery UPDATE — no second agent_runs
-- writer). Zero behavioural change for the bare lane (which produces no doc attachments);
-- the column stays null/[] there.

alter table public.agent_runs
  add column if not exists clickup_attachment_ids jsonb;

comment on column public.agent_runs.clickup_attachment_ids is
  'ADR-044/ADR-053 Block 7: jsonb array of ClickUp attachment ids created by this run '
  '(office-doc task attachments + inline image-comment attachments), recorded by '
  'Post Reply (v1) Record Artifact for erasure-readiness. Null/[] for runs that attach nothing.';
