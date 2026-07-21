# Claudible — the finish line

The release contract: every line below is DONE (verified as stated) or the app is not finished.
Verified-by legend: **[suite]** = automated test in `npm test` · **[probe]** = scripted check an agent
can run against an isolated copy · **[2M-n]** = step n of the two-machine manual script
(docs/TWO-MACHINE-TEST.md) — the only category needing humans.

## A. Install & first run
- A1. The README/SETUP one-liner installs on a machine with nothing but Windows + WSL2: clones,
  installs Node if missing, npm install, voice build, shortcut, launches. **[probe: isolated run + transcript]**
- A2. `install.ps1` re-run on an existing clone self-updates (clean tree) and never clobbers local edits. **[probe]**
- A3. System-check wizard: every row shows true state (node version-gated, voice by real file sizes,
  claude/gh sign-in), every missing dep has a working Install button or an exact copy-paste command,
  and one dep's failure text never erases another's. **[suite + probe]**
- A4. A failed/partial dependency install is recoverable from inside the app — no dead ends. **[probe]**
- A5. Uninstall (app + deps, keeping ~/.claudible data) → reinstall → all projects, sessions, names,
  and sync consent are back without manual repair. **[probe — the 2026-07-18 regression, incl. state
  living outside the app folder or being restored on rediscovery]**
- A6. First-run wizard completes start-to-finish with only clicks: check → connect Claude → first
  project → optional GitHub. Skippable at every step, resumable later. **[probe]**

## B. Projects
- B1. Create a blank (local) project — appears, becomes active, sessions work immediately. **[suite + probe]**
- B2. Add an existing folder (adopt) — never touches its git config unsafely, never rm -rf's anything
  it didn't create. **[suite]**
- B3. Turn a local project into a synced GitHub project from the ▾ menu (explicit consent, private
  repo, transcripts stay out). **[suite + 2M-1]**
- B4. Rename a project → renames the GitHub repo (owner), slug/transcripts frozen, collaborators'
  machines follow without a phantom duplicate. **[suite + 2M-2]**
- B5. Delete a project → busy-guarded, whole footprint trashed (recoverable), stays deleted across
  restarts and discovery, on every machine. **[suite + 2M-3]**
- B6. Invite a collaborator → they discover the project without a restart, clone it in-app, and land
  in a working synced project. **[2M-4]**
- B7. The active project, expanded trees, and every per-project session list never show another
  project's sessions or peers. **[suite]**

## C. Sessions
- C1. New Session always opens a fresh tab without stopping any running session; every open tab keeps
  running when you click away. **[suite]**
- C2. Sessions list is truthful: correct order (stable, drag-reorder), correct last-used times, no
  promptless stubs, named stubs visible. **[suite]**
- C3. Rename a session → converges to the same name on every machine (newest-wins), including while
  open, including the live session's title for guests. **[suite + 2M-5]**
- C4. Delete for me → gone locally, stays gone across syncs (unless the remote copy grew). Delete
  everywhere → gone for every collaborator, tombstoned forever. **[suite + 2M-6]**
- C5. A busy (mid-turn) session can never be killed by a switch, delete, sync reload, or project
  operation — every mutating path is busy-guarded by main's authoritative flag. **[suite]**
- C6. Busy/done indicators on rows always match reality (no stuck flair after esc/crash). **[suite]**

## D. Sync & collaboration (the invisible engine)
- D1. Session transcripts sync both directions via the orphan branch; imports are foreign-marked
  (trust boundary holds — a foreign transcript can never run with skipped permissions). **[suite]**
- D2. Title/metadata sync converges on every machine with no oscillation. **[suite]**
- D3. Divergence (same session continued on two machines) is detected, flagged once, resolvable
  either way, and the resolution sticks. **[suite + 2M-7]**
- D4. The LIVE session is excluded from sync writes on both sides while live. **[suite]**
- D5. Open sessions auto-reload when a sync updates them — never while busy or mid-typing. **[suite]**
- D6. Sync failures are visible (chip/toast), never silent, and self-heal on the next pass. **[probe]**
- D7. Machine A offline for a day → comes back → converges cleanly with no duplicates, no
  resurrections, no lost sessions. **[probe: simulated with a stale worktree]**

## E. Live sessions
- E1. Share live → link + presence advertised to collaborators (● LIVE badge on their side within **~5s**
  via the per-workspace beacon; sub-second if a presence relay is deployed). **[suite + 2M-8]**
- E2. Join from the badge → native joined tab in the joiner's cockpit: co-typing, shortcuts, tracker,
  chat, voice, roster all work with full parity. **[2M-9]**
- E3. Browser guest link works with approval gate, read-only mode, guest cap (enforced at admission,
  incl. grace seats), and the typist chip names whoever is typing. **[suite + 2M-10]**
- E4. One shared view: anyone's scroll pages the shared TUI for everyone (co-driving model); a
  read-only guest's gutter is inert. **[suite]**
- E5. A live session appears exactly ONCE in every sidebar: no duplicate rows, no out-of-sync chip on
  a live row, correct project, correct highlight. **[suite]**
- E6. The host can navigate anywhere (sessions, projects, new tabs) without guests seeing their
  private screens or the live session pausing/ending. **[suite + 2M-11]**
- E7. Ending the live session (button, tab close, project delete, app quit) tears down instantly for
  everyone: badge gone ≤2s on joined guests' machines, presence cleared with retry, no ghost "still
  live" anywhere. A crashed host ages out ≤2min. **[suite + 2M-12]**
- E8. A guest's reconnect (sleep/network blip) resumes their seat and name — no "(2)" ghosts, no
  duplicate roster entries, no stolen identity. **[suite + 2M-13]**
- E9. Exactly one host per session ever; a second Share on an already-live session refuses with the
  holder's name. **[suite]**
- E10. Attribution is always right: prompts credited to the actual typist (host or named guest) in
  history and context, on every machine, including at share-stop. **[suite]**

## F. Voice
- F1. Voice services provision on install, start on launch, and self-heal on next launch if killed;
  the wizard row reflects reality and can install/repair from the UI. **[probe]**
- F2. Push-to-talk and Talk work solo (STT in, TTS replies). **[2M-14]**
- F3. Live-session voice: host + joined guests hear each other; join/leave never doubles a roster
  entry; leaving a session drops its voice. **[2M-15]**

## G. Robustness & state
- G1. App state (registry, settings, consent, machine-id) survives reinstall/update — it must not
  live only inside the app folder, or must be restored on rediscovery. **[probe]**
- G2. No orphan processes: quit/tab-close reaps the full WSL-side tree on every path; no leaked
  pollers or intervals. **[suite]**
- G3. Every user-visible error is a human sentence with a next step — no raw codes, no internal
  command lines, no silent failures. **[suite grep-gate + probe]**
- G4. All three install modes (WSL, Windows-native, Linux/macOS from source) pass the suite's parity
  gates; node resolution works in every non-interactive shell. **[suite]**
- G5. A hostile collaborator name/title/transcript cannot inject into the UI, the shell, the model
  context, or the host's terminal. **[suite]**

## H. Docs & release
- H1. README + SETUP describe exactly what ships (no stale claims, no missing steps); the install
  one-liner in the README is the one that works. **[probe]**
- H2. CHANGELOG current; version bumped; tag + CI release artifacts build on all three OS targets. **[suite/CI]**
- H3. docs/TWO-MACHINE-TEST.md exists, is ≤15 minutes, and covers every [2M-n] above in order. **[this loop]**
