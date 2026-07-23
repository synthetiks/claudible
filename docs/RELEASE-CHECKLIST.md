# Release checklist — 0.9.1

The code/doc prep for 0.9.1 is committed (`package.json` bumped, `CHANGELOG.md` dated, docs reconciled).
The remaining steps are **human-gated** — they need real hardware and an outward-facing tag push that
triggers a public CI release build, so they are intentionally NOT automated. Do them in order.

## 1. Confirm the version number
`package.json` is set to **0.9.1** (minor bump: two new user-facing features — opt-in presence relay and the
clone-install self-update — plus a security-relevant guest-input-safety batch). If you'd rather ship an
incremental **0.9.2**, change `package.json` and the `## [0.9.1]` heading in `CHANGELOG.md` to match before
tagging — they must be identical or CI fails.

## 2. Green gates (re-run locally right before tagging)
- `npm test` — full suite (expect ~19s, 0 failures).
- `npm run lint` — ESLint.
- `shellcheck --severity=error -e SC1091 wsl/*.sh setup/setup.sh`.

## 3. Hardware smoke (the coverage the code itself flags as thinnest)
These cannot be run from a dev/CI box; record a pass for each.
- **Windows packaged install** (`docs/SMOKE.md`, 10-point) with the `win` runner — priority: #1 terminal
  spawn, #4 telemetry, voice on `:2022`/`:8880`. This is the "simplest, for most people" path and the
  least-exercised runner.
- **Self-update** on a real clone install: with an upstream commit ahead of HEAD, click **Update & restart** →
  confirm the pull, the npm-install branch (only when deps changed), and the teardown→relaunch cycle all
  complete and the app comes back on the new commit.
- **Two-machine live test** (`docs/TWO-MACHINE-TEST.md`) — both machines on the SAME commit and restarted
  first (build skew is now shown on the badge; heed it). Cover 2M-8 (see live ≤~5s), 2M-12 (end/quit clears
  ≤~5s), the guest **paste/copy/interrupt** fixes, and the build-skew badge.
- **(Only if deploying the relay this cycle)** the `relay/README.md` "Before you deploy" `wrangler dev` smoke —
  `relay/worker.js` has no automated tests.

## 4. Tag & publish (the one outward-facing, irreversible step)
Only after §2 and §3 pass. `.github/workflows/build.yml` builds/publishes installers on a `v*` tag and
**hard-fails if the tag doesn't equal `package.json`'s version**.

```bash
git tag -a v0.9.1 -m "Claudible 0.9.1"
git push origin v0.9.1
```

## 5. Verify the release
- GitHub Releases shows the Windows `.exe` attached and the body contains the real `## [0.9.1]` CHANGELOG
  excerpt (not the "See CHANGELOG.md" fallback).
- Linux/macOS artifacts were **not** manually promoted to the Release (they stay CI-artifact-only by design —
  `build.yml`).

## Known limitations shipping with 0.9.1 (owner decisions — see CHANGELOG [0.9.1])
No packaged in-app auto-updater (self-update is clone-installs only); packaged Windows forces the native
runner even on WSL2 machines; Linux/macOS packaged installers unpublished; macOS signing/notarization and a
native-Windows runtime smoke still open; presence relay ships inert. The guest resume token in the WS URL is
an accepted, mitigated exposure (see `SECURITY.md`) with an HttpOnly-cookie migration deferred.
