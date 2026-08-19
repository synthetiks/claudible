'use strict';
// Claudible — per-agent OBSERVED report for a session's subagents dir.
// agent-tokens-tool.js answers "how many tokens did the swarm burn"; this answers "what actually RAN":
// for each agent-*.jsonl, the model and effort the harness recorded, plus the per-type token split the
// receipt card re-prices. Everything here is read from disk, never inferred — the whole point of this
// rail is that the Agents tab stops guessing (the old card substituted the tab's model when a Task call
// omitted one, which displayed an assumption as an observation).
// $1 = subagents dir. Prints a JSON array; on any structural problem prints [] (callers treat it as "no data").
//
// Walk rules mirror agent-tokens-tool.js: skip dot-entries, only *.jsonl. Per-file errors skip the file —
// a half-written line from a live agent must not take down the whole report.

const fs = require('fs');
const path = require('path');

function report(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name.charCodeAt(0) === 0x2e) continue;
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const m = /^agent-([A-Za-z0-9]+)\.jsonl$/.exec(ent.name);
    if (!m) continue;
    const a = { id: m[1], model: '', effort: '', in: 0, out: 0, cw: 0, cr: 0, turns: 0, lastTs: '' };
    let text;
    try { text = fs.readFileSync(path.join(dir, ent.name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }   // live agents append; a torn last line is normal
      if (typeof o.effort === 'string' && o.effort) a.effort = o.effort;
      if (typeof o.timestamp === 'string') a.lastTs = o.timestamp;
      const msg = o && o.message;
      if (!msg || typeof msg !== 'object') continue;
      // model only ever appears on assistant entries; last-seen wins (a mid-run /model switch is real)
      if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') { a.model = msg.model; a.turns++; }
      const u = msg.usage;
      if (u && typeof u === 'object') {
        a.in += (typeof u.input_tokens === 'number' ? u.input_tokens : 0);
        a.out += (typeof u.output_tokens === 'number' ? u.output_tokens : 0);
        a.cw += (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0);
        a.cr += (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0);
      }
    }
    if (a.model || a.out > 0) out.push(a);   // a file with no assistant turn yet reports nothing rather than a blank row
  }
  return out;
}

const dir = process.argv[2];
if (!dir) { process.stdout.write('[]'); process.exit(0); }
try { process.stdout.write(JSON.stringify(report(dir))); } catch { process.stdout.write('[]'); }
