#!/usr/bin/env python3
"""ADR-054 positive MCP-acceptance spike (THROWAWAY): does the HOSTED ClickUp MCP
(https://mcp.clickup.com/mcp) actually honor a token our OWN OAuth app minted, when the user's vault is
attached to the session? This is the single biggest INFERRED unknown from Block 0 — we have proven the
token exists and is stored as a static_bearer credential, but not yet that the hosted MCP accepts it.

Registers a throwaway agent with the ClickUp MCP + an always-allow toolset, opens a session in the
persistent prod env with the user's vault attached (so the harness injects U's ClickUp bearer), and asks it
to read something only U can see (their accessible Spaces). PASS = a clickup_* tool is called in-harness and
returns real data (not an auth/permission error). Cleans up (delete session, archive agent). Stdlib only.
Reads ANTHROPIC_API_KEY from env.

Run on the VPS:  set -a; . /opt/haxe-agents/.env; set +a; python3 /tmp/ma-spike-clickup-mcp.py
"""
import json, os, time, urllib.request, urllib.error

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MA = "managed-agents-2026-04-01"
ENV = "env_01T1PexJQheEUVnzVTKjyrz4"               # persistent prod environment (config.managed_agent_environment_id)
MCP_URL = "https://mcp.clickup.com/mcp"
VAULT = "vlt_011CcJFTSejGJnjA4tEBcM7o"             # Franciszek's per-user vault (holds his ClickUp static_bearer)
created = {"agent": None, "session": None}


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


def snippet(obj, n=400):
    s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return s[:n]


def main():
    if not KEY:
        print("NO KEY"); return

    st, agent = api("POST", "/v1/agents", {
        "name": "spike-clickup-mcp-054",
        "model": "claude-haiku-4-5",
        "system": ("You are a connectivity test agent. You have ClickUp tools available via an MCP server. "
                   "When asked, you MUST call a ClickUp tool to fetch the requested data and then report the "
                   "result verbatim. Do not refuse, do not ask for confirmation, do not claim you lack access "
                   "without first trying a tool call."),
        "tools": [{"type": "mcp_toolset", "mcp_server_name": "clickup",
                   "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}}}],
        "mcp_servers": [{"type": "url", "url": MCP_URL, "name": "clickup"}],
    })
    print("create agent -> HTTP %s" % st)
    if st >= 300:
        print(json.dumps(agent, indent=2)); return
    created["agent"] = agent["id"]; print("agent:", agent["id"])

    # vault attached -> the harness injects U's ClickUp bearer when the agent calls the clickup MCP
    st, sess = api("POST", "/v1/sessions", {"agent": agent["id"], "environment_id": ENV, "vault_ids": [VAULT]})
    print("create session -> HTTP %s (vault_ids=[%s])" % (st, VAULT))
    if st >= 300:
        print(json.dumps(sess, indent=2)); return
    created["session"] = sess["id"]; print("session:", sess["id"])

    msg = ("Use your ClickUp tools to retrieve the Spaces / workspace hierarchy I have access to, then list "
           "the Space names you got back. If a tool returns an error, report the exact error text.")
    t0 = time.time()
    st, _ = api("POST", "/v1/sessions/%s/events" % sess["id"],
                {"events": [{"type": "user.message", "content": [{"type": "text", "text": msg}]}]})
    print("send -> HTTP %s" % st)

    final_evs = []
    while time.time() - t0 < 180:
        time.sleep(3)
        sstat, _ = status(sess["id"])
        if sstat in ("idle", "terminated"):
            final_evs = events(sess["id"])
            print("session %s after %ss" % (sstat, round(time.time() - t0)))
            break
    else:
        final_evs = events(sess["id"])
        print("client-timeout after 180s")

    print("\n== FULL EVENT STREAM ==")
    tool_called = False
    for ev in final_evs:
        t = ev.get("type") or ""
        if "tool" in t:
            tool_called = True
        # dump the whole event so nothing (esp. session.error detail) is hidden
        print("  " + snippet(ev, 900))

    print("\n== SESSION OBJECT ==")
    _, sjson = status(sess["id"])
    print("  " + snippet(sjson, 900))

    print("\n== VERDICT ==")
    print("  a clickup tool was called in-harness:", tool_called)
    print("  -> inspect the tool content/agent.message above: real Space names = MCP honors our OAuth token (PASS);")
    print("     an auth/permission error = the hosted MCP rejects an OAuth-app token (RESHAPE).")


def cleanup():
    print("\n== CLEANUP ==")
    if created["session"]:
        print("del session", api("DELETE", "/v1/sessions/%s" % created["session"])[0])
    if created["agent"]:
        print("archive agent", api("POST", "/v1/agents/%s/archive" % created["agent"])[0])


try:
    main()
except Exception:
    import traceback; traceback.print_exc()
finally:
    cleanup()
