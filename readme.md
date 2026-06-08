# Haxe Agentic OS

Infrastructure-as-code for Haxe's internal agentic operating system.

## What this is

A system that automates routine and commoditizable work at Haxe (Polish 
wellness/electronics e-commerce distributor) through AI agents governed by 
process knowledge in ClickUp, with structured recursive self-improvement.

## Architecture

See `architecture/current.md` for the authoritative architecture description.

## Quick links

- Architecture: `architecture/current.md`
- Operating procedures: `docs/operating-procedures.md`
- Deployment guide: `infrastructure/deployment.md`
- Decision history: `architecture/decisions/`

## Stack

- ClickUp (source of truth for operational knowledge)
- n8n self-hosted (orchestration) on Hetzner VPS EU
- Redis (queue backing)
- Supabase EU (logs + sessions + learning)
- AWS Bedrock EU (Claude inference)
- Gmail (email integration)

## Status

Phase 2 (the agent spine) in progress — core path live: ClickUp @-mention →
signature-verified webhook → context + rules → model → draft comment posted back.
See `architecture/current.md` for the authoritative, up-to-date state.