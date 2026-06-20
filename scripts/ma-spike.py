#!/usr/bin/env python3
"""
ADR-053 Block 0 capability-gate spike (THROWAWAY).

Proves the live Anthropic Managed Agents beta shapes we need before building:
  (a) create environment + agent
  (b) session + custom-tool pause/resume loop  <- the feasibility gate
  (c) in-harness web search (agent_toolset)
  (d) a Skill producing a file (xlsx)
  (e) Files API upload + download
  (f) the cost / usage surface

Reads ANTHROPIC_API_KEY from the environment. Creates disposable resources and
cleans them up (delete session/environment/file; archive agent) in a finally block.
Prints a structured report to stdout. Uses only the Python standard library.

Run on the VPS:  set -a; . /opt/haxe-agents/.env; set +a; python3 /tmp/ma-spike.py
"""
import json, os, sys, time, urllib.request, urllib.error

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MA_BETA = "managed-agents-2026-04-01"
FILES_BETA = "files-api-2025-04-14"
MODEL = "claude-haiku-4-5"  # cheapest tier; spike only

if not KEY:
    print("NO KEY IN ENV"); sys.exit(1)

created = {"env": None, "agent": None, "session": None, "file": None}

def api(method, path, body=None, betas=MA_BETA, raw_body=None, ctype=None):
    url = BASE + path
    headers = {
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": betas,
    }
    data = None
    if raw_body is not None:
        data = raw_body
        headers["content-type"] = ctype
    elif body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt and txt.strip().startswith(("{", "[")) else txt)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try: parsed = json.loads(txt)
        except Exception: parsed = txt
        return e.code, parsed

def jdump(label, obj):
    print(f"\n--- {label} ---")
    print(json.dumps(obj, indent=2)[:4000])

def get_status(sid):
    st, s = api("GET", f"/v1/sessions/{sid}")
    return (s.get("status") if isinstance(s, dict) else None), s

def get_events(sid):
    st, e = api("GET", f"/v1/sessions/{sid}/events")
    return e.get("data", []) if isinstance(e, dict) else []

def run_turn(sid, text, label, handle_tool=None, timeout=200):
    """Send a user.message, poll events to idle, servicing custom tools via handle_tool(event)->result_text."""
    print(f"\n========== TURN: {label} ==========")
    st, _ = api("POST", f"/v1/sessions/{sid}/events",
                {"events": [{"type": "user.message", "content": [{"type": "text", "text": text}]}]})
    print(f"send user.message -> HTTP {st}")
    handled = set()
    seq = []
    start = time.time()
    while time.time() - start < timeout:
        time.sleep(3)
        events = get_events(sid)
        for ev in events:
            t = ev.get("type")
            if ev.get("id") not in [s[0] for s in seq]:
                seq.append((ev.get("id"), t))
        # service custom tools
        for ev in events:
            if ev.get("type") == "agent.custom_tool_use" and ev.get("id") not in handled:
                jdump("agent.custom_tool_use (RAW)", ev)
                result = handle_tool(ev) if handle_tool else "ok"
                rs, _ = api("POST", f"/v1/sessions/{sid}/events",
                            {"events": [{"type": "user.custom_tool_result",
                                         "custom_tool_use_id": ev.get("id"),
                                         "content": [{"type": "text", "text": result}]}]})
                print(f"  -> sent user.custom_tool_result for {ev.get('id')} (HTTP {rs})")
                handled.add(ev.get("id"))
        status, sjson = get_status(sid)
        if status == "idle":
            # is it waiting on an unhandled custom tool?
            pending = [ev for ev in events
                       if ev.get("type") == "agent.custom_tool_use" and ev.get("id") not in handled]
            if pending:
                continue
            print(f"  session idle after {round(time.time()-start)}s")
            return events, seq
    print(f"  TIMEOUT after {timeout}s")
    return get_events(sid), seq

