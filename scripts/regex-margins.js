#!/usr/bin/env node
// scripts/regex-margins.js — measure actual-gap vs cap for every distance-capped regex ([\s\S]{0,N}?)
// in the test files. Run: `node scripts/regex-margins.js` (from the repo root), on demand — it is NOT a
// CI gate, because ~10% of the spans are unmeasurable (multi-line literals, shell-script targets outside
// the source set below) and a gate that cries wolf gets deleted.
//
// WHY: the distance-capped grep is this suite's recurring rot mechanism. Five separate checks have now
// broken on comment growth alone (three repaired in 34216a1, twelve widened the day this tool landed —
// including one sitting at margin 15 of a 4600 cap and one at exactly 0 of 300). The check's regex passes
// today and breaks the day an explanatory sentence lands between its anchors; the failure then reads like
// a real regression. Run this after touching app.js/main.js hot spots, or when a contract check fails and
// you suspect prose; anything it lists as TIGHT should be widened (2x current gap) or re-anchored to a
// comment-stripped view BEFORE it starts failing. Widening is safe only while no OTHER occurrence of the
// end anchor is reachable within the new cap — measure that (see 326bd7e's session notes) — and a check
// whose anchor IS comment text can never move to a stripped view.
//
// Method: wrap each capped span in a NAMED capture group; where the original regex matches a source,
// exec the instrumented one and read each group's length. Lazy matching makes the captured span the
// MINIMAL gap that still permits the match — i.e. the real distance the cap must cover today. Greedy
// TRAILING windows (…[\s\S]{0,N} used to extract a body for later .test calls) always fill their cap,
// so they are reported as WINDOW for manual eyeballing, not as margins.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..');

const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; } };

// Candidate sources + the derived views the tests actually use (flat HTML, comment-stripped).
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const bases = {
  APP: read('renderer/app.js'), MAIN: read('main.js'), HTML: read('renderer/index.html'),
  GUEST_JS: read('share/guest.js'), GUEST_HTML: read('share/guest.html'), PRELOAD: read('preload.js'),
  SERVER: read('share/server.js'), CLOUDFLARED: read('share/cloudflared.js'),
  WORKFLOW: read('.github/workflows/test.yml'), BUILD: read('.github/workflows/build.yml'),
  ADOPT: read('wsl/adopt-workspace.sh'), SELFUPD: read('lib/selfUpdate.js'),
  RUNNER_WSL: read('runners/wsl.js'), RUNNER_WIN: read('runners/win.js'), ESLINTC: read('eslint.config.js'),
  PKG: read('package.json'), CHANGELOG: read('CHANGELOG.md'),
};
const sources = {};
for (const [k, v] of Object.entries(bases)) {
  if (v == null) continue;
  sources[k] = v;
  sources[k + '.nc'] = stripComments(v);
  sources[k + '.flat'] = v.replace(/\s*\n\s*/g, '');
  sources[k + '.ncflat'] = stripComments(v).replace(/\s*\n\s*/g, '');
}

const TEST_FILES = ['test/contract.test.js', 'test/tabs-share.test.js', 'test/adopt-workspace.test.js',
  'test/beacon.test.js', 'test/self-update.test.js', 'test/naming-focus.test.js', 'test/tunnel-retry.test.js',
  'test/tab-focus.test.js', 'test/session-order.test.js', 'test/live-holder.test.js', 'test/live-teardown.test.js',
  'test/live-peers-scope.test.js', 'test/guest-paste.test.js', 'test/presence-relay.test.js', 'test/presence-filter.test.js'];

// Extract single-line regex literals that contain a distance cap. Handles escaped slashes.
function extractRegexLiterals(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('[\\s\\S]{0,')) continue;
    // regex literal: starts after a non-symbol boundary; conservative scan
    const re = /\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[gimsuy]*/g;
    let m;
    while ((m = re.exec(line))) {
      if (m[0].includes('[\\s\\S]{0,')) out.push({ line: i + 1, literal: m[0] });
    }
  }
  return out;
}

