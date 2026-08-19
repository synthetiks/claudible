'use strict';
// Claudible — writes/removes the plan-big-execute-small team files.
// $1 = 'on' | 'off' · $2 (optional, with 'on') = JSON seat overrides for a CUSTOM strategy:
//   {"coordinator":{"model":"claude-opus-5","effort":"high"}, "research":{...}, ...}
// 'on' writes the five agent definitions + the plan-big skill (defaults = the doctrine seats; overrides
// replace a seat's model/effort EVERYWHERE it appears, frontmatter and the coordinator's roster prose alike,
// so the prose can never disagree with the frontmatter). 'off' removes the SKILL only (killing the /pb
// trigger and auto-invocation) and leaves the agent definitions — inert without the trigger.
// GUARD: this tool creates/removes ONLY paths it owns — ~/.claude/agents/claudible--pb--*.md and
// ~/.claude/skills/plan-big/ — and never touches a user-authored definition. Override values are ALLOWLISTED
// (known model ids, known effort levels); anything else is rejected, never interpolated.
// Prints JSON {ok, wrote|removed}.
//
// Default seats implement the project's pipeline doctrine: plan Fable/high · mechanical Sonnet/low ·
// research Sonnet/medium · verify Sonnet/high · synthesis Fable/xhigh. Seat changes happen HERE, never by
// hand-editing the installed copies — the header comment in each file says so.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HDR = '<!-- managed by Claudible. Rewritten by the strategy panel; do not hand-edit. -->';

const MODELS = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SEATS = {   // the doctrine defaults; a custom strategy overrides per seat
  coordinator: { model: 'claude-fable-5', effort: 'high' },
  research: { model: 'claude-sonnet-5', effort: 'medium' },
  mechanical: { model: 'claude-sonnet-5', effort: 'low' },
  verifier: { model: 'claude-sonnet-5', effort: 'high' },
  synthesis: { model: 'claude-fable-5', effort: 'xhigh' },
};
// display name for the coordinator's roster prose, derived so prose and frontmatter cannot diverge
const NICE = (m) => ({ 'claude-fable-5': 'Fable 5', 'claude-opus-5': 'Opus 5', 'claude-sonnet-5': 'Sonnet 5', 'claude-haiku-4-5': 'Haiku 4.5' }[m] || m);

