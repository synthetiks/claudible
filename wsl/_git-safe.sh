# shellcheck shell=bash
# Claudible — neutralize the command-executing keys in a workspace's `.git/config`. SOURCE this (`. _git-safe.sh`)
# at the top of any script that runs `git` inside a workspace directory, BEFORE the first git call.
#
# WHY: an ADOPTED project is a folder the user already had — its entire `.git/config` is attacker-controlled (a
# "starter template" zip can ship a poisoned `.git/`). git reads several config keys whose VALUE is a shell command
# it runs during ordinary operations — verified live: `core.fsmonitor` fires on `git diff HEAD` (so it reaches the
# 4-second Project-History poll), and `core.sshCommand` fires on any ssh-URL fetch. Validating the remote is not
# enough; the safe model is "trust NO config value that runs a command."
#
# HOW: git ≥ 2.31 applies GIT_CONFIG_KEY_<n>/VALUE_<n> as if passed via `-c`, to EVERY git command in the process —
# and `-c` overrides the repo's own config. So one export up front hardens every later `git` call in the script.
# On older git these vars are simply ignored (no error), so this degrades to a no-op rather than breaking anything.
# `protocol.file` is deliberately left at git's default: a local-path origin is a legitimate (if rare) setup, and
# the `file` transport runs no remote-side code — only `ext` is an execution vector.
git_safe_env() {
  export GIT_CONFIG_COUNT=6
  export GIT_CONFIG_KEY_0='core.fsmonitor';           export GIT_CONFIG_VALUE_0=''       # index-refresh hook command
  export GIT_CONFIG_KEY_1='core.sshCommand';          export GIT_CONFIG_VALUE_1='ssh'    # per-repo ssh command (RCE, verified)
  export GIT_CONFIG_KEY_2='core.alternateRefsCommand'; export GIT_CONFIG_VALUE_2=''      # alternate-refs enumeration command
  export GIT_CONFIG_KEY_3='core.gitProxy';            export GIT_CONFIG_VALUE_3=''       # git:// proxy command
  export GIT_CONFIG_KEY_4='protocol.ext.allow';       export GIT_CONFIG_VALUE_4='never'  # `ext` transport = arbitrary command
  export GIT_CONFIG_KEY_5='protocol.git.allow';       export GIT_CONFIG_VALUE_5='never'  # unauthenticated git:// has no place here
  # …and the ssh command itself may not escalate to a GUI passphrase dialog if it ever does run.
  export GIT_TERMINAL_PROMPT=0 SSH_ASKPASS_REQUIRE=never
  unset GIT_ASKPASS SSH_ASKPASS 2>/dev/null || true
}
git_safe_env
