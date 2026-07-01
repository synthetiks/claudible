# Session History — activity feed + revert

A single append-only **event log** that powers two faces of the Repo Review window: a
per-prompt **activity feed** (who changed what, when, on which machine) and, built on the
very same records, **revert** to a previous checkpoint.

> **Status:** Phases 1–7 complete, including the **revert UI** (shipped `b77bc95`:
> per-prompt code checkpoints + one-click Revert, with an undo). Ships **dark** behind the
> `sessionHistory` setting (default **off**) — completely inert until enabled. Live multiplayer
> sync and the in-app smoke test are still pending.

## Why one log
The feed and revert are not two features — they're one record set with two consumers. The
capture/sync layer *writes* entries; the window *reads* them; revert *acts on* the checkpoint
each entry points at. Build the spine once, get all of it.

## Entry shape
```
{ id, seq, ts, author, authorId, machine{id,host,os}, session, prompt, summary, files[{path,add,del}], checkpointRef }
```
- `author` / `machine` — *who drove this turn / which PC* (multiplayer attribution).
- `prompt` — the feed's change line; later injected as context so Claude knows who's asking.
- `files` / `summary` — the GitHub-style "3 files (+42/-10)" line.
- `checkpointRef` — the snapshot that revert restores.

## Architecture
| Piece | File | Role |
|---|---|---|
| Log core | `lib/history.js` | makeEntry / ringPush (capped) / mergeLogs (conflict-free union by id) / summarizeFiles — **pure** |
| Attribution | `lib/identity.js` | resolveAuthor / machineRecord / sessionMeta — **pure** |
| Persistence | `lib/historyStore.js` | atomic load/save/append (temp+rename); corrupt/missing → `[]` |
| Checkpoints | `lib/checkpoint.js` | git-backed snapshot/restore (hidden refs, temp index) |
| Backend IPC | `main.js` | `history:append` / `history:load` — **stamps id/seq/author/machine server-side**, persists per workspace |
| Bridge | `preload.js` | `historyAppend(prompt, session)` / `historyLoad()` |
| Capture | `renderer/app.js` | fires `historyAppend` at the `UserPromptSubmit` seam (no-op when disabled) |
| Feed UI | `renderer/app.js` + `index.html` | `#history-feed` panel atop the Repo Review drawer; hidden unless enabled + non-empty |

The renderer only ever sends the **raw prompt**; the main process stamps identity, so a guest
can't spoof who they are (attribution-trust by construction).

## Enable it
In `runtime/settings.json`:
```json
{ "sessionHistory": true }
```
Then every prompt is captured and the last 10 render in the Repo Review drawer.

## Storage
Per-workspace, local-first, in the gitignored runtime dir:
`~/.claudible/runtime/history/<workspaceId>.json` (ring-buffered to the last 10).
Cross-machine, the log travels over the **live channel** (join handshake), not git.

## Tests (headless — no running app needed)
```
node test/history.test.js        # 15  pure log core
node test/identity.test.js       # 11  attribution
node test/history-store.test.js  #  8  disk roundtrip / corruption tolerance
node test/checkpoint.test.js     # 12  git snapshot/restore on a throwaway repo
```
All wired into `npm test`. (The bash statusline-parity test fails on native Windows Git Bash —
pre-existing and unrelated to this feature.)

## Shipped since
- **Phase 7 — revert UI (done, `b77bc95`):** click an entry's Revert → confirm → restore its
  checkpoint, taking a fresh `undo` snapshot first so the revert is itself undoable. Revert now
  also targets the feed's own workspace and warns if a turn is still in flight.

## What's left
- **Multiplayer:** attribute remote drivers + propagate the log over the live channel + send a
  full snapshot in the join handshake.
- **Files-changed:** compute the per-prompt diff for the summary line.
- **Smoke test:** verify capture + feed in the running app before the flag defaults on.
