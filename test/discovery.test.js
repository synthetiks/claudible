// test/discovery.test.js — the rename-safe discovery dedup (lib/discovery.js). The property under test: renaming a
// project's GitHub repo must NOT make it reappear as a phantom duplicate on the next launch (of any machine), and
// following a rename must never touch the workspace slug (which names every Claude transcript). Run: node test/discovery.test.js
'use strict';
const { findExistingWorkspace, reconcileWorkspace } = require('../lib/discovery');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }
function eq(label, a, b) { ok(label + ' (got ' + JSON.stringify(a) + ')', JSON.stringify(a) === JSON.stringify(b)); }

// A repo workspace created/discovered normally: slug === repo name, ghId stored.
const wsFoo = { id: 'repo-foo', kind: 'repo', slug: 'foo', owner: 'mk', repoName: 'foo', ghId: 111, label: 'foo' };
// The SAME repo after it was renamed foo -> bar on GitHub: slug frozen at 'foo', repoName/label moved to 'bar'.
const wsRenamed = { id: 'repo-foo', kind: 'repo', slug: 'foo', owner: 'mk', repoName: 'bar', ghId: 111, label: 'bar' };
// A pre-ghId legacy entry (upgraded before this change shipped): no ghId yet.
const wsLegacy = { id: 'repo-leg', kind: 'repo', slug: 'leg', owner: 'mk', label: 'leg' };
// An adopted working copy of mk/ad.
const wsAdopted = { id: 'local-ad', kind: 'repo', adopted: true, repoId: 'mk/ad', slug: 'ad', owner: 'mk', label: 'ad' };

// ---- match by stable id (the renamed repo is recognised, NOT re-added) ----
{
  // discovery now reports the repo under its NEW name 'bar' but the SAME id 111
  const m = findExistingWorkspace([wsRenamed], { slug: 'bar', owner: 'mk', ghId: 111 });
  ok('renamed repo matches its workspace by ghId', m === wsRenamed);
}
{
  // the crux: a renamed ws must NOT be re-added just because discovery reports a new name
  const disc = { slug: 'bar', owner: 'mk', ghId: 111 };
  const m = findExistingWorkspace([wsRenamed], disc);
  ok('no phantom duplicate after rename (found → skip add)', !!m);
}

// ---- the freed-up OLD name reused by a DIFFERENT repo must NOT hijack the renamed ws ----
{
  // someone creates a brand-new mk/foo (different id 999); the renamed ws still owns slug 'foo' + id 'repo-foo'
  const m = findExistingWorkspace([wsRenamed], { slug: 'foo', owner: 'mk', ghId: 999 });
  ok('reused old name (new id) does NOT match the renamed ws', m === null);
}
{
  // and without the guard, id `repo-foo` OR owner+slug 'foo' would have false-matched — prove they don't
  const m = findExistingWorkspace([wsRenamed], { slug: 'foo', owner: 'mk', ghId: 999, wid: 'repo-foo' });
  ok('renamed ws is matchable ONLY by ghId (id/name clauses skipped)', m === null);
}

// ---- never-renamed repos still match by id / owner+slug / adopted ----
{
  const m = findExistingWorkspace([wsFoo], { slug: 'foo', owner: 'mk', ghId: 111 });
  ok('normal repo matches by ghId', m === wsFoo);
}
{
  // same repo, discovery didn't report an id (older script) → falls back to owner+slug
  const m = findExistingWorkspace([wsFoo], { slug: 'foo', owner: 'mk', ghId: null });
  ok('normal repo matches by owner+slug when no ghId', m === wsFoo);
}
{
  const m = findExistingWorkspace([wsLegacy], { slug: 'leg', owner: 'mk', ghId: 222 });
  ok('legacy (no ghId) matches by owner+slug', m === wsLegacy);
}
{
  const m = findExistingWorkspace([wsAdopted], { slug: 'ad', owner: 'mk', ghId: 333 });
  ok('adopted matches by repoId', m === wsAdopted);
}
{
  const m = findExistingWorkspace([wsFoo], { slug: 'brand-new', owner: 'mk', ghId: 444 });
  ok('genuinely new repo matches nothing', m === null);
}

// ---- reconcile: backfill ghId onto a legacy entry, without following a (non-)rename ----
{
  const { changed, patch } = reconcileWorkspace(wsLegacy, { slug: 'leg', owner: 'mk', ghId: 222 });
  ok('legacy backfill is a change', changed === true);
  eq('legacy backfill sets ghId only', patch, { ghId: 222 });
  ok('backfill NEVER contains slug', !('slug' in patch));
}

// ---- reconcile: a collaborator following the owner's rename (matched by ghId, name moved) ----
{
  const collab = { id: 'repo-foo', kind: 'repo', slug: 'foo', owner: 'mk', ghId: 111, label: 'foo' };  // repoName unset, label uncustomized
  const { changed, patch } = reconcileWorkspace(collab, { slug: 'bar', owner: 'mk', ghId: 111, repoUrl: 'https://github.com/mk/bar' });
  ok('rename-follow is a change', changed === true);
  eq('follows repoName', patch.repoName, 'bar');
  eq('follows repoUrl', patch.repoUrl, 'https://github.com/mk/bar');
  eq('adopts new name as label (was uncustomized)', patch.label, 'bar');
  ok('rename-follow NEVER contains slug', !('slug' in patch));
}
{
  // same, but the user set a CUSTOM label → the rename must not clobber it
  const collab = { id: 'repo-foo', kind: 'repo', slug: 'foo', owner: 'mk', ghId: 111, label: 'My Project' };
  const { patch } = reconcileWorkspace(collab, { slug: 'bar', owner: 'mk', ghId: 111 });
  eq('follows repoName even with custom label', patch.repoName, 'bar');
  ok('custom label is preserved (no label in patch)', !('label' in patch));
}

// ---- reconcile: nothing to do when the name is unchanged (idempotent) ----
{
  const { changed, patch } = reconcileWorkspace(wsFoo, { slug: 'foo', owner: 'mk', ghId: 111 });
  ok('no change when nothing moved', changed === false);
  eq('empty patch when nothing moved', patch, {});
}
{
  // the renamer's own machine on the next launch: ghId already set, repoName already 'bar', discovery reports 'bar'
  const { changed } = reconcileWorkspace(wsRenamed, { slug: 'bar', owner: 'mk', ghId: 111 });
  ok('renamer machine: no spurious change post-rename', changed === false);
}

console.log('discovery: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
