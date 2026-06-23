#!/usr/bin/env python3
"""ADR-054 Block 3 pre-flight capability gate (THROWAWAY). Before baking the hosted ClickUp MCP +
read-only allowlist into the 4 production tier agents, prove three things the production wiring depends on:

  TEST 1 (allowlist accepted): does POST /v1/agents accept a `mcp_toolset` with
          default_config:{enabled:false} + configs:[{name,enabled:true,...}] (the read-only allowlist
          shape)? Block 0 called this "empirically supported" but it was never run against the live API.
          If it 400s here, the block reshapes BEFORE we touch production agents.

  TEST 2 (reads work under the allowlist, onboarded): with the onboarded user's MCP-OAuth vault attached
          (SPIKE_VAULT_ID), does the agent call a read tool (clickup_get_workspace_hierarchy) in-harness
          and get real data — proving the allowlist enables reads and the tool names are right?

  TEST 3 (degrade, un-onboarded): with NO clickup vault attached, does a session against the SAME
          clickup-registered agent still CREATE + COMPLETE (reach idle/terminated)? Decision #5
          ("degrade, don't break") hard-depends on this. The Anthropic docs say invalid/absent MCP creds
          don't block session creation (a session.error fires, the run proceeds) — verify it live.

Cleans up (delete sessions, archive agent). Stdlib only. Reads ANTHROPIC_API_KEY from env.

Run on the VPS:
  set -a; . /opt/haxe-agents/.env; set +a
  SPIKE_VAULT_ID=vlt_011CcJU6Q9MVqpds2D1VLmLH python3 /tmp/ma-spike-block3-readonly-degrade.py
"""
import json, os, time, urllib.request, urllib.error

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MA = "managed-agents-2026-04-01"
ENV = "env_01T1PexJQheEUVnzVTKjyrz4"               # persistent prod environment (config.managed_agent_environment_id)
MCP_URL = "https://mcp.clickup.com/mcp"
VAULT = os.environ.get("SPIKE_VAULT_ID", "")        # onboarded user's MCP-OAuth vault (TEST 2 only)

# A minimal read-only allowlist sample (the production toolset in sync-agent-definitions enables the full
# discovery set). default disabled + these read tools enabled; every write tool stays off by construction.
READ_TOOLS = [
    "clickup_get_workspace_hierarchy",
    "clickup_search",
    "clickup_get_task",
    "clickup_get_task_comments",
]
CLICKUP_TOOLSET = {
    "type": "mcp_toolset",
    "mcp_server_name": "clickup",
    "default_config": {"enabled": False},
    "configs": [{"name": n, "enabled": True, "permission_policy": {"type": "always_allow"}} for n in READ_TOOLS],
}

created = {"agent": None, "sessions": []}


