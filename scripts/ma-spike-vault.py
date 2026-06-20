#!/usr/bin/env python3
"""ADR-055 Block 5.3 vault gate (THROWAWAY): prove how a self-hosted MCP server's bearer is
attached to a Managed Agents session via an Anthropic Vault (the 5.1 open item — the auth is NOT a
field on the agent's mcp_servers entry; it is a per-session vault credential keyed by the MCP url).

Verifies live, against our REAL image MCP server (https://agents.haxe.ai/mcp/haxe-image-gen):
  1. the exact static_bearer credential shape the API accepts;
  2. that a session created with vault_ids=[vlt] injects the bearer so the bearerAuth-protected
     trigger accepts the call and generate_image runs in-harness (agent.mcp_tool_use, no client pause);
  3. that no agent.custom_tool_use appears (image is NOT a custom tool here).

Tears everything down (delete session, archive agent, delete credential, delete/archive vault).
Stdlib only. Reads ANTHROPIC_API_KEY + IMAGE_MCP_BEARER from env."""
import json, os, time, urllib.request, urllib.error

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
BEARER = os.environ.get("IMAGE_MCP_BEARER", "")
MA = "managed-agents-2026-04-01"
ENV = "env_01T1PexJQheEUVnzVTKjyrz4"
MCP_URL = "https://agents.haxe.ai/mcp/haxe-image-gen"
created = {"agent": None, "session": None, "vault": None, "credential": None}

def api(method, path, body=None):
    h = {"x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-beta": MA}
    data = json.dumps(body).encode() if body is not None else None
    if data is not None: h["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t.strip().startswith(("{", "[")) else t)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t

def events(sid):
    st, e = api("GET", "/v1/sessions/%s/events" % sid)
    return e.get("data", []) if isinstance(e, dict) else []

def status(sid):
    st, s = api("GET", "/v1/sessions/%s" % sid)
    return (s.get("status") if isinstance(s, dict) else None), s

def main():
    if not KEY or not BEARER:
        print("MISSING KEY or BEARER"); return

    # 1) Vault
    st, vault = api("POST", "/v1/vaults", {"display_name": "spike-image-mcp-053-53"})
    print("create vault -> HTTP %s" % st)
    if st >= 300: print(json.dumps(vault, indent=2)); return
    created["vault"] = vault["id"]; print("vault:", vault["id"])

    # 2) static_bearer credential keyed by the MCP url
    cred_body = {
        "display_name": "spike image mcp bearer",
        "auth": {"type": "static_bearer", "mcp_server_url": MCP_URL, "token": BEARER},
    }
    st, cred = api("POST", "/v1/vaults/%s/credentials" % vault["id"], cred_body)
    print("create credential (static_bearer) -> HTTP %s" % st)
    print("  credential resp:", json.dumps(cred, indent=2)[:600])
    if st >= 300:
        print("  ** static_bearer shape rejected — read the error above to learn the field names **")
        return
    created["credential"] = cred.get("id")

    # 3) Agent: mcp_servers (NO auth) + mcp_toolset always_allow
    st, agent = api("POST", "/v1/agents", {
        "name": "spike-image-mcp-agent-053-53",
        "model": "claude-haiku-4-5",
        "system": "Jesteś agentem testowym. Gdy poprosisz o obraz, WYWOŁAJ narzędzie generate_image z podanym promptem, a potem odpowiedz samym zwroconym file_id. Nie pytaj o potwierdzenie.",
        "tools": [{"type": "mcp_toolset", "mcp_server_name": "haxe_image",
                   "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}}}],
        "mcp_servers": [{"type": "url", "url": MCP_URL, "name": "haxe_image"}],
    })
    print("create agent -> HTTP %s" % st)
    if st >= 300: print(json.dumps(agent, indent=2)); return
    created["agent"] = agent["id"]; print("agent:", agent["id"])

    # 4) Session WITH vault_ids (this is what injects the bearer)
    st, sess = api("POST", "/v1/sessions",
                   {"agent": agent["id"], "environment_id": ENV, "vault_ids": [vault["id"]]})
    print("create session (vault_ids) -> HTTP %s" % st)
    if st >= 300: print(json.dumps(sess, indent=2)); return
    created["session"] = sess["id"]; print("session:", sess["id"])

    # 5) Drive a generation
    st, _ = api("POST", "/v1/sessions/%s/events" % sess["id"],
                {"events": [{"type": "user.message", "content": [{"type": "text",
                  "text": "Wywołaj generate_image z promptem: czerwone jabłko na białym tle. Potem odpowiedz samym file_id."}]}]})
    print("send -> HTTP %s" % st)
    t0 = time.time()
    final = None
    while time.time() - t0 < 280:
        time.sleep(4)
        sstat, _ = status(sess["id"])
        if sstat == "idle":
            evs = events(sess["id"])
            pend = [e for e in evs if e.get("type") == "agent.custom_tool_use"]
            if pend:
                print("  ** UNEXPECTED agent.custom_tool_use (client pause) — image is being treated as custom tool **")
            print("  idle after %ss" % round(time.time() - t0))
            final = evs; break
        if sstat == "terminated":
            print("  TERMINATED after %ss" % round(time.time() - t0)); final = events(sess["id"]); break
    if final is None:
        print("  TIMEOUT"); final = events(sess["id"])

    types = [e.get("type") for e in final]
    print("  event types:", types)
    for e in final:
        t = e.get("type") or ""
        if "mcp_tool" in t:
            print("    [%s] name=%s" % (t, e.get("name")))
        if t == "agent.mcp_tool_result":
            c = e.get("content")
            print("    mcp_tool_result content:", json.dumps(c)[:400])
        if t == "session.error":
            print("    SESSION.ERROR:", json.dumps(e)[:400])
    for e in final:
        if e.get("type") == "agent.message":
            txts = [b.get("text") for b in e.get("content", []) if b.get("type") == "text"]
            if txts and txts[-1]: print("    agent.message:", repr(txts[-1][:200]))

def cleanup():
    print("\n== CLEANUP ==")
    if created["session"]: print("del session", api("DELETE", "/v1/sessions/%s" % created["session"])[0])
    if created["agent"]: print("archive agent", api("POST", "/v1/agents/%s/archive" % created["agent"])[0])
    if created["credential"] and created["vault"]:
        print("del credential", api("DELETE", "/v1/vaults/%s/credentials/%s" % (created["vault"], created["credential"]))[0])
    if created["vault"]: print("del vault", api("DELETE", "/v1/vaults/%s" % created["vault"])[0])

try: main()
except Exception:
    import traceback; traceback.print_exc()
finally: cleanup()
