# Master Fix List — Post Second-Audit (ship-prioritized)

Derived from `SECOND-AUDIT.md` by reasoning about **what actually gates shipping tomorrow** vs. what's noise. The guiding question for each item: *if we ship without this, what breaks, for whom, how likely?*

**TL;DR:** There are **no code-level blockers**. The only true blocker is **real-machine validation** of the two unproven platforms. Everything else is cheap hardening (P1) or fast-follow (P2/P3).

---

## P0 — Blockers for the "works on Win / Linux / Win+WSL" promise (do before you tell the world)

These are about **validation + the Linux install trap**, not code bugs.

- [ ] **P0.1 — Smoke-test on a real Windows machine and a real Linux machine.**
  Win+WSL is proven by the suite (103/103). Windows-native (ConPTY + `claude.exe` spawn) and native-Linux are **never-run-on-hardware**. Follow `docs/SMOKE.md`: install fresh, open a session, switch sessions, share live, run a voice round-trip. *This is the single thing MK is right about.* Without it you're claiming three platforms while having proven one.

- [ ] **P0.2 — Decide the Linux `node-pty` story (real first-run trap).**
  `node-pty` ships **no Linux prebuild**, and `node-pty-prebuilt-multiarch` is **not** a dependency — so a fresh Linux user's `npm install` builds from source and **fails with no C toolchain**, leaving the loader's fallback empty. Pick one:
  (a) add `node-pty-prebuilt-multiarch` as an `optionalDependency` (best for plug-n-play), **or**
  (b) keep source-build but add a **preflight check** that detects the missing pty and prints a one-line "run: `sudo apt install build-essential python3`" instead of a stack trace.
  Today it's only documented in the README — not enough for "plug-n-play."

---

## P1 — Cheap hardening (~30 min total; worth doing before ship — all low-risk)

I'd batch these into one commit before you ship; none can regress anything meaningful.

- [ ] **P1.1 — Null-delimit the `presence-list` path loop.** `sessions-sync.sh:393` — `for path in $(git ls-tree …)` → `git ls-tree -z … | while read -r -d ''`. *Not exploitable* (the `case live/*.json` guard holds — verifier confirmed) but it removes a fragile word-split on attacker-influenced (push-access) filenames. Pure defense-in-depth.
- [ ] **P1.2 — `setup-win.ps1:100`** add the explicit `$LASTEXITCODE` check after `uv run` (model download), matching the now-fixed `git clone`/`uv sync` checks. Stops a half-installed voice stack reading "Done" on the Windows path.
- [ ] **P1.3 — `main.js:1203, 1230`** use the `win && win.webContents.send(…)` guard (finish prior 3.6 — two stragglers still use bare try/catch).
- [ ] **P1.4 — `main.js:840`** log the failed-`git clone` stderr; show the user a clean message (don't surface raw stderr).
- [ ] **P1.5 — `sessions-sync-tool.js:240`** `String.substr()` → `.slice()` (deprecated API; cosmetic).

> Say the word and I'll do **all of P1 in one verified commit** right now.

---

## P2 — Fast-follow (safe to ship without; schedule for the next cycle)

- [ ] **P2.1 — Guest resume-token out of the URL** (M1 / prior 3.1). Move it to an `HttpOnly`+`Secure`+`SameSite` cookie + per-reconnect rotation. **Why it can wait:** already IP-bound + 15 s grace + fail-open; exploitation needs the exact URL *and* same IP within 15 s. Real but low — the proper fix changes the guest auth handshake, which you don't want to rush the night before.
- [ ] **P2.2 — Orphaned `cloudflared` cleanup on crash/force-kill** (gap 11) — accumulate → port contention, esp. WSL. Track the PID; reap on next launch.
- [ ] **P2.3 — Surface "tunnel is down" in the UI** (gap 4) so a guest with a stale link isn't met with a cryptic refusal.
- [ ] **P2.4 — Validate custom invite-clone dir for `..`/symlinks** (L6 / gap 15). User-chosen path, low risk, but cheap to harden.
- [ ] **P2.5 — `runScript` in-flight coalescing** (M2 / prior 3.7) — optional perf; only if you ever see duplicate spawns under load.

---

## P3 — Polish / UX backlog (post-launch)

- [ ] Restore/"undo delete" API for the `(recoverable)` trash promise (gap 2) — today users manually dig `~/.claudible/trash`.
- [ ] Specific error messages: voice `EADDRINUSE` (gap 5), sync timeout vs permission vs hung (gap 6), worktree-corruption diagnostic (gap 9).
- [ ] Pre-flight `gh auth` / `claude` onboarding warning instead of failing only at sync time (gap 10).
- [ ] UI shortcut to the logs dir (gap 14); resume interrupted voice-model downloads (gap 1).
- [ ] Orphaned-workspace-on-failed-delete cleanup (gap 3); transcript write-race on network drop during push (gap 12).

---

## What's explicitly **DONE / verified safe** (no action — for confidence)

Foreign-session RCE guard (both backends, even under bypass) · permission-mode preserves it · kick/terminate host-gated + token-revoking · safe clipboard · pinned minimal supply chain + the one legit `node-pty` patch · strict guest CSP · safe command construction · **repo verified clean of malicious code/secrets** · prior findings **3.2–3.6 fixed**, **3.1 hardened**. 103/103 tests green.

---

### My recommendation, plainly
Ship-readiness of the **code** is there. Do **P0.1 + P0.2** (a few hours on real Win + Linux boxes, plus the node-pty decision) and you can ship tomorrow honestly. Fold in **P1** while you're at it (30 min, I can do it now). Defer P2/P3. That's the difference between "MK's right, you're dreaming" and "shipped, and it actually installs for everyone."
