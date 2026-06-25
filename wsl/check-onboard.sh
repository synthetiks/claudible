#!/usr/bin/env bash
# Onboarding status probe — cross-runner (run via the active runner's runScript: git-bash on Windows-native,
# wsl.exe on WSL, bash on Posix). $HOME resolves to the execution space's home on each, so the credential
# checks read the right store. Emits ONE JSON line consumed by main.js's onboard:status handler:
#   {"claudeInstalled":bool,"claudeSignedIn":bool,"claudeVersion":str,"ghInstalled":bool,"ghSignedIn":bool,"ghAccount":str}
# Signed-in signal = ~/.claude/.credentials.json has a non-empty claudeAiOauth.accessToken (the canonical OAuth
# token; checked precisely via node — NOT a loose grep — so a stray mcpOAuth token can't false-positive). node
# is always present (it runs Claude Code's hooks). The file is piped via stdin so no MSYS/Windows path
# translation is needed for the path arg.
ci=false; cs=false; cv=""; gi=false; gs=false; ga=""

if command -v claude >/dev/null 2>&1; then
  ci=true
  cv="$(claude --version 2>/dev/null | head -1 | tr -d '\000-\037"\\')"
fi

cred="$HOME/.claude/.credentials.json"
if [ -f "$cred" ]; then
  cs="$(cat "$cred" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const c=JSON.parse(s);process.stdout.write(c&&c.claudeAiOauth&&c.claudeAiOauth.accessToken?"true":"false")}catch{process.stdout.write("false")}})' 2>/dev/null)"
  [ "$cs" = "true" ] || cs=false
fi

if command -v gh >/dev/null 2>&1; then
  gi=true
  if gh auth status >/dev/null 2>&1; then
    gs=true
    ga="$(gh api user --jq .login 2>/dev/null | head -1 | tr -d '\000-\037"\\')"
  fi
fi

printf '{"claudeInstalled":%s,"claudeSignedIn":%s,"claudeVersion":"%s","ghInstalled":%s,"ghSignedIn":%s,"ghAccount":"%s"}\n' \
  "$ci" "$cs" "$cv" "$gi" "$gs" "$ga"
