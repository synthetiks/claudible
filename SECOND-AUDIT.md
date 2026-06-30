# Second Claudible Audit — Bugs, Security, Cross-Platform & Ship-Readiness

**Repo:** `claudible` · **Date:** 2026-06-28 · **HEAD:** `c22fbb5` · **Branch:** `main`
**Prior audit:** "Finishline Audit" @ `2054ee9` (2026-06-24) — 9 findings, none critical.
**Mode:** read-only audit (no source changed). **Scope:** full source — main process, runners, ported Node helpers, share/co-work server, voice services, bash scripts, native installers, packaging, docs.

---

## 1. Verdict

**The codebase is in good, shippable shape.** A 8-dimension parallel scan (11 agents) surfaced **51 candidate findings**; an adversarial verification pass (each high/critical re-checked against the real code, empirically where possible) **dismissed the two scariest findings as false positives**, leaving **no critical or high issues that survive scrutiny**. The repo is **verified clean of malicious code, hardcoded secrets, and obfuscated payloads**. The foreign-session RCE guard, the new permission-mode setting, the live host-controls, and the supply chain are all **confirmed correct**. Of the 9 prior findings, **3.2–3.6 are FIXED** and **3.1 is substantially hardened**.

**There are no code-level ship blockers.** The single real pre-ship risk is **validation, not code**: the Windows-native and native-Linux install/run paths cannot be proven headless and are currently **unverified on real hardware** — only Windows+WSL is fully proven by the test suite. That is the gap to close before promising "anyone on Win/Linux/Win+WSL can plug-n-play."

> **On MK's "you're dreaming":** he's *partly* right — not because the code is bad, but because **Win-native + native-Linux have never been run on a real machine.** Close that and the dream is real. See §6.

---

## 2. Method & coverage

- **Fan-out (read-only, 8 finders):** shell/command injection + RCE, the live/share network surface, malicious-code + secrets + supply-chain, main.js bugs/leaks/races, renderer bugs, dead code/deprecated/hygiene, cross-platform (Win-native/Linux/Win+WSL), install/setup/ship-readiness. Each finder also re-checked the 9 prior findings for fixed/open/regressed.
- **Adversarial verify (1 agent):** every high/critical/security-medium candidate independently re-checked against the real code, biased *against* needless change — empirical bash tests where applicable. **This turned 2 "HIGH" findings into dismissed false positives.**
- **Smoke (1 agent):** actually ran the full test suite + every syntax check + lockfile integrity + static boot-trace per platform.
- **Completeness critic (1 agent):** 17 coverage gaps for what a headless audit can't see (§5).
- **Excluded:** `node_modules/`, `dist/`, transcripts, fixtures.

---

## 3. Findings

### 3a. Dismissed by verification (reported by a finder, then proven NOT real) — important

| Candidate | Finder severity | Verdict | Why it's not a bug |
|---|---|---|---|
| **Command injection via git-tree paths in `presence-list`** (`sessions-sync.sh:393-398`) | HIGH | **FALSE POSITIVE** | Empirically tested: bash does **not** re-evaluate `$(...)` when expanding a variable inside double quotes. `$path="live/$(whoami).json"` reaches `git show` as a literal string, never executed. The `case "$path" in live/*.json` pattern also rejects malformed splits. Not exploitable. |
| **Duplicate session rows: `liveTabs` missing `shown` dedup** (`app.js:2549`) | HIGH | **FALSE POSITIVE** | The `liveTabs` filter is `!savedIds.has(r.session)`, and `ordered` is built **from** `savedIds`. Collision is impossible by construction. The missing `shown.has()` check is a style asymmetry, not a reachable bug. |

Both are still worth a **cosmetic hardening** (see Low items) — but neither is a real vulnerability or bug.

### 3b. Real findings — MEDIUM

| # | Finding | Location | Notes |
|---|---|---|---|
| M1 | **Guest resume-token still travels in the URL** (`?r=`) + `sessionStorage` (prior **3.1**) | `share/server.js:87,162,267-281` · `share/guest.js:5` | Hardened since the first audit — IP-bound at mint, 15 s grace (was 45 s), fail-open. Residual exposure: browser history / DevTools / HTTP logs. **Exploitability is low** (needs the URL *and* the same IP within 15 s). Verifier confirmed REAL → medium. **Defer-able to fast-follow.** Fix: HttpOnly+Secure+SameSite cookie + per-reconnect rotation. |
| M2 | **No in-flight coalescing of identical `runScript` spawns** (prior **3.7**) | `main.js` (multiple sites) | Optional perf; same as prior audit. Low value, low risk. |

### 3c. Real findings — LOW / hygiene (cheap, do-before-or-just-after ship)