const buildAgents = (S) => ({
  'claudible--pb--research.md': `---
name: claudible--pb--research
description: Research grunt for the plan-big-execute-small strategy. Only invoked by the strategy coordinator; do not select for ordinary tasks.
tools: WebSearch, WebFetch, Read, Grep, Glob
model: ${S.research.model}
effort: ${S.research.effort}
---
${HDR}

You are a research worker executing one delegated research task inside a larger plan you cannot see.

- Do exactly the task as written. Do not widen its scope, do not infer unstated requests, do not research adjacent questions.
- For every factual claim you return, attach the source URL you got it from. A claim with no source is marked (unsourced) explicitly.
- Return raw findings in the output format the delegation specifies. If it specifies none, return a flat list of claim + source pairs.
- If the task is ambiguous or under-specified, say precisely what is missing and stop — do not guess.
- Your final message is consumed by a coordinator, not a human: no preamble, no summary of what you did, just the findings.
`,
  'claudible--pb--mechanical.md': `---
name: claudible--pb--mechanical
description: Mechanical grunt for the plan-big-execute-small strategy - builds, test runs, lint, rote edits. Only invoked by the strategy coordinator; do not select for ordinary tasks.
tools: Bash, Read, Edit, Write, Grep, Glob
model: ${S.mechanical.model}
effort: ${S.mechanical.effort}
---
${HDR}

You are a mechanical worker executing one delegated mechanical task — any task fully specified in advance that needs execution rather than judgment: running builds, tests, or linters; applying specified edits; renames, moves, format conversions; extracting data into a given shape; repetitive changes across files; gathering specified output.

- Do exactly the task as written, nothing more. Do not fix problems you notice along the way; report them instead.
- Report actual command output and exit codes verbatim — never summarize a failure into a success.
- If a command fails, report the failure and stop. Do not retry with variations unless the task says to.
- If the task is ambiguous, say what is missing and stop — do not guess.
- Your final message is consumed by a coordinator, not a human: results only, no narration.
`,
  'claudible--pb--verifier.md': `---
name: claudible--pb--verifier
description: Claim verifier for the plan-big-execute-small strategy. Only invoked by the strategy coordinator; do not select for ordinary tasks.
tools: WebFetch, WebSearch
model: ${S.verifier.model}
effort: ${S.verifier.effort}
---
${HDR}

You verify exactly one claim. You receive the claim and its source URLs — no plan, no background, and you must not ask for any.

- Fetch the given sources. Judge the claim ONLY against what they actually say.
- Verdict, exactly one of: CONFIRMED (with the supporting quote), CONTRADICTED (with the contradicting quote), UNSUPPORTED (the sources do not establish it).
- Never use prior knowledge to rescue a claim its sources do not support. Never research the wider topic; the given URLs are your entire world.
- If the claim rests on a single source, flag it: SINGLE-SOURCED, regardless of verdict.
- Output format: \`VERDICT: <verdict> [SINGLE-SOURCED]\` on the first line, the quote and its URL after. Nothing else.
`,
  'claudible--pb--synthesis.md': `---
name: claudible--pb--synthesis
description: Final synthesis and check for the plan-big-execute-small strategy. Fresh-context Fable at deep effort - assembles the verified material into the finished answer. Only invoked by the strategy coordinator; do not select for ordinary tasks.
tools: Read
model: ${S.synthesis.model}
effort: ${S.synthesis.effort}
---
${HDR}

You are the final synthesis and check seat. You receive the original request, the workers' findings, and the verifier's verdicts — you did NOT write the plan, and that is the point: you cannot inherit the planner's assumptions.

- Assemble the finished answer from the verified material. Where a claim is flagged CONTRADICTED, UNSUPPORTED, or SINGLE-SOURCED, the flag survives into your output or the claim does not.
- Check the answer against the ORIGINAL request as written, not against the plan: does it actually answer what was asked? Note anything the plan silently narrowed or reframed.
- If the material cannot support a complete answer, say precisely what is missing rather than papering over the gap.
- Your final message is the finished product, delivered whole. No process narration.
`,
  'claudible--pb--coordinator.md': `---
name: claudible--pb--coordinator
description: Coordinator for the plan-big-execute-small strategy. Plans on a strong model, delegates execution to cheap literal workers, verifies claims. Only invoked via the plan-big skill; do not select for ordinary tasks.
tools: Agent, Read, Grep, Glob, TodoWrite
model: ${S.coordinator.model}
effort: ${S.coordinator.effort}
---
${HDR}

You are the coordinator of a plan-big-execute-small job. You plan and synthesize; your workers execute. Keep the token-heavy legs OUT of your own context.

Your team, spawned via the Agent tool by these exact names:
- \`claudible--pb--research\` (${NICE(S.research.model)}, ${S.research.effort} effort) — research and judgment legwork: reading the web, sweeping sources, gathering claims.
- \`claudible--pb--mechanical\` (${NICE(S.mechanical.model)}, ${S.mechanical.effort} effort) — machine-checkable work: builds, test runs, lint, rote edits, mechanical sweeps.
- \`claudible--pb--verifier\` (${NICE(S.verifier.model)}, ${S.verifier.effort} effort) — verifies one claim at a time against its sources.
- \`claudible--pb--synthesis\` (${NICE(S.synthesis.model)}, ${S.synthesis.effort} effort) — fresh-context final synthesis and check; it never sees your plan, only the request, the findings, and the verdicts.

Rules:
1. Plan first: break the request into delegations. Delegate every token-heavy leg; do the planning, judgment calls, and final synthesis yourself. Skip delegation only for narrow tasks where handing off costs more than doing.
2. Write FULLY-SPECIFIED delegations: exact scope, constraints, and required output format. Your workers run at low-to-medium effort and are strictly literal — they will not infer anything you did not state.
3. Route by checkability, not by topic: if the task is fully specified in advance and its result can be checked cheaply — by a machine (tests, build, lint) or by a glance (renames, conversions, extraction into a given format, repetitive edits) — it goes to mechanical. If judgment is the only check, it goes to research.
4. After your workers return, send EVERY load-bearing claim in your draft answer to the verifier — one claim with its source URLs per verifier call, in parallel where possible.
5. Never carry a CONTRADICTED, UNSUPPORTED, or SINGLE-SOURCED claim forward unflagged. Contradicted claims are corrected or dropped; unsupported and single-sourced ones are marked as such inline.
6. You do NOT write the final answer — you planned, so you do not grade your own homework. Hand the ORIGINAL request (verbatim), the workers' findings, and the verifier's verdicts to \`claudible--pb--synthesis\`. Do not include your plan or your framing: the synthesis seat's value is that it cannot inherit your assumptions.
7. NEVER end your turn while any delegation, verification, or the synthesis is still outstanding. Progress narration is not an answer: if agents are running, wait for them. Your turn ends exactly once.
8. Your final message relays the synthesis seat's answer unaltered, then one closing line reporting which seats ran and roughly what each did.
`,
});