def api(method, path, body=None):
    h = {"x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-beta": MA}
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        h["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t.strip().startswith(("{", "[")) else t)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, t


def events(sid):
    st, e = api("GET", "/v1/sessions/%s/events" % sid)
    return e.get("data", []) if isinstance(e, dict) else []


def status(sid):
    st, s = api("GET", "/v1/sessions/%s" % sid)
    return (s.get("status") if isinstance(s, dict) else None), s


def snippet(obj, n=600):
    s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return s[:n]


def run_session(label, vault_ids, msg):
    body = {"agent": created["agent"], "environment_id": ENV}
    if vault_ids:
        body["vault_ids"] = vault_ids
    st, sess = api("POST", "/v1/sessions", body)
    print("\n[%s] create session -> HTTP %s (vault_ids=%s)" % (label, st, vault_ids or "[]"))
    if st >= 300:
        print("  " + snippet(sess)); return None
    created["sessions"].append(sess["id"]); print("  session:", sess["id"])

    st, _ = api("POST", "/v1/sessions/%s/events" % sess["id"],
                {"events": [{"type": "user.message", "content": [{"type": "text", "text": msg}]}]})
    print("  send -> HTTP %s" % st)

    t0 = time.time()
    final = "client-timeout"
    while time.time() - t0 < 180:
        time.sleep(3)
        sstat, _ = status(sess["id"])
        if sstat in ("idle", "terminated"):
            final = sstat
            print("  session %s after %ss" % (sstat, round(time.time() - t0)))
            break

    evs = events(sess["id"])
    tool_called, had_error = False, False
    for ev in evs:
        t = ev.get("type") or ""
        if "tool" in t:
            tool_called = True
        if "error" in t:
            had_error = True
            print("  ERROR EVENT: " + snippet(ev, 700))
    return {"final": final, "tool_called": tool_called, "had_error": had_error, "events": evs, "sid": sess["id"]}


def main():
    if not KEY:
        print("NO KEY"); return

    # ---- TEST 1: read-only allowlist accepted by agent-create ----
    st, agent = api("POST", "/v1/agents", {
        "name": "spike-block3-readonly-degrade-054",
        "model": "claude-haiku-4-5",
        "system": ("You are a connectivity test agent. ClickUp tools may be available via an MCP server. "
                   "When asked, call a ClickUp tool to fetch the requested data and report the result "
                   "verbatim. If a tool errors or no ClickUp tool exists, say so plainly and stop — do not "
                   "fabricate data."),
        "tools": [CLICKUP_TOOLSET],
        "mcp_servers": [{"type": "url", "url": MCP_URL, "name": "clickup"}],
    })
    print("== TEST 1: read-only allowlist on agent-create -> HTTP %s ==" % st)
    if st >= 300:
        print("  SHAPE REJECTED — allowlist schema is wrong, reshape Block 3:")
        print("  " + snippet(agent, 1200)); return
    created["agent"] = agent["id"]
    print("  PASS — agent created:", agent["id"])
    # echo back what the API stored for the toolset, to confirm the shape round-trips
    print("  stored tools:", snippet(agent.get("tools"), 800))

    # ---- TEST 2: reads work under the allowlist (onboarded vault) ----
    if VAULT:
        r = run_session("TEST 2 onboarded",
                         [VAULT],
                         "Use your ClickUp tools to retrieve the Spaces / workspace hierarchy I can access, "
                         "then list the Space names. If a tool errors, report the exact error text.")
        if r:
            print("  [TEST 2] tool_called=%s had_error=%s final=%s" % (r["tool_called"], r["had_error"], r["final"]))
            for ev in r["events"]:
                if "message" in (ev.get("type") or "") and ev.get("type", "").startswith("agent"):
                    print("  agent.message: " + snippet(ev, 700))
    else:
        print("\n[TEST 2] SKIPPED — set SPIKE_VAULT_ID=<onboarded user's MCP vault> to run the positive read test")

    # ---- TEST 3: degrade — un-onboarded (no clickup vault) still creates + completes ----
    r = run_session("TEST 3 degrade",
                     [],   # NO clickup credential anywhere
                     "Briefly say hello and confirm you are running. If you have no ClickUp tools, just say so.")
    if r:
        print("  [TEST 3] created+completed=%s (final=%s) had_error=%s" %
              (r["final"] in ("idle", "terminated"), r["final"], r["had_error"]))
        for ev in r["events"]:
            if "message" in (ev.get("type") or "") and ev.get("type", "").startswith("agent"):
                print("  agent.message: " + snippet(ev, 500))

    print("\n== VERDICT ==")
    print("  TEST 1 (allowlist accepted): see HTTP above — PASS gates the production toolset shape.")
    print("  TEST 2 (reads work):         tool_called + real Space names = allowlist enables reads.")
    print("  TEST 3 (degrade):            created+completed=True = decision #5 holds; a session.error for")
    print("                               the missing clickup cred is EXPECTED and is the degrade signal.")


def cleanup():
    print("\n== CLEANUP ==")
    for sid in created["sessions"]:
        print("del session", sid, api("DELETE", "/v1/sessions/%s" % sid)[0])
    if created["agent"]:
        print("archive agent", api("POST", "/v1/agents/%s/archive" % created["agent"])[0])


try:
    main()
except Exception:
    import traceback; traceback.print_exc()
finally:
    cleanup()
