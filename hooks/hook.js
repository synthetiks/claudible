#!/usr/bin/env node
// Claudible event hook — SHARED across every OS backend (WSL / Windows-native / Posix).
// Appends each hook payload as ONE NDJSON line to $CLAUDIBLE_HOOKS (the per-tab hooks.ndjson the
// pollers tail for telemetry/agents/voice/sync). A faithful Node port of the bash script session.sh
// used to generate. Per-tab routing is via the inherited CLAUDIBLE_HOOKS env, like the bash original.
'use strict';
const fs = require('fs');

let buf = '';
try { buf = fs.readFileSync(0, 'utf8'); } catch {}   // fd 0 = stdin (the hook payload from Claude Code)
const line = buf.replace(/\n+$/, '');                // bash `line=$(cat)` strips trailing newlines

const out = process.env.CLAUDIBLE_HOOKS || process.argv[2];   // per-tab path: inherited env (routing), baked argv = fallback (matches bash ${CLAUDIBLE_HOOKS:-$HOOKS})
try { if (out) fs.appendFileSync(out, line + '\n'); } catch {}   // bash `printf '%s\n' "$line" >> "$out"`
process.exit(0);
