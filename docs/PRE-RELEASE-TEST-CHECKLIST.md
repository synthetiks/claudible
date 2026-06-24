# Claudible — Pre-Release Test Checklist

The multi-OS smoke pass before a wider release. Tiers are ordered fastest-and-highest-coverage first.
Reference for the full per-backend acceptance: [SMOKE.md](SMOKE.md).

**Status going in:** Linux/WSL backends proven, all 3 OS installers build in CI, the python3 port is
byte-parity green, and the finish-line audit fixes (3.1–3.6) are merged. What's left is *running it on real
hardware* per OS.

---

## TIER 1 — WSL regression smoke  *(do first — fastest; re-validates 4 of the 6 audit fixes)*

The poller + share changes (3.3–3.6, 3.1) live in `main.js` / `share/server.js`, which the proven **WSL**
backend also runs — so this re-checks them on the easiest-to-run path.

```powershell
npm start          # WSL backend (CLAUDIBLE_RUNNER unset)
```

Pass = all still work, nothing crashes:
- [ ] **Telemetry ticks** (ctx % / cost / tokens) — proves 3.6 (`win &&` guard)
- [ ] **Agent-token meter** updates during a swarm, then settles when idle — proves 3.4
- [ ] **A reply streams + TTS fires with no added lag** — proves 3.5 (adaptive cadence)
- [ ] **Close the app mid-turn** → clean exit, no crash — proves 3.3 / 3.6 on shutdown
- [ ] **Idle CPU/IO lower** with a tab sitting open — the 3.4 / 3.5 win

## TIER 2 — Co-work rejoin  *(the only live test for 3.1)*

1. [ ] Click **Share**, open the invite link in a second browser/device, approve the guest.
2. [ ] **Background / lock** the guest tab so its WebSocket drops.
3. [ ] **Within 15 s**, foreground it → it should **silently auto-rejoin** (no re-approval).
4. [ ] *(adversarial, optional)* copy the `?r=` token, open from a **different network** → should get
       **denied: revoked** (the IP-bind working).

## TIER 3 — Windows-native  *(the new-platform gate + 3.2)*

Get the app either way:
- **From CI:** download the `claudible-windows-latest` artifact → unzip → run the NSIS `.exe`.
- **From source:** `git clone … ; cd claudible ; .\install.ps1 -Native`

Then walk **SMOKE.md** (10 points). Watch the 3 known-risk spots:
- [ ] **#1 Terminal** — `claude.exe` spawns in the embedded pty (ConPTY)
- [ ] **#3 Voice-out / Kokoro `:8880`** — **likeliest failure** (espeak-ng on Windows); check
      `%USERPROFILE%\.claudible\logs\kokoro.out`
- [ ] **#5 / #6 Agents / diff** — the `wsl/*.sh` fleet via git-bash
- [ ] **3.2 check:** force a failure during `install.ps1 -Native` (e.g. drop wifi mid-`uv sync`) → it must
      print **"uv sync failed — Re-run"** and **not** report "Done" / pin the runner.

## TIER 4 — macOS  *(when a Mac is available)*

- [ ] Download `claudible-macos-latest`, right-click → **Open** (unsigned), **or** `npm start` from source.
- [ ] Walk SMOKE.md (10 points). Voice deps come from Homebrew (`brew install cmake ffmpeg espeak-ng`).

---

## Distribution plan
- **Linux:** a tester runs Tier 1-style smoke on a Linux desktop (auto-selects the posix backend).
- **macOS:** a tester runs Tier 4.
- **Windows:** self-test, Tier 1 + 2 + 3.

**Definition of "smoke-passed":** the happy path works on a real machine per OS. This is a strong signal, **not**
exhaustive coverage — early public users will still hit OS-version / distro / antivirus edge configs.
