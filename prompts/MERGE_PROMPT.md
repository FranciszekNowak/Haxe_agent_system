# Reusable merge prompt (paste into Claude Code from repo root)

Use this every time a chat session hands you a changeset for architecture/current.md
and/or new ADRs. Attach or paste the changeset file and any new ADR files, then
paste the prompt below.

---

I'm handing you a CHANGESET to apply to the architecture docs. A changeset is a
targeted diff, NOT a replacement document. Your job is to apply only the changes
it names and leave everything else untouched.

INPUTS (attached/pasted):
- A changeset file describing specific edits to architecture/current.md.
- Zero or more new ADR files for architecture/decisions/.

RULES
1. Apply ONLY the edits the changeset specifies. Do not reformat, re-summarize,
   reorder, or drop any section the changeset does not mention. Treat every
   unmentioned line as immutable.
2. The current.md may contain long detailed sections from earlier sessions
   (diagrams, tables, procedures). These MUST survive byte-for-byte unless the
   changeset explicitly edits them.
3. For each change, locate the anchor text the changeset gives. If you cannot
   find it, or it appears more than once ambiguously, STOP and report that
   change as un-appliable rather than guessing.
4. For new ADRs: add each file as-is. Check architecture/decisions/ for a number
   collision; if the proposed number already exists, renumber to the next free
   contiguous number and report the rename. Then verify the whole decisions/
   sequence is contiguous (0001..N) with no gaps or duplicates.
5. Bump/seteany version/date header fields exactly as the changeset states.

OUTPUT (do all before committing)
- A unified diff of architecture/current.md.
- The final ordered list of files in architecture/decisions/.
- A bullet list of: changes applied cleanly, changes that needed adaptation
  (e.g. ADR renumber, section inserted vs replaced), and any changes you could
  NOT apply (with the reason).
- Then WAIT for my approval.

CONSTRAINTS
- Do not commit or push until I approve the diff.
- Never stage .env, *.key, or any credential file.
- Touch only architecture/current.md and architecture/decisions/. No other files.

After I approve, stage and commit with a concise message summarizing the
changeset (e.g. "docs: Phase 0 infra status + ADR-0006 VPS hardening"). Do not
push unless I say so.
