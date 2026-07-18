# Changelog

All notable changes to Claudible are documented here.

## [Unreleased]

The master-debug release: a 63-agent audit of the whole codebase confirmed 42 defects; this ships fixes for 39
of them (2 were verified fine-as-designed; 3 remain owner decisions, below).

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