| # | Finding | Location | Fix |
|---|---|---|---|
| L1 | `for path in $(git ls-tree …)` word-splits (not exploitable — `case` guards it — but fragile) | `sessions-sync.sh:393` | Use `ls-tree -z … \| while read -r -d ''` (null-delimited). Defense-in-depth. |
| L2 | Deprecated `String.substr()` | `sessions-sync-tool.js:240` | `.slice()`/`.substring()`. Cosmetic. |
| L3 | `setup-win.ps1` `uv run` (model download) lacks an explicit `$LASTEXITCODE` check (has try/catch + fallback) | `setup-win.ps1:100` | Add the exit-code check for parity with the now-fixed `git clone`/`uv sync` checks. Windows voice path robustness. |
| L4 | Two `win.send()` calls still rely on `try/catch` instead of the `win &&` guard (prior **3.6**, mostly fixed) | `main.js:1203,1230` (also 1167) | Use the `win && win.webContents.send(…)` pattern consistently. |
| L5 | Failed `git clone` stderr surfaced in a user-facing error message (minor info-leak / noise) | `main.js:840` | Log full stderr; show a clean message to the user. |
| L6 | Custom invite-clone directory validated for quotes but not `..`/symlinks (user-chosen path, low risk) | `clone-workspace.sh` / `repo-invite.sh` (gap 15) | Reject `..` segments; resolve symlinks. |

### 3d. Verified **SAFE** (checked and correct — the good news)

- **Foreign-session RCE guard** — both backends sandbox imported sessions (`session.sh:141-148`, `win.js:108`); **holds even when permission mode = bypass** (tested: `win-runner` "foreign sandboxed even with bypass").
- **Permission-mode setting** preserves that guard end-to-end (all 3 runners).
- **Live host-controls** (kick/terminate) host-gated; kick revokes the resume token; no double-cleanup.
- **Chat copy** uses the main-process clipboard helper (not the failure-prone `navigator.clipboard`).
- **Command construction** — arg arrays via `spawn`/`execFile`, no `shell:true`, allowlisted ids/slugs/effort/permMode, single-quote escaping. No `bash -c` with interpolated user input.
- **Supply chain** — 4 prod deps (`@xterm/*`, `node-pty`, `ws`) + 4 dev, **pinned** in `package-lock.json`; the single patch (`node-pty+1.1.0` AttachConsole guard) is **legitimate**.
- **CSP** on the guest page is strict (`default-src 'self'`, no remote CDN, no inline scripts).
- **Prior findings 3.2 (setup-win failures), 3.3 (FD leak), 3.4 (idle-tab subprocess), 3.5 (poll cadence), 3.6 (win.send) — all FIXED.**
- **No malicious code, no secrets, no exfiltration, no remote-code-fetch in postinstall.**

---

## 4. Smoke test (what actually ran)

**Result: PASS for everything runnable headless.**

- ✅ `npm test` — **103/103** (runner-parity 24, posix-runner 10, win-runner 55, hooks-parity, port-parity 14)
- ✅ `node --check` — main.js, preload.js, app.js, all 6 runners, all 8 `*-tool.js`
- ✅ `bash -n` — all 23 `wsl/*.sh` + `setup/setup.sh`
- ✅ `package.json` loads (v0.5.4, electron 42.4.0, electron-builder 26.0.12; win=nsis-x64, linux, mac targets) · `package-lock.json` in sync, all 8 top-level deps present

---

## 5. Coverage gaps & what needs a REAL machine

**Cannot be verified headless** (must be smoke-tested on real hardware before claiming cross-platform plug-n-play):
1. **Windows-native** ConPTY + `claude.exe` spawn + git-bash script delegation (pure bootstrap is unit-tested; live spawn is not). **← biggest unknown.**
2. **Native Linux/macOS** `npm install` — `node-pty` ships no Linux prebuild, so a fresh Linux user **needs a C toolchain** to build it (or the `node-pty-prebuilt-multiarch` fallback). **← real install risk for Linux users.**
3. Electron UI rendering, electron-builder `dist` output (NSIS/dmg/fpm), the WSL2 bridge on real Windows, cloudflared tunnel activation, Whisper/Kokoro voice services, the actual `install.ps1`/`setup.sh` runs.

**Robustness/UX gaps the critic flagged (low-priority, fast-follow):** interrupted-voice-download resume (gap 1); no restore API for "(recoverable)" trash (gap 2); orphaned `cloudflared` on crash → port leak, esp. WSL (gap 11); tunnel-down not surfaced in UI (gap 4); voice port `EADDRINUSE` shows generic error (gap 5); generic sync-error messaging hides network-vs-permission-vs-hung (gap 6); no pre-flight `gh auth` onboarding warning (gap 10); logs dir hidden with no UI shortcut (gap 14). Full list of 17 in the audit data.

---

## 6. Bottom line for shipping tomorrow

- **Code quality / security:** green. No blockers. Ship-grade.
- **The one thing standing between you and the promise:** **run it on a real Windows box and a real Linux box.** Win+WSL is proven; the other two are unproven, and the Linux `node-pty` build is a genuine first-run trap. Do those two smoke tests (per `docs/SMOKE.md`) and you've earned the "anyone can plug-n-play" claim.
- Everything else (M1/M2 + L1–L6 + the UX gaps) is **fast-follow** — see `MASTER-FIX-LIST.md`.
