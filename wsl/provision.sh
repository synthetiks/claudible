#!/usr/bin/env bash
# wsl/provision.sh — install ONE dependency on WSL / native Linux / macOS for the self-bootstrapping
# provisioner (runners/deps.js installPosix). Claude itself uses install-claude.sh; this handles the rest.
# Emits a single JSON line {"ok":bool[,"error":str]}. Mirrors setup/setup.sh's apt/brew/curl branches.
# (node via the distro package may be older than 22.12 — the proven WSL voice path is the recommended one;
# detection will flag an outdated node so the user can upgrade.)

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/node-path.sh" 2>/dev/null || true   # nvm's node isn't on PATH for non-interactive shells — without this the `node` case below can judge the WRONG node (system vs nvm)

dep="$1"
ok()  { printf '{"ok":true}\n'; exit 0; }
err() { printf '{"ok":false,"error":"%s"}\n' "$(printf '%s' "$1" | tr -d '\000-\037"\\')"; exit 0; }
have() { command -v "$1" >/dev/null 2>&1; }
# Run a command with root privileges — directly if we already ARE root, else via sudo, but ONLY if sudo can run
# WITHOUT a password. This script is invoked through runScript() with NO TTY and NO stdin (wsl.js: cp.execFile
# 'wsl.exe' '-e' 'bash' '-lc'), so a sudo that needs a password can never succeed — it fails instantly. When that
# is the case as_root returns the sentinel 2, so callers can report the accurate "run this yourself" message
# instead of the misleading "no apt/brew" one the old code emitted for what is really a permissions problem.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; return $?; fi
  sudo -n true 2>/dev/null || return 2
  sudo "$@"
}
pkg_err() {   # $1 = dep, $2 = the failing pkg() exit code → the accurate, actionable error
  case "$2" in
    2) err "installing $1 needs admin rights, and this installer has no way to prompt for your password — open your WSL/Linux terminal and run:  sudo apt-get install -y $1" ;;
    3) err "no package manager (apt or brew) found — install $1 manually, then retry" ;;
    *) err "$1 could not be installed automatically — install it manually, then retry" ;;
  esac
}
pkg() {   # install system packages via apt (Debian/WSL, needs root) or brew (macOS, no root); distinct exit codes
  if have apt-get; then
    as_root true || return 2                                       # can't get root non-interactively → tell the truth
    as_root apt-get update -y >/dev/null 2>&1; as_root apt-get install -y "$@" >/dev/null 2>&1
  elif have brew; then brew install "$@" >/dev/null 2>&1           # brew's own exit (1 on failure) now maps to the generic "couldn't install" — NOT "no package manager", which it used to collide with
  else return 3; fi                                               # neither apt nor brew — a DISTINCT sentinel (was 1, which brew's failure also returns)
}

