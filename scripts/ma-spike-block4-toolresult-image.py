#!/usr/bin/env python3
"""ADR-054 Block 4 pre-flight capability gate (THROWAWAY). The Block-4 extraction tool is a CLIENT-SIDE
custom tool on the retained Execute Agent Session loop: the agent calls extract_clickup_task(task_id),
n8n runs read-input as U, and answers with a user.custom_tool_result. Documents come back as Docling
markdown TEXT (trivially fits a text tool_result). The LOAD-BEARING UNKNOWN is image attachments:

  Q1 (the linchpin): can a user.custom_tool_result deliver an IMAGE the agent can actually SEE (vision)?
     If yes, the handler uploads each extracted image to the Files API and embeds an image content block
     in the tool_result. If no, extraction is text/doc-only and images need a different channel.
     Two source shapes tested, because the handler design forks on which works:
       TEST A — image block via Files-API file_id  { type:image, source:{type:file, file_id} }
                (the shape read-input images already take after Upload Input Images)
       TEST B — image block via inline base64        { type:image, source:{type:base64, media_type, data} }
                (fallback: skip the Files-API round-trip, base64 the bytes straight into the result)

  Q2 (regression): the custom-tool pause/resume cycle (agent.custom_tool_use -> we post
     user.custom_tool_result -> agent continues) has been DORMANT in production since ADR-055 moved
     generate_image to an MCP toolset. Confirm a custom tool still surfaces as pending and the agent
     resumes after we answer it. (A plain text tool_result is the baseline.)

Method: build a solid-GREEN PNG with stdlib (no PIL), upload it (purpose=agent), declare a custom tool,
drive a session per test, and check whether the agent names the colour green from the tool_result image.
"GREEN" in the final message => vision through the tool_result works for that source shape.

Cleans up (delete sessions, delete file, archive agent). Stdlib only. Reads ANTHROPIC_API_KEY from env.

Run on the VPS:
  set -a; . /opt/haxe-agents/.env; set +a
  python3 /tmp/ma-spike-block4-toolresult-image.py
"""
import json, os, time, struct, zlib, base64, urllib.request, urllib.error, uuid

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MA = "managed-agents-2026-04-01"
FILES = "files-api-2025-04-14"
BOTH = MA + "," + FILES
ENV = "env_01T1PexJQheEUVnzVTKjyrz4"   # persistent prod environment (config.managed_agent_environment_id)

created = {"agent": None, "sessions": [], "file": None}


def api(method, path, body=None, beta=MA):
    h = {"x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-beta": beta}
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


