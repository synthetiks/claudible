# Finishline Audit — Security & Optimizations

**Repo:** `claudible` · **Scope:** full source (main process, runners, ported Node helpers, share/co-work
server, voice services, native installers) · **Mode:** read-only audit — no code was changed.
**Date:** 2026-06-24 · **Branch audited:** `main` @ `2054ee9`

---

## 1. Verdict

**The codebase is in good shape for the finish line.** A 6-dimension parallel scan surfaced **41 candidate
issues**; an adversarial, skeptical verification pass (each candidate re-checked against the real code with a
bias *against* needless change) cut that to **9 genuine findings** — and my own re-verification downgraded two
of those (see §3.6). **Nothing is critical. There are no exploitable RCE/auth-bypass holes, no data-loss bugs,
no broken shipping paths.** Several security controls were checked and found *correct* (§5).

The findings that genuinely warrant action cluster into **three buckets worth your time** and a few minor/optional
ones:

| # | Finding | Severity | Effort | Bucket |
|---|---------|----------|--------|--------|
| 3.1 | Guest resume-token replay window (45 s, token in URL) | **Medium** | Medium | Security hardening |
| 3.2 | `setup-win.ps1` swallows native-command failures → "Done" on a broken voice install | **Medium-High** | Low | New-code robustness |
| 3.3 | FD leak in `pollHooks` if a read throws | Low-Med | Trivial | Resource safety |
| 3.4 | `pollAgentTokens` spawns a subprocess for **idle** tabs every 8 s | Medium | Low | Optimization |
| 3.5 | `pollHooks` 80 ms cadence runs full-tilt even on idle tabs | Medium | Low-Med | Optimization |
| 3.6 | Two `win.send()` calls rely on a `try/catch` instead of the `win &&` guard | **Low** (downgraded) | Trivial | Consistency |
| 3.7 | No in-flight coalescing of identical `runScript` spawns | Low | Low | Optional |

If you only do three things: **3.2** (it can silently pin a broken voice stack on the new Windows path), **3.4**
(free CPU/IO win, cheap), and **3.3** (trivial resource-safety fix). Everything else is polish.

---

## 2. Method & coverage

- **Fan-out (read-only):** 6 independent agents, one per dimension — shell/command injection, the share +
  voice network surface, runtime correctness, dead code / dependency hygiene, performance, and a deep pass on
  the **newest, least-tested code** (the native installer + voice provisioning).
- **Adversarial verify:** every candidate was independently re-checked by a separate skeptical agent instructed
  to *avoid* needless change — confirm `worthFixing` only for a real, reachable risk/bug/optimization. This is
  what turned 41 → 9 and dismissed 32 (§4).
- **Human re-verification:** I read the actual code for every code-path finding before writing it up; this
  corrected two over-rated "crash" findings to low-severity consistency items (§3.6).

Files covered: `main.js`, `runners/{wsl,posix,win}.js`, `runners/_shared.js`, `wsl/*-tool.js` (the 8 ported
helpers), `wsl/services.sh`, `share/server.js` + `share/guest.js`, `preload.js`, `install.ps1`,
`setup/setup-win.ps1`, `setup/setup.sh`, `package.json`. Excluded: `node_modules/`, `dist/`, transcripts,
test fixtures.

---

## 3. Findings worth acting on

### 3.1 — Guest resume-token replay window · `share/server.js` · **Security · Medium**

**What.** When a guest's WebSocket drops (phone lock, tab background), the server holds their **resume token**
live for a grace window (`REJOIN_GRACE`, default **45 s**) so they can silently reconnect *without re-approval*.
The token travels in the **URL query string** and is kept in `sessionStorage` (`share/guest.js`), and
`hasResume()` validates it with only a timing-safe string compare — **no IP binding, no per-reconnect refresh**.

**Why it matters.** Inside that 45 s window, anyone who captures the token (DevTools, an HTTP proxy/log, browser
history) can replay it from *any* network and silently rejoin **as that guest**. It's bounded — the attacker must
sniff *and* replay within 45 s, and only gains the access the approved guest already had (not the terminal, not
the host's approval gate for *new* guests) — and the trust model is "people you invited over a `trycloudflare`
link," which is why this is **Medium, not High**. But it's a real TOCTOU gap and the token-in-URL is the weak link.

**Recommended fix (defense-in-depth, pick what fits):**
1. Move the resume token to an **HttpOnly + Secure + SameSite cookie** instead of the URL (kills DevTools/history
   exposure and most XSS reads). *Highest value.*
2. **Bind the token to the client IP** at mint time and check it on resume — a stolen token can't be replayed
   from another network.
3. Make `REJOIN_GRACE` **shorter** (15–20 s) and/or let the host **revoke an individual** guest (today
   `regenerateLink()` is all-or-nothing).
4. **Rotate the resume token on every successful reconnect** so a captured one is single-use.

### 3.2 — `setup-win.ps1` swallows native-command failures · `setup/setup-win.ps1` · **Bug · Medium-High** *(new code)*

**What.** PowerShell's `$ErrorActionPreference = 'Stop'` stops on **cmdlet** errors (so `Invoke-WebRequest` /
`Expand-Archive` are guarded) but **not on native-process** non-zero exits — so `git clone`, `uv sync --extra cpu`,
`uv run … download_model.py`, and the `winget`/`npm` calls can **fail and the script keeps going, exiting 0**.
`install.ps1 -Native` then sees `$LASTEXITCODE -eq 0`, passes its guard, and **pins `CLAUDIBLE_RUNNER=win`** —
so the user gets a green "Done" on top of a **half-installed, non-functional voice stack**.

