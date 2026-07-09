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

### 4b. The sidebar (`4e2d836`, `9cede17`, `a0c3c59`, `09d2364`, `5e24a04`)
- [ ] Click between sessions in one project, then between projects. The list **never blanks, flickers, or reorders**
      after it paints, and you never see one project's sessions under another project's name.
- [ ] Leave a session for another one. The one you left gets **no white/grey bar** on its left edge. The only left
      accents that exist: **green** (live), **amber** (draft/unsaved), **red** (mid-turn).
- [ ] Make a **brand-new project**. You see exactly one **New Session** row — no `(empty session)`, and no live
      session carried over from another project.
- [ ] Start a new session and type nothing. It shows once, as **DRAFT · UNSAVED** — not as a saved `(empty session)`.

### 4c. Sync + invites land on their own (`b242e79`, `07960e2`)
- [ ] With **Repo Review** open, hit **Sync now** (or let a background sync pull something). The diff/history feed
      updates **without** you switching to another project and back.
- [ ] Expand a project you are *not* currently in. A sync that changes it updates that expanded list **in place**.
- [ ] Have someone invite you to a repo while Claudible is **already running**. Accept on GitHub, then click back
      into the Claudible window → the project appears. (Or open **New project → Check for invites**.) The **invited**
      tag on the chip is clearly legible.

### 4d. Renaming a project renames the GitHub repo (`13aeda8`, `acdc8c7`)
- [ ] Rename a **synced repo project you own**. Confirm on GitHub that the **repo itself was renamed**, and that the
      toast says so.
- [ ] Open a session in that project — **all your old conversations are still there** (the rename must never orphan
      transcripts), and **Sync now** still works.
- [ ] **Fully quit and relaunch.** The project appears **once**. There is **no second, ghostly "invited" copy** of it.
- [ ] Rename a project someone **invited** you to → it renames locally and tells you the GitHub repo was untouched.

### 4e. A failed clone never eats your files (`c50eafc`) — *the one that could destroy data*
- [ ] Make a folder somewhere with a file in it (e.g. `~/tmp/collide/notes.txt`), where `collide` matches a repo
      name you can't actually clone (revoke access, or use a repo that doesn't exist).
- [ ] Accept/open that project so the clone targets `~/tmp/collide` → you get **"that folder already exists and is
      not empty — pick another location"**, and **`notes.txt` is still there**. Nothing was deleted.

## Needs a second person / second machine

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

`package.json` is already at `0.8.0`. If all boxes pass: replace `— unreleased` in the CHANGELOG's `## [0.8.0]`
heading with the release date, then tag `v0.8.0` (`build.yml` hard-fails if the tag and `package.json` version
disagree).
