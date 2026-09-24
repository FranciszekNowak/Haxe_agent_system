# ADR-0006: VPS hardening and access model

Date: 2026-05-30
Status: Accepted

## Context
The production VPS (Cyberfolks vroot_SPRINT, AlmaLinux 10, 185.25.149.174)
came online with only root + password SSH. Within hours it logged ~2000
failed login attempts from internet bots. OpenSSH's per-source penalty
system (PerSourcePenalties, default in modern OpenSSH) intermittently
blocked the operator's own IP after fumbled password attempts, producing
"Not allowed at this time" handshake rejections. fail2ban was confirmed
inactive; root login and password auth were enabled by default.

## Decision
Establish a least-privilege, key-based access model:

1. **Non-root sudo user `franciszek`** created and added to the `wheel`
   group. Day-to-day operation happens as this user; root is reserved for
   exceptional cases. Mirrors the caller-scoping principle of the agent
   architecture (broad capability exists, each action runs with the minimum
   privilege needed).
2. **SSH key authentication** (ed25519) installed for both root and
   franciszek. The operator's private key currently lives only on the home
   desktop.
3. **firewalld** restricted to ssh/http/https (plus harmless defaults
   cockpit, dhcpv6-client). All other inbound ports closed.
4. **franciszek added to the `docker` group** for non-sudo Docker access
   (accepted as root-equivalent on a single-operator box).
5. Timezone set to Europe/Warsaw; system patched via `dnf update`.

## Deliberately deferred
**Password authentication is left ENABLED.** Full hardening would disable it
(`PasswordAuthentication no`), making brute-force impossible. But the
operator's key exists only on the home desktop; the office machine is not yet
keyed. Disabling password auth now would lock the operator out from the
office. Password auth stays ON as the fallback until every machine the
operator administers from has its key installed, after which password auth
is disabled as the final hardening step.

> **Update 2026-06-01 (supersedes the deferral above):** the office desktop is
> now keyed — both workstations have their own ed25519 keypair installed for
> `franciszek`. With key-based access confirmed on both, password authentication
> has been disabled (`PasswordAuthentication no`). Access is now key-only; the
> deferral described in this section no longer applies.

> **Update 2026-09-24 (third machine keyed — a laptop):** `Laptop_FN` (Windows 11 Home
> 10.0.26200, local user `franc`) now has its own ed25519 keypair installed for
> `franciszek`, fingerprint `SHA256:mZHvDaCSdYVR4KM8r8PPBrp9YZAtrMBwLtSr9G69U7E`. The key
> was generated on the laptop, so no private key moved between machines, and the public half
> was appended from the home desktop with `>>`. Verified the same day: the server's
> `authorized_keys` lists three keys — `franciszek-haxe`, `haxe_biuro2` and
> `franciszek@Laptop_FN` — so the two desktops were not disturbed, and
> `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes franciszek@185.25.149.174` returns
> `vps57524999`. The ED25519 host key was read as
> `/etc/ssh/ssh_host_ed25519_key.pub` from inside the home desktop's trusted session,
> confirming `SHA256:Zl0i+LIcg4GfNrkREfguhyIIwDax+ilmms1MHsAWhBQ`; the laptop's
> `known_hosts` entry was written only after re-scanning the key and checking its
> fingerprint against that value, not by accepting it on first connection.
>
> Three things this enrollment established that apply to every machine keyed from now on:
>
> 1. **Enrollment now requires an already-keyed machine.** Because the 2026-06-01 update
>    disabled password authentication, a new machine cannot enroll itself. The only routes
>    are an appended key from a keyed machine, or the Cyberfolks (Solus) VNC console. Two of
>    the three keyed machines are now portable or off-site, so this is the constraint to plan
>    around if a workstation is lost.
> 2. **The laptop's key is passphrase-free,** consistent with the practice recorded in
>    `architecture/current.md` under "Access" ("private keys passphrase-free, for
>    non-interactive automation"). A laptop is a different threat model from two fixed
>    desktops — it leaves the building — so whether this convention should still hold for
>    portable machines is left as an open question for the operator rather than settled here.
>    Adding a passphrase requires a working `ssh-agent` first, or automation loses
>    unattended access. On `Laptop_FN` the `ssh-agent` service is currently `Stopped` and
>    `StartType: Disabled`, and enabling it failed with access denied even from a window the
>    operator believed to be elevated.
> 3. **On Windows, two SSH clients compete and the wrong one wins.** Windows OpenSSH
>    (`C:\WINDOWS\System32\OpenSSH\ssh.exe`) is the only client that talks to the Windows
>    `ssh-agent` service; Git Bash ships its own `/usr/bin/ssh` that shadows it on `PATH`
>    and runs with an empty `SSH_AUTH_SOCK`. This is invisible while keys are
>    passphrase-free, and becomes an unexplained hang the moment one is added, so automation
>    on Windows should drive SSH through the Windows client.
>
> `komputer-marketing` remains unkeyed. The consuming repo's side of this is recorded in
> `formularz-reklamacje-Allegro`, ADR-001, which pins this ADR as the owner of the access
> model.

## Lessons captured (operational)
- Almost every access failure during setup was a TIME-BASED lockout
  triggered by rapid retries (OpenSSH penalty, panel rate-limit, VNC
  handshake stalls). The fix for all of them is to stop and wait, not retry
  faster.
- NEVER paste passwords into terminal prompts (`passwd`, `sudo`). Paste can
  inject hidden characters / newlines; the double-entry check passes (both
  entries equally wrong) but later login fails. Type passwords by hand at
  terminal prompts and record them simultaneously.
- Four distinct credentials exist and must be labeled separately in the
  password manager: (a) Cyberfolks account login, (b) Solus service password,
  (c) server root password, (d) franciszek sudo password. Conflating them
  caused significant confusion.
- `passwd` changes the current user's password; `passwd <user>` changes the
  named user's (needs root). Targeting was always correct; the only bug was
  pasting.

## Consequences
- Reliable key-based access from the home desktop; office machine to be keyed
  next, then password auth disabled.
- VNC (Solus console) remains the hardware-level emergency fallback, though it
  proved flaky under load and is not relied upon.