**Why it matters.** This is on the brand-new native-Windows path that has *never run on real hardware*. A network
hiccup mid-`git clone`/`uv sync` is exactly the kind of thing that happens on a first install, and the failure
mode is the worst kind — **silent**. A partial `.git` also breaks the idempotent rerun guard (`-not (Test-Path …\.git)`),
so a second run can't self-heal (related: §3.9-style git-clone cleanup).

**Recommended fix.** After each native command add an explicit `$LASTEXITCODE` check, e.g.:
```powershell
git clone --depth 1 https://github.com/remsky/Kokoro-FastAPI $kokoro
if ($LASTEXITCODE -ne 0) { Remove-Item -Recurse -Force $kokoro -EA SilentlyContinue; Die "Kokoro clone failed" }
...
uv sync --extra cpu;  if ($LASTEXITCODE -ne 0) { Die "uv sync failed" }
```
and gate `install.ps1`'s runner-pin on the voice setup *actually* succeeding (or pin the runner regardless but
print an honest "voice not provisioned — terminal will still work" instead of "Done"). **This is the single most
valuable fix in the report** because it protects the path you're about to smoke-test.

### 3.3 — File-descriptor leak in `pollHooks` on read error · `main.js:995–996` · **Bug · Low-Medium**

**What.**
```js
const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(st.size - s.offset);
fs.readSync(fd, buf, 0, buf.length, s.offset); fs.closeSync(fd);
```
If `fs.readSync` throws, `fs.closeSync(fd)` never runs and the FD leaks. The surrounding `try/catch` swallows the
error but **not** the descriptor. `pollHooks` runs every **80 ms** per tab, so a persistently-failing read would
accumulate FDs and eventually hit the process limit.

**Why it matters / severity.** The trigger is narrow — `statSync` just succeeded and the file exists, so
`readSync` rarely throws — which is why it's **Low-Medium, not High**. But it's a genuine latent leak on the
hottest loop in the app, and the fix is one `try/finally`:
```js
const fd = fs.openSync(p, 'r');
try { fs.readSync(fd, buf, 0, buf.length, s.offset); } finally { fs.closeSync(fd); }
```

### 3.4 — `pollAgentTokens` spawns a subprocess for idle tabs · `main.js:962–983` · **Optimization · Medium**

**What.** Every **8 s**, for *every* live tab with a session id, it spawns `agent-tokens.sh` (a real subprocess
that scans the subagents dir). It does this **regardless of whether the tab is doing any agent work** — but the
all-time agent-token total it reads only changes *while agents run*. For an idle tab the spawn is pure waste.

**Why it matters.** Subprocess spawn (fork/exec + a bash + a Node helper + a directory walk) is the most
expensive thing in these pollers. With several idle tabs open you're paying it continuously for a number that
isn't changing.

**Recommended fix (with a caveat).** Skip idle tabs — but make sure you still get the *final* update when work
finishes. Guard on the busy flag and force one trailing poll on the `busy → idle` transition:
```js
if (!rec.busy && rec.agentTokSettled) continue;   // poll while busy + once after it goes idle
```
(Don't just `if (!rec.busy) continue;` or the meter can miss the last increment when a swarm finishes.)

### 3.5 — `pollHooks` 80 ms cadence runs full-tilt on idle tabs · `main.js:986–1002` · **Optimization · Medium**

**What.** The hooks poller `statSync`s every tab's `hooks.ndjson` every **80 ms** (12.5×/s/tab) whether or not
anything is happening. The 80 ms is *intentional* — the comment notes it keeps a finished reply (and TTS) low-latency.

**Why it matters / tradeoff.** It's the highest-frequency FS load in the app. Adaptive backoff (e.g., drop idle
tabs to ~400–500 ms and snap back to 80 ms the moment a line arrives or the tab goes busy) would cut the idle
baseline ~5× **without** hurting the latency-critical case. **Implement carefully** — the whole point of 80 ms is
low TTS latency, so the "snap back to fast" trigger must be reliable (tie it to `rec.busy` / a fresh `status`
event, not just to new hook lines).

### 3.6 — Two `win.send()` calls lean on `try/catch` instead of the `win &&` guard · `main.js:947, 998` · **Consistency · Low** *(downgraded)*

