'use strict';
// Claudible — Node port of the python3 transform in agent-tokens.sh (removes the python3 dependency).
// Shared by the WSL/Posix/Windows backends; output MUST stay byte-identical to the original python.
//
// Original python (single block):
//   import sys, os, glob, json
//   d = sys.argv[1]; tot = 0
//   for f in glob.glob(os.path.join(d, '**', '*.jsonl'), recursive=True):
//       try:
//           for line in open(f, encoding='utf-8', errors='ignore'):
//               try: o = json.loads(line)
//               except Exception: continue
//               u = (o.get('message') or {}).get('usage') or {}
//               tot += (u.get('output_tokens', 0) or 0) + (u.get('cache_creation_input_tokens', 0) or 0)
//       except Exception:
//           pass
//   print(tot)
//
// Notes / parity decisions:
// - glob '**/*.jsonl' (recursive=True) matches files directly in `d` (zero-dir case) AND nested, and
//   EXCLUDES any path component beginning with '.' (python glob skips dotfiles/dotdirs). We replicate
//   that by walking with fs and skipping entries whose basename starts with '.'.
// - Per-file abort: the inner try skips a single bad-JSON line (continue); the OUTER try/except: pass
//   means any OTHER error (e.g. a token value being a string -> int + str TypeError, or `o`/`message`/
//   `usage` being a truthy non-dict so .get raises) aborts the REST of that file while keeping the
//   tokens accumulated so far. We mirror this: dictGet throws on a truthy non-object, and a non-number
//   token after the `|| 0` coercion throws (like python's int + str) — caught per file, total preserved.
// - print(tot) emits the integer followed by '\n'.
// - Float caveat: JSON.parse collapses 5.0 -> 5 (vs python json keeping the float, print -> '5.0').
//   This is unrecoverable with JSON.parse and only matters if token fields are non-integer floats, which
//   they are not in real data — so the integer sum is byte-identical for all real inputs.

const fs = require('fs');
const path = require('path');

// Recursively collect '*.jsonl' files like python glob('**/*.jsonl', recursive=True):
// includes files directly in `dir` and in subdirs, EXCLUDING any name starting with '.'.
function collectJsonl(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (name.charCodeAt(0) === 0x2e /* '.' */) continue; // python glob skips dotfiles/dotdirs
    const full = path.join(dir, name);
    if (ent.isDirectory()) {
      for (const f of collectJsonl(full)) out.push(f);
    } else if (ent.isFile() && name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

// Python truthiness for the `or` operator: None/0/False/'' AND empty list/dict are falsy.
// JS `!x` / `x ? :` would treat [] and {} as truthy, diverging from python (an empty array/dict in a
// message/usage/token slot makes python `or {}`/`or 0` substitute the default, where JS would keep the
// empty container and throw). pyFalsy() restores python's semantics so behavior stays byte-identical.
function pyFalsy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// Mirror python dict.get on a value that must behave like a dict. `(o.get('message') or {})`:
// python raises AttributeError if `o` is a truthy non-dict (str, int, list). We replicate by throwing
// for a truthy non-plain-object, so the outer per-file try/catch aborts that file like python.
function getDict(o, key) {
  // `o or {}` already applied by caller for the falsy case; here o is the (possibly truthy) value.
  if (o === null || o === undefined) return undefined; // python: {}.get(key) -> None
  if (typeof o !== 'object' || Array.isArray(o)) {
    // truthy non-dict -> python .get raises -> abort rest of file
    throw new TypeError('not a dict');
  }
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

function main() {
  const d = process.argv[2];
  let tot = 0;
  if (d === undefined) {
    // python with no argv[1] would IndexError before printing -> nonzero exit, hitting the shell
    // fallback. Match by exiting nonzero (no output) rather than printing a bogus total.
    process.exit(1);
  }
  const files = collectJsonl(d);
  for (const f of files) {
    try {
      let data;
      try {
        data = fs.readFileSync(f, 'utf8');
      } catch (e) {
        // python open() failure is caught by the outer except: pass (skip this file).
        continue;
      }
      // Iterating `open(f)` yields lines split on universal newlines; a trailing empty segment from a
      // final newline is not yielded. Use /\r?\n/ and json.loads('') raises -> skipped (continue).
      const lines = data.split(/\r?\n/);
      // python's line iteration does not produce a final empty line for a trailing '\n'; drop one
      // trailing '' to avoid an extra (harmless, since json.loads('') just `continue`s) empty parse.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let o;
        try {
          o = JSON.parse(line);
        } catch (e) {
          continue; // bad JSON line -> python `except Exception: continue`
        }
        // u = (o.get('message') or {}).get('usage') or {}
        // o must be a dict for o.get; json top-level non-object is possible (e.g. a number/array/null).
        if (o === null || typeof o !== 'object' || Array.isArray(o)) {
          // python: o.get(...) raises -> outer except aborts rest of THIS file.
          throw new TypeError('top-level not a dict');
        }
        let msg = Object.prototype.hasOwnProperty.call(o, 'message') ? o['message'] : undefined;
        if (pyFalsy(msg)) msg = {}; // `or {}` — empty []/{} are falsy in python, so substitute {}
        // getDict throws if msg is truthy non-dict (python .get raises); a substituted {} is fine.
        let u = getDict(msg, 'usage');
        if (pyFalsy(u)) u = {}; // `or {}` — empty []/{}/None -> {}
        if (typeof u !== 'object' || Array.isArray(u)) {
          throw new TypeError('usage not a dict'); // truthy non-dict -> python .get raises
        }
        // (u.get('output_tokens', 0) or 0) + (u.get('cache_creation_input_tokens', 0) or 0)
        let ot = Object.prototype.hasOwnProperty.call(u, 'output_tokens') ? u['output_tokens'] : 0;
        if (pyFalsy(ot)) ot = 0; // `or 0` (covers None/0/false/''/empty container)
        let cc = Object.prototype.hasOwnProperty.call(u, 'cache_creation_input_tokens')
          ? u['cache_creation_input_tokens']
          : 0;
        if (pyFalsy(cc)) cc = 0; // `or 0`
        if (typeof ot !== 'number' || typeof cc !== 'number') {
          // python: int + str raises TypeError -> outer except aborts rest of THIS file.
          throw new TypeError('token value not numeric');
        }
        tot += ot + cc;
      }
    } catch (e) {
      // outer `except Exception: pass` — abort the rest of this file, keep `tot` so far.
    }
  }
  process.stdout.write(String(tot) + '\n');
}

main();
