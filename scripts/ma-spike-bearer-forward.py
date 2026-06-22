#!/usr/bin/env python3
"""ADR-054 Option-3 bearer-forwarding probe (THROWAWAY): can a self-hosted n8n MCP Server Trigger READ the
per-user bearer the Managed Agents harness injects, and expose it to the workflow logic?

We already know the harness injects a vault bearer to our self-hosted MCP endpoint (the image MCP proves it).
The open question for Option 3 (self-host a thin ClickUp MCP that calls ClickUp REST as user U with U's token):
does n8n's MCP Server Trigger SURFACE that incoming Authorization header to a tool, or only validate-and-discard?

Setup (built separately): n8n workflow `_TMP spike bearer-forward 054` — MCP Server Trigger (auth=none) ->
Code Tool `echo_headers` that returns the incoming request context (incl. $('MCP Server Trigger').json.headers).

This script: throwaway agent registers that MCP, a vault holds a static_bearer keyed to it with a SENTINEL
token, a session attaches the vault, and we ask the agent to call echo_headers. If the SENTINEL shows up in
the tool result -> n8n EXPOSES the injected bearer -> Variant A via pure n8n WORKS. If not -> Option 3 needs a
thin non-n8n MCP handler (or Variant B: Supabase token mirror). Cleans up. Stdlib only. Reads ANTHROPIC_API_KEY.

Run on the VPS:  set -a; . /opt/haxe-agents/.env; set +a; python3 /tmp/ma-spike-bearer-forward.py
"""
import json, os, time, urllib.request, urllib.error

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MA = "managed-agents-2026-04-01"
ENV = "env_01T1PexJQheEUVnzVTKjyrz4"
MCP_URL = "https://agents.haxe.ai/mcp/spike-bearer-054"
SENTINEL = "SENTINEL-BEARER-CHECK-7Q2X9"
created = {"agent": None, "session": None, "vault": None}


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


def main():
    if not KEY:
        print("NO KEY"); return

    st, vault = api("POST", "/v1/vaults", {"display_name": "spike-bearer-forward-054"})
    print("create vault ->", st)
    if st >= 300:
        print(json.dumps(vault, indent=2)); return
    created["vault"] = vault["id"]

    st, cred = api("POST", "/v1/vaults/%s/credentials" % vault["id"], {
        "display_name": "sentinel bearer",
        "auth": {"type": "static_bearer", "mcp_server_url": MCP_URL, "token": SENTINEL},
    })
    print("create credential ->", st)
    if st >= 300:
        print(json.dumps(cred, indent=2)); return

    st, agent = api("POST", "/v1/agents", {
        "name": "spike-bearer-fwd-054",
        "model": "claude-haiku-4-5",
        "system": "You are a connectivity test agent. When asked, call the echo_headers tool with a short input and then reply with its exact result. Do not refuse.",
        "tools": [{"type": "mcp_toolset", "mcp_server_name": "probe",
                   "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}}}],
        "mcp_servers": [{"type": "url", "url": MCP_URL, "name": "probe"}],
    })
    print("create agent ->", st)
    if st >= 300:
        print(json.dumps(agent, indent=2)); return
    created["agent"] = agent["id"]

    st, sess = api("POST", "/v1/sessions", {"agent": agent["id"], "environment_id": ENV, "vault_ids": [vault["id"]]})
    print("create session ->", st, "(vault attached)")
    if st >= 300:
        print(json.dumps(sess, indent=2)); return
    created["session"] = sess["id"]

    api("POST", "/v1/sessions/%s/events" % sess["id"],
        {"events": [{"type": "user.message", "content": [{"type": "text", "text": "Call the echo_headers tool with input 'ping' and report its exact result verbatim."}]}]})

    t0 = time.time(); evs = []
    while time.time() - t0 < 120:
        time.sleep(3)
        s_st, s = api("GET", "/v1/sessions/%s" % sess["id"])
        if isinstance(s, dict) and s.get("status") in ("idle", "terminated"):
            _, e = api("GET", "/v1/sessions/%s/events" % sess["id"])
            evs = e.get("data", []) if isinstance(e, dict) else []
            print("session %s after %ss" % (s.get("status"), round(time.time() - t0)))
            break

    blob = json.dumps(evs)
    print("\n== EVENTS (type -> snippet) ==")
    for ev in evs:
        t = ev.get("type") or ""
        line = "  " + t
        if "tool" in t or "error" in t:
            line += "  " + json.dumps(ev)[:600]
        elif t == "agent.message":
            txts = [b.get("text") for b in ev.get("content", []) if b.get("type") == "text"]
            if txts:
                line += "  text=" + (txts[-1][:400])
        print(line)

    print("\n== VERDICT ==")
    if SENTINEL in blob:
        print("  SENTINEL FOUND in the event stream => n8n MCP Server Trigger EXPOSES the injected bearer.")
        print("  => Variant A via PURE n8n WORKS: a self-hosted n8n ClickUp MCP can forward U's token to ClickUp REST.")
    else:
        print("  SENTINEL NOT in the event stream => n8n does NOT surface the injected bearer to the tool.")
        print("  => Option 3 needs a thin NON-n8n MCP handler (read bearer -> call ClickUp REST), or Variant B (Supabase token mirror).")


def cleanup():
    print("\n== CLEANUP ==")
    if created["session"]:
        print("del session", api("DELETE", "/v1/sessions/%s" % created["session"])[0])
    if created["agent"]:
        print("archive agent", api("POST", "/v1/agents/%s/archive" % created["agent"])[0])
    if created["vault"]:
        print("del vault", api("DELETE", "/v1/vaults/%s" % created["vault"])[0])


try:
    main()
except Exception:
    import traceback; traceback.print_exc()
finally:
    cleanup()
