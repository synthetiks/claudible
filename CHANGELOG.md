# Changelog

All notable changes to Claudible are documented here.

## [Unreleased]

## [0.9.7] — 2026-08-07

A hardware-validation pre-release: 34 changes verified in code and by 691 automated checks (up from 491),
**none of them yet proven by a human on a real machine.** This build exists so the owners can run the
hardware smoke checklist against it. Treat every item below as "implemented and tested in CI" — not
"proven working" — until that pass lands.

**New**
- Sessions are never auto-created anymore. An empty project shows a "Create a new session" overlay and a
  session exists only when you click it and name it — the structural end of the phantom "New session" bug
  family, patched five times before this.
- Deleting is a designed flow: an in-app dialog with options per project kind (shared projects can be
  deleted from GitHub, deleted only locally, or archived), a trash icon next to Settings' close button,
  and Open/Delete trash buttons in Settings. "Discard" on a brand-new file in Diff Review now moves it to
  the trash instead of permanently deleting it.
- First run now asks before downloading the ~500 MB voice models, remembers a "Later", and verifies both
  model downloads against pinned SHA-256 hashes. Voice setup failure now offers a manual path and a
  Rescan button that detects a hand-fixed install.
- The wizard actively asks about connecting GitHub and won't finish until you connect or explicitly skip.
  ffmpeg has its own System-check row.
- Settings shows your version and build, a persistent chip appears when a newer release exists, and
  "you're on X · latest is Y" replaces guesswork. Crashes now write an always-on log under
  ~/.claudible/logs and a dialog names the file to attach to a bug report.
- Live-session roster redesigned: larger rectangular name badges, an always-visible kick button, a
  scrollable guest strip, "Chat" instead of "Group Chat", and the host is always labeled HOST. A red
  CO-DRIVE marker stays visible the whole time a co-drive share is running.
- Optional (off by default): commits made during a live session can credit everyone present as
  co-authors, via a hook that never overwrites an existing one.

**Fixed**
- The 0.9.6 speed fix now covers the WSL and Linux/macOS backends too — all three runners start their
  background shells the fast way, and WSL path lookups are cached instead of spawning a process per call.
- Repo names with dots or underscores (my_repo, next.js) now clone the exact repo named, on every path —
  invites and renames silently mangled them before. Name fields validate as you type and list exactly
  which characters aren't allowed.
- The browser guest page now checks it is being shown the session it was promised and warns on a
  mismatch — this check was believed shipped in 0.9.5 but had never actually been built.
- Reverting in Repo Review with two project cards open could check the wrong project's safety state;
  each card now acts on its own project. Reverting a second time warns that it replaces your one undo
  point — and that warning now survives an app restart.
- A broken script backend shows a persistent banner with a Retry button instead of failing silently or
  flashing a 2-second toast. Session names never show a stale guess — a changed session shows a neutral
  loading row until the confirmed name arrives.
- Hand-edits to an adopted project's .claude/settings.json get a fresh dated backup before Claudible
  overwrites them, instead of being silently lost. The settings drawer answers instantly from cache and
  never waits on the network; a failed skills/plugins scan keeps the last good list instead of showing a
  false "none found".
- Voice reinstall on Linux/macOS/WSL now stops running voice servers first (Windows already did), and
  the setup shell scripts joined the ASCII gate that protects the PowerShell ones.

**Known limitations**
- Everything above is CI-verified only. The hardware checklist (both-machine share tests, timing budgets,
  the new UI flows, a real my_repo invite) has not run yet — that is the point of this pre-release.
- The installer remains unsigned: SmartScreen will warn ("More info → Run anyway").
- macOS remains source-install only and has never been exercised on Apple hardware.

## [0.9.6] — 2026-08-03

Speed fix for native Windows. If sessions, names, sync or live-session status took many seconds to appear,
this is the one to install.

**Fixed**
- Every session read, sync and live-session check started a shell the slow way, loading your whole shell
  profile each time. On some machines that cost 3–7 seconds *per call*; on others it was unnoticeable, which
  is why it went unspotted. It now starts the shell the fast way.
- The live-session check ran every 1.5 seconds even when each one was taking 10+ seconds, so it never caught
  up. It now waits in proportion to how long the last one actually took.

## [0.9.5] — 2026-08-03

Three corrections to 0.9.4, found by verifying that release. Install this one rather than 0.9.4.

**Fixed**
- Switching to a project with no sessions could leave the sidebar showing a different project than the tab you
  were actually in — introduced in 0.9.4.
- A guest who clicked Disconnect was announced as "removed by the host", which the host had not done.
- A test that could only pass on Linux now passes everywhere (no effect on the app itself).

## [0.9.4] — 2026-08-03

Ten fixes, mostly to live share. A demo to a friend surfaced three problems with sharing that were worse than
they looked, and two more came from collaborator reports. Windows, Linux (AppImage + `.deb`) as before.

Still a test release — Linux has not yet been run on real hardware, and the public release will be `1.0.0`.

**Fixed**
- Sharing a live link while another session was already shared handed out the **first** session's link — guests
  saw a terminal the host had not chosen to share. It now refuses and says which session is already sharing.
- "View-only" could show as on while guests could actually type. The warning now describes the mode that will
  really be served.
- The view-only switch looked clickable when it was locked. It now looks locked and says why.
- The view-only switch could stay locked after a tunnel drop, with no share running.
- Clicking a project with no sessions yet opened a new tab every time, and the duplicate sessions that caused
  could make the spacebar stop working in the terminal.
- A guest who clicked Disconnect could rejoin without the host approving again.
- A guest could move the host's project while the host had paused sharing for privacy.
- Slow startup on some machines: two path lookups ran a full login shell on the main thread before the window
  appeared. On a machine with a heavy shell profile this was tens of seconds, every launch.
- The Settings drawer could hang on a slow or offline network, and its dependency checks are now cached.
- Voice setup that failed once retried its several-hundred-MB download at every launch. It now stops and waits
  for you to retry from Settings.

**Known limitations**
- Importing a GitHub repo whose name contains `.` or `_` is still refused rather than handled.
- Windows and macOS builds are unsigned; macOS is source-install only.

## [0.9.3] — 2026-08-03

Linux, for the first time: this release ships an **AppImage** and a **`.deb`** alongside the Windows
installer. It is a **pre-release** — the Linux build's first run on real hardware is happening against
these exact artifacts, so treat it as a test build, not a stable.

**Linux notes (read before installing):**
- The AppImage needs `libfuse2` (`sudo apt install libfuse2`) — many distros no longer ship it. The `.deb`
  needs no FUSE: `sudo apt install ./Claudible-0.9.3-amd64.deb`.
