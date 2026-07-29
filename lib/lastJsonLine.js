'use strict';
// Claudible — extract the LAST line of a script's stdout that parses as a JSON object/array.
//
// Every wsl/ script that reports JSON prints exactly ONE JSON line, last. But runScript's wrapper is
// `bash -lc` — a LOGIN shell — so anything a user's profile prints (an nvm banner, a conda activation
// notice, a corporate MOTD) lands in stdout ABOVE that line. `JSON.parse(stdout)` then throws, and the
// SyntaxError's own text ("Unexpected token 'W', \"Welcome to\"… is not valid JSON") is what reached the
// onboarding wizard as the "install error". Scanning from the END finds the script's real result under
// any amount of banner noise; a line has to LOOK like JSON (`{`/`[`) before a parse is attempted, so a
// banner line can't cost a throw, and a parseable SCALAR (a stray "0" from some profile) is not mistaken
// for a result.
//
// `fallback` is returned when no line parses — callers pass their "no output" shape.
function lastJsonLine(raw, fallback) {
  const lines = String(raw == null ? '' : raw).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') return v;
    } catch {}
  }
  return fallback;
}
module.exports = { lastJsonLine };
