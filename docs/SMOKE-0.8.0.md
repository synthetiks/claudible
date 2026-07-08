# 0.8.0 smoke checklist

Targeted manual checks for the hardening pass (`pre-polish-baseline..HEAD`). This is **not** the general
`docs/SMOKE.md` — it covers only the paths 0.8.0 actually changed. The automated suite (`npm test`, `npm run lint`,
shellcheck, the Electron boot smoke, and per-OS `electron-builder --dir`) already runs in CI; everything below is
the part a machine can't drive — the live pty, the cloudflared tunnel, voice, and two-machine sync.

Do these on the machine you'll tag from, **after pulling and fully restarting the app** (both machines must pull +
restart for the sync/voice items). Check each box; anything that fails is a blocker for the tag.

## Solo — you alone can verify these

### 1. Node hooks actually run (the headline fix — `d6b8a00`)
This is the one most worth your attention: before this release, on an nvm-based install every session silently ran
the *degraded bash* hooks.
- [ ] Open a **new** session in a repo project. Then, in a shell:
      `ls ~/.claudible/repos/<your-project>/.claude/` — you should see **`statusline.js`, `hook.js`, `context-hook.js`**
      (the `.js` files), not only the `.sh` ones.
- [ ] The **status line shows live token/context numbers** as the turn runs (not blank, not frozen).
- [ ] Ask the model "what machine and user am I?" — it should answer from the injected runtime block (correct
      machine name + git identity), proving the context hook fired.
- [ ] **Export conversation** on a session with real history → the saved file is **not empty**.
- [ ] Open **System Check** (the onboarding/deps wizard). Node should read **present** (it may say *outdated* if your
      WSL Node is < 22.12 — that's correct new information, not a regression), and Claude should read **signed in**.

### 2. A hostile / awkward folder name is refused cleanly (`d9b1a49`, security `6786cda`)
- [ ] Try to **adopt** or **create** a project in a folder whose name contains a `"` (double quote) or a backslash
      → you get a clear "that folder's path contains a quote, a backslash or a line break" message, and **no empty
      folder is left behind**.
- [ ] A normal folder with **spaces and/or unicode** in its path (e.g. `~/My Projects/café`) **still works**.
- [ ] (If you have one) open a project you cloned from GitHub — it opens normally; nothing unexpected runs. (The
      RCE fix is invisible when there's nothing hostile in `.git/config`; this just confirms normal repos are fine.)

### 3. Your settings + projects survive (`5908224`, `6ce2305`, `5511584`)
- [ ] Rename a session (give it a custom title), **fully quit** the app, relaunch → the **title is still there**.
- [ ] Delete a project → its folder moves to `~/.claudible/trash/` and the confirm dialog says **"kept 30 days"**
      (not "recoverable"). Confirm the folder is actually under `~/.claudible/trash/`.
- [ ] Delete a session whose delete you know will succeed → it's gone; its custom name doesn't reappear on another
      session.

### 4. Clearer failure messages (`d9e7b4a`, `71934ed`)
- [ ] Hit **Sync now** on a project twice in quick succession (or while a sync is already running) → you do **not**
      get "that session is still running — wait for the turn to finish" (the old wrong message); the chip doesn't
      flash a red error for the second, redundant click.

## Needs a second person / second machine (you + Crazy)

### 5. Voice survives a reconnect (`a667b25`, `89187a4`)
- [ ] Both join a live voice session. Set a **custom volume** for the other person (the per-person slider).
- [ ] Have that person **drop and rejoin** — close their tab and reopen it, or toggle their WiFi briefly.
- [ ] The volume you set for them **is still applied** after they're back (it used to reset to default).
- [ ] They appear in the voice roster **exactly once** after rejoining (not duplicated).

### 6. Two-machine sync still round-trips (touched indirectly by `d6b8a00`, `18b8398`, `d4b005d`)
- [ ] Start a session on machine A in a synced repo project; confirm it appears on machine B after a sync.
- [ ] Session titles you set on one machine converge on the other.
- [ ] Accept an invite / open a synced project whose folder path is normal — it clones and opens.

### 7. Live co-drive (regression guard around the session/tab changes)
- [ ] Host a live session, have the guest join, and **click into another of your own sessions** — the live session
      **stays up** (only "End session" ends it). This was fixed pre-baseline; confirm the polish pass didn't regress it.

---

If all boxes pass, bump `package.json` to `0.8.0`, date the CHANGELOG's `## [0.8.0]` heading, and tag `v0.8.0`
(`build.yml` hard-fails if the tag and `package.json` version disagree).
