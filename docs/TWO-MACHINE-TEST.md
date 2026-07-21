# The two-machine test — ~15 minutes, two people

The one thing no automated suite can drive: real collaboration between two machines. Run this together
after both of you **pull + fully quit + relaunch** (a running app executes the code it started with — the
root cause of most "the fix didn't work" reports). Check items off in order; anything that fails goes back
to the fix loop with the step number as the repro. Steps map to `docs/FINISH-LINE.md`'s [2M-n] tags.

**Cast:** A = the project owner (host). B = the collaborator (guest). Both signed into Claude Code + GitHub.

## Setup & sync (2M-1 … 2M-7)
1. **[2M-1]** A: create a blank project → ▾ → *Sync across my devices / Invite someone*. The consent dialog
   must say transcripts get committed. Accept → private repo appears on GitHub.
2. **[2M-4]** A: ▾ → *Invite collaborator* → B's GitHub login. B: accept on GitHub, then in Claudible
   *Check for invites* → the project appears → *Add shared project* → clone lands, **and sessions sync
   without any further toggle** (the accept modal's promise).
3. **[2M-5]** A: rename a session. Within ~a minute B sees the new name — without clicking anything.
   B: rename a different session; A sees it. Rename the *project* on A → B's side follows, no phantom
   duplicate project appears.
4. **[2M-6]** A: delete a session "everywhere" → it disappears on B and **stays gone** after B's next sync.
   B: delete a different session "for me" → it stays gone on B across restarts, still exists on A.
5. **[2M-7]** B: quit Claudible, continue the same shared session on A meanwhile, relaunch B → B converges
   (updated transcript, no duplicates, no resurrections).
6. **[2M-2/3]** A: rename the project (GitHub repo renames with it, B follows). Then delete a *different*
   test project → busy-guarded if running, gone everywhere it should be, does not re-appear via discovery.

## Live session (2M-8 … 2M-13)
7. **[2M-8]** A: open a session in the shared project → *Share live*. B sees **● LIVE · Join** on that exact
   session within **~5s** (near-instant if the presence relay is deployed) — in the right project, exactly
   once (no duplicate rows anywhere, no out-of-sync chip on the live row). A "going live…" row may appear
   within ~3s and flip to joinable when the tunnel lands. *(If B's app is on an older build, the badge will
   also show a build-skew note — update B before treating a slow result as a regression.)*
8. **[2M-9]** B: click Join → native tab opens: co-typing works both directions, `/model`-style pills work,
   the tracker mirrors A's, the typist chip names whoever types, scroll pages the shared view for both.
9. **[2M-10]** A: send the web link to B (or open it in a phone browser) → approval prompt on A → approve →
   viewer streams. Kick the viewer → it says so and cannot silently rejoin.
10. **[2M-11]** A: while sharing, open ANOTHER project and a private session. B's mirror must stay on the
    shared session — nothing of A's private screen, tracker, or history leaks; the badge stays put.
11. **[2M-13]** B: drop the network for ~30s (wifi off/on) mid-join → the tab reconnects by itself (or via
    its ↻), same seat, same name — no "(2)" ghost in the roster, no permanent "offline".
12. **[2M-12]** A: End the session → B's badge and mirror clear within **~5s** (not minutes). Re-share → B can
    re-join. Then A: **quit the app entirely while sharing** → B's badge clears within ~5s again.

## Voice (2M-14 … 2M-15)
13. **[2M-14]** Each solo: push-to-talk transcribes; Speak reads a reply aloud.
14. **[2M-15]** A shares + both join voice from the live bar → both hear each other; B leaves the session →
    B's voice drops (no ghost member on A); A ends the session → A's mic light goes off (room released).

## Windows-native smoke (required once — R22 shipped statically verified)
15. On a **native-Windows (no WSL) install**: open two sessions, close one tab, quit the app → Task Manager
    shows **no orphaned claude/node processes** from Claudible afterward. Voice row shows an Install button
    and works after clicking it.

**Pass = release.** Anything that fails: note the step number + which machine + a screenshot, and hand it
to the fix loop — that step number is the acceptance test for the fix.
