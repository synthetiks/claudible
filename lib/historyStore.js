'use strict';
const { ringPush } = require('./history.js');
// Disk persistence for the event log. Atomic write (temp + rename) so a crash never leaves a
// half-written log. Missing/corrupt file -> [] (never throws). `fs` is injected, so it unit-tests
// against a real temp dir or a fake. The base dir is chosen by the caller (default: gitignored
// .claudible/<workspace>/history.json — local-first; the live channel carries it cross-machine).

function load(fs, file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function save(fs, file, log) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
  fs.renameSync(tmp, file);
}

function append(fs, file, entry, max) {
  const next = ringPush(load(fs, file), entry, max);
  save(fs, file, next);
  return next;
}

module.exports = { load, save, append, _internals: { load, save, append } };
