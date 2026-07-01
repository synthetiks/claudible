// test/checkpoint-tool.test.js — drives wsl/checkpoint-tool.js (the WSL adapter over lib/checkpoint.js) end-to-end
// against a REAL throwaway git repo: snapshot → diverge → restore (with auto-undo) → undo-revert → prune. This is
// what main.js actually shells to, so it proves the whole engine, not just the pure lib. Run: node test/checkpoint-tool.test.js
'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const TOOL = path.join(__dirname, '..', 'wsl', 'checkpoint-tool.js');

let pass = 0, fail = 0;
function ok(l, c) { c ? pass++ : (fail++, console.error('  FAIL ' + l)); }
function eq(l, a, b) { try { assert.strictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${l}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ckpttool-'));
const g = (...a) => cp.execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] });
function tool(...args) {                                    // run the tool with cwd = repo (what checkpoint.sh does after cd)
  const r = cp.spawnSync(process.execPath, [TOOL, ...args], { cwd: repo, encoding: 'utf8' });
  try { return JSON.parse((r.stdout || '').trim()); } catch { return { ok: false, _raw: r.stdout, _err: r.stderr }; }
}
const W = (rel, txt) => fs.writeFileSync(path.join(repo, rel), txt);
const R = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const has = (rel) => fs.existsSync(path.join(repo, rel));

g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
W('a.txt', 'A1'); g('add', 'a.txt'); g('commit', '-qm', 'base');

// snapshot c1 with a modified + b untracked
W('a.txt', 'A2'); W('b.txt', 'B1');
const s1 = tool('snapshot', 'c1');
ok('snapshot ok + sha', s1.ok === true && /^[0-9a-f]{40}$/.test(s1.sha || ''));

// diverge: change a, drop b, add c
fs.unlinkSync(path.join(repo, 'b.txt')); W('c.txt', 'C1'); W('a.txt', 'A3');

// revert to c1 (auto-captures current A3 state to 'undo')
const rs = tool('restore', 'c1');
ok('restore ok', rs.ok === true);
eq('a rolled back to ckpt', R('a.txt'), 'A2');
ok('b (untracked-at-ckpt) restored', has('b.txt') && R('b.txt') === 'B1');
ok('c (added after ckpt) removed', !has('c.txt'));
eq('undo ref reported', rs.undo, 'undo');

// undo the revert → back to the diverged A3 state (proves the undo net is REACHABLE, not just created)
const un = tool('restore', 'undo');
ok('undo-revert ok', un.ok === true);
eq('a back to pre-revert', R('a.txt'), 'A3');
ok('c is back', has('c.txt'));
ok('b gone again', !has('b.txt'));
eq('restoring undo does not spawn a new undo', un.undo, null);

// prune: keep only c1; c2/c3 dropped, undo (safety net) never pruned
tool('snapshot', 'c2'); tool('snapshot', 'c3');
const pr = tool('prune', 'c1');
ok('prune ok', pr.ok === true);
ok('c2 + c3 pruned', pr.pruned.indexOf('c2') >= 0 && pr.pruned.indexOf('c3') >= 0);
ok('c1 kept', pr.pruned.indexOf('c1') < 0);
ok('undo survives prune (still restorable)', tool('restore', 'undo').ok === true);

// guards
ok('bad id rejected (no injection)', tool('snapshot', '../evil').ok === false);
ok('restore of unknown id → ok:false', tool('restore', 'nope').ok === false);

// ===== regression tests for the adversarial-review findings =====
// [1] non-ASCII / CJK filenames added after a checkpoint must be REMOVED on revert (ls-files -z, not C-quoted paths).
{
  tool('snapshot', 'u1');
  W('café.txt', 'x'); W('日本語.txt', 'y');
  const ru = tool('restore', 'u1');
  ok('[1] non-ASCII café.txt removed on revert', !has('café.txt'));
  ok('[1] CJK file removed on revert', !has('日本語.txt'));
  ok('[1] removed[] reports the real (unquoted) path', (ru.removed || []).indexOf('café.txt') >= 0);
}
// [6] data-loss guard: an untracked file present at a checkpoint, later gitignored+edited, is clobbered by revert —
//     but the pre-revert 'undo' (which force-includes the checkpoint's paths) restores its precious content.
{
  const R2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ck6-'));
  const g2 = (...a) => cp.execFileSync('git', a, { cwd: R2, stdio: ['ignore', 'ignore', 'ignore'] });
  const t2 = (...a) => { const rr = cp.spawnSync(process.execPath, [TOOL, ...a], { cwd: R2, encoding: 'utf8' }); try { return JSON.parse((rr.stdout || '').trim()); } catch { return { ok: false }; } };
  const rd = (rel) => fs.readFileSync(path.join(R2, rel), 'utf8');
  g2('init', '-q'); g2('config', 'user.email', 't@t.t'); g2('config', 'user.name', 'T');
  fs.writeFileSync(path.join(R2, 'keep.txt'), 'K'); g2('add', 'keep.txt'); g2('commit', '-qm', 'base');
  fs.writeFileSync(path.join(R2, 'notes.md'), 'CHECKPOINT-CONTENT');   // untracked, not ignored → captured in the checkpoint
  fs.writeFileSync(path.join(R2, 'gone.txt'), 'G');                    // also in the checkpoint, but DELETED before revert (would abort force-add if not filtered)
  t2('snapshot', 'k1');
  fs.unlinkSync(path.join(R2, 'gone.txt'));                           // Claude deleted a checkpoint file — the force-add pathspec would be fatal on it
  fs.writeFileSync(path.join(R2, '.gitignore'), '*.md\n');            // *.md becomes ignored
  fs.writeFileSync(path.join(R2, 'notes.md'), 'PRECIOUS-NEW-WORK');   // precious edit to the now-ignored file
  const rr = t2('restore', 'k1');
  ok('[6] revert clobbers the now-ignored file to checkpoint content', rr.ok === true && rd('notes.md') === 'CHECKPOINT-CONTENT');
  const uu = t2('restore', 'undo');
  ok('[6] undo restores the PRECIOUS content (no silent data loss)', uu.ok === true && rd('notes.md') === 'PRECIOUS-NEW-WORK');
  fs.rmSync(R2, { recursive: true, force: true });
}
// [2] on a repo with NO commits, restore leaves the index EMPTY (not staged to the checkpoint tree).
{
  const R3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ck2-'));
  const g3 = (...a) => { try { return cp.execFileSync('git', a, { cwd: R3, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || ''; } };
  const t3 = (...a) => { const rr = cp.spawnSync(process.execPath, [TOOL, ...a], { cwd: R3, encoding: 'utf8' }); try { return JSON.parse((rr.stdout || '').trim()); } catch { return { ok: false }; } };
  g3('init', '-q'); g3('config', 'user.email', 't@t.t'); g3('config', 'user.name', 'T');
  fs.writeFileSync(path.join(R3, 'a.txt'), 'A');
  t3('snapshot', 'n1');
  fs.writeFileSync(path.join(R3, 'a.txt'), 'B'); fs.writeFileSync(path.join(R3, 'b.txt'), 'B');
  t3('restore', 'n1');
  ok('[2] no-HEAD restore leaves the index empty (not staged)', g3('diff', '--cached', '--name-only').trim() === '');
  ok('[2] no-HEAD restore rolled a.txt back', fs.readFileSync(path.join(R3, 'a.txt'), 'utf8') === 'A');
  fs.rmSync(R3, { recursive: true, force: true });
}

fs.rmSync(repo, { recursive: true, force: true });
console.log(`\ncheckpoint-tool (real temp repo): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
