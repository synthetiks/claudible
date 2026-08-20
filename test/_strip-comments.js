'use strict';
// test/_strip-comments.js — remove comments from a source file so the static pins search CODE and
// never a sentence about code. Shared by every suite that does that, because getting it wrong is
// silent: a pin that cannot find its pattern still reports PASS whenever it asserts an ABSENCE, so a
// broken stripper turns guards into decoration without anyone seeing a failure.
//
// WHAT WENT WRONG WITH THE OBVIOUS VERSION, which was two chained regexes:
//     s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
// It stripped BLOCK comments first, so a `/*` sitting inside a LINE comment was still treated as the
// start of one. main.js:549 ends with `// … (asar:false, setup/** included)`, and that `/**` is a
// glob in prose. With no `*/` after it the match never completed and the bug lay dormant for months.
// The moment somebody added an ordinary `/* … */` comment further down the file, that glob paired
// with it and the replace deleted everything in between — 305KB of a 396KB file, silently, before a
// single pin ran. Exactly one pin failed loudly, and only because it happened to assert a presence.
//
// So this is a single left-to-right pass that knows what it is inside of. Strings, template
// literals and regex literals are copied through untouched; only real comments are removed. Line
// comments keep their newline and block comments do not, matching what the pins have always
// assumed about spacing.

// Characters after which a `/` begins a REGEX rather than a division. Anything else (an identifier,
// a number, a closing bracket) means the `/` is an operator. This is the standard heuristic and it
// is sufficient here: being wrong can only mean copying a few characters through unchanged, never
// deleting code.
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n']);
const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function stripComments(src) {
  const s = String(src == null ? '' : src);
  let out = '';
  let i = 0;
  let lastSignificant = '';   // last non-whitespace character of real code, for the regex/division call
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];

    // --- comments: the only thing this function removes ---
    if (c === '/' && d === '/') {
      while (i < n && s[i] !== '\n') i++;
      continue;                                   // the newline itself is left for the next iteration
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;                                     // past the closing */ (or past the end, for an unterminated one)
      continue;
    }

    // --- string and template literals: copied through verbatim ---
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i];
        if (s[i] === quote) { i++; break; }
        // A plain quote ends at a newline even when unterminated, so one stray quote cannot swallow
        // the rest of the file the way the old block-comment match could.
        if (quote !== '`' && s[i] === '\n') { i++; break; }
        i++;
      }
      lastSignificant = quote;
      continue;
    }

    // --- regex literals: also copied through verbatim, character class aware ---
    if (c === '/' && (BEFORE_REGEX.has(lastSignificant) || lastSignificant === '' || KEYWORD_BEFORE_REGEX.test(out))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = s[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;                   // an unterminated regex is not a regex — fall through and treat the / as an operator
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(s[j])) j++;   // trailing flags
        out += s.slice(i, j);
        i = j;
        lastSignificant = '/';
        continue;
      }
    }

    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    else if (c === '\n') lastSignificant = '\n';
    i++;
  }
  return out;
}

// A BACKSTOP, not a nicety. The failure this whole file exists to prevent is losing a large slice of
// the corpus without anyone noticing, and no future variant of that bug will announce itself either.
// Comments are dense in this codebase but they are not most of it: a strip that leaves less than a
// third of the file behind has eaten code, and the suite must stop rather than measure the remains.
function assertStripSane(original, stripped, label) {
  const before = String(original || '').length;
  const after = String(stripped || '').length;
  if (before > 2000 && after < before * 0.33) {
    throw new Error(
      'stripComments removed ' + Math.round((1 - after / before) * 100) + '% of ' + (label || 'the source') +
      ' (' + before + ' -> ' + after + ' chars). That is code, not comments — every pin over the missing ' +
      'region is now searching a string that does not contain it, and the ones asserting absence would ' +
      'have passed silently. Fix the stripper before trusting this run.'
    );
  }
  return stripped;
}

// The one call sites should use: strip, then prove the strip was sane.
function stripCode(src, label) {
  return assertStripSane(src, stripComments(src), label);
}

module.exports = { stripComments, assertStripSane, stripCode };
