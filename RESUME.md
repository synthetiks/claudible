# Claudible — resume notes (new-laptop setup + where we are)

## New laptop: yes, same account + same repo gets you the work — with setup
Logging in with the **same GitHub account** and joining the **same workspace** is the right idea.
The git repo carries the **app code** and (via the `claudible/sessions` branch) the **shared session
transcripts + names**, so you'll see the same work. But some things are **per-machine** (not in the repo)
and must be set up fresh:

1. **Clone this repo**, then `npm install` (rebuilds native `node-pty` for that machine).
2. **WSL2** installed, with the `claude` CLI installed **and logged in INSIDE WSL** (Claudible runs Claude in WSL).
3. **`gh` CLI authenticated** with your GitHub account (used for workspace sync + invites).
4. *(Optional)* voice services (whisper/kokoro) for voice in/out.
5. Launch → open the **MK & Crazy** workspace → turn **Sync sessions ON** → it pulls the shared
   sessions so you're caught up.

**Re-set locally** (these live in app storage, not the repo): your **collab display name** (Settings),
voice + effort prefs.

**One caveat about "full context":** the repo carries code + sessions, but the *assistant's* memory of
our debugging lives in Claude Code's local memory on the old machine. On the new laptop, point Claude Code
at **this file** (or paste it) and it's caught up.

## Where the live co-working ("Join live") work stands
- Native **in-app join** — co-drive a peer's session as a tab, with the shortcut pills, tracker, chat,
  voice, and a "who's here" roster — is **BUILT + pushed** (commit `85cfcd9`). The `⤢` button is the
  old separate-window join (kept as a fallback).
- **OPEN BUG:** clicking **● Join live** does nothing — no tab, no overlay, no toast — and `⤢` also does
  nothing. The code is verified correct and loads clean, so it's a runtime/environment issue, not a syntax bug.
- **Diagnostics are in** (commit `09be050`): on launch, DevTools force-opens and all renderer
  console/errors are mirrored to **`.claudible-debug.log`** in the app folder.

### To resume debugging
On the machine running the **host** app: `git pull` → **fully quit and relaunch** Claudible (a pull won't
take effect until the process actually restarts) → have the other person go live → click **● Join live**, then:
- read the **red error** in the now-open DevTools Console, **or**
- send the **`.claudible-debug.log`** file.

The log will show `[live] badge clicked` → `[live] openLiveTab called` → the result or the thrown error,
which pinpoints the bug. Likely culprits to confirm from the log: a real-DOM throw in `setActiveTab` for a
live tab, a missing `claudible.live*` method (stale preload), or the click handler not firing at all.

*(The diagnostics in `09be050` are TEMP — revert them once the cause is found.)*
