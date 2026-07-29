// test/replay.test.js — share/replay.js, the session-replay HTML renderer. Zero coverage before this file,
// and it is an injection surface by construction: transcript text and metadata are USER/PEER-controlled, and
// the output is a standalone HTML page people open in a real browser. The module's own safety model is
// two-layer — metadata is HTML-escaped into markup, transcript text rides only inside a JSON <script> literal
// (DOM built client-side with textContent) — so the tests pin exactly those two layers.
// Run: node test/replay.test.js
'use strict';
const assert = require('assert');
const { renderReplayHtml } = require('../share/replay.js');

let pass = 0;
function ok(label, fn) { fn(); pass++; }

// ---- metadata is escaped into markup ----
ok('a hostile title cannot open a tag in <title> or the header', () => {
  const html = renderReplayHtml({ title: '<script>alert(1)</script> & "q" \'s\'' });
  assert(!html.includes('<script>alert'), 'raw <script> from the title leaked into markup');
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;s&#39;'), 'title not escaped with the full charset');
});
ok('a hostile workspace name is escaped inside its chip', () => {
  const html = renderReplayHtml({ workspace: '"><img src=x onerror=alert(1)>' });
  assert(!html.includes('"><img'), 'workspace text escaped the chip attribute context');
  assert(html.includes('&quot;&gt;&lt;img'), 'workspace not escaped');
});
ok('the workspace chip renders only when a workspace is given', () => {
  assert(renderReplayHtml({ workspace: 'ws1' }).includes('class="chip"'));
  assert(!renderReplayHtml({}).includes('class="chip"'));
});

// ---- transcript text rides ONLY inside the JSON literal, and that literal cannot break out ----
ok('a </script> inside a message cannot terminate the embed script', () => {
  const html = renderReplayHtml({ messages: [{ role: 'you', text: 'x</script><script>alert(1)</script>' }] });
  // the ONLY authored </script> closers are the page's own; the payload's must have been \u003c-escaped
  const closers = html.match(/<\/script>/g) || [];
  assert.strictEqual(closers.length, 1, `expected exactly the page's own </script>, found ${closers.length}`);
  assert(html.includes('\\u003c/script'), 'the payload closer was not neutralized to \\u003c');
});
ok('U+2028/U+2029 (legal JSON, ILLEGAL pre-ES2019 JS) are unicode-escaped in the literal', () => {
  const html = renderReplayHtml({ messages: [{ role: 'claude', text: 'a\u2028b\u2029c' }] });
  assert(!html.includes('\u2028') && !html.includes('\u2029'), 'raw line separators reached the script literal');
  assert(html.includes('\\u2028') && html.includes('\\u2029'), 'separators not escaped');
});
ok('message text is NOT HTML-escaped into the literal (textContent renders it verbatim client-side)', () => {
  const html = renderReplayHtml({ messages: [{ role: 'you', text: 'a < b & c' }] });
  assert(html.includes('"a \\u003c b & c"'), 'the JSON literal must carry the raw text (with < as \\u003c), not &lt; entities');
});

// ---- shape tolerance: this renders from persisted history, which may be old or partial ----
ok('no arguments at all renders a complete page with defaults', () => {
  const html = renderReplayHtml();
  assert(html.startsWith('<!DOCTYPE html>') && html.includes('Claude session') && html.includes('0 / 0'));
});
ok('a non-array messages value is treated as empty, not crashed on', () => {
  for (const bad of [null, 'hi', 42, { 0: 'x' }]) {
    const html = renderReplayHtml({ messages: bad });
    assert(html.includes('const MSGS = []'), `messages=${JSON.stringify(bad)} did not degrade to []`);
  }
});
ok('the message count is reported in the header and the progress counter', () => {
  const html = renderReplayHtml({ messages: [{ role: 'you', text: 'a' }, { role: 'claude', text: 'b' }] });
  assert(html.includes('2 messages') && html.includes('0 / 2'));
  assert(renderReplayHtml({ messages: [{ role: 'you', text: 'a' }] }).includes('1 message<'), 'singular form');
});

console.log(`replay: ${pass} passed, 0 failed`);
