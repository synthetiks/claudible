#!/usr/bin/env node
// Claudible statusLine hook — SHARED across every OS backend (WSL / Windows-native / Posix).
// Reads the status JSON on stdin, writes it verbatim to $CLAUDIBLE_STATUS (the per-tab status.json the
// meter polls), and prints the compact TUI line. A faithful Node port of the bash+python3 script that
// wsl/session.sh used to generate — no python3, no bash, so the same file runs everywhere. Per-tab
// routing is via the inherited CLAUDIBLE_STATUS env, exactly like the bash original.
'use strict';
const fs = require('fs');

let buf = '';
try { buf = fs.readFileSync(0, 'utf8'); } catch {}   // fd 0 = stdin (a pipe from Claude Code)
const inp = buf.replace(/\n+$/, '');                 // bash `in=$(cat)` strips trailing newlines

const out = process.env.CLAUDIBLE_STATUS || process.argv[2];   // per-tab path: inherited env (routing), baked argv = fallback (matches bash ${CLAUDIBLE_STATUS:-$STATUS})
try { if (out) fs.writeFileSync(out, inp); } catch {}

// Reproduce the bash line EXACTLY. The original was:
//   d=json.load(stdin); c=d.get('context_window',{}); print('claudible · %s%% ctx' % c.get('used_percentage','?'))
//   except: print('claudible')
// So: valid JSON object with an object context_window -> used_percentage is %s-formatted
// (number -> 'N', JSON null -> python None -> 'None', key missing -> '?'); any parse/shape error -> bare 'claudible'
// (incl. context_window === null, which made python's None.get(...) raise).
let line = 'claudible';
try {
  const d = JSON.parse(buf);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw 0;        // python d.get on a non-dict raises
  const c = Object.prototype.hasOwnProperty.call(d, 'context_window') ? d.context_window : {};
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw 0; // python c.get on None/non-dict raises -> bare 'claudible'
  let pct = '?';
  if (Object.prototype.hasOwnProperty.call(c, 'used_percentage')) {
    const v = c.used_percentage;
    // Mirror python '%s' for the values that actually occur: number -> its string, null -> 'None'.
    // (Cosmetic caveat: a whole-number float like 66.0 renders '66' here vs python's '66.0' — JSON.parse
    // drops the int/float distinction, so it's unrecoverable; the disk status.json is byte-identical, and
    // that — not this TUI line — is what the meter reads, so telemetry is unaffected. '66' is arguably nicer.)
    pct = v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v);
  }
  line = `claudible · ${pct}% ctx`;
} catch { line = 'claudible'; }
process.stdout.write(line + '\n');                   // python print adds the trailing newline