case "$dep" in
  node)
    # Presence isn't enough — Claudible needs >=22.12, and the distro 'nodejs' package is often older. Gate on
    # VERSION (not just `have node`) so the System-check wizard can actually self-heal an outdated node.
    nok() { have node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' >/dev/null 2>&1; }
    nok && ok
    if have apt-get; then
      as_root true || err "installing Node needs admin rights, and this installer has no way to prompt for your password — open your WSL/Linux terminal and run:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -  &&  sudo apt-get install -y nodejs"
      if [ "$(id -u)" = 0 ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
      else curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1; fi
      as_root apt-get install -y nodejs >/dev/null 2>&1
    elif have brew; then brew install node@22 >/dev/null 2>&1; brew link --overwrite --force node@22 >/dev/null 2>&1
    else err "no apt/brew to install node"; fi
    nok && ok || err "node is still older than 22.12 — upgrade from https://nodejs.org"
    ;;
  git)         have git && ok;  pkg git; rc=$?; have git && ok;  pkg_err git "$rc" ;;
  gh)          have gh && ok;   pkg gh;  rc=$?; have gh && ok
               [ "$rc" = 2 ] && err "installing gh needs admin rights, and this installer can't prompt for your password — open your WSL/Linux terminal and run:  sudo apt-get install -y gh  (or see https://cli.github.com)"
               err "could not install gh automatically — see https://cli.github.com" ;;
  cloudflared)
    # EXEC-validate (run --version), never just `have` (command -v): a truncated/corrupt binary left on PATH by a
    # prior half-install passes `have` but can't run, so `have && ok` would falsely report success. Same rule the
    # download branch below already applies — now applied to BOTH fast paths too.
    have cloudflared && cloudflared --version >/dev/null 2>&1 && ok
    pkg cloudflared && { have cloudflared && cloudflared --version >/dev/null 2>&1 && ok; }   # brew (macOS) / apt (rare on stock WSL) → else fall back to Cloudflare's official release below
    arch="$(uname -m)"; case "$arch" in x86_64|amd64) a=amd64 ;; aarch64|arm64) a=arm64 ;; armv7l) a=arm ;; *) a=amd64 ;; esac
    if [ "$(uname -s)" = "Darwin" ]; then
      # macOS ships a .tgz, NOT a bare binary — downloading cloudflared-linux here would drop a Linux ELF that
      # `have` still finds on PATH (so `ok` would falsely report success while `cloudflared` never runs). Pull the
      # darwin tarball and extract its binary instead.
      tgz="$(mktemp)"; ex="$(mktemp -d)"
      if curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$a.tgz" -o "$tgz" 2>/dev/null && [ -s "$tgz" ] && tar -xzf "$tgz" -C "$ex" 2>/dev/null && [ -f "$ex/cloudflared" ]; then
        chmod +x "$ex/cloudflared"; sudo mv "$ex/cloudflared" /usr/local/bin/cloudflared 2>/dev/null || { mkdir -p "$HOME/.local/bin"; mv "$ex/cloudflared" "$HOME/.local/bin/cloudflared"; }
      fi
      rm -f "$tgz" 2>/dev/null; rm -rf "$ex" 2>/dev/null
    else
      tmp="$(mktemp)"
      if curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$a" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        chmod +x "$tmp"; sudo mv "$tmp" /usr/local/bin/cloudflared 2>/dev/null || { mkdir -p "$HOME/.local/bin"; mv "$tmp" "$HOME/.local/bin/cloudflared"; }
      fi
    fi
    # Validate by actually RUNNING it, not just `have` (command -v) — a truncated-but-nonzero-size download
    # passes the `[ -s ]` checks above yet can't execute, and `have` would still report a false ok.
    if have cloudflared && cloudflared --version >/dev/null 2>&1; then ok; fi
    cfbin="$(command -v cloudflared 2>/dev/null)"
    [ -n "$cfbin" ] && rm -f "$cfbin"   # don't leave a broken binary on PATH claiming to be installed
    err "could not install cloudflared (https://developers.cloudflare.com/cloudflared/)"
    ;;
  uv)
    have uv && ok
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
    { [ -x "$HOME/.local/bin/uv" ] || have uv; } && ok || err "uv install failed"
    ;;
  voice)
    # Reuse setup.sh unchanged (it's also the direct `npm run setup` entry point) rather than duplicating its
    # whisper.cpp/Kokoro build+download logic here. It isn't JSON-shaped — it's `say()` progress lines for a
    # terminal — so capture it and translate: exit 0 -> ok; non-zero -> its own last say() line is already the
    # actionable message ("run this, then re-run `npm run setup`"), which is exactly what a failure here should show.
    _here="$(cd "$(dirname "$0")" && pwd)"
    VOICE="${CLAUDIBLE_VOICE:-$HOME/.claudible/voice}"
    mkdir -p "$(dirname "$VOICE")"
    _lock="$(dirname "$VOICE")/voice-install.lock"   # mkdir is atomic → a cross-process lock; lives in VOICE's PARENT so it survives setup.sh's own `rm -rf "$VOICE/..."` calls

    # The caller (runners/deps.js) bounds this whole call with a ~10min timeout by killing the wsl.exe WRAPPER on
    # the Windows side — that kill never reaches this Linux-side process (same interop gap killtree.sh documents
    # for the pty), so a "timed out" install can keep running here as an ORPHAN while the caller retries. Without
    # a lock, the retry's setup.sh would `rm -rf "$VOICE/whisper"` (etc.) out from under the still-running orphan.
    if ! mkdir "$_lock" 2>/dev/null; then
      _holder="$(cat "$_lock/pid" 2>/dev/null || echo 0)"
      _started="$(cat "$_lock/started" 2>/dev/null || echo 0)"
      _age=$(( $(date +%s) - _started ))
      # Refuse on LIVENESS, not just elapsed time. The old age-only rule both (a) blocked a legitimate retry for a
      # full 2h when the holder had already died without cleanup, and (b) reclaimed purely on age without checking
      # the holder was gone. If we recorded the holder PID, trust it: alive → still running, refuse; dead → reclaim
      # now. Fall back to the 2h age heuristic only for a pre-upgrade lock that has no pid file.
      _busy=0
      if [ "$_holder" -gt 0 ] 2>/dev/null; then
        kill -0 "$_holder" 2>/dev/null && _busy=1
      elif [ "$_age" -lt 7200 ]; then
        _busy=1
      fi
      if [ "$_busy" = 1 ]; then
        err "a voice install is already in progress (started ~$(( _age / 60 )) min ago) — wait for it to finish, then retry"
      fi
      rm -rf "$_lock"; mkdir "$_lock" 2>/dev/null || true   # holder is dead (or a pid-less lock older than 2h) → reclaim
    fi
    date +%s > "$_lock/started" 2>/dev/null || true
    echo $$ > "$_lock/pid" 2>/dev/null || true   # record the holder so a later attempt can check liveness, not just age

    _log="$(mktemp)"
    "$_here/../setup/setup.sh" >"$_log" 2>&1 &
    _pid=$!
    # session id, captured now — for the SID sweep below (same idiom as killtree.sh: catches a double-forked/
    # detached child that would otherwise escape the parent-pointer walk).
    _sid="$(ps -o sess= -p "$_pid" 2>/dev/null | tr -d ' ')"
    [ "$_sid" = "$_pid" ] || _sid=""   # only sweep if setup.sh IS the session leader — else its sid is shared with unrelated processes
    for ((_i = 0; _i < 270; _i++)); do   # 2s * 270 = 9 min — comfortably under the caller's ~10min cutoff, so WE clean up instead of leaving an orphan for it to miss
      kill -0 "$_pid" 2>/dev/null || break
      sleep 2
    done
    if kill -0 "$_pid" 2>/dev/null; then
      # REAL timeout: reap the WHOLE tree, not just $_pid — STOP-then-walk (same idiom as killtree.sh) so nothing
      # forks into the gap between snapshotting children and killing them, plus the SID sweep for anything detached.
      _kill_tree() { kill -STOP "$1" 2>/dev/null; local c; for c in $(pgrep -P "$1" 2>/dev/null); do _kill_tree "$c"; done; kill -KILL "$1" 2>/dev/null; }
      _kill_tree "$_pid"
      case "$_sid" in '' | 0 | *[!0-9]*) ;; *)
        for _p in $(ps -eo pid=,sess= 2>/dev/null | awk -v s="$_sid" '$2==s {print $1}'); do kill -KILL "$_p" 2>/dev/null; done ;;
      esac
      wait "$_pid" 2>/dev/null
      rm -rf "$_lock"; rm -f "$_log"
      err "voice install timed out after 9 minutes — re-run \`npm run setup\` in a WSL terminal to see where it's stuck"
    fi
    wait "$_pid"; _rc=$?
    if [ "$_rc" -eq 0 ]; then rm -rf "$_lock"; rm -f "$_log"; ok; fi
    # say()'s bold/reset codes (\033[1m / \033[0m) survive as literal "[1m"/"[0m" once err()'s tr strips only the
    # ESC byte, not the whole escape sequence — strip the full CSI sequence here so the wizard shows clean text.
    _msg="$(sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$_log" | grep -v '^[[:space:]]*$' | tail -n 4 | tr '\n' ' ')"
    rm -rf "$_lock"; rm -f "$_log"
    err "${_msg:-voice setup failed - run: npm run setup}"
    ;;
  *) err "unknown dependency: $dep" ;;
esac