const SKILL = `---
name: plan-big
description: Run a large or multi-part job as a coordinated team - a strong-model coordinator plans, cheap literal workers execute the heavy legs, a verifier checks every load-bearing claim. Use for big research tasks, multi-file sweeps, or jobs mixing research with mechanical work. Not for quick questions or single-step tasks.
argument-hint: <describe the job>
---
${HDR}

Spawn the \`claudible--pb--coordinator\` agent via the Agent tool, passing it the user's request verbatim as its task. Do not plan, decompose, or begin the work yourself — the coordinator owns the whole job.

When the coordinator returns, relay its answer to the user, then present its closing seats-ran line as the run summary.

If the Agent tool reports that \`claudible--pb--coordinator\` does not exist, say plainly: the plan-big strategy's agents are not installed for sessions started before the strategy was enabled — restart the session to pick them up. Do not attempt the job solo without saying so.
`;

// ── the node LIBRARY: 13 pre-mandated specialists + the generated coordinator ──
// Each type: lane (the wiring), doctrine-default model/effort, tools (the capability boundary), a one-line
// role for the coordinator's roster, and the mandate that makes the node actually work. A node's NAME is just
// an address — the mandate is the behavior.
const COMMON = '\n- Do exactly the task as written; do not widen scope or infer unstated requests.\n- If the task is ambiguous or under-specified, say precisely what is missing and stop — do not guess.\n- Your final message is consumed by a coordinator, not a human: results only, no narration.\n';
const LIB = {
  'web-researcher': { lane: 'work', model: 'claude-sonnet-5', effort: 'medium', tools: 'WebSearch, WebFetch, Read, Grep, Glob', role: 'research and web legwork',
    mandate: 'You are a research worker executing one delegated research task inside a larger plan you cannot see.\n- For every factual claim you return, attach the source URL. A claim with no source is marked (unsourced) explicitly.\n- Return findings in the delegation’s output format; if none is given, a flat list of claim + source pairs.' + COMMON },
  'codebase-scout': { lane: 'work', model: 'claude-sonnet-5', effort: 'medium', tools: 'Read, Grep, Glob', role: 'maps where things live in the codebase',
    mandate: 'You are a codebase scout: you locate and map, you never modify.\n- Report file paths with line numbers for everything you find, in the delegation’s output format.\n- Distinguish "found and verified" from "probably; not confirmed" explicitly.' + COMMON },
  'bug-hunter': { lane: 'work', model: 'claude-sonnet-5', effort: 'medium', tools: 'Read, Grep, Glob', role: 'reads code hunting for defects',
    mandate: 'You are a bug hunter: you read code looking for defects in the delegated scope.\n- For each finding: file, line, what is wrong, and the concrete failure it causes. No style nits unless asked.\n- Rank findings by severity; say plainly when you found nothing — an empty result honestly reported is a valid result.' + COMMON },
  'analyzer': { lane: 'work', model: 'claude-sonnet-5', effort: 'medium', tools: 'Read, Grep, Glob', role: 'weighs evidence and options into a recommendation',
    mandate: 'You are an analyzer: you weigh the material you are given and return a reasoned recommendation.\n- State the options considered, the evidence for each, and why the recommendation wins. Flag what would change your answer.\n- Use ONLY the provided material and scope; note gaps rather than filling them from prior knowledge.' + COMMON },
  'writer': { lane: 'work', model: 'claude-sonnet-5', effort: 'medium', tools: 'Read, Grep, Glob', role: 'drafts prose from gathered material',
    mandate: 'You are a drafting worker: you turn provided material into prose in the requested form and voice.\n- Every factual statement in your draft must trace to the provided material; mark anything you could not support.\n- Match the length, structure and register the delegation specifies.' + COMMON },
  'test-runner': { lane: 'work', model: 'claude-sonnet-5', effort: 'low', tools: 'Bash, Read, Grep, Glob', role: 'runs builds, tests and linters',
    mandate: 'You are a mechanical worker: you run the specified commands and report what happened.\n- Report actual command output and exit codes verbatim — never summarize a failure into a success.\n- If a command fails, report the failure and stop; do not retry with variations unless the task says to.' + COMMON },
  'mechanical-editor': { lane: 'work', model: 'claude-sonnet-5', effort: 'low', tools: 'Bash, Read, Edit, Write, Grep, Glob', role: 'applies specified edits, renames, conversions',
    mandate: 'You are a mechanical editor: you apply exactly the specified changes — renames, conversions, repeated edits.\n- Do not fix problems you notice along the way; report them instead.\n- Report every file touched and what changed in it.' + COMMON },
  'data-extractor': { lane: 'work', model: 'claude-sonnet-5', effort: 'low', tools: 'Read, Grep, Glob', role: 'pulls data into a specified shape',
    mandate: 'You are an extractor: you pull the requested data out of the given sources into exactly the requested shape.\n- No interpretation, no summarizing — the shape in the delegation is the whole contract.\n- Mark cells/fields you could not fill as MISSING rather than guessing.' + COMMON },
  'claim-verifier': { lane: 'check', model: 'claude-sonnet-5', effort: 'high', tools: 'WebFetch, WebSearch', role: 'verifies one claim against its sources',
    mandate: 'You verify exactly one claim. You receive the claim and its source URLs — no plan, no background.\n- Fetch the given sources; judge ONLY against what they say. Verdict: CONFIRMED (quote) / CONTRADICTED (quote) / UNSUPPORTED.\n- Never use prior knowledge to rescue a claim. Flag SINGLE-SOURCED regardless of verdict.\n- Output: `VERDICT: <verdict> [SINGLE-SOURCED]` first line, quote + URL after. Nothing else.' },
  'code-reviewer': { lane: 'check', model: 'claude-sonnet-5', effort: 'high', tools: 'Read, Grep, Glob', role: 'reviews a change for correctness',
    mandate: 'You review exactly the change you are pointed at, for correctness only.\n- For each finding: file, line, the defect, and the concrete input/state where it fails. No style commentary.\n- End with a verdict line: LOOKS CORRECT or N FINDINGS. An honest "looks correct" is a valid result.' + COMMON },
  'skeptic': { lane: 'check', model: 'claude-sonnet-5', effort: 'high', tools: 'Read, Grep, Glob, WebFetch, WebSearch', role: 'tries to refute the conclusion',
    mandate: 'You are the skeptic: your job is to try to knock down the conclusion you are handed.\n- Attack the weakest links: unstated assumptions, single sources, untested paths. Check what you can check.\n- Verdict: REFUTED (with the break), WEAKENED (with the soft spot), or HOLDS. Trying and failing to refute is the valuable result — report it plainly.' + COMMON },
  'synthesizer': { lane: 'deliver', model: 'claude-fable-5', effort: 'xhigh', tools: 'Read', role: 'fresh-context final synthesis and check',
    mandate: 'You are the final synthesis seat. You receive the original request, the workers’ findings, and the checkers’ verdicts — you did NOT write the plan, and that is the point.\n- Where a claim is flagged CONTRADICTED, UNSUPPORTED, or SINGLE-SOURCED, the flag survives into your output or the claim does not.\n- Check the answer against the ORIGINAL request as written; note anything the plan silently narrowed.\n- If the material cannot support a complete answer, say precisely what is missing.\n- Your final message is the finished product, delivered whole. No process narration.' },
  'judge': { lane: 'deliver', model: 'claude-fable-5', effort: 'high', tools: 'Read', role: 'picks between competing options and says why',
    mandate: 'You are the judge: workers produced competing options and you pick one.\n- State the decision criteria first, then score each option against them, then decide. One winner, stated plainly.\n- Note the strongest point of each loser — what the winner should adopt from it, if anything.\n- Your final message is the decision and its reasons. No process narration.' },
};
const LANES = ['work', 'check', 'deliver'];

