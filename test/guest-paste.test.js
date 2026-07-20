// test/guest-paste.test.js — a guest's Ctrl+V must paste the GUEST's clipboard, never the host's.
//
// The failure this pins down: xterm's stock keymap turns an unintercepted Ctrl/⌘+V into a raw 0x16 byte;
// relayed verbatim to the host's pty, the CLI there answers ^V by reading the clipboard of the machine it
// runs on — the HOST's. The old guest-side interceptor matched by KEY NAME ('v'), which any non-Latin
// keyboard layout bypasses, so the leak was layout-dependent and silent. The fix has three layers:
//   1. guest.js: attachCustomKeyEventHandler (physical-key match) + a native 'paste' listener that ships
//      the guest's clipboard as its own typed frame — and no navigator.clipboard.readText() interceptor.
//   2. server.js: a 'paste' message type, and stripCtrlV() on the keystroke channel so a bare 0x16 can
//      never reach the pty from ANY client, stale or future.
//   3. main.js: onPaste sanitizes (no bracketed-paste breakout) and wraps in \x1b[200~…\x1b[201~ exactly
//      like the host's own paste path.
// Pure helpers are behavior-tested; the wiring is proven contract-test style (grep-level, zero deps).
// Run: node test/guest-paste.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { stripCtrlV, sanitizePaste } = require('../share/server.js');

let pass = 0, fail = 0;
function t(label, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL ${label}: ${e.message}`); }
}

// ---- stripCtrlV: the keystroke channel never carries a bare ^V ----
t('stripCtrlV removes a lone 0x16', () => assert.strictEqual(stripCtrlV('\x16'), ''));
t('stripCtrlV removes embedded 0x16s', () => assert.strictEqual(stripCtrlV('a\x16b\x16c'), 'abc'));
t('stripCtrlV passes normal keystrokes through untouched', () => {
  for (const s of ['a', '\r', '\x03', '\x1b[5~', '\x1b[200~hi\x1b[201~', '']) assert.strictEqual(stripCtrlV(s), s);
});
t('stripCtrlV tolerates non-strings', () => { assert.strictEqual(stripCtrlV(null), ''); assert.strictEqual(stripCtrlV(undefined), ''); });

// ---- sanitizePaste: pasted text can't break out of its bracketed-paste block ----
t('sanitizePaste strips the end mark (paste-injection breakout)', () =>
  assert.strictEqual(sanitizePaste('safe\x1b[201~rm -rf /\r'), 'saferm -rf /\r'));
t('sanitizePaste strips a nested start mark', () =>
  assert.strictEqual(sanitizePaste('a\x1b[200~b'), 'ab'));
t('sanitizePaste strips NUL and ^V bytes', () =>
  assert.strictEqual(sanitizePaste('a\x00b\x16c'), 'abc'));
t('sanitizePaste keeps newlines, tabs and plain text intact', () => {
  const s = 'line one\n\tline two\r\nfin — ünïcode ✓';
  assert.strictEqual(sanitizePaste(s), s);
});
t('sanitizePaste keeps unrelated escapes (they are literal inside a paste block)', () =>
  assert.strictEqual(sanitizePaste('\x1b[31mred\x1b[0m'), '\x1b[31mred\x1b[0m'));
t('sanitizePaste tolerates non-strings', () => { assert.strictEqual(sanitizePaste(null), ''); assert.strictEqual(sanitizePaste(123), '123'); });

// ---- wiring: the three layers actually exist in the shipped source ----
const GUEST = read('share/guest.js');
const SERVER = read('share/server.js');
const MAIN = read('main.js');

t('guest: xterm is told to skip the paste chord (physical-key match)', () => {
  assert.ok(GUEST.includes('attachCustomKeyEventHandler'), 'no attachCustomKeyEventHandler');
  assert.ok(/code === 'KeyV'/.test(GUEST), 'chord must match e.code (layout-independent), not just e.key');
});
t("guest: a native 'paste' listener ships the guest clipboard as a typed frame", () => {
  assert.ok(/addEventListener\('paste'/.test(GUEST), "no 'paste' listener");
  assert.ok(/type:\s*'paste'/.test(GUEST), "guest never sends a {type:'paste'} frame");
});
t('guest: the readText() keydown interceptor is gone (its failure modes WERE the bug)', () =>
  assert.ok(!GUEST.includes('readText'), 'navigator.clipboard.readText still present in guest.js'));
t("server: handles the 'paste' frame and gates it like keystrokes", () => {
  assert.ok(/msg\.type === 'paste'/.test(SERVER), "no 'paste' message handling");
  assert.ok(/onPaste/.test(SERVER), 'no onPaste callback');
});
t('server: keystroke channel is scrubbed with stripCtrlV', () =>
  assert.ok(/stripCtrlV\(msg\.data\)/.test(SERVER), 'input path does not strip ^V'));
t('main: onPaste sanitizes and wraps in bracketed-paste marks like host paste', () => {
  assert.ok(/onPaste:/.test(MAIN), 'main.js does not wire onPaste');
  assert.ok(/sanitizePaste\(/.test(MAIN), 'main.js does not sanitize pasted text');
  assert.ok(MAIN.includes("'\\x1b[200~' + safe + '\\x1b[201~'"), 'paste is not host-wrapped in bracket marks');
});

console.log(`guest-paste: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