**What & correction.** The scan flagged these as **high-severity crash bugs** ("unguarded `win.webContents.send`").
**On reading the code, both are *inside* the poller `try { … } catch {}`** (lines 941–955 and 990–999), so a
window-destroyed-mid-tick throw is **caught and swallowed — it does not crash.** I've **downgraded this to Low.**
The remaining merit is consistency: every *other* IPC send in the file uses the explicit `win && win.webContents.send(…)`
guard (e.g. line 979). Two spots rely on the `catch` instead. Aligning them (`win && win.webContents.send(…)`) is
a 2-character tidy-up that makes the intent explicit and avoids the catch silently eating a *different* error on
that line. **Not urgent.** (Logged here mainly to record that the "crash" framing was checked and is wrong.)

### 3.7 — No in-flight coalescing of identical `runScript` spawns · `main.js` (several sites) · **Optional · Low**

**What.** Rapid actions or poll ticks can spawn the same `(script, args)` concurrently. A small in-flight map
(mirroring the existing `cloneInFlight` pattern) would dedupe these. **Low probability, low payoff** — listed for
completeness; only worth doing if you're already touching the poller code for §3.4/§3.5.

---

## 4. Considered but **not** worth fixing (accepted risks / false positives)

The verify pass dismissed 32 candidates. The ones worth recording so they're not "re-discovered" later:

- **Unsigned downloads + `irm … | iex` / `curl … | sh`** (`setup-win.ps1`, `setup.sh`) — *real, accepted.* These
  fetch over **HTTPS** from first-party hosts (GitHub releases, HuggingFace, astral.sh) and exactly mirror the
  vendors' own documented install lines and the existing, shipped `setup.sh`. Adding SHA-256 pinning for
  `whisper-bin-x64.zip` / `ggml-base.bin` is a reasonable **future** defense-in-depth, **not** a finish-line blocker.
- **Voice services bind `0.0.0.0` on WSL** — *real, by design + documented.* WSL2's NAT isolates it; the README's
  Security section already calls out mirrored-networking. The **native-Windows** path already binds `127.0.0.1`
  (the `CLAUDIBLE_BIND_HOST` bridge), which is the right call there.
- **Peer-handle URL from a collaborator-writable branch** — flagged *critical* by the scanner, **dismissed**: the
  join window's **origin lock** (verified, §5) already constrains it to `*.trycloudflare.com`/localhost.
- **No auth on the local STT/TTS ports** — accepted; loopback/WSL-NAT scoped, standard for a local voice stack.
- **Unpinned Kokoro `git clone` / deprecated `String.substr` / unused `voiceHealth()`/`toHostPath()`/`detect()`
  runner methods** — trivial or intentional (the runner methods are part of the documented `Runner` contract).
- **`@electron/rebuild`, `patch-package`, `node-pty+1.1.0.patch`** — checked: **all still actively used**
  (rebuild is the install.ps1 source-build fallback; the patch applies on install). *Not* cruft.
- A handful of "unhandled rejection / respawn race / orphaned tunnel" bug candidates were dismissed as
  **structurally unreachable** on closer reading.

> **Net:** the only accepted-risk worth a line in your release notes is the **unsigned voice downloads** (HTTPS,
> first-party) — everything else is either already defended or genuinely a non-issue.

---

## 5. Security controls verified **correct**

The audit confirmed these are implemented properly (worth knowing for confidence + the release writeup):

- **Resume-token compare is timing-safe** (`crypto.timingSafeEqual`).
- **Join-window origin lock** — only `*.trycloudflare.com`/localhost, navigation + popups blocked.
- **Approval gate with a 90 s timeout** — prevents an unapproved guest from pinning resources indefinitely.
- **Workspace isolation + paused state** — prevents cross-workspace session/diff leakage.
- **Guest page ships a strict CSP** (the scanner's "no CSP" claim was a false positive).
- **Cross-engine parity of the ported Node helpers** — byte-identical to the old python3 (your `port-parity.sh`).

---

## 6. Recommended order of work (if/when you act)

1. **§3.2** — `setup-win.ps1` failure handling. *Do this before the Windows smoke test* — it's the difference
   between "voice didn't install" being **visible** vs a silent green "Done" on a broken stack.
2. **§3.4 + §3.3** — idle-tab subprocess skip + the `try/finally` FD close. Cheap, real, low-risk; do them together.
3. **§3.1** — guest-token hardening (cookie + IP-bind + shorter grace). The biggest *security* item, but its
   trust model makes it a fast-follow, not a blocker.
4. **§3.5** — adaptive `pollHooks` cadence, *carefully* (don't regress TTS latency).
5. **§3.6 / §3.7** — tidy-ups; bundle into whichever poller change you make.

**Bottom line:** no blockers, no critical security holes, the new installer code has one robustness gap worth
closing before you smoke-test it, and there's a cheap cluster of poller optimizations. This is a clean
finish-line state.