const rows = [];
for (const tf of TEST_FILES) {
  const src = read(tf);
  if (src == null) continue;
  for (const { line, literal } of extractRegexLiterals(src)) {
    let reOrig;
    try { reOrig = new Function('return ' + literal)(); } catch { rows.push({ tf, line, cap: '?', gap: 'PARSE-FAIL', margin: -1 }); continue; }
    // instrument: name each capped span g0,g1,...
    let gi = 0;
    const instrumentedSrc = reOrig.source.replace(/\[\\s\\S\]\{0,(\d+)\}\??/g, (full) => `(?<g${gi++}>${full})`);
    let reInst;
    try { reInst = new RegExp(instrumentedSrc, reOrig.flags); } catch { rows.push({ tf, line, cap: '?', gap: 'INST-FAIL', margin: -1 }); continue; }
    const caps = [...reOrig.source.matchAll(/\[\\s\\S\]\{0,(\d+)\}/g)].map((x) => +x[1]);
    // Greedy trailing window (…[\s\S]{0,N} with no lazy ? at the very end) is an EXTRACTION, not a distance —
    // it always fills its cap. Measuring it as a margin is a false positive; flag for manual review instead.
    if (/\[\\s\\S\]\{0,\d+\}$/.test(reOrig.source)) { rows.push({ tf, line, cap: caps.join('/'), gap: 'WINDOW', margin: -1 }); continue; }
    // RAW sources first: a test that greps raw APP must be measured against raw APP even if a comment-stripped
    // view also matches with a smaller gap. Raw-first can only OVERSTATE the gap for nc/flat-based tests, which
    // errs toward widening — the safe direction.
    const ordered = [...Object.keys(bases).filter((k) => sources[k] != null),
      ...Object.keys(sources).filter((k) => k.includes('.'))];
    let matchedIn = null, gaps = null;
    for (const name of ordered) {
      const text = sources[name];
      if (!reOrig.test(text)) continue;
      const em = reInst.exec(text);
      if (!em || !em.groups) continue;
      matchedIn = name; gaps = caps.map((_, i) => (em.groups['g' + i] != null ? em.groups['g' + i].length : -1));
      break;
    }
    if (!gaps) { rows.push({ tf, line, cap: caps.join('/'), gap: 'NO-MATCH', margin: -1 }); continue; }
    for (let i = 0; i < caps.length; i++) {
      rows.push({ tf, line, src: matchedIn, cap: caps[i], gap: gaps[i], margin: caps[i] - gaps[i] });
    }
  }
}
rows.sort((a, b) => (a.margin === b.margin ? 0 : a.margin < b.margin ? -1 : 1));
const bad = rows.filter((r) => typeof r.gap !== 'number');
// TIGHT = the growth of one explanatory comment could break it. Small caps (≤100) are adjacency
// assertions — two statements meant to sit together — so for them only proportional headroom matters
// (a 2-char gap under a 40 cap is fine); for larger caps, absolute headroom under ~60 chars is a comment
// away from breaking regardless of ratio.
const tight = rows.filter((r) => typeof r.gap === 'number'
  && (r.cap <= 100 ? r.gap > r.cap * 0.5 : (r.margin < 60 || r.margin < r.cap * 0.2)));
console.log(`measured ${rows.length} capped spans across ${TEST_FILES.length} files; ${bad.length} unmeasurable, ${tight.length} tight (a comment away from breaking)\n`);
console.log('--- TIGHT (fix these) ---');
for (const r of tight) console.log(`  ${r.tf}:${r.line} [${r.src}] cap=${r.cap} gap=${r.gap} margin=${r.margin}`);
console.log('\n--- UNMEASURABLE (eyeball these) ---');
for (const r of bad) console.log(`  ${r.tf}:${r.line} ${r.gap}`);
