#!/usr/bin/env python3
"""ADR-053 Block 3 spike (THROWAWAY): resolve the input-image attach mechanism with a
GUARANTEED-VALID image generated in-process (an earlier run used a copy-corrupted base64,
which made every image fail with "Could not process image" — a false negative).

Generates a valid 64x64 red PNG via stdlib zlib (no copy step), then:
  T1  Bare Messages API + inline base64           -> image-validity control (must describe red)
  T2  LIVE Haiku agent + file_id image block      -> the attach shape under test
                                                      {type:image, source:{type:file, file_id}}
Reads ANTHROPIC_API_KEY from env. Deletes env/session/file (reuses the live agent, no archive cruft).
"""
import json, os, time, base64, zlib, struct, urllib.request, urllib.error

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MA = "managed-agents-2026-04-01"
FILES = "files-api-2025-04-14"
BOTH = MA + "," + FILES
HAIKU = "agent_01VFVwm2tC8rmJvMRZLfSERY"
PROMPT = "What single shape and color is in this image? Answer in 6 words max."

def make_png(w=64, h=64, rgb=(220, 20, 20)):
    def chunk(typ, data):
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

PNG = make_png()
B64 = base64.b64encode(PNG).decode()

def api(method, path, body=None, betas=MA, raw=None, ctype=None, use_beta=True):
    h = {"x-api-key": KEY, "anthropic-version": "2023-06-01"}
    if use_beta: h["anthropic-beta"] = betas
    data = None
    if raw is not None: data = raw; h["content-type"] = ctype
    elif body is not None: data = json.dumps(body).encode(); h["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            b = r.read()
            try: return r.status, json.loads(b.decode())
            except Exception: return r.status, b
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t

created = {"env": None, "session": None, "file": None}

def main():
    if not KEY: print("NO KEY"); return
    print("valid PNG bytes:", len(PNG), "| b64 chars:", len(B64))

    # T1: bare Messages API (image-validity control)
    st, r = api("POST", "/v1/messages",
                {"model": "claude-haiku-4-5", "max_tokens": 60,
                 "messages": [{"role": "user", "content": [
                     {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": B64}},
                     {"type": "text", "text": PROMPT}]}]},
                use_beta=False)
    txt = None
    if isinstance(r, dict):
        for c in r.get("content", []):
            if c.get("type") == "text": txt = c.get("text")
    print("\nT1 (bare API):", st, "| SAID:", repr(txt) if txt else json.dumps(r)[:300])

    # upload to Files API (purpose=agent, the Block-0 default)
    bnd = "----b3"
    pre = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"red.png\"\r\n"
           f"Content-Type: image/png\r\n\r\n").encode()
    post = (f"\r\n--{bnd}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nagent\r\n--{bnd}--\r\n").encode()
    st, up = api("POST", "/v1/files", betas=FILES, raw=pre + PNG + post,
                 ctype=f"multipart/form-data; boundary={bnd}")
    print("\nupload(purpose=agent):", st, up.get("id") if isinstance(up, dict) else up)
    if st >= 300: return
    fid = up["id"]; created["file"] = fid

    # T2: live Haiku agent + file_id image block
    st, env = api("POST", "/v1/environments",
                  {"name": "spike3-env", "config": {"type": "cloud", "networking": {"type": "unrestricted"}}})
    if st >= 300: print("env failed", env); return
    created["env"] = env["id"]
    st, sess = api("POST", "/v1/sessions", {"agent": HAIKU, "environment_id": env["id"]})
    if st >= 300: print("session failed", sess); return
    created["session"] = sess["id"]
    st, _ = api("POST", f"/v1/sessions/{sess['id']}/events",
                {"events": [{"type": "user.message", "content": [
                    {"type": "image", "source": {"type": "file", "file_id": fid}},
                    {"type": "text", "text": PROMPT}]}]}, betas=BOTH)
    print("\nT2 send (file_id, both betas):", st)
    text = None; err = None; status = None
    for _ in range(50):
        time.sleep(3)
        _, s = api("GET", f"/v1/sessions/{sess['id']}", betas=BOTH)
        _, ev = api("GET", f"/v1/sessions/{sess['id']}/events", betas=BOTH)
        evs = ev.get("data", []) if isinstance(ev, dict) else []
        for e in evs:
            if e.get("type") == "agent.message":
                for c in e.get("content", []):
                    if c.get("type") == "text": text = c.get("text")
            if "error" in (e.get("type") or ""): err = e.get("error")
        status = s.get("status") if isinstance(s, dict) else None
        if status in ("idle", "terminated") and (text or err): break
    print("T2 (managed, file_id): status:", status, "| err:", json.dumps(err) if err else None, "| SAID:", repr(text))
    if text and any(w in text.lower() for w in ("red", "square", "rectangle")):
        print(">>> VISION CONFIRMED via file_id image block on the live agent.")

def cleanup():
    print("\n== CLEANUP ==")
    if created["session"]: print("del session", api("DELETE", f"/v1/sessions/{created['session']}", betas=BOTH)[0])
    if created["env"]: print("del env", api("DELETE", f"/v1/environments/{created['env']}")[0])
    if created["file"]: print("del file", api("DELETE", f"/v1/files/{created['file']}", betas=FILES)[0])

try: main()
except Exception: import traceback; traceback.print_exc()
finally: cleanup()
