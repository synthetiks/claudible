// test/repo-tombstone.test.js — a deleted repo workspace must STAY deleted, even after a rename.
//
// The bug: the in-app rename deliberately FREEZES ws.slug (it names ~/.claudible/repos/<slug> and, through that,
// every Claude transcript for the project) and records the new GitHub name in ws.repoName. Delete then tombstoned
// `owner + '/' + ws.slug` — the frozen, pre-rename name. Discovery lists the repo under its CURRENT name. The two
// strings could never meet, so the workspace the user had just deleted came back as a fresh "clone me" invite on
// the very next launch. Deterministic (rename → delete), not a race.
//
// Like test/live-teardown.test.js, this lifts the REAL functions out of main.js source rather than restating them —
// a re-implementation here would happily keep passing while main.js regressed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };
const eqSet = (name, a, b) => { assert.deepStrictEqual([...a].sort(), [...b].sort(), name); console.log('  ✓ ' + name); pass++; };

// ---- lift the real implementations out of main.js --------------------------------------------------------------
const lift = (name) => {
  const m = MAIN.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `could not find function ${name}() in main.js — did it get renamed? This test is now blind.`);
  return m[0];
};
const src = lift('repoTombstoneKeys') + '\n' + lift('isRepoDismissed');
const { repoTombstoneKeys, isRepoDismissed } = new Function(`${src}\nreturn { repoTombstoneKeys, isRepoDismissed };`)();

console.log('\nrepo delete-tombstones (main.js, lifted from source)\n');

ok('main.js actually calls repoTombstoneKeys on the delete path (else this test guards nothing)',
  /dismissedRepos = Array\.from\(new Set\(\[\.\.\.\(registry\.dismissedRepos \|\| \[\]\), \.\.\.repoTombstoneKeys\(ws\)\]\)\)/.test(MAIN));
ok('…and discovery asks isRepoDismissed rather than string-matching owner/slug itself',
  /if \(isRepoDismissed\(registry, owner, slug, ghId\)\) continue;/.test(MAIN)
  && !/dismissedRepos \|\| \[\]\)\.includes\(owner \+ '\/' \+ slug\)/.test(MAIN));

// ---- the key set ------------------------------------------------------------------------------------------------
eqSet('a plain (never-renamed) repo tombstones under its stable id AND its name',
  repoTombstoneKeys({ kind: 'repo', owner: 'crazy', slug: 'marketplace', ghId: 42 }),
  ['gh:42', 'crazy/marketplace']);

eqSet('a RENAMED repo tombstones under its CURRENT GitHub name, never its frozen slug',
  repoTombstoneKeys({ kind: 'repo', owner: 'crazy', slug: 'old-name', repoName: 'new-name', ghId: 42 }),
  ['gh:42', 'crazy/new-name']);

eqSet('a repo whose ghId backfill never landed still gets a name key (degrades, never blanks)',
  repoTombstoneKeys({ kind: 'repo', owner: 'crazy', slug: 'no-id-here' }),
  ['crazy/no-id-here']);

ok('a workspace with neither owner nor id yields no keys (never tombstones "undefined/undefined")',
  repoTombstoneKeys({ kind: 'repo' }).length === 0);

// ---- THE regression: rename → delete → discover -----------------------------------------------------------------
{
  // The user renamed `old-name` → `new-name` in-app (slug frozen, repoName updated), then deleted the workspace.
  const ws = { kind: 'repo', owner: 'crazy', slug: 'old-name', repoName: 'new-name', ghId: 42 };
  const registry = { dismissedRepos: repoTombstoneKeys(ws) };
  // Next launch: discovery lists the repo under its CURRENT name, with its stable id.
  ok('THE BUG: a renamed-then-deleted repo stays deleted when discovery reports its current name',
    isRepoDismissed(registry, 'crazy', 'new-name', 42) === true);
  // …and it must still be suppressed even if GitHub's id is missing from the discovery item this time.
  ok('…still suppressed when the discovery item carries no ghId (falls back to the name key)',
    isRepoDismissed(registry, 'crazy', 'new-name', null) === true);
  // …and even if it gets renamed AGAIN on github.com afterwards: only the stable id can catch that.
  ok('…still suppressed after a FURTHER rename on github.com (only the stable id can match)',
    isRepoDismissed(registry, 'crazy', 'renamed-yet-again', 42) === true);
}

// ---- what must NOT be suppressed --------------------------------------------------------------------------------
{
  const registry = { dismissedRepos: repoTombstoneKeys({ kind: 'repo', owner: 'crazy', slug: 'old-name', repoName: 'new-name', ghId: 42 }) };
  // The freed-up OLD name is fair game: a DIFFERENT repo may take it later, and suppressing that would be a fresh
  // bug of exactly the kind lib/discovery.js guards against. This is why the stale slug is deliberately not a key.
  ok('a DIFFERENT repo that later takes the freed-up old name is NOT suppressed',
    isRepoDismissed(registry, 'crazy', 'old-name', 99) === false);
  ok('an unrelated repo of the same owner is not suppressed', isRepoDismissed(registry, 'crazy', 'something-else', 7) === false);
  ok('another owner\'s repo of the same name is not suppressed', isRepoDismissed(registry, 'mk', 'new-name', 7) === false);
  ok('an empty registry suppresses nothing', isRepoDismissed({ dismissedRepos: [] }, 'crazy', 'new-name', 42) === false);
  ok('a registry with no dismissedRepos at all suppresses nothing (no crash)', isRepoDismissed({}, 'crazy', 'new-name', 42) === false);
}

// ---- the old key form must keep working (users have these on disk already) ---------------------------------------
ok('a tombstone written by the OLD code (bare owner/slug) still suppresses that repo',
  isRepoDismissed({ dismissedRepos: ['crazy/legacy-repo'] }, 'crazy', 'legacy-repo', 1234) === true);

console.log(`\nrepo-tombstone: ${pass} passed\n`);
