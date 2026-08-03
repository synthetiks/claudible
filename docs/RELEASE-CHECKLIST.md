# Release checklist — current as of 0.9.3

The steps below are **human-gated** — they need real hardware and an outward-facing tag push that triggers a
public CI release build, so they are intentionally NOT automated. Do them in order. (Version references here
go stale by design; trust the shape, verify the numbers against HEAD.)

## 0. Confirm CI can actually run (do this FIRST)
`build.yml` is the only thing that produces an installer, and a `v*` tag is the only thing that triggers a
publish. If Actions cannot allocate a runner, the tag pushes cleanly, no workflow runs, and **no Release and
no installer are ever created** — a silent non-release with a tag sitting in the repo. Check
`gh run list --limit 5`: every job failing with **zero steps executed** is the runner-allocation signature
(billing / spending limit / Actions disabled), not a code failure. This was the repo's actual state for a
week in July 2026. Resolve it before tagging, then push a no-op commit and confirm a green run.

A `workflow_dispatch` run of `build.yml` is the cheap full rehearsal: it builds all three legs and skips the
publish job (tag-gated), so it validates the workflow and the artifacts without releasing anything.

## 1. Confirm the version number
`package.json` and the `## [x.y.z]` heading in `CHANGELOG.md` must both carry the version you are about to tag.

What is actually enforced, so you know which mistake is loud and which is silent:
- **`v*` tag vs `package.json` — hard-fails the build on EVERY leg** (`build.yml`, "Check tag matches
  package.json version"; it runs before anything is produced, so a mismatch costs a re-tag, not a bad artifact).
- **`CHANGELOG.md` heading vs the tag — NOT gated, and fails silently.** The publish job extracts the
  `## [<tag version>]` block; if no such heading exists it degrades (deliberately, via `|| true`) to a bare
  "See CHANGELOG.md" link and the release still publishes. Nothing turns red. Verify it by eye in §5.
- Anything parked under `## [Unreleased]` is **not** in the extracted block, so it never reaches the release
  page. Move it into the version section before tagging.

## 2. Green gates (re-run locally right before tagging)
CI runs the first two on every push to main (`test.yml`), but see §0 — do not treat a check mark you have not
seen as evidence. Run them locally regardless; the third is CI-only otherwise.
- `npm test` — full suite: **50 test files** as of 0.9.3 (the runner prints its own `x/50 files` aggregate);
  on Windows expect the documented environment-only failures (bash-dependent files), on Linux expect 0.
- `node test/contract.test.js` — the pin count moves with every release (479 at 0.9.3); expect **0 failed**.
  On Windows, clone with LF intact — `.gitattributes` pins `*.js`/`*.html`/`*.sh` since 0.9.3, but an old
  clone from before that fix still shows phantom failures until re-checked-out.
- `npm run lint` — ESLint, expect zero problems.
- `shellcheck --severity=error -e SC1091 wsl/*.sh setup/setup.sh`.
- Not covered by any of the above: `renderer/index.html` (CSS/markup — no linter), `relay/worker.js` beyond
  an inertness assertion, and every packaged-install path (§3).

## 3. Hardware smoke (the coverage the code itself flags as thinnest)
These cannot be run from a dev/CI box; record a pass for each **in the roadmap's §2 verification ledger,
naming the build sha** (see `tools/PUBLIC-RELEASE-ROADMAP.md` in the dev repo — that ledger, not this file,
is the source of truth for what is hardware-proven).
- **Windows packaged install** (`docs/SMOKE.md`, 10-point) with the `win` runner — priority: #1 terminal
  spawn, #4 telemetry, voice on `:2022`/`:8880`, and **two tabs on ONE project** (both tabs' telemetry must
  move independently — the G7 class).
- **Linux packaged install** (0.9.3+): the AppImage launches (needs `libfuse2`), a session opens, and
  `~/.claudible/runtime/tabs/*/hooks.ndjson` goes non-zero (the B1 class). `ss -ltn` shows voice on
  `127.0.0.1:2022`/`:8880`, not `0.0.0.0` (the B2 class).
- **Self-update** on a real clone install: with an upstream commit ahead of HEAD, click **Update & restart** →
  confirm the pull, the npm-install branch (only when deps changed), and the teardown→relaunch cycle all
  complete and the app comes back on the new commit.
- **Two-machine live test** (`docs/TWO-MACHINE-TEST.md`) — both machines on the SAME commit and restarted
  first (build skew is shown on the badge; heed it).
- **(Only if deploying the relay this cycle)** the `relay/README.md` "Before you deploy" `wrangler dev` smoke —
  `relay/worker.js` has no automated tests.

## 4. Tag & publish (the one outward-facing, irreversible step)
Only after §0, §2 and §3 pass. The `publish` job in `build.yml` ships **the Windows `.exe`, the Linux
AppImage and the `.deb`** on a `v*` tag — the macOS `.dmg` deliberately stays a CI artifact (unsigned;
roadmap decision 1). The workflow is tag/dispatch-only — nothing about it is exercised by a normal push.

```bash
git tag -a vX.Y.Z -m "Claudible X.Y.Z"
git push origin vX.Y.Z
```

For an internal/testing release, flag it pre-release after CI publishes — this keeps it off
`/releases/latest` and out of the in-app update check:

```bash
gh release edit vX.Y.Z --prerelease
```

## 5. Verify the release
- GitHub Releases shows **three assets** (`.exe`, `.AppImage`, `.deb`) and the body contains the real
  `## [x.y.z]` CHANGELOG excerpt (not the "See CHANGELOG.md" fallback).
- No `.dmg` attached (stays CI-artifact-only until the signing decision).
- If this was meant to be a pre-release, confirm the flag actually shows on the release page.

## Known limitations (carried; see the roadmap for owners' decisions)
Windows installer unsigned (SmartScreen warns — roadmap B11); first-run voice provisioning downloads several
hundred MB without a consent prompt (roadmap B10); macOS unpublished pending the signing decision (B3);
packaged in-app auto-update is notify-only. The guest resume token in the WS URL is an accepted, mitigated
exposure (see `SECURITY.md`) with an HttpOnly-cookie migration deferred.