- You need a signed-in [Claude Code](https://docs.anthropic.com/claude-code) (`npm i -g @anthropic-ai/claude-code`, then `claude`) — the app embeds it but does not install it.
- Voice on Linux needs a one-time terminal step (`bash setup/setup.sh` from a clone) — the in-app installer
  is Windows-only for now.

**Fixed**
- Packaged Linux/macOS builds now write their per-tab state under `~/.claudible` instead of trying to write
  into a read-only install location.
- Voice services bind to localhost on native Linux/macOS instead of listening on the local network.
- Two tabs on one project no longer cross-write each other's telemetry (context %, agents, busy state).
- A portable Git installed without admin rights survives a settings change and a restart.
- Theme and collab-name preferences can no longer be silently lost on relaunch.
- Closing a tab during a sync reload no longer leaves an invisible `claude` process running.
- Stopping a share while someone is waiting to join now dismisses the approval prompt instead of stranding it.
- Importing a GitHub repo whose name the importer can't represent (dots, underscores) now refuses with an
  explanation instead of cloning the wrong repository.

<!-- Notes style, agreed 2026-08-02: bullets and one or two short paragraphs. The 0.9.1 entry below is a wall
     of prose nobody reads — write what changed for the person using it, put the reasoning in the commit.
     KEEP EVERY EDITORIAL NOTE ABOVE THIS LINE. build.yml extracts from `## [<version>]` up to the NEXT
     `## [`, so a comment sitting between two version headings lands inside the OLDER one's release body.
     (GitHub hides HTML comments, so it renders as nothing — but the raw notes carry it, and the next person
     reading them wonders why a release is explaining a version that shipped before it.)
     On 0.9.1's naming, which used to be noted here: 0.9.0 was prepared but never tagged, so its section was
     renamed to 0.9.1 rather than left as a second dated heading — 0.8.3 and 0.8.4 already sit in this file
     with no matching tag, and a third orphan would have made the history actively misleading. -->
## [0.9.2] — 2026-08-02

Two rounds of work on things that were quietly broken rather than visibly failing: several guards were
refusing correctly but saying nothing, so the app looked dead when it was actually protecting you. Those all
speak now. The rest is the project/session UX that had been on the list for a while.

**Fixed**

- Voice installs from the in-app button — three separate causes, including "install all missing" silently
  giving up after Git and never attempting the rest.
- A brand-new session no longer appears as a phantom draft over a project that already has sessions.
- Sessions that refuse to open now say why, and clicking one already open elsewhere jumps to its tab.
- The spacebar no longer dies after enabling sync on a project with an open tab.
- Switching sessions is quicker, and shows "Opening …" instead of a black rectangle.
- The setup check no longer opens on top of Settings and swallows your clicks.
- The ⓘ explainers no longer cover the field they are explaining.
- Voice on Linux/macOS skips a source build it never needed.

**New**

- **Import a GitHub project** — clone a repo you already have and work in it. Sessions stay private unless you
  turn sharing on yourself.
- **Join a live session before the host is ready** — click the moment it appears; you join automatically once
  their tunnel is up.
- **Connect GitHub** in the terminal's git menu, and a GitHub status row in Settings.
- Shared projects announce themselves instead of appearing as silent rows.

**Changed**

- Setup is three steps: System check → Claude → GitHub. It no longer creates a second project you did not ask
  for — one is already there.
- When the shell backend is unavailable, the app says so at launch instead of failing silently everywhere.

## [0.9.1] — 2026-07-31

- **The setup wizard connects GitHub for real.** The "Link GitHub" step used to print a `gh auth login`
  command for you to go run in a terminal yourself — on a packaged install (no terminal in sight, sometimes
  no `gh` at all) nobody ever connected. It's now a one-click flow like the Claude step: an Install button
  when the CLI is missing, a **Connect GitHub** button that shows your one-time code right in the wizard and
  opens the GitHub approval page, and a ✓ that flips by itself once you approve. Still skippable, as always.
- **Projects, sync and Repo Review no longer go silently dead when WSL is installed.** On native Windows,
  Claudible finds the shell its scripts run on by asking Windows for `bash.exe` — and on any machine with
  WSL enabled, the first answer is WSL's launcher, not Git Bash. Everything that needs a project then failed
  at the first step and gave up quietly: shared sessions never appeared, no project could be created, and
  Repo Review stayed empty, while the terminal and voice worked perfectly and nothing on screen said why.
  Claudible now checks that what it found is really Git Bash, considers every candidate rather than the
  first, and can locate it from Git itself for installs in unusual places (scoop, Chocolatey, portable).
  Found on a collaborator's machine whose sync had never once worked.
- **Hooks work on every Windows machine, not just some.** Claudible writes its telemetry, identity and
  status-line hooks as commands for Claude Code to run, and Claude Code hands them to whichever shell the
  machine uses. The path was quoted, which cmd.exe accepts and PowerShell rejects outright as a syntax
  error — so on a PowerShell box every hook failed before it started, and Claude Code only logged a
  non-blocking status code. The visible cost: no live telemetry, no status line, and the assistant never
  received the note telling it which machine and live session it was on. Found on a collaborator's machine
  where the hook log had been empty since install. The command now uses a form both shells accept.
- **The setup wizard reopens itself when a required component goes missing.** It used to be strictly
  first-run: skip it once and the flag was written forever, so anyone who later *lost* a required tool (an
  uninstall, an antivirus quarantine, a failed update) was stranded — Claudible could still detect the
  missing tool and still had a working Install button for it, but nothing in the interface could reach
  them. Now a blocking component reopens the System check at step 1 on the next launch, using the same
  rule that decides whether you can continue. It stays skippable, runs after startup so it never delays
  the app, and stays quiet if the check itself can't run.
- **Native-Windows voice actually works now (three separate bugs).** The v0.9.1 install smoke on a real
  Windows box found the whole native voice path dead, in layers: the setup script could not be *parsed*
  (below), then `uv sync` demanded a C++ toolchain that this path exists specifically to avoid, and finally
  speech-to-text started but failed every transcription because `ffmpeg` was never installed on Windows
  (Linux gets it from apt, macOS from brew; this script simply never did). All three are fixed, and both
  services are now verified running natively: Whisper on `:2022`, Kokoro on `:8880` with its full voice list.
- **Native-Windows voice setup no longer dies before it starts.** Windows PowerShell reads a BOM-less
  script as ANSI, not UTF-8 — so an em dash inside a string in `setup-win.ps1` decoded into a curly
  closing quote, the parser's quote state flipped, and every packaged install failed voice provisioning
  at parse time ("The string is missing the terminator"), caught by the 0.9.1 release smoke. All
  PowerShell scripts are pure ASCII now, and a new suite gate (`test/ps1-ascii.test.js`) fails the build
  if a non-ASCII byte ever lands in a `.ps1` again.
- **Plan usage in the top bar.** A gauge next to the context meter shows how much of your Claude 5-hour limit
  you have burned — a 4-cell battery that fills as you consume, with the same `used_percentage` figure `/usage`
  prints, coloured green through red as you approach the cap. Click it for both windows and their reset times.
  It reads the limits Claude Code already reports, so there is nothing to configure; it stays hidden for API-key
  users, whom the upstream data never covers, and a missing reading leaves the gauge alone rather than painting
  a reassuring 0%. Your own limits only — a guest never sees the host's, and yours stay visible while you watch
  someone else's session.
- **Command palette (Ctrl/Cmd+Shift+P) replaces the command pill bar.** The old bar showed 5 of 15 commands and
  hid the rest behind a horizontal drag nobody discovers, while costing a full row of terminal height. The
  palette searches every command at once (subsequence matching — `cmp` finds `/compact`) and can also open
  Settings, Project History, a new session or the share flow, which a pill never could. Deliberately **not**
  Ctrl+K: that is readline's kill-to-end-of-line, and this app is a terminal.
- **Design-system pass.** 19 ad-hoc font sizes collapse to one 8-step scale, six motion durations and three
  easings to one motion system, and per-element shadows to a single elevation ladder — anchored on the sidebar's
  own values so the surface tuned most did not move. Selected projects and sessions now read as *selected*
  rather than *alarmed*: the Claude-orange and red washes are replaced by a neutral blue-silver that does not
  compete with any theme's accent.
- **Sidebar and chrome overhaul.** One-line session rows with icon flairs and hover detail, a dark-glass pane,
  and a single `--chrome` token so the top bar and sidebar match by construction in every theme instead of by
  coincidence in one. Seamless top edge, tidier share dock, quieter scrollbars.
- **Live sharing: a failed presence push is no longer silent.** With a dead network, a revoked `gh` token or a
  rate limit, the host saw "Sharing live" and believed they were joinable while no peer ever saw them — there
  was no retry and nothing on screen. The heartbeat now retries promptly instead of waiting its full cadence,
  and a standing chip appears if publishing keeps failing. The failure message also names the real cause: it
  used to blame cloudflared for what were GitHub authentication problems.
- **Live sharing: a peer with a skewed clock can no longer lock a session.** Presence timestamps are written by
  one machine and read by another; a clock running fast made a claim look permanently fresh, which could refuse
  every later claim on that session with no expiry able to clear it. Such stamps are now distrusted past a
  generous tolerance, in both the arbiter and the sidebar.
- **Live sharing: a live session reaches collaborators within seconds, not minutes.** The presence timestamp was
  stamped by the WSL backend's own clock (`date +%s`), but every peer ages that stamp with the app's clock — and a
  WSL2 clock silently drifts *behind* after a Windows sleep/resume, so a freshly-shared session read as
  minutes-stale and its join-on-hover button never appeared until WSL re-synced. The stamp (and the one-host
  arbiter) now carry the app's own clock — the exact one every reader uses — so write and read can no longer
  disagree, whichever way a machine's backend clock has drifted.
- **Live sharing: advertise on the shared session's project**, not whichever tab happens to be in front — a host
  focused on a local project silently failed every presence write. An empty presence read now clears peers
  instead of resurrecting them, and a "going live…" row can no longer strand.
- **Accepting a shared project no longer opens as a phantom "New session" draft.** Accept-invite imported the
  team's transcripts in the background but returned "done" before they hit disk, so the app switched into a
  project whose session list was still empty and resolved to a blank draft — which nothing reconciled once the
  import landed a moment later. The import is now awaited before the switch, and a strictly-gated safety net
  re-points a still-untouched auto-opened draft to the newest real session if any project's sessions arrive
  while you're sitting on it (never a draft you opened deliberately or typed into, never onto a session already
  open in another tab). **On launch, too:** the boot tab is created before the restored project is even known and,
  unlike every other navigation path, never resolved its session — and no sync event fires for an already-synced
  project, so nothing reconciled it. Boot now resolves the restored project's real session in place, behind that
  same guard.
- **Fixes.** The session options ▾ no longer jumps when pressed (the global press animation was overriding the
  centring). Toasts sit over the terminal, hug their text, and no longer stretch to a fixed width. A live row
  keeps its hover timestamp hidden, since the Live pill already claims that space.
- **A dead test assertion revived.** One beacon check passed an un-invoked function as its condition, so it had
  silently rubber-stamped itself since the day it was written — while guarding the very watchdog that stops a
  "going live…" row stranding. The behaviour it covers was correct; only the guard was dead.

**Known limitations (owner decisions, not defects — carried forward):** packaged installs have no in-app
auto-updater (the new **Update & restart** button is for git-clone installs only; packaged builds still get
a notice-only "newer release" toast). A packaged Windows build always selects the native `win` runner even
on a WSL2-equipped machine. Linux/macOS packaged installers remain CI-artifact-only (not published) pending
the packaged-runtime-dir work. macOS `.dmg` signing/notarization and a native-Windows runtime smoke pass are
still open. The presence relay ships **inert** (no default URL) — it is opt-in, self-hosted per team.

