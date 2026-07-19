// Claudible ESLint — signal, not style. This is a correctness net, not a formatter: it exists to catch the
// classes of bug that actually shipped here (dead vars behind `if (el)` guards, a typo'd global, a `==` where
// `===` was meant), not to relitigate whitespace. Run: `npm run lint`. CI-gated.
//
// Three execution environments, because this repo runs code in three of them and they have different globals:
//   * Node        — main.js, lib/, runners/, hooks/, wsl/*.js, test/
//   * Electron renderer — renderer/app.js: a browser context PLUS the `claudible` preload bridge and xterm's
//                         `Terminal`, loaded as one non-module <script> (no import/export).
//   * Browser guest — share/guest.js + share/voice-core.js: a plain browser tab, no preload, no Node.
'use strict';

const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', console: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', queueMicrotask: 'readonly', URL: 'readonly', TextEncoder: 'readonly',
  TextDecoder: 'readonly', globalThis: 'readonly',
  // Node 18+ web-platform globals the voice/tts handlers use
  fetch: 'readonly', Blob: 'readonly', FormData: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  fetch: 'readonly', WebSocket: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  Blob: 'readonly', FileReader: 'readonly', Audio: 'readonly', AudioContext: 'readonly',
  webkitAudioContext: 'readonly', MediaRecorder: 'readonly', ResizeObserver: 'readonly',
  MutationObserver: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', atob: 'readonly', btoa: 'readonly',
  CustomEvent: 'readonly', Event: 'readonly', getComputedStyle: 'readonly', alert: 'readonly',
  confirm: 'readonly', prompt: 'readonly', structuredClone: 'readonly', crypto: 'readonly',
};

// The rules. Deliberately small — every one has caught (or would have caught) a real defect class here.
const RULES = {
  'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-undef': 'error',                       // a typo'd global / a call to a function that doesn't exist — this rule
                                             // found `listSessions()` (undefined, silently broke a sync guard). Its whole point.
  'no-cond-assign': ['error', 'except-parens'],   // catches `if (x = y)`; allows the idiomatic `while ((m = re.exec(s)))`
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-async-promise-executor': 'error',
  'no-empty-pattern': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'no-var': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],   // `== null` is an idiom here; everything else must be ===
  // NOT gated: `require-atomic-updates`. It flagged 35 sites here, ~all false positives (the standard
  // "assign an outer var after an await" pattern, benign in a single-threaded renderer). The genuine await-holes
  // the reliability audit found (e.g. workspace:acceptInvite) get targeted fixes with real reasoning — a blanket
  // gate would force 35 inline disables, which is noise, not signal.
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'runtime/**', 'patches/**', 'assets/**', 'test/fixtures/**'] },

  // Node: main process, libs, runners, node-side hooks, wsl tool scripts, tests. share/cloudflared.js and
  // share/server.js are node too (required by main.js) — before they were listed here they matched NO block
  // and were silently unlinted, which is how a whole file can drift with zero gate.
  {
    files: ['main.js', 'preload.js', 'lib/**/*.js', 'runners/**/*.js', 'hooks/**/*.js', 'wsl/**/*.js', 'test/**/*.js', 'eslint.config.js', 'share/cloudflared.js', 'share/server.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: NODE_GLOBALS },
    rules: RULES,
  },

  // Electron renderer: browser globals + the preload bridge + xterm, one classic <script> (not a module)
  {
    files: ['renderer/app.js'],
    languageOptions: {
      ecmaVersion: 2022, sourceType: 'script',
      // makeVoiceRoom is defined in share/voice-core.js, loaded as a separate <script> before app.js.
      globals: { ...BROWSER_GLOBALS, claudible: 'readonly', Terminal: 'readonly', FitAddon: 'readonly', makeVoiceRoom: 'readonly' },
    },
    rules: RULES,
  },

  // Browser guest page (served over the tunnel; no preload, no Node). These two files predate the house
  // let/const style and are written entirely in `var`. `no-var` is pure style, not correctness, and these are
  // browser-only files with no test harness — hand-converting 26 hoisting-sensitive vars (several scoped to a
  // try block) risks a TDZ crash for a guest we can't smoke-test here. So `no-var` is off for these two ONLY;
  // every correctness rule still applies, and the rest of the codebase stays gated.
  {
    files: ['share/guest.js', 'share/voice-core.js'],
    languageOptions: {
      ecmaVersion: 2022, sourceType: 'script',
      // guest.js and voice-core.js are separate <script>s in guest.html; makeVoiceRoom is voice-core.js's export.
      globals: { ...BROWSER_GLOBALS, Terminal: 'readonly', FitAddon: 'readonly', makeVoiceRoom: 'readonly' },
    },
    rules: { ...RULES, 'no-var': 'off' },
  },
];