// Generated coordinator for a CUSTOM graph: the roster and flow come from the nodes, so the prose can never
// disagree with the files — one source builds both.
function buildGraphFiles(nodes) {
  const files = {};
  const byLane = { work: [], check: [], deliver: [] };
  nodes.list.forEach((n, i) => {
    const t = LIB[n.type];
    const name = 'claudible--pb--n' + (i + 1) + '-' + n.type;
    byLane[t.lane].push({ name, type: n.type, model: n.model, effort: n.effort, sendback: n.sendback || 0, role: t.role });
    // SEND-BACK (deliver lane only): the option turns "say what is missing" into a protocol the coordinator
    // can act on — a machine-readable first line, a delegable gap list, and a hard cap baked into the prose.
    const sb = n.sendback ? '\n- SEND-BACK (×' + n.sendback + '): if the material cannot support a complete result, do NOT deliver. Reply with the single word SEND-BACK on the first line, then a numbered list of precisely what is missing — each item specific enough to hand to a worker as-is. You may do this at most ' + n.sendback + ' time' + (n.sendback > 1 ? 's' : '') + ' in one job; when the cap is spent, deliver with the remaining gaps flagged inline.' : '';
    files[name + '.md'] = '---\nname: ' + name + '\ndescription: ' + t.role + ' - a node of the active Claudible graph. Only invoked by the graph coordinator; do not select for ordinary tasks.\ntools: ' + t.tools + '\nmodel: ' + n.model + '\neffort: ' + n.effort + '\n---\n' + HDR + '\n\n' + t.mandate + sb + '\n';
  });
  const coord = nodes.coordinator || { model: 'claude-fable-5', effort: 'high' };
  const rosterLine = (x) => '- `' + x.name + '` (' + NICE(x.model) + ', ' + x.effort + ' effort) — ' + x.role + '.';
  const deliver = byLane.deliver;
  const rules = [];
  rules.push('1. Plan first: break the request into delegations. Delegate every token-heavy leg; keep planning and judgment calls yourself. Skip delegation only for narrow tasks where handing off costs more than doing.');
  rules.push('2. Write FULLY-SPECIFIED delegations: exact scope, constraints, and required output format. Your workers are strictly literal — they will not infer anything you did not state.');
  rules.push('3. All WORK nodes may run in parallel; route each delegation to the node whose role fits it. Do not send work to a node outside its role.');
  if (byLane.check.length) rules.push('4. After your workers return, send their load-bearing output through the CHECK nodes — one claim/change/conclusion per call, in parallel where possible. Never carry a CONTRADICTED, UNSUPPORTED, SINGLE-SOURCED, or REFUTED item forward unflagged.');
  if (deliver.length) rules.push((byLane.check.length ? 5 : 4) + '. You do NOT write the final answer — you planned, so you do not grade your own homework. Hand the ORIGINAL request (verbatim), the findings, and the verdicts to ' + deliver.map((d) => '`' + d.name + '`').join(deliver.length > 1 ? ' (use the judge for choosing between alternatives, the synthesizer for final assembly) and ' : '') + '. Do not include your plan or your framing.');
  else rules.push((byLane.check.length ? 5 : 4) + '. This graph has no DELIVER node: assemble the final answer yourself, against the ORIGINAL request as written, with every flag carried through.');
  const sbNodes = deliver.filter((d) => d.sendback);
  if (sbNodes.length) rules.push((rules.length + 1) + '. SEND-BACK: if ' + sbNodes.map((d) => '`' + d.name + '`').join(' or ') + ' opens its reply with the word SEND-BACK, that reply is NOT the answer — every numbered gap in it becomes a fresh fully-specified delegation to the fitting WORK node' + (byLane.check.length ? ', checked like any other output,' : '') + ' and the ENLARGED material then goes back to the same deliver node. Honor its cap (it states one); never loop past it.');
  const nr = rules.length + 1;
  rules.push(nr + '. NEVER end your turn while any delegation, check, or handoff is still outstanding. Progress narration is not an answer. Your turn ends exactly once.');
  rules.push((nr + 1) + '. Your final message ' + (deliver.length ? 'relays the deliver node’s answer unaltered, then' : 'is the finished answer, then') + ' one closing line reporting which nodes ran and roughly what each did.');
  files['claudible--pb--coordinator.md'] = '---\nname: claudible--pb--coordinator\ndescription: Coordinator for the active Claudible graph. Plans on a strong model, delegates to the graph’s nodes. Only invoked via the plan-big skill; do not select for ordinary tasks.\ntools: Agent, Read, Grep, Glob, TodoWrite\nmodel: ' + coord.model + '\neffort: ' + coord.effort + '\n---\n' + HDR + '\n\nYou are the coordinator of a user-built graph. You plan and delegate; your nodes execute. Keep the token-heavy legs OUT of your own context.\n\nYour nodes, spawned via the Agent tool by these exact names:\n'
    + LANES.filter((l) => byLane[l].length).map((l) => byLane[l].map(rosterLine).join('\n')).join('\n') + '\n\nRules:\n' + rules.join('\n') + '\n';
  return files;
}

