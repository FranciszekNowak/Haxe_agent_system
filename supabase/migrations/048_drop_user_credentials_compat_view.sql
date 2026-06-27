-- 048_drop_user_credentials_compat_view.sql
-- ADR-064 contract step. Migration 047 renamed user_clickup_credentials -> user_data_and_config and
-- left a transitional compatibility view under the old name so live workflows kept resolving during
-- the cut-over. All consumers (execute-agent-session Resolve Agent, clickup-onboarding, the three
-- onboard-clickup-*.mjs scripts) now reference user_data_and_config directly, so the shim is removed
-- to keep a single path (CLAUDE.md unification rule). Append-only.

drop view if exists user_clickup_credentials;
