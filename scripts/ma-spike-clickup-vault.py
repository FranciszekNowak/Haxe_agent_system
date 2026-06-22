#!/usr/bin/env python3
"""ADR-054 Block 0 capability-gate spike, part 1 — VAULT CREDENTIAL MECHANICS (THROWAWAY).

Proves the Anthropic-Vault shapes ADR-054 depends on, independent of ClickUp:
  (b) the Vault accepts an `mcp_oauth` credential (OAuth w/ auto-refresh block), not only static_bearer;
  (g) credential lifecycle — can the access_token be UPDATED IN PLACE, and are the *keys*
      (mcp_server_url, token_endpoint, client_id) immutable (forcing create-new + re-point)?
  plus: secrets are write-only on GET; duplicate mcp_server_url in one vault → 409; static_bearer baseline.

No model inference, no ClickUp call — pure vault CRUD against a PLACEHOLDER mcp_server_url
(the API does not validate credential tokens until session runtime, so a placeholder is fine
for shape-proving). Tears everything down in finally. Stdlib only. Reads ANTHROPIC_API_KEY from env.

Run on the VPS:  set -a; . /opt/haxe-agents/.env; set +a; python3 /tmp/ma-spike-clickup-vault.py
"""
import json, os, urllib.request, urllib.error

BASE = "https://api.anthropic.com"
KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MA = "managed-agents-2026-04-01"
PLACEHOLDER_MCP_URL = "https://mcp.clickup.example/spike-054"  # not real; shape-proving only
created = {"vault": None, "cred_oauth": None, "cred_bearer": None}


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


def show(label, st, obj, limit=700):
    print("\n== %s -> HTTP %s ==" % (label, st))
    print(json.dumps(obj, indent=2)[:limit] if isinstance(obj, (dict, list)) else str(obj)[:limit])


def main():
    if not KEY:
        print("NO ANTHROPIC_API_KEY IN ENV"); return

    # 1) vault
    st, vault = api("POST", "/v1/vaults", {"display_name": "spike-054-clickup-vault"})
    show("create vault", st, vault)
    if st >= 300:
        return
    created["vault"] = vault["id"]
    vid = vault["id"]

    # 2) mcp_oauth credential (the gap-(b) proof) — OAuth with auto-refresh block
    oauth_body = {
        "display_name": "spike clickup user U (oauth)",
        "auth": {
            "type": "mcp_oauth",
            "mcp_server_url": PLACEHOLDER_MCP_URL,
            "access_token": "spike-access-token-AAA",
            "expires_at": "2030-01-01T00:00:00Z",
            "refresh": {
                "refresh_token": "spike-refresh-token-AAA",
                "client_id": "spike-client-id-123",
                "token_endpoint": "https://app.clickup.com/api/v2/oauth/token",
                "token_endpoint_auth": {"type": "client_secret_post", "client_secret": "spike-secret-xyz"},
            },
        },
    }
    st, cred = api("POST", "/v1/vaults/%s/credentials" % vid, oauth_body)
    show("create credential (mcp_oauth)  [GAP b]", st, cred)
    if st < 300:
        created["cred_oauth"] = cred.get("id")
        print("  >> mcp_oauth ACCEPTED — Vault supports OAuth auto-refresh credentials (not only static_bearer)")
    else:
        print("  >> mcp_oauth REJECTED — read the error; may need static_bearer + self-refresh (RESHAPE)")

    # 3) GET the credential back — confirm secrets are write-only
    if created["cred_oauth"]:
        st, got = api("GET", "/v1/vaults/%s/credentials/%s" % (vid, created["cred_oauth"]))
        show("GET credential (expect NO secret fields returned)", st, got)
        blob = json.dumps(got)
        leaked = [s for s in ("spike-access-token-AAA", "spike-refresh-token-AAA", "spike-secret-xyz") if s in blob]
        print("  >> leaked secret fields on GET:", leaked or "NONE (write-only confirmed)")

    # 4) lifecycle (gap g, part 1): UPDATE access_token IN PLACE (rotation)
    if created["cred_oauth"]:
        upd = {"auth": {"type": "mcp_oauth", "access_token": "spike-access-token-ROTATED",
                        "expires_at": "2031-01-01T00:00:00Z",
                        "refresh": {"refresh_token": "spike-refresh-token-ROTATED"}}}
        st, r = api("POST", "/v1/vaults/%s/credentials/%s" % (vid, created["cred_oauth"]), upd)
        show("UPDATE access_token in place (rotation)  [GAP g: in-place?]", st, r)
        print("  >> in-place token rotation:", "WORKS" if st < 300 else "REJECTED")

    # 5) lifecycle (gap g, part 2): try to change the KEY (mcp_server_url) — expect immutable
    if created["cred_oauth"]:
        upd2 = {"auth": {"type": "mcp_oauth", "mcp_server_url": "https://mcp.clickup.example/CHANGED",
                         "access_token": "spike-access-token-ROTATED2"}}
        st, r = api("POST", "/v1/vaults/%s/credentials/%s" % (vid, created["cred_oauth"]), upd2)
        show("UPDATE mcp_server_url (key) — expect rejected/ignored  [GAP g: keys immutable?]", st, r)
        print("  >> changing the key (mcp_server_url):", "REJECTED (immutable -> create-new+re-point)" if st >= 300 else "ACCEPTED? verify below")

    # 6) duplicate mcp_server_url in same vault -> expect 409
    st, dup = api("POST", "/v1/vaults/%s/credentials" % vid, {
        "display_name": "dup url",
        "auth": {"type": "mcp_oauth", "mcp_server_url": PLACEHOLDER_MCP_URL, "access_token": "x"},
    })
    show("create 2nd credential, SAME url — expect 409", st, dup)
    print("  >> unique-key enforcement:", "409 as expected" if st == 409 else "HTTP %s (note it)" % st)
    if st < 300 and isinstance(dup, dict):
        created["cred_bearer"] = dup.get("id")  # clean it up if it somehow created

    # 7) static_bearer baseline at a different url (proven in ADR-053; sanity here)
    st, sb = api("POST", "/v1/vaults/%s/credentials" % vid, {
        "display_name": "static bearer baseline",
        "auth": {"type": "static_bearer", "mcp_server_url": "https://mcp.clickup.example/bearer", "token": "pk_spike"},
    })
    show("create static_bearer (baseline)", st, sb)
    if st < 300 and isinstance(sb, dict) and not created["cred_bearer"]:
        created["cred_bearer"] = sb.get("id")


def cleanup():
    print("\n== CLEANUP ==")
    vid = created["vault"]
    for k in ("cred_oauth", "cred_bearer"):
        if created[k] and vid:
            print("del %s:" % k, api("DELETE", "/v1/vaults/%s/credentials/%s" % (vid, created[k]))[0])
    if vid:
        print("del vault:", api("DELETE", "/v1/vaults/%s" % vid)[0])


try:
    main()
except Exception:
    import traceback; traceback.print_exc()
finally:
    cleanup()