def main():
    print("=== ADR-053 Block 0 spike ===")

    # (a) environment + agent
    st, env = api("POST", "/v1/environments",
                  {"name": "spike-env-053", "config": {"type": "cloud", "networking": {"type": "unrestricted"}}})
    print(f"\ncreate environment -> HTTP {st}")
    if st >= 300: jdump("env error", env); return
    created["env"] = env["id"]; print("env_id:", env["id"])

    st, agent = api("POST", "/v1/agents", {
        "name": "spike-agent-053",
        "model": MODEL,
        "system": "You are a test agent. Follow instructions literally and use tools when asked.",
        "tools": [
            {"type": "agent_toolset_20260401"},
            {"type": "custom", "name": "get_secret_word",
             "description": "Returns a secret word for a given topic. You MUST call this to learn the word.",
             "input_schema": {"type": "object", "properties": {"topic": {"type": "string"}}, "required": ["topic"]}},
        ],
        "skills": [{"type": "anthropic", "skill_id": "xlsx"}],
    })
    print(f"create agent -> HTTP {st}")
    if st >= 300: jdump("agent error", agent); return
    created["agent"] = agent["id"]
    print("agent_id:", agent["id"], "version:", agent.get("version"))
    jdump("agent object (shape)", {k: agent.get(k) for k in ("id","version","model","tools","skills","name")})

    # (b) session
    st, sess = api("POST", "/v1/sessions", {"agent": agent["id"], "environment_id": env["id"]})
    print(f"\ncreate session -> HTTP {st}")
    if st >= 300: jdump("session error", sess); return
    created["session"] = sess["id"]; print("session_id:", sess["id"], "status:", sess.get("status"))

    # (b) custom-tool pause/resume loop  <-- THE GATE
    events, seq = run_turn(
        sess["id"],
        "Call the get_secret_word tool with topic 'sky'. You MUST use the tool. After it returns, reply with exactly: SECRET=<word>.",
        "custom-tool pause/resume",
        handle_tool=lambda ev: json.dumps({"word": "azure-7"}),
    )
    print("\nevent sequence:", [t for _, t in seq])
    for ev in events:
        if ev.get("type") == "span.model_request_end":
            jdump("span.model_request_end (COST/USAGE SURFACE)", ev)
            break
    for ev in events:
        if ev.get("type") == "agent.message":
            txts = [b.get("text") for b in ev.get("content", []) if b.get("type") == "text"]
            print("\nagent.message text:", txts)

    # (c) in-harness web search
    events, seq = run_turn(
        sess["id"],
        "Use web search to find who the current CEO of Anthropic is. Cite the source URL. Keep it to one sentence.",
        "web search",
    )
    print("web-search event sequence:", [t for _, t in seq])
    for ev in events:
        if ev.get("type") in ("agent.tool_use", "agent.message"):
            jdump(f"{ev.get('type')}", ev)

    # (d) skill producing a file + (e download)
    events, seq = run_turn(
        sess["id"],
        "Using the xlsx skill, create a spreadsheet named budget.xlsx with a 3-row table: columns 'item' and 'amount', rows (rent, 1000), (food, 400), (transport, 150). Save it to the session outputs.",
        "skill -> xlsx file",
        timeout=260,
    )
    print("skill event sequence:", [t for _, t in seq])
    time.sleep(4)  # files indexing lag
    st, files = api("GET", f"/v1/files?scope_id={sess['id']}", betas=f"{FILES_BETA},{MA_BETA}")
    jdump("session output files (scope_id)", files)
    if isinstance(files, dict) and files.get("data"):
        fid = files["data"][0]["id"]
        sc, content = api("GET", f"/v1/files/{fid}/content", betas=f"{FILES_BETA},{MA_BETA}")
        print(f"\ndownload output file {fid} -> HTTP {sc}; bytes preview ok (xlsx is binary)")

    # (e) Files API upload (input side)
    boundary = "----spikeBoundary053"
    parts = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"spike.txt\"\r\n"
        f"Content-Type: text/plain\r\n\r\nhello from spike\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nagent\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    st, up = api("POST", "/v1/files", betas=FILES_BETA, raw_body=parts,
                 ctype=f"multipart/form-data; boundary={boundary}")
    print(f"\nFiles API upload -> HTTP {st}")
    jdump("uploaded file", up)
    if isinstance(up, dict) and up.get("id"):
        created["file"] = up["id"]

    # (f) session usage surface
    status, sjson = get_status(sess["id"])
    print(f"\nfinal session status: {status}")
    if isinstance(sjson, dict):
        jdump("session.usage (COST SURFACE)", sjson.get("usage"))

def cleanup():
    print("\n========== CLEANUP ==========")
    if created["session"]:
        st, _ = api("DELETE", f"/v1/sessions/{created['session']}")
        print(f"delete session -> HTTP {st}")
    if created["file"]:
        st, _ = api("DELETE", f"/v1/files/{created['file']}", betas=FILES_BETA)
        print(f"delete uploaded file -> HTTP {st}")
    if created["agent"]:
        st, _ = api("POST", f"/v1/agents/{created['agent']}/archive")
        print(f"archive agent -> HTTP {st}")
    if created["env"]:
        st, _ = api("DELETE", f"/v1/environments/{created['env']}")
        print(f"delete environment -> HTTP {st}")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback; traceback.print_exc()
    finally:
        cleanup()