- **Renaming a session is no longer auto-committed by an expand/collapse click.** Clicking a project's
  caret while a rename box was open detached the sidebar list, blurring the input and silently saving the
  half-typed name; the caret's in-place repaint now defers while a rename is open, exactly like the full
  sidebar rebuild already did.
- **Presence stamps are shell-quote hardened (defense-in-depth).** The values written into the live-presence
  git commands are now escaped at the interpolation site, not just validated by charset — so a future field
  can't reintroduce a quoting break.
- **11-agent master audit — every confirmed finding fixed, verified by the full suite.** Highlights: a
  guest's Ctrl+C on a non-Latin layout could fall through as a raw interrupt and KILL the host's running
  turn (fixed layout-independent, both guest page and cockpit, matching the paste fix); Backspace/Cut on a
  joined live tab injected erase keystrokes into the host's input (guarded); native-peer paste bypassed the
  paste sanitizer entirely (sealed — it now rides the same typed frame browser guests use); a transient
  presence read painting as "nobody is live" erased good rows on every peer (failed reads are now
  distinguishable and never painted); a relay announce racing a stale git read flickered peers to "gone"
  (timestamp-reconciled); ref-lock contention between the plumbing and worktree fetches surfaced as fake
  sync errors (retried); orphaned "going live…" stamps blocked re-claims for 60s after every UI stopped
  showing them (arbiter TTL now matches the UI); the "jump to my live session" path bypassed the eager
  presence fetch (joined); per-workspace probe chains now die at quit; the CI e2e boot-smoke red (predating
  today) was a test bug, fixed and verified against real Electron.
- **"Update & restart" button for clone installs.** The drift chip now carries the action: one click pulls
  --ff-only, streams npm install when the lockfile changed, refuses dirty trees with the evidence (never a
  silent skip, never an auto-stash), names the one case that needs the full installer (an Electron runtime
  bump), runs the SAME teardown as a normal quit, and relaunches. Installer -NoUpdate persists an opt-out
  the button honors. The build-drift goose chase that ate this whole day is structurally over. **Update no
  longer pops a second GitHub login:** the button runs host-side git, whose credential store is separate from
  the WSL `gh` login every other feature uses, so a private repo prompted Windows' credential manager on an
  already-signed-in machine. It now reuses the gh token to authenticate the pull (over an HTTP auth header,
  token kept out of argv) — no popup; best-effort, so a public repo or a machine without gh is unaffected.

- **Realtime presence relay (opt-in) — "went live"/"ended" reach every collaborator in under a second.** A
  ~130-line Cloudflare Worker (relay/, free tier, deploy once with wrangler) fans presence frames out over
  one WebSocket per shared repo; GitHub push-permission is the publish gate, the verified login is forced
  into every frame, and repo names never appear in relay URLs/logs. Git stays the untouched source of
  truth: frames merge in as an instant preview, the beacon's authoritative reads reconcile moments later,
  and with no relay configured the entire layer is inert. See relay/README.md to deploy.
- **Build drift is now visible instead of a recurring goose chase.** Presence stamps carry the publisher's
  git sha, so a collaborator on a different build shows it right on their live badge; a persistent chip
  says "updated on disk — restart to run it" when a pull lands under a running app (git-clone installs had
  NO update signal at all); and the timing journal logs its own sha at boot, so every future latency report
  self-identifies its build.

- **One dead or slow project can no longer slow every other project's live detection.** All workspace probes
  shared one round that waited for the slowest — a workspace whose GitHub repo was deleted (or just slow)
  stretched every project's detection to ~10s. Each workspace now probes on its own independent chain with
  exponential backoff on failure; the probe is a bare bounded head-check (~0.9s) at a 1.5s cadence, and the
  bounded fetch happens only when something actually changed.

- **Presence is now worktree-free plumbing — going live AND ending are fast and, above all, consistent.**
  The live stamps/clears no longer touch the sync worktree at all: they commit directly against the object
  graph (rewrite live/, commit-tree, push) on their own queue lane. A stamp can no longer wait behind a
  running multi-second transcript sync (the journaled 2.5–3.9s outliers), and the app-quit clear can no
  longer die on an index.lock corpse a killed sync left behind — which used to leave peers watching a zombie
  "live" row for the full 120s TTL after closing Claudible. The gh author lookup is cached (10 min TTL),
  shaving ~1s off every script call. Measured stamp: ~1.8–2.2s incl. the GitHub push; click→peer-visible and
  end→peer-gone both land ~3–4.5s consistently. Proven against a real bare origin by
  test/presence-plumbing.test.sh (stale-base retry, non-destructive rebuild, lock immunity, arbiter, clear).
- **Going live is announced reliably and ~2× faster.** Fixed a race where the advertise call could fire
  before the share server finished binding and then silently never retry — the "going live…" stamp (and
  sometimes the whole advertisement) simply didn't happen. Presence work now also jumps ahead of queued
  transcript syncs, the stamp pushes optimistically (no pre-push pull on a quiet branch), the beacon's probe
  is a narrow fetch so a detected change is painted from already-local data with zero extra round-trips, and
  probes run in parallel across projects. The beacon now announces exactly once per branch change (its
  baseline used to advance only after a successful sync, so a busy workspace re-fired the announce every
  tick and kept the peer's queue permanently churning), and its presence read is a lock-free object-store
  read that bypasses the queue entirely — it can never wait behind a running multi-second sync. A rolling
  `runtime/live-timing.log` journals every stage so slowness reports come with numbers. Net: a live session
  is typically visible to every collaborator in ~3–5s of the Share click.
- **A guest's Ctrl+V now pastes the guest's own clipboard — never the host's.** The old paste interceptor
  matched the key by NAME ('v'), which any non-Latin keyboard layout bypasses; the chord then fell through
  to xterm as a raw ^V byte, and the CLI on the host answered it by pasting the **host's** clipboard into
  the shared terminal. Guest paste now rides the browser's native paste event (works in every browser, no
  permission prompt, layout-independent) as its own typed frame; the host wraps it in bracketed-paste marks
  exactly like its own paste, sanitizes embedded escape marks (no paste-block breakout), and the server
  strips any bare ^V from the keystroke channel — so no client, stale or future, can trigger a
  host-clipboard paste again.
- **Collaborators see a live session (and new synced sessions) in seconds, not minutes.** Everything shared
  rides one git branch, so main now probes that branch's head sha every ~2.5s per synced project (one cheap
  ls-remote round-trip — no fetch, no worktree lock, no GitHub API budget) and fires the existing
  sync/presence pipeline only when it actually moves — including for shared projects with no open tab,
  which previously never synced at all until you opened them. Going live is announced in two phases: a
  "going live…" row appears for peers the moment Share is clicked (before the tunnel finishes spawning) and
  flips to a joinable badge as soon as the tunnel lands. Renderer presence/title polls also survive a
  minimized window now (background throttling off).
- **A Windows+WSL live share now actually reaches remote guests.** cloudflared was detected (and installed)
  inside the WSL guest but launched from the Windows host — two different machines, so the System-check row
  said "ready" while every share silently degraded to a localhost-only link nobody could join. Detection now
  probes the exact binary the host will launch, the Install button lands it on Windows, a dropped or
  never-present tunnel self-heals in the background (immediately after an in-place install), and hosting
  without a public link shows a standing warning with a one-click fix instead of nothing.

### A live link works the first time you send it (July 24–26)

- **The link was revealed ~2.4s before its DNS existed — and the first click cached that for 30 minutes.**
  Share printed the `trycloudflare.com` URL as soon as cloudflared emitted it, but the hostname is not
  resolvable yet at that moment. Anyone who clicked in that window got NXDOMAIN, and `trycloudflare.com`
  publishes a **1800-second** negative-cache TTL — so one early click poisoned that guest's resolver for half
  an hour and the link stayed dead long after the tunnel was healthy. The URL is now withheld until the
  record actually resolves, and the tunnel is verified before the host is told they are live.
- **That verification was inert inside Electron, and it blamed cloudflared for its own failure.** The check
  used a fresh `dns.Resolver()`, which in Electron starts with no configured servers and throws
  `ECONNREFUSED` on every query — so it "failed" every tunnel, told the user to install cloudflared (which
  was already installed and working), and, worse, still issued the lookups that seeded the 30-minute negative
  cache it existed to prevent. It now sets explicit bootstrap resolvers, falls back to DNS-over-HTTPS, and
  treats a reachable tunnel as proof even when DNS is slow.
- **cloudflared is found where the Windows `.msi` actually puts it**, and a tunnel that fails to come up says
  what went wrong instead of leaving Share spinning.
- **A self-update no longer kills a live share silently.** The restart tore down the tunnel and left the
  presence record standing, so peers saw a joinable badge pointing at nothing.

### Sharing a link is view-only by default (July 24)

- **View-only is now the default, and turning it off says what that means.** A shared link previously granted
  keystroke access unless you noticed a toggle. It now ships read-only; granting control is a deliberate act,
  and the dialog spells out — in a warning that scales with what you are handing over — that a guest with
  control drives the real Claude Code session on your machine. The invite-a-collaborator flow (gated by
  GitHub repo access) is pointed to as the safer path for anyone you want to work with repeatedly.
