#!/usr/bin/env python3
"""ADR-055 Block 5.1 capability gate (THROWAWAY): prove Managed Agents calls a self-hosted MCP tool,
how the tool-call appears in the event stream (in-harness vs client-pause), and the max tool-call
duration the harness tolerates (kill-criterion: must clear ~170s for gpt-image-2 high).

Registers a throwaway agent pointing at the live n8n MCP Server Trigger echo endpoint
(https://agents.skalus.com/mcp/spike-mcp-echo-053, built in Block 5.1), runs a session in the persistent
prod env, and drives three turns: echo 0s, echo 30s, echo 200s. Records event types + wall time per turn.
Cleans up (delete session, archive agent). Stdlib only. Reads ANTHROPIC_API_KEY from env."""
import json, os, time, urllib.request, urllib.error

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MA = "managed-agents-2026-04-01"
ENV = "env_01T1PexJQheEUVnzVTKjyrz4"           # persistent prod environment (config.managed_agent_environment_id)
MCP_URL = "https://agents.skalus.com/mcp/spike-mcp-echo-053"
created = {"agent": None, "session": None}

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

def run_turn(sid, text, label, timeout=300):
    print("\n========== TURN: %s ==========" % label)
    t0 = time.time()
    st, _ = api("POST", "/v1/sessions/%s/events" % sid,
                {"events": [{"type": "user.message", "content": [{"type": "text", "text": text}]}]})
    print("send -> HTTP %s" % st)
    seen = []
    while time.time() - t0 < timeout:
        time.sleep(3)
        evs = events(sid)
        for ev in evs:
            key = (ev.get("id"), ev.get("type"))
            if key not in seen: seen.append(key)
        sstat, sjson = status(sid)
        if sstat == "idle":
            # done only if no unanswered custom_tool_use (MCP runs in-harness; custom would pause)
            answered = set(ev.get("custom_tool_use_id") for ev in evs if ev.get("type") == "user.custom_tool_result")
            pending = [ev for ev in evs if ev.get("type") == "agent.custom_tool_use" and ev.get("id") not in answered]
            if pending:
                print("  ** IDLE WITH PENDING custom_tool_use (client pause!) after %ss **" % round(time.time()-t0))
                return seen, round(time.time()-t0), evs, "pending"
            print("  idle after %ss" % round(time.time()-t0))
            return seen, round(time.time()-t0), evs, "idle"
        if sstat == "terminated":
            print("  TERMINATED after %ss" % round(time.time()-t0))
            return seen, round(time.time()-t0), evs, "terminated"
    print("  CLIENT-TIMEOUT after %ss" % timeout)
    return seen, timeout, events(sid), "client_timeout"

def main():
    if not KEY: print("NO KEY"); return
    st, agent = api("POST", "/v1/agents", {
        "name": "spike-mcp-agent-053",
        "model": "claude-haiku-4-5",
        "system": "You are a test agent. When asked to echo, you MUST call the echo tool with the exact text given, then reply with the tool's result verbatim. Do not refuse and do not ask for confirmation.",
        "tools": [{"type": "mcp_toolset", "mcp_server_name": "spike_echo",
                   "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}}}],
        "mcp_servers": [{"type": "url", "url": MCP_URL, "name": "spike_echo"}],
    })
    print("create agent -> HTTP %s" % st)
    if st >= 300: print(json.dumps(agent, indent=2)); return
    created["agent"] = agent["id"]; print("agent:", agent["id"])

    st, sess = api("POST", "/v1/sessions", {"agent": agent["id"], "environment_id": ENV})
    print("create session -> HTTP %s" % st)
    if st >= 300: print(json.dumps(sess, indent=2)); return
    created["session"] = sess["id"]; print("session:", sess["id"])

    for txt, label, to in [("Call the echo tool with the text: ping0", "echo 0s", 120),
                           ("Call the echo tool with the text: 30", "echo 30s", 180),
                           ("Call the echo tool with the text: 200", "echo 200s (kill-criterion)", 320)]:
        seen, secs, evs, how = run_turn(sess["id"], txt, label, to)
        types = [t for _, t in seen]
        print("  result=%s elapsed=%ss" % (how, secs))
        print("  event types:", types)
        # MCP tool call events + the agent's final text
        for ev in evs:
            t = ev.get("type") or ""
            if "tool" in t:
                print("    [%s] name=%s" % (t, ev.get("name")))
        for ev in evs:
            if ev.get("type") == "agent.message":
                txts = [b.get("text") for b in ev.get("content", []) if b.get("type") == "text"]
                last = txts[-1] if txts else None
                if last: print("    agent.message:", repr(last[:200]))

def cleanup():
    print("\n== CLEANUP ==")
    if created["session"]: print("del session", api("DELETE", "/v1/sessions/%s" % created["session"])[0])
    if created["agent"]: print("archive agent", api("POST", "/v1/agents/%s/archive" % created["agent"])[0])

try: main()
except Exception:
    import traceback; traceback.print_exc()
finally: cleanup()
