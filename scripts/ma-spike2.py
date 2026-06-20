#!/usr/bin/env python3
"""ADR-053 Block 0 spike, part 2 (THROWAWAY): the two shapes part 1 missed.
  (e-upload) Files API upload returns a file_id
  (f-agg)    GET /v1/sessions/{id}.usage aggregate shape + any runtime/cost field
Stdlib only. Reads ANTHROPIC_API_KEY from env. Cleans up."""
import json, os, sys, time, urllib.request, urllib.error
BASE="https://api.anthropic.com"; KEY=os.environ.get("ANTHROPIC_API_KEY","")
MA="managed-agents-2026-04-01"; FILES="files-api-2025-04-14"; MODEL="claude-haiku-4-5"
if not KEY: print("NO KEY"); sys.exit(1)
created={"env":None,"agent":None,"session":None,"file":None}
def api(method,path,body=None,betas=MA,raw=None,ctype=None):
    h={"x-api-key":KEY,"anthropic-version":"2023-06-01","anthropic-beta":betas}
    data=None
    if raw is not None: data=raw; h["content-type"]=ctype
    elif body is not None: data=json.dumps(body).encode(); h["content-type"]="application/json"
    req=urllib.request.Request(BASE+path,data=data,headers=h,method=method)
    try:
        with urllib.request.urlopen(req,timeout=60) as r:
            b=r.read()
            try: return r.status, json.loads(b.decode())
            except Exception: return r.status, {"_bytes":len(b)}
    except urllib.error.HTTPError as e:
        t=e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t
def jd(l,o): print(f"\n--- {l} ---"); print(json.dumps(o,indent=2)[:3000])
def main():
    # (e-upload)
    bnd="----b053"
    parts=(f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"spike.txt\"\r\n"
           f"Content-Type: text/plain\r\n\r\nhello from spike\r\n"
           f"--{bnd}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nagent\r\n--{bnd}--\r\n").encode()
    st,up=api("POST","/v1/files",betas=FILES,raw=parts,ctype=f"multipart/form-data; boundary={bnd}")
    print(f"Files upload -> HTTP {st}"); jd("uploaded file",up)
    if isinstance(up,dict) and up.get("id"): created["file"]=up["id"]
    # session for usage aggregate
    st,env=api("POST","/v1/environments",{"name":"spike2-env","config":{"type":"cloud","networking":{"type":"unrestricted"}}})
    created["env"]=env.get("id") if isinstance(env,dict) else None
    st,agent=api("POST","/v1/agents",{"name":"spike2-agent","model":MODEL,"system":"Test.","tools":[{"type":"agent_toolset_20260401"}]})
    created["agent"]=agent.get("id")
    st,sess=api("POST","/v1/sessions",{"agent":agent["id"],"environment_id":env["id"]})
    created["session"]=sess["id"]; print("session:",sess["id"])
    api("POST",f"/v1/sessions/{sess['id']}/events",{"events":[{"type":"user.message","content":[{"type":"text","text":"Reply with exactly: hi there friend"}]}]})
    for _ in range(40):
        time.sleep(3)
        st,s=api("GET",f"/v1/sessions/{sess['id']}")
        if isinstance(s,dict) and s.get("status")=="idle": break
    jd("FULL session object keys", {k:(s[k] if k not in ('resources',) else '...') for k in s} if isinstance(s,dict) else s)
    jd("session.usage", s.get("usage") if isinstance(s,dict) else None)
def cleanup():
    print("\n== CLEANUP ==")
    if created["session"]: print("del session", api("DELETE",f"/v1/sessions/{created['session']}")[0])
    if created["file"]: print("del file", api("DELETE",f"/v1/files/{created['file']}",betas=FILES)[0])
    if created["agent"]: print("archive agent", api("POST",f"/v1/agents/{created['agent']}/archive")[0])
    if created["env"]: print("del env", api("DELETE",f"/v1/environments/{created['env']}")[0])
try: main()
except Exception: import traceback; traceback.print_exc()
finally: cleanup()