// Remove ONLY this tool's own generated node files (claudible--pb--n<digits>-<type>.md) — the strict regex
// IS the guard: nothing outside the reserved graph-node pattern can ever match, so a user-authored
// definition is untouchable by construction.
function pruneGraphNodes(agentsDir) {
  let entries = [];
  try { entries = fs.readdirSync(agentsDir); } catch { return; }
  for (const f of entries) if (/^claudible--pb--n\d+-[a-z-]+\.md$/.test(f)) { try { fs.unlinkSync(path.join(agentsDir, f)); } catch {} }
}

function main(mode, cfgJson) {
  const home = os.homedir();
  const agentsDir = path.join(home, '.claude', 'agents');
  const skillDir = path.join(home, '.claude', 'skills', 'plan-big');
  if (mode === 'on') {
    // Seat overrides (custom strategy): allowlisted per field — an unknown model or effort REJECTS the whole
    // call rather than silently falling back, so the UI can never claim a seat the files don't implement.
    const seats = {};
    for (const k of Object.keys(SEATS)) seats[k] = { model: SEATS[k].model, effort: SEATS[k].effort };
    if (cfgJson) {
      let cfg; try { cfg = JSON.parse(cfgJson); } catch { return { ok: false, error: 'bad seat config JSON' }; }
      if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'bad seat config' };
      for (const [k, v] of Object.entries(cfg)) {
        if (!seats[k] || !v || typeof v !== 'object') return { ok: false, error: 'unknown seat: ' + String(k).slice(0, 40) };
        if (v.model !== undefined) { if (!MODELS.includes(v.model)) return { ok: false, error: 'unknown model for ' + k }; seats[k].model = v.model; }
        if (v.effort !== undefined) { if (!EFFORTS.includes(v.effort)) return { ok: false, error: 'unknown effort for ' + k }; seats[k].effort = v.effort; }
      }
    }
    const wrote = [];
    fs.mkdirSync(agentsDir, { recursive: true });
    pruneGraphNodes(agentsDir);   // the fixed five replace any custom graph's node files
    for (const [name, body] of Object.entries(buildAgents(seats))) { fs.writeFileSync(path.join(agentsDir, name), body, 'utf8'); wrote.push(name); }
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL, 'utf8'); wrote.push('plan-big/SKILL.md');
    return { ok: true, wrote, seats };
  }
  if (mode === 'graph') {
    // CUSTOM graph: cfg = {coordinator:{model,effort}, nodes:[{type,model,effort}, …]}. Every value
    // allowlisted; an unknown type/model/effort rejects the whole call — the UI can never claim a node the
    // files don't implement.
    let cfg; try { cfg = JSON.parse(cfgJson || ''); } catch { return { ok: false, error: 'bad graph JSON' }; }
    if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.nodes) || !cfg.nodes.length) return { ok: false, error: 'a graph needs at least one node' };
    if (cfg.nodes.length > 200) return { ok: false, error: 'too many nodes' };
    const coord = { model: 'claude-fable-5', effort: 'high' };
    if (cfg.coordinator && typeof cfg.coordinator === 'object') {
      if (cfg.coordinator.model !== undefined) { if (!MODELS.includes(cfg.coordinator.model)) return { ok: false, error: 'unknown coordinator model' }; coord.model = cfg.coordinator.model; }
      if (cfg.coordinator.effort !== undefined) { if (!EFFORTS.includes(cfg.coordinator.effort)) return { ok: false, error: 'unknown coordinator effort' }; coord.effort = cfg.coordinator.effort; }
    }
    const list = [];
    for (const n of cfg.nodes) {
      if (!n || typeof n !== 'object' || !LIB[n.type]) return { ok: false, error: 'unknown node type: ' + String(n && n.type).slice(0, 40) };
      const t = LIB[n.type];
      const model = n.model === undefined ? t.model : n.model;
      const effort = n.effort === undefined ? t.effort : n.effort;
      if (!MODELS.includes(model)) return { ok: false, error: 'unknown model for ' + n.type };
      if (!EFFORTS.includes(effort)) return { ok: false, error: 'unknown effort for ' + n.type };
      let sendback = 0;
      if (n.sendback !== undefined && n.sendback !== 0) {
        // 3 and 5 added 2026-08-19 with the header's Loop Settings control (owner sign-off). The list stays an
        // ALLOWLIST of finite caps — "loop until done" is 5, never unbounded. 1 is kept for graphs saved before
        // that control existed, though the UI no longer offers it.
        if (![1, 2, 3, 5].includes(n.sendback)) return { ok: false, error: 'bad send-back for ' + n.type };
        if (t.lane !== 'deliver') return { ok: false, error: 'send-back is a deliver-lane option' };
        sendback = n.sendback;
      }
      list.push({ type: n.type, model, effort, sendback });
    }
    const wrote = [];
    fs.mkdirSync(agentsDir, { recursive: true });
    pruneGraphNodes(agentsDir);   // clear the previous graph's node files before writing this one's
    for (const [name, body] of Object.entries(buildGraphFiles({ coordinator: coord, list }))) { fs.writeFileSync(path.join(agentsDir, name), body, 'utf8'); wrote.push(name); }
    // the fixed seats not present in a custom graph become stale — overwrite research/mechanical/verifier/
    // synthesis with the graph's coordinator roster ONLY if they linger? No: they carry the reserved prefix
    // and the generated coordinator names only its own nodes, so the seat files are inert. Left in place.
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL, 'utf8'); wrote.push('plan-big/SKILL.md');
    return { ok: true, wrote, nodes: list.length };
  }
  if (mode === 'off') {
    const removed = [];
    // the guard in file form: the ONLY deletion this tool can perform is the plan-big skill dir
    try { if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) { fs.rmSync(skillDir, { recursive: true }); removed.push('plan-big/'); } } catch {}
    return { ok: true, removed };
  }
  return { ok: false, error: 'mode must be on|off' };
}

let out;
try { out = main(String(process.argv[2] || ''), process.argv[3] ? String(process.argv[3]) : ''); } catch (e) { out = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
process.stdout.write(JSON.stringify(out));