def solid_png(r, g, b, w=120, h=120):
    """Minimal solid-colour RGB PNG, stdlib only."""
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)   # 8-bit, colour type 2 (RGB)
    row = b"\x00" + bytes([r, g, b]) * w                   # filter 0 + RGB pixels
    idat = zlib.compress(row * h, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def upload_png(png_bytes, filename):
    """POST /v1/files multipart (file + purpose=agent), mirroring Upload Input Images (v1)."""
    boundary = "----spike" + uuid.uuid4().hex
    pre = (
        "--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
        "Content-Type: image/png\r\n\r\n" % (boundary, filename)
    ).encode()
    mid = ("\r\n--%s\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nagent\r\n--%s--\r\n"
           % (boundary, boundary)).encode()
    body = pre + png_bytes + mid
    h = {"x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-beta": FILES,
         "content-type": "multipart/form-data; boundary=" + boundary}
    req = urllib.request.Request(BASE + "/v1/files", data=body, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def events(sid):
    st, e = api("GET", "/v1/sessions/%s/events" % sid, beta=BOTH)
    return e.get("data", []) if isinstance(e, dict) else []


def status(sid):
    st, s = api("GET", "/v1/sessions/%s" % sid, beta=BOTH)
    return (s.get("status") if isinstance(s, dict) else None), s


def snippet(obj, n=600):
    s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return s[:n]


def wait_for(sid, predicate, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(3)
        evs = events(sid)
        sstat, _ = status(sid)
        r = predicate(evs, sstat)
        if r is not None:
            return r, evs, sstat
    return None, events(sid), status(sid)[0]


def pending_tool(evs):
    answered = set(e.get("custom_tool_use_id") for e in evs if e.get("type") == "user.custom_tool_result")
    for e in evs:
        if e.get("type") == "agent.custom_tool_use" and e.get("id") not in answered:
            return e
    return None


def agent_text_after_tool(evs):
    """Last agent.message text (the reply after the tool result)."""
    txt = ""
    for e in evs:
        if e.get("type") == "agent.message":
            for b in (e.get("content") or []):
                if b.get("type") == "text":
                    txt = b.get("text", "")
    return txt


def run_test(label, result_content):
    """Drive one session: send message -> wait for the custom tool -> answer with result_content ->
    wait for the agent's reply -> return its text. result_content is the user.custom_tool_result content[]."""
    st, sess = api("POST", "/v1/sessions", {"agent": created["agent"], "environment_id": ENV})
    if st >= 300:
        print("[%s] create FAILED HTTP %s %s" % (label, st, snippet(sess))); return None
    sid = sess["id"]; created["sessions"].append(sid)
    print("\n[%s] session %s" % (label, sid))
    msg = ("Call the tool extract_clickup_task with clickup_task_id set to \"TEST-1\" to retrieve the "
           "attachment for that task. The tool result will contain an image. After you receive it, tell me "
           "in ONE word the single dominant colour of that image. If you cannot see any image in the tool "
           "result, say exactly: NO_IMAGE_VISIBLE.")
    st, _ = api("POST", "/v1/sessions/%s/events" % sid,
                {"events": [{"type": "user.message", "content": [{"type": "text", "text": msg}]}]}, beta=BOTH)
    print("  send -> HTTP %s" % st)

    tool, evs, sstat = wait_for(sid, lambda e, s: pending_tool(e) if (s == "idle" and pending_tool(e)) else None)
    if not tool:
        print("  NO PENDING TOOL (status=%s) — custom-tool cycle did not surface. events:" % sstat)
        for e in evs:
            print("   ev:", e.get("type"), snippet(e, 200))
        return {"tool_surfaced": False, "final": ""}
    print("  pending tool: name=%s id=%s input=%s" % (tool.get("name"), tool.get("id"), snippet(tool.get("input"), 200)))

    st, _ = api("POST", "/v1/sessions/%s/events" % sid,
                {"events": [{"type": "user.custom_tool_result", "custom_tool_use_id": tool["id"],
                             "content": result_content}]}, beta=BOTH)
    print("  post tool_result -> HTTP %s" % st)

    def settled(e, s):
        if s == "idle" and agent_text_after_tool(e):
            return True
        return None
    _, evs, sstat = wait_for(sid, settled)
    had_err = any("error" in (e.get("type") or "") for e in evs)
    final = agent_text_after_tool(evs)
    print("  final status=%s had_error=%s" % (sstat, had_err))
    print("  agent reply: %s" % snippet(final, 400))
    for e in evs:
        if "error" in (e.get("type") or ""):
            print("  ERROR EVENT:", snippet(e, 500))
    return {"tool_surfaced": True, "final": final, "had_error": had_err}


def verdict(label, r):
    if not r:
        print("  %s: INCONCLUSIVE (session failure)"); return
    if not r.get("tool_surfaced"):
        print("  %s: TOOL DID NOT SURFACE — custom-tool pause/resume regression (Q2)." % label); return
    f = (r.get("final") or "").lower()
    sees_green = "green" in f or "ziel" in f
    no_image = "no_image_visible" in f.replace(" ", "_") or "no image" in f
    if sees_green:
        print("  %s: PASS — agent named GREEN from the tool_result image (vision via tool_result WORKS)." % label)
    elif no_image:
        print("  %s: FAIL — agent reported NO_IMAGE_VISIBLE (image NOT delivered via tool_result)." % label)
    else:
        print("  %s: UNCLEAR — agent named neither green nor NO_IMAGE_VISIBLE; inspect reply above." % label)


def main():
    if not KEY:
        print("NO KEY"); return

    png = solid_png(0, 180, 0)   # vivid green, unambiguous + unlikely to be a default guess
    print("green PNG bytes:", len(png))
    st, fr = upload_png(png, "green-test.png")
    print("upload /v1/files -> HTTP %s %s" % (st, snippet(fr, 300)))
    if st >= 300 or not isinstance(fr, dict):
        print("UPLOAD FAILED — cannot run TEST A (file_id)."); file_id = None
    else:
        file_id = fr.get("id"); created["file"] = file_id

    st, agent = api("POST", "/v1/agents", {
        "name": "spike-block4-toolresult-image-054",
        "model": "claude-haiku-4-5",
        "system": ("You are a connectivity test agent. You have one custom tool, extract_clickup_task, which "
                   "returns the content of a ClickUp task's attachments. When asked, call it, then answer the "
                   "user's question about what you received. Be literal and do not fabricate."),
        "tools": [
            {"type": "custom", "name": "extract_clickup_task",
             "description": "Retrieves the extracted content (document text and/or images) of a ClickUp task's "
                            "file attachments, scoped to the caller's permissions. Input: a clickup_task_id.",
             "input_schema": {"type": "object",
                              "properties": {"clickup_task_id": {"type": "string",
                                             "description": "The ClickUp task id whose attachments to extract."}},
                              "required": ["clickup_task_id"]}},
        ],
    })
    print("create agent -> HTTP %s" % st)
    if st >= 300:
        print("  AGENT CREATE FAILED:", snippet(agent, 800)); return
    created["agent"] = agent["id"]
    print("  agent:", agent["id"])

    results = {}

    # ---- TEST A: image via Files-API file_id ----
    if file_id:
        results["A"] = run_test("TEST A file_id", [
            {"type": "text", "text": "Extracted 1 image attachment from the task (filename: green-test.png)."},
            {"type": "image", "source": {"type": "file", "file_id": file_id}},
        ])
    else:
        print("\n[TEST A file_id] SKIPPED — upload failed.")

    # ---- TEST B: image via inline base64 ----
    results["B"] = run_test("TEST B base64", [
        {"type": "text", "text": "Extracted 1 image attachment from the task (filename: green-test.png)."},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                     "data": base64.b64encode(png).decode()}},
    ])

    # ---- TEST C: plain text tool_result (Q2 baseline — does the cycle resume at all?) ----
    results["C"] = run_test("TEST C text-only", [
        {"type": "text", "text": "Extracted document text from the task: 'The dominant colour is green.'"},
    ])

    print("\n== VERDICT ==")
    if "A" in results:
        verdict("TEST A (file_id image in tool_result)", results.get("A"))
    verdict("TEST B (base64 image in tool_result)", results.get("B"))
    # TEST C: a text-only result that asserts green; if the agent echoes green, the cycle resumed (Q2 OK)
    c = results.get("C") or {}
    if not c.get("tool_surfaced"):
        print("  TEST C (custom-tool cycle): FAIL — tool did not surface (pause/resume regression).")
    else:
        print("  TEST C (custom-tool cycle): PASS — tool surfaced and agent resumed after the text result.")


def cleanup():
    print("\n== CLEANUP ==")
    for sid in created["sessions"]:
        print(" del session", sid, api("DELETE", "/v1/sessions/%s" % sid, beta=BOTH)[0])
    if created["file"]:
        print(" del file", created["file"], api("DELETE", "/v1/files/%s" % created["file"], beta=FILES)[0])
    if created["agent"]:
        print(" archive agent", api("POST", "/v1/agents/%s/archive" % created["agent"])[0])


try:
    main()
except Exception:
    import traceback; traceback.print_exc()
finally:
    cleanup()