- **A live link shares one session, not your history.** The guest page carried a session browser that let a
  visitor page through the host's other transcripts. It is gone. Guests also get a **Disconnect** button, so
  leaving is an action rather than closing a tab and hoping.
- **A revoked link renders as a real page.** It used to print the bare word "forbidden".
- **The tab holding the live link is visibly the one that is live**, instead of looking like every other tab.

### The guest page (July 25–27)

- **The terminal is pinned.** There was a second scrollbar outside it — a page-level scroll that moved the
  whole layout and confused every guest who found it. The frame no longer scrolls; only the terminal does.
- **The host's cost and token counters are gone from the viewer.** They are the host's billing, not the
  guest's business, and they read as the guest's own numbers.
- **The projects strip is gone** — one shared session does not need a project switcher.
- **"⟨name⟩ is typing…" means someone is typing.** It fired on scroll, on mouse movement, on any byte the
  browser sent. It is now gated on actual keystrokes into the terminal, and the same wording and placement
  now appear on the host side, so both ends describe the same event the same way.
- **A readable typing line, a thin near-invisible chat scrollbar, a grouped top bar, and a tighter terminal
  frame** — the typing state was a chip too small to read, the chat's scrollbar was a full-width slab, and
  the terminal sat inside noticeably uneven dead space.

### The share dock (July 25)

- **One button, not a button plus a redundant label plus a dead status dot.** The share icon moved into the
  button, the label above it was cut, and the "i" gave up its own row instead of crowding the label — which
  it had been overlapping by ~3px at a narrow sidebar width. The popover behind the "i" is larger, ranks its
  information (what a link exposes first, mechanics second), and the button now reads as the primary action
  it is.

### Sessions and the sidebar (July 24–29)

- **Switching to a project opens the session you last worked in.** It used to guess from transcript mtime,
  which picks whichever file Claude Code happened to flush last — routinely not the session you were in.
  The session you actually type in is recorded, and boot and project-switch both restore from that record.
- **Switching projects can no longer start a SECOND `claude` on a session already live in another tab.** Two
  processes on one session produced a modal that swallowed every keystroke — including spacebar — which read
  as "the terminal is frozen".
- **A project that already has sessions no longer opens as a blank "New session" draft** (and rapid clicking
  between sessions could leave two of those drafts behind).
- **Refresh session can no longer kill a different, mid-turn session.** The busy check ran in the renderer
  against the tab on screen, not the tab being refreshed.
- **The session list stops lurching when you switch projects.** Rows are now one height — **29px** — whether
  the project is selected or not (the tint already tells you which one is selected), and skeleton rows hold
  the list's shape while the real ones load.
- **Long session names truncate instead of squeezing the timestamp out of the row**, a joined session shows
  its name again rather than a bare dot, the new-session dialog's **OK** button works, and the inline rename
  field gets its width back — a draft row previously left **9.8px** to type in, with ✓/✗ buttons taller than
  the row.

### Claude Code, the palette and the meter (July 23–26)

- **The Claude Code button surfaces "update available" and can refresh a session in place**, so a new CLI
  version does not require quitting the app to pick up.
- **The command palette lists Claude Code's own commands — all 54 of them** — anchored to its trigger, with
  the dead space below the list (the panel stretching, not padding) removed.
- **The usage gauge is populated at launch.** The restore-on-boot path never ran: a temporal-dead-zone error
  swallowed by an empty `catch` left the gauge blank until the first live reading.

### Under the hood

- **The test suite runs end to end again.** The `&&` chain meant one stale assertion stopped every later file
  from running — 20 of 43 steps were never executing while the run still reported success. A discovery-based
  runner now runs all of them and reports an aggregate; the three stale assertions are repaired. **43/43.**
- **CI installs the dependencies the suite needs.** Without `ws`, `test/share-names.test.js` caught the module
  error and skipped its four deepest live-share parts while still printing "0 failed" — the green check was
  covering **16** assertions where it should have covered **43**.
- **Three shipped files had zero ESLint rules.** `share/replay.js`, `scripts/**` and `relay/worker.js` matched
  no config block, so `eslint .` reported clean on files it was not reading. They are linted now, and a guard
  fails if a tracked JS file ever again resolves to an empty rule set.
- Relay inertness is pinned by a test, and CONTRIBUTING covers all four install paths.
- **Settings stays clickable when the setup check reopens.** The wizard that returns when a required tool has
  gone missing could appear about two seconds after launch on top of an already-open Settings drawer, and its
  full-screen backdrop then quietly absorbed every click underneath — most visibly on the username field,
  which looked simply dead. It now waits instead: if Settings is open the check holds off and returns on the
  next launch, which it was always going to do anyway while the tool is still missing.

## [0.8.4] — 2026-07-19

Driven by two live reports ("the create flow won't let me invite anyone" and "sometimes a rename/name box won't
let me type") plus a 6-agent scan of the last 200 commits.

- **The three-tile New-project modal is back** — Local project / **Shared GitHub project** / Add a folder I
  already have (an owner decision, restoring what 0.8.2 removed). The shared tile now carries the same honest
  transcript-sync consent as the ▾-menu share flows (the old tile had none), and — new — **a project created
  shared syncs from birth**: session sync auto-enables and the sessions branch initializes at creation, exactly
  like an upgraded project, so it's invitable immediately (▾ → Invite collaborator…). GitHub name collisions are
  reported plainly before anything is created, and auth problems show the "connect GitHub first" hint only when
  gh is genuinely missing/signed out.
- **Typing into rename / naming / create prompts can no longer be silently stolen.** The renderer had ~15
  independent deferred "hand the keyboard back to the terminal" timers; whichever fired last won, so a box opened
  right after the wrong action sent keystrokes to the terminal — intermittently. One focus discipline now: a
  deferred terminal-focus never steals from an open modal or a focused text field, and the "Name this session"
  prompt reclaims the keyboard if the terminal grabs it while the prompt is open.
- **An open rename survives background repaints.** A sync event or the peer poll could rebuild the sidebar and
  destroy the input mid-keystroke (or silently auto-save a half-typed name via the native blur). Both repaint
  paths now defer while a rename is open — the same rule the active list has always enforced.

The master-debug release: a 63-agent audit of the whole codebase confirmed 42 defects; this ships fixes for 39
of them (2 were verified fine-as-designed; 3 remain owner decisions, below).

### Post-audit debug overhaul (July 19)
A second 10-agent audit — the last 100 commits, the installers, and the docs — surfaced 39 findings plus two live
user symptoms (spacebar not registering after a session switch; a mysterious "can't invite" failure). This pass
fixes them across a dozen commits, each pinned by tests:
- **The spacebar reaches the terminal after a session switch.** xterm delivers Space only via the native
  `keypress` event, so a Space that lands on a still-focused `role=button` sidebar row scrolled the sidebar
  instead of typing. Rows now activate on Space too, and switching a tab focuses the terminal synchronously.
- **Collaboration invites surface the real error and recover the owner.** A failed upgrade-to-repo showed
  "something went wrong — connect GitHub first" (the actionable 130-char message exceeded a 120-char cap, and a
  text sniff mislabeled it); the hint is now gated on a real auth flag, curated errors show in full, and the
  repo owner is recovered from the clone's remote so owner-less workspaces stop being an invite/rename dead end.
- **First run no longer races.** The onboarding wizard and the legacy "name your project" modal both fired on a
  fresh install, stacked, and stole keyboard focus; the wizard now owns first-run and its create-project step is
  reachable again.
- **Installers.** `install-claude.sh` finds a version-manager (nvm/fnm/volta/asdf/n) node; `install.ps1` requires
  WSL2, not just any distro; cloudflared and the voice-install lock validate by liveness/execution, not by name;
  whisper downloads fail with a friendly message instead of a raw stack trace.
- **Tests.** The `sessions-divergence` suite survives an ambient `CLAUDIBLE_WS_DIR` — it's green when run from
  inside Claudible, and a sourced script now resolves its own dir (a latent git-safety skip fixed too).
- **State durability.** The R4 settings/history migration is atomic and resumable (an interrupted run no longer
  strands history); `machine-id` writes atomically; a custom Windows workspace path is fully validated.
- **Live + cleanup.** Joining a live session at the tab cap reclaims a slot instead of dead-ending; a native join
  seeds its voice roster from the join handshake; a removed-in-Electron-36 code branch and a duplicated error
  string are gone.
- **Docs/comments.** The voice server RELAYS audio (it was wrongly documented as peer-to-peer signaling-only);
  the reverted resize experiment is recorded as reverted; pre-R4 storage paths corrected.

### Finish-line fix loop (July 18, evening — release-readiness register R1–R42)
A second full-fleet sweep (10 subsystem auditors against docs/FINISH-LINE.md) produced a ranked 42-defect
register; fixes land here one commit per register id, each pinned by a test.
- **R7 — quitting while hosting now truly detaches its presence-clear.** The entry further down claims the
  cleanup processes are detached; the detach capability existed but no call site passed it, so quitting could
  still kill the clear mid-push and leave you "live · Join" on collaborators' screens for up to 2 minutes.
  window-all-closed now sends a detached one-shot that survives app exit (the in-process retry loop is for
  app-alive ends only — its backoff timers can never fire in a dying process). Test-executed both ways.
- **R1 — "End this session" can no longer kill a mid-turn Claude silently.** The Command Center's ✕ (and any
  tab close) was the one mutating path with no busy guard. A busy close now asks first — same pattern as the
  live-shared-tab confirm, driven by main's authoritative busy flag so a crashed/esc'd turn can't false-alarm.
- **R6 — a joined live session's row can no longer vanish sidebar-wide.** Clicking into another project while a
  joined tab stayed open left its home tree's stale paint in place (trees only refill when empty), erasing the
  session everywhere until a manual collapse/expand. Tab switches across a live tab now repaint the trees.
- **R8 — the wizard's voice Install now actually starts Whisper + Kokoro on WSL/Linux/macOS.** It downloaded and
  built everything, reported "ready" — and started nothing, so the first Talk failed with a raw fetch error
  until the next full relaunch. The install path now starts the services the moment the build succeeds.
- **R5 (security) — the per-prompt context hook now neutralizes hostile `.git/config` values.** The app's shell
  scripts already refuse to let an adopted repo's config run commands (`_git-safe.sh`); the identity/repo-state
  hook — which runs `git -C <workspace>` on every single prompt — didn't, reopening the exact RCE class on a
  different runway. It now applies the same neutralization per child process, and the git-safe sweep gained a
  hooks/*.js edition so the class can't silently reappear outside the shell-script glob.
- **R33/R42 — the orphan-reaper gets real tests, the docs stop pointing at the old state location.** killtree.sh
  (the guard against the "(empty session)" orphan factory) now has behavioral coverage in the suite — a real
  process tree reaped, the recycled-pid guard proven both ways; the README describes where state actually
  lives. Plus docs/TWO-MACHINE-TEST.md: the 15-minute script for the one thing automation can't drive.
- **R28/R29/R34 — sidebar order, tree visibility, and the native-Windows voice button.** Dragging sessions no
  longer forgets where a joined session belongs; a collaborator live in a session you haven't synced yet shows
  up in that project's tree; the packaged Windows app gets the voice Install button every other install had.
- **R26/R27/R31/R39/R40 — joined sessions and invite-checking tell the whole truth.** A view-only mirror now
  says so (once, plus on its row) instead of silently eating keys; reconnecting re-arms voice instead of a
  mic button that lies; "Check for invites" says WHY it can't look when GitHub isn't connected; /clear on a
  mirror no longer zeroes the host's stats; an already-joined session never shows a stale Join badge.
- **R24/R25 — sync hygiene: cross-process temp files can't clobber each other, and a failed push no longer
  hides what the pull already brought in** (open tabs refresh from a half-successful sync instead of showing
  stale turns until the network recovers).
- **R35/R36/R37/R38/R41 — five more quiet or cryptic failures now speak.** A failed skill toggle, removing a
  guest, an unmapped revert error, a new session's name failing to share, and a folder that couldn't be
  trashed — each either said nothing or showed an internal code. All five now report plainly.
- **R32 — launching Claudible twice can no longer race itself.** A double-clicked shortcut booted a second
  full app — two voice-service owners fighting the ports, two sync engines on one branch. The second launch
  now just brings the running window to the front.
- **R22 — closing sessions on native-Windows installs reaps the whole process tree.** The Windows-native
  runner had no equivalent of the WSL tree-reaper, and the terminal's own kill can miss children — orphaned
  claude.exe processes piled up across restarts. Every kill now walks the tree at the OS level. (Needs the
  Windows smoke pass to verify live — this machine runs the WSL flavor.)
- **R10 — sync operations stop racing each other.** Presence beats, delete-everywhere, out-of-sync resolves,
  title renames and full syncs all ran the sync script concurrently against the same branch — one operation's
  pull could silently discard another's just-committed work while both reported success. Every operation now
  rides one per-project chain (heartbeats coalesce instead of piling up).
- **R15 — deleted projects stay deleted, in every shape.** Deleting an adopted project never recorded a
  tombstone (wrong kind), and deleting a repo before its stable GitHub id was known tombstoned by name only —
  either way the "deleted" project came back as a phantom invite. Tombstones are now kind-agnostic and
  backfill the stable id in the background.
- **R11 — a fork between your OWN two machines is detected, not silently overwritten.** Sessions you continue
  on two of your devices used to be invisible to divergence detection ("same login = my own edit"), so
  whichever machine synced last quietly destroyed the other's turns. Exports now carry a per-machine tag:
  your own devices get the same out-of-sync resolution flow collaborators always had (MK's call:
  per-machine tags over the one-machine assumption).
- **R23 — the setup wizard's "Create your project" step actually appears on a fresh install.** A boot-time
  guarantee (a default workspace always exists) made the step unreachable for every user — the wizard's four
  dots lied and everyone kept the placeholder project name. First runs now get the naming step; creating the
  real project cleans up the placeholder as designed.
- **R21 — node discovery covers fnm, volta, asdf and n — not just nvm.** Anyone using those managers had the
  original "empty session list" bug (their shell init never runs in the app's scripts). The resolver now
  sweeps every manager's install dir and uses the newest node it finds.
- **R20 — ending a live session hangs up your mic.** The host's own voice-room membership outlived every end
  path — the mic stayed hot after "End Session" and the next share started with a ghost member already in the
  room. The one shared teardown now leaves the voice room too.
- **R17/R19 — the last two raw-error surfaces speak human.** A failed Claude Code install dumped npm's raw
  "npm ERR!" noise (now: real next steps for permission/network failures); a voice transcription/speech
  failure returned the raw exception ("TypeError: fetch failed" — now: "the voice services aren't running —
  use Install/Repair on the Voice row, or restart Claudible").
- **R9 — one interrupted sync can no longer wedge syncing forever.** A git write cut off mid-flight (timeout,
  sleep, force-quit) left a lock file that nothing ever cleared — every later sync failed silently until
  someone hand-deleted a file they'd never heard of. Locks older than a minute now self-heal at the start of
  every sync; a genuinely running git is never touched.
- **R12 — invites always target the repo's real owner.** A collaborator clicking "Invite collaborator…" used
  to fire the invite at their OWN GitHub namespace (whoever was signed in), silently hitting a same-named repo
  of theirs or reporting success on a 404. The owner is now explicit, and a non-owner gets the honest answer:
  ask the owner to invite.
- **R13 — "Sync now" can no longer export the hosted session mid-write.** With a second tab mid-turn in the
  same project, the busy tab's session id silently replaced the hosted session's in the sync exclusion — the
  transcript guests were watching got copied to the branch while Claude was still appending to it. The
  exclusion now takes every live writer at once.
- **R16/R18/R30 — live-join and installer errors reach you as sentences, never internals.** A crashed join
  toasted the raw JS exception; two of the three install-error surfaces still showed the raw "Command failed:
  wsl.exe …" dump; a declined/dead joined row painted bare wire codes (" — full"). One shared filter now guards
  every install surface, joins fail through the human-error map, and denial codes read as real explanations.
- **R14 — live-session reconnects stop giving up on you.** Retry counters accumulated for the joined tab's
  entire lifetime (the 9th failed dial *ever* was permanent death with no rejoin control anywhere), and the
  browser viewer retried a long-dead resume token forever — even a reload couldn't escape it. Now: a
  successful connect resets every counter, exhausted retries drop to a quiet 30-second lifeline that
  self-heals the moment the host answers, a twice-refused resume token falls back to the normal approval
  flow, and a dead joined row grows a ↻ Reconnect button.
- **R2 — sharing consent tells the truth, and "Invite someone…" asks before publishing.** Inviting from a local
  project used to create the GitHub repo with no dialog at all, and the sync consent claimed transcripts "stay
  OUT of the repo" while enabling the very machinery that commits them. Both flows now show the same honest
  disclosure the collaboration modal always had.
- **R3 — accepting a project invite now actually turns session sync on.** The modal promised "sessions still
  sync with the team", then left sync off — the invited collaborator saw an empty-looking project until they
  found a second consent menu item nothing pointed at (today's onboarding confusion, root-caused). Accepting is
  the consent; the first sync kicks immediately.
- **R4 — your projects, settings, consent and history now survive a reinstall.** They lived inside the app
  folder (`<clone>/runtime/`), so "delete the folder and re-clone" — the documented uninstall, an
  update-by-reclone, an antivirus quarantine — silently wiped the project registry, every sync consent and
  every session title (the July 18 reinstall data loss, root-caused). Durable state now lives at
  `~/.claudible/app/` with a one-time automatic migration; per-tab runtime stays in the clone on purpose
  (the bash writer and the app's pollers must derive the same path).

### Finish-line follow-up (July 19)
- **Live-share resize handling: the experiments were reverted.** A round of host/guest resize-independence work
  (fill / floor / pan the joined mirror) was tried across several iterations and then removed entirely — it broke
  rendering. The joined mirror is back to its original, stable shrink-to-fit behavior: a host resize triggers only
  Claude's own redraw for the new width, which both sides see identically. (No fill/floor/pan behavior ships.)
- **Joining a live session no longer "moves" it into whatever project you were browsing.** The joined tab now
  scopes the sidebar to the session's home project, the same way opening any local session does — the third
  and final sighting of the pinned-row-under-the-wrong-header confusion.

### Session tabs tell the truth
- **Switching projects can no longer re-scope your sidebar to a project your tab never entered** — a refused or
  failed switch now rolls everything back, not just the tab. This was the live root of "my project shows the
  other repo's sessions".
- **A failed session-list read no longer looks like "you have no sessions"** — the sidebar keeps the last good
  list and retries instead of blanking (the "where are all my sessions" class, fixed at all three layers).
- A guest clicking a project — or you clicking sign-in — can no longer kill a mid-turn Claude (the last two
  unguarded respawn paths). Deleting a project mid-clone/rename no longer strands an orphaned GitHub repo.
- Turn stats land on the right history entry (new-session tabs mis-attributed them cross-tab); fast turns no
  longer drop their subagent tokens from the meter; Speak reads *this* tab's reply, never another tab's.
- Orphaned Claude processes can't survive a tab close anymore (freeze-then-walk + session sweep), and the
  scripts they ran on now use your real node, not a stale system one — together with the sync stub filter now
  matching the app's own definition, this closes the "(empty session)" phantom-multiplication machinery.

### Live sessions
- **"End Session" reliably un-advertises** — the everyday end path skipped the retry-hardened teardown whenever
  a share link was also on ("I ended it but they saw live for minutes", the surviving path).
- **A joined live session can no longer vanish from the sidebar** while still streaming — it renders in its
  home project's tree when you're working elsewhere.
- Quitting while hosting really clears your presence now (the cleanup processes are detached — they used to be
  an unenforced assumption). The guest cap can't be overflowed through the reconnect grace window. A hosted
  session can no longer be overwritten or foreign-marked by a background sync mid-share.
- Host/guest build skew is surfaced as a toast on join instead of failing as a mystery. The browser viewer's
  scroll gutter finally pages the shared terminal. The sidebar no longer flickers on every 45s presence beat.
- Ctrl+Shift+I opens DevTools again, so "clicking X does nothing" is self-diagnosable.

### Install & voice
- Model downloads verify their bytes (>100MB floors + wipe-and-retry) at every layer — a truncated download
  used to read as "voice ready" forever with no recovery path. Voice installs take a lock so a relaunch can't
  race an orphaned installer's cleanup. cloudflared is validated by actually running it.
- The install one-liner stops blaming your antivirus for network/clone failures — each failure mode gets its
  own message. Packaged builds now check GitHub for a newer release once per launch and tell you (notice-only).
- Deleting a project trashes its whole footprint (transcripts + sync worktree included, all recoverable) —
  they used to leak forever and haunt a re-created project at the same path.

### Still owner decisions (not code)
- No real auto-updater (the notice is the honest minimum); packaged-Windows always forces the native runner
  even on a WSL-equipped machine; the Linux/macOS packaged runtime-dir landmine (neither installer ships yet).

## [0.8.2] — 2026-07-17

A reliability release: live-session collaboration now shows the truth, quickly — plus the security and legal
fixes from the pre-beta audit.

### Live sessions show who's live, and clear the instant it ends
- **When a teammate ends a live session, everyone sees it end — right away, and everywhere.** Before, the "● LIVE"
  badge could linger for minutes after a host stopped, and only cleared when you clicked the session. Three
  separate things were wrong: (1) the badge only tracked the project you were *actively* in, so a session going
  live or ending in a project you were merely looking at froze until you clicked into it; (2) the host's "end"
  could silently fail to publish — a network blip at the wrong moment left you advertised as live until a timeout,
  and closing the shared tab or deleting the shared project didn't stop it cleanly; (3) if you'd *joined* the
  session, your own connection knew the host was gone within a second or two, but the sidebar ignored that and
  waited on the slow sync. All three are fixed: every open project's badge stays current, ending is reliable and
  immediate, and a joined session clears in ~1–2 seconds. A hard crash (the one case nothing can clean up) now
  clears in about two minutes instead of five.

### One kind of project
- **Creating a project no longer asks "local or shared repo?"** Every project starts as a plain private folder —
  the "Shared repo project" tile is gone. When you actually want it on your other devices or want a teammate in,
  use the project's ▾ menu (*Sync across my devices* / *Invite someone*): the same consented flow as before, with
  the same "creates a **private** GitHub repo — your transcripts stay out" confirmation. Nothing is created on
  GitHub until you say so, ever. Invites, discovery and already-synced projects behave exactly as before; folders
  you *adopt* still never offer sync (publishing someone's existing repo is not our call to make).


### The model can no longer describe your repo from memory
- **Claudible now injects the live git state of your project into the model's context on every prompt**: branch,
  short commit, `package.json` version, up-to-date/ahead/**behind-origin** status, and the last commit subject —
  with an explicit instruction to never state "which version / what's shipped / is it done" from memory or the
  conversation summary. In a multi-machine, multi-collaborator, auto-syncing setup the repo genuinely moves under
  a long session, and a model answering from a 50-turn-old snapshot confidently reported a *released* project as
  having open bugs. Same cure as the machine-identity line: re-present the truth every turn instead of hoping the
  model remembers to check. Local-only git reads (never a fetch) — no network on the prompt hot path; when the
  local clone is behind origin, the line says so loudly and tells the model to `git fetch` before making claims.
  Commit subjects are collaborator-authored, so the line is sanitized like every other injected field.

### Security & legal
- **Third-party licenses now ship with the app.** The installer bundles a handful of MIT-licensed libraries
  (ws, node-pty, xterm), and their licenses now travel with it in `THIRD-PARTY-LICENSES.md`, as those licenses
  require. Enforced by the test suite so it can't silently fall out of the build.
- **The live-session guest cap is now enforced at admission, not just at connect.** With approval on, a backlog of
  approvals could seat more than the 8-guest limit; it's now re-checked the moment each guest is let in.

### Fixed
- **A clearer error when "Install" needs admin rights.** On first run, the System-check installer runs with no
  terminal, so on a machine without passwordless `sudo` the package install failed and unhelpfully reported "no
  apt/brew" — which was false. It now tells you exactly what to run yourself. The normal (passwordless / root)
  path is unchanged.

### Docs
- **An "Uninstalling" section**, covering what a Windows uninstall intentionally leaves behind (your projects and
  the voice models) and how to reclaim it, plus how to stop the background voice services.
- **The full-transcript sync is now spelled out.** Turning on collaboration commits each session's entire
  transcript — including anything Claude read — into the private repo's history for collaborators to see. The
  in-app modal already said this; the README and SECURITY.md now do too.

## [0.8.1] — 2026-07-12

Two security fixes you should take, and the end of a sidebar bug we chased for ten rounds.

### Security
- **Adopting a folder could run code from that folder.** When you point Claudible at a project you already have, it inspects the folder with `git`. Git can be configured — *by the folder itself*, in a file that travels inside it — to run a command of its choosing during ordinary, read-only-looking operations. Claudible already had a neutralizer for exactly this, and already used it everywhere else it touched git; the "adopt a folder" path was the one place it was missing, which is also the most likely place for a folder you didn't create to arrive. It's now applied there, and in every other script that runs git. **If you've adopted a folder you got from someone else — a template, a zip, a repo you cloned from anywhere you don't fully trust — this is the fix to take.**
- The invariant is now enforced by the test suite across the whole tree, rather than by a hand-written list of scripts to remember. A hand-written list is how the gap happened.

### Fixed
- **An apostrophe in your Windows or Linux account name broke every session.** If your user folder was something like `C:\Users\O'Brien\`, Claudible couldn't launch a single Claude session — and said only "node-pty unavailable", which pointed nowhere. Every session, project, diff and clone command was silently aimed at a path that didn't exist.
- **A session could sit in the sidebar wearing a "working" marker forever.** If a turn ended in any way other than finishing cleanly — you pressed <kbd>esc</kbd>, the session died, Claude Code crashed — the sidebar never found out, and the row kept telling you it was busy indefinitely. The app's *actual* record of what's running always knew better (it's what stops a busy session being deleted or synced mid-turn); the sidebar simply kept its own, weaker copy. Now there is one record, and the sidebar reads it.
- **The mid-turn marker is quiet again.** A running session is marked with the small pulsing dot the sidebar already used elsewhere, instead of repainting the whole session title red — which shouted, and which put a red title next to a green **● LIVE** badge on the same row.
- **A project you renamed and then deleted came back.** Deleting a project remembers it by GitHub's permanent id now, not by the name it had before you renamed it — which is a name GitHub no longer reports, so the two never matched and the project reappeared as a fresh invite on the next launch.
- **macOS: closing a tab left the session running.** The guard that stops Claudible killing an unrelated process reads a file that only exists on Linux, so on a Mac it never confirmed the process and never cleaned anything up — on every tab close and every tab switch. A leftover session holds its conversation open and forces the next resume to fork it, which is where "(empty session)" entries come from. *(Fixed in code; still unverified on real Mac hardware.)*
- A deleted project's sync state is now dropped from memory along with its other caches.

### Docs
- **"Share live" tells your collaborators, and now the docs say so.** In a synced project, sharing a session live also publishes the invite link to the project's shared branch — that's how a teammate sees the **● LIVE** badge and can click **Join** without you sending anything. It also means anyone with git access to that repo can read the link. Nobody gets in without your by-name approval, but you should know it's there. To share with exactly one person, use **Share** and hand them the link yourself.
- Releases now carry their changelog section as release notes, instead of publishing an empty body.

## [0.8.0] — 2026-07-10

A hardening pass with **one new behavior**: renaming a project now renames its GitHub repo. Everything else is a lot of quietly-wrong things made right — the sidebar in particular now tells the truth. Every change ships with an executable test, and the whole tree has an ESLint + shellcheck gate, a real-Electron boot smoke test, and a per-OS packaging check running in CI on every push.

### Renaming a project renames its GitHub repo
- **Rename a project and the GitHub repo is renamed too.** It used to change only the label on the chip. Your **conversations are never touched**: the project's internal slug — which names its folder and every Claude transcript — stays frozen, so only the GitHub/display identity moves. The local `origin` remote is repointed, so syncing no longer leans on GitHub's redirect.
- Renaming a repo **you don't own** (a project someone invited you to) renames it locally and tells you plainly that the GitHub repo was left alone. Projects that merely *point at* a folder you already had are never renamed on GitHub.
- **A project you already have is no longer re-added as a phantom "invited" duplicate.** Claudible now recognises your repos by GitHub's permanent id rather than by name. This also fixes a long-standing bug for anyone who had **renamed a repo on GitHub outside Claudible** — it used to reappear as a second, ghostly copy of the same project on every launch.

### The sidebar tells the truth
- **The white bar on the session you just left is gone.** It meant "still open in a background tab", but it read exactly like a stale *selected* highlight. Session rows now carry only the vocabulary we actually use: green for live, amber for draft, a soft wash for the row you're on.
- **A brand-new project no longer shows someone else's live session, or a phantom `(empty session)`.** A joined live session now stays in the project you joined it from, and a new, untyped session shows once — as the draft row it is.
- **Switching projects and sessions no longer flickers or blanks the list.** The sidebar paints the new project's rows immediately, in the order they'll settle in, instead of clearing to empty and then reshuffling.
- **The session you're looking at always has a row.** If a session turned out to be unresumable (a collaborator deleted it) and Claude started a fresh one, the tab you were sitting in could vanish from the sidebar entirely.

### Sync and invites land without a nudge
- **Synced changes show up when they arrive.** You no longer have to click to another project and back before a pulled session, commit or revert appears. Projects you have expanded but not selected update in place too.
- **A project you were invited to appears without restarting.** Claudible re-checks for invites when the window regains focus, and the New-project dialog has a **Check for invites** button. The "invited" tag on the chip is now legible.

### Safety
- **A failed clone can no longer delete a folder that was already there.** The rollback that drops a half-finished clone had only one check — "is there a `.git` here?" — so a directory holding your own files sailed past it, the clone failed on the non-empty target, and the rollback removed your work. It now refuses a non-empty target outright and only ever removes a directory it created itself.

### Your sessions were running the fallback hooks (the big one)
- Claudible runs its scripts in a non-interactive login shell, where **nvm's `node` is not on `PATH`** — and four scripts that call `node` weren't compensating for it. On a machine whose Node came from nvm, that meant: every session silently staged the **degraded bash hooks instead of the Node ones**; **"Export conversation" wrote an empty file**; and the System Check reported **Node.js as "missing" and Claude as "not signed in"** — on a machine that had both. All fixed; a build-time check now fails if any script calls `node` without resolving it first.
- The System Check now reports an installed-but-**outdated** Node as outdated, instead of hiding it as "missing".

### Security
- **A repository you *adopt* can no longer run commands on your machine.** A hostile `.git/config` in a folder you open — via keys like `core.sshCommand`, `core.fsmonitor` (which fires on the every-4-seconds Project History diff) or an `ext::` remote — was arbitrary code execution just from opening the project card. Every git call Claudible makes now neutralizes the command-executing config keys.
- **A folder whose name contains a quote, a backslash or a control character is refused with a clear message** instead of half-creating the workspace and then failing to record it (which left the folder on disk, owned by nothing). Legitimate unusual paths — spaces, unicode, `$`, `;` — keep working.

### Your data survives a crash and tells the truth on failure
- **`settings.json` is now written atomically.** It holds every session title, your collaborator name, the permission mode and the effort level; a crash mid-write used to leave a torn file that reads back as *empty* — a silent first-run. Same tmp-and-rename the workspace registry already used.
- **The trash is bounded.** Deleting a project moves the whole folder to `~/.claudible/trash`, which nothing ever emptied. It's now swept (30-day age + 2 GB cap, oldest first).
- **Deleting a project that fails to move now says so** instead of reporting success and orphaning the folder — and deleting a session no longer forgets its custom name when the delete didn't actually happen.
- **Script failures are surfaced, not disguised as empty results.** A checkpoint, diff, transcript-export or session-list script that crashes used to look like "nothing here"; it now reports the failure, and every script call has a timeout so a hang can't wedge the UI.
- **Reverting a change while a turn is finishing can no longer corrupt a checkpoint.** Worktree writes (checkpoint snapshot/restore, diff revert/discard) are serialized per project, so a Stop-time snapshot can't capture a half-reverted tree.

### Multiplayer & voice
- **Per-person voice volume survives a reconnect.** The level you set for someone was silently reset by any WiFi blip, because their voice identity was re-minted on every reconnect; it's now stable across a resume.
- **The voice roster no longer shows someone twice** during a reconnect.
- **Guest capacity, chat history and the presence roster no longer grow without bound** on a long-lived public link.
- Clearer error messages throughout: an out-of-sync project mid-sync no longer tells you to "wait for the turn to finish", and raw internal error codes no longer leak into the UI.

### Under the hood
- New: ESLint + shellcheck gates, a static wiring contract (proves the DOM/IPC/script seams still line up), a real-Electron boot smoke test (catches a renderer crash before you open the app), and `electron-builder --dir` on Windows/Linux/macOS — all in CI.
- Removed dead code (a retired tab strip and its 11 call sites, unused runner methods) and de-duplicated the workspace-directory resolution that had been copy-pasted across twelve shell scripts into one.
- The **Linux terminal keeps its safety net.** node-pty has no Linux prebuild, so the app falls back to a second module at runtime — which was installed only by a single line of CI config. Any Linux build made anywhere else shipped without it, and a failed build of the primary module would have left the terminal dead with no fallback. `dist:linux` now provisions it itself, and a test fails if that ever stops being true.
- The whole suite passes under a clean git config, and every fix in this release is covered by a test that fails when the fix is reverted.

## [0.7.0] — 2026-07-03

### Session history grew up — and is now ON by default
- **Live multiplayer feed:** the per-prompt history streams to connected guests (full log on join, per-entry updates live) — a joined cockpit shows "Session History · from the host". Same privacy rules as the terminal mirror: private workspaces never leave the machine.
- **"Changes: 3 files (+42/−10)"** on every entry (per-file breakdown on hover), computed when the turn settles.
- **The first prompt is revertable** (a checkpoint now seeds at session start, not after the first full turn), and entries authored on another machine hide their Revert button (their snapshots live in that machine's clone).
- `sessionHistory` **defaults on**; explicit off still respected.

### The model knows who's talking (multiplayer identity)
- Every turn now tells the embedded Claude **who typed the prompt** (host vs a named co-driving guest), **which machine** it's on (stable machine-id + both hostname views), and **which Claudible flavor** is running (WSL / native Windows / Linux). No more addressing the host while a guest is driving, or stale machine identity after a synced transcript.

### Session switching fixed (the "empty session" bug)
- The resume fallback can no longer mistake a tab-switch **kill** for a resume **refusal** — the thing that minted multiplying "(empty session)" stubs.
- Killed tabs' WSL-side processes are now **actually reaped** (ConPTY kills never crossed the WSL boundary; zombies survived for days), including a startup sweep for crash leftovers — and each session generation gets its own runtime dir so a zombie can never pollute the live tab's telemetry.
- Promptless stub sessions are hidden from the session picker and refused by sync in both directions.
- A slow workspace clone can no longer stomp the session you just clicked.

### Permissions you can trust
- A permission-mode change that fails to save **says so** (and the registry write is now atomic) instead of silently reverting on relaunch.
- The status bar always shows the active mode (`perms: ask first / auto-accept edits / bypass`).
- The native-Windows runner now prints the collaborator-session sandbox notice instead of sandboxing silently.

### Agents cockpit
- Every agent tile shows **which model runs it** (fable 5 / sonnet 5 / opus 4.8 …), read live from the agent's transcript.

### Public-beta hygiene
- SECURITY.md rewritten to match the shipped app (real network-surface map, the actual permission model, private vulnerability reporting); README/SETUP/docs scrubbed of private-repo instructions and stale "pending" claims; Linux window icon + "Git for Windows" label fixed off-Windows.

## [0.6.0] — 2026-07-02

A big feature + polish release: a full session-history/revert system, a visual redesign, and a large security & reliability pass.

### Session History + one-click Revert (new, ships behind the `sessionHistory` setting)
- A per-prompt **activity feed** in the Repo Review drawer — who drove each turn, when, on which machine — built on a single append-only event log.
- **Git-backed per-prompt checkpoints** with a **one-click Revert** (and an Undo): roll the working tree back to the code as it was going into any of the last 10 prompts. Reversible — it snapshots the current tree first, and never touches gitignored files or your commits.

### Redesign
- **Soft-seam UI** — regions separate by stepped background shades instead of hard borders; chips became quiet filled pills.
- **Frameless "blackboard" terminal** — the terminal reads as the app's own surface, not a card in a card; sleeker command bar + tighter spacing.
- **Live Agents cockpit** — watch a subagent/workflow swarm think in parallel: type-hued tiles, each with a live "current tool" line, over a telemetry hero (running/done/tokens). The parallelism a bare terminal can't show.
- **Elevated all 6 themes** — vivid, mutually-distinct green/blue accents and deeper contrast, WCAG-validated (ink ≥ 15:1, accents ≥ 4.5:1). Fixed themes where green and blue had collapsed into one color.
- **Live runtime identity** injected into the model's context each turn (which machine/user, live-session state) — so a transcript synced from another machine no longer confuses the model.

### Security & reliability
- **Live share:** a kicked guest can no longer regain access via a still-valid resume token; presence now clears on the workspace you actually advertised on; host-controlled peer strings are escaped in the UI; relayed voice frames are size-capped.
- **Session history:** co-drive prompts are attributed to the guest who typed them (not the host); a stale checkpoint ref is cleared when the setting toggles.
- **Voice:** STT/TTS calls now time out instead of hanging ~5 min on a stuck local service; the mic-blocked state surfaces in embedded browsers.
- **Sync/diff:** the diff is bounded by bytes (multibyte diffs no longer vanish); a deleted workspace's debounced push is cancelled; the out-of-sync resolve targets the right workspace.
- **Terminal:** an unfocused text selection no longer shows a stray grey highlight band.

## [0.5.4] — Frictionless install

Making a fresh install "paste one line and go," to production standards.

### Install
- **No compiler, no Python, no Visual Studio Build Tools.** `node-pty` — the one native module — ships ABI-stable **N-API** prebuilts that load under Electron unchanged, so the forced `electron-rebuild` step was a no-op left over from node-pty's pre-N-API (0.x) days — and the *sole* reason the install pulled in a multi-GB C++ toolchain (and, via node-gyp, Python). Removed it; `install.ps1` now just verifies the shipped prebuilt for your CPU arch is present. Proven safe: the npm-published prebuilt is **byte-identical** to the binary this app already runs on under Electron 42. (A source build stays available as `npm run rebuild` for the rare arch with no prebuilt.)
- **Self-bootstrapping one-liner.** The install command installs **Git for Windows** via winget if it's missing (refreshing PATH in-session) and lets you **choose the install folder** (Enter for the default) — one paste, with no prerequisites beyond WSL2 + a signed-in Claude Code.
- **Antivirus quarantine self-diagnoses.** Some antivirus engines false-positive on `install.ps1` and quarantine it; the installer now detects the resulting gap and prints plain-English recovery (allow the folder → `git restore install.ps1` → re-run) instead of a cryptic "file not found," with per-AV steps in SETUP.md.

### Cross-OS portability (the multi-OS conversion)
- **The runtime script fleet no longer needs `python3`.** The 8 helper scripts shelled out to `python3` for their JSON transforms (session list, transcript, diff, workflows, agent-tokens, plugins, skills, sync-titles). All 9 transforms were ported to Node (`wsl/*-tool.js`), so the scripts now need only Node — which already runs the app and the hooks. This unblocks the native-Windows backend (Git for Windows ships no Python) and drops a prerequisite for the terminal/telemetry/agents/workspaces path on **every** OS. (The optional local **voice/TTS** stack — Kokoro — still uses Python; `setup.sh` provisions it. That's a separate, opt-in concern from the core app.) The port is **byte-faithful**: `test/port-parity.sh` diffs each new Node helper against the original `python3` across 14 deliberately-nasty fixtures (emoji/astral surrogate escaping, CJK, malformed JSON lines, conditional keys + ordering, binary diffs, multi-commit logs, base64 with BOM+control chars, a git-fixture title-read, cross-engine cache) — 14/14 identical under both node 18 and the shipping node 22. (Removed 441 lines of inline Python.)
- **One-click installers via electron-builder.** A packaging config (`package.json#build`) + CI matrix (`.github/workflows/build.yml`) produce a Windows NSIS installer (you pick the folder), a Linux AppImage/deb, and a macOS dmg — no git clone, npm, or build toolchain for end users. `asar: false` keeps the bash scripts + Node helpers + hooks readable on disk (they're executed by PATH). The Linux target is **built + layout-verified locally** (electron 42, node-pty bundled, the right files included/excluded); Windows/mac artifacts build in CI.
- **Native Linux + macOS backends.** A `Runner` seam routes every OS-coupled call through `runners/{wsl,posix,win}.js`; the Posix backend is live-tested on Linux (runScript + a real node-pty spawn). macOS shares it (one documented non-UTF-8 diff caveat tracked for when the dmg ships).
- **WSL-free native-Windows path (authored, smoke-gated).** `install.ps1 -Native` provisions native Windows Claude Code + the prebuilt voice services (`setup/setup-win.ps1`: the A0-proven `whisper-server.exe` with no compiler, + Kokoro on CPU torch) and pins the `win` runner. Download URLs + zip layout + the npm package are verified against live sources; the PowerShell is AST-parsed clean. The end-to-end native install + voice runtime still need a Windows smoke test (`docs/SMOKE.md`) — the WSL path remains the proven default.

## [0.5.3] — 2026-06-26
- Fixed session-sync setup failing on native Windows ("could not set up sync", missing sessions) — the same literal-`/c/…` path root cause as 0.5.2, one level deeper in git's config.

## [0.5.2] — 2026-06-26
- Custom workspace folders land where you chose them on native Windows (a `C:\Games\…` pick no longer becomes `C:\c\Games\…`): paths now cross the MSYS boundary in mixed `C:/…` form.

## [0.5.1] — 2026-06-26
- Desktop shortcut is created reliably on every install; Claude-connect detection works when native Windows keeps credentials in Credential Manager; clone failures surface a real error instead of silence.

## [0.5.0] — 2026-06-25
- **Cross-device workspace sync**: make a local workspace synced (and shareable) in one click, GitHub-backed; fast one-call discovery of your synced workspaces on any device. Engine live-tested against real GitHub.

## [0.4.0] — 2026-06-25
- **First-run Get-Started wizard**: connect Claude → pick a workspace → connect GitHub, shown once — replacing the cold open.

## [0.3.1] — 2026-06-24
- Fixed the first real native-Windows install crash (CreateProcess error 193): `claude` now resolves to a runnable `.cmd`/`.exe`, not npm's extensionless shim.

## [0.3.0] — 2026-06-24
- **Claudible ships as a prebuilt Windows installer** — double-click `.exe`, no clone/npm/PowerShell — while the git-clone path stays for devs, Linux, and terminal users.

## [0.2.0] — Hardening & Polish

A correctness, security, and UX pass across the whole app.

### Security & integrity
- **Live share never spawns a second tunnel.** `share:start` is now concurrency-guarded (single in-flight start) and defensively kills any prior tunnel before spawning, so a double-click or a collab/manual race can no longer orphan a public `cloudflared` tunnel that survives app exit.
- **Guest access can be revoked.** A guest's private reconnect token is now invalidated when they truly leave (after the rejoin grace window), so a departed guest can no longer silently auto-reconnect. **"New link" now fully resets access** — it disconnects current guests and revokes all old tokens, so re-inviting really does lock out everyone who had the old link.
- **Join is pinned to the tunnel host.** Joining a peer (whose handle comes from a shared, collaborator-writable branch) only accepts a `*.trycloudflare.com` (or localhost) origin, and the join window is locked against navigating away or opening popups — closing an arbitrary-origin / token-exfiltration vector.
- **Session bootstrap fails safe.** `session.sh` now aborts if it can't create or enter its session directory, instead of launching Claude with permissions disabled in the wrong directory.

### Reliability (bugs)
- Fixed a workspace/foreground-tab state desync that could read sessions/diffs for the wrong directory.
- Guarded terminal output sends against window-close races.
- Background pollers are now torn down on window close.
- Each diff revert/discard uses its own temp file (no more cross-action races).
- Settings now persist through a synchronous write path, closing the force-kill window.
- Voice/chat no longer replay old turns when a tab's session process restarts.

### Robustness
- Shell scripts report honest success/failure instead of silently succeeding; a missing `python3`/`gh` is surfaced as an error rather than masquerading as "empty".
- The local voice services start/health-check more robustly and recover from an occupied port.
- Synced session deletions (tombstones) survive a sync merge conflict.
- The renderer surfaces a toast on user-initiated failures instead of failing silently; removed a temporary diagnostics handler.

### UI
- Decluttered the top bar (per-session **tokens stay visible**; session **cost moved into the context-bar tooltip**).
- Unified the voice controls and naming everywhere: **Talk** / **Speak** / **Auto-speak**, with a real on/off toggle.
- The command bar now shows a visible scrollbar + arrows so all commands are discoverable; `/clear` is tinted as destructive.

## [0.1.0]
- Initial release.
