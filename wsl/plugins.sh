#!/usr/bin/env bash
# Claudible — list installed Claude Code PLUGINS (read-only from disk) and enable/disable them via the
# `claude plugin` CLI (never hand-edit installed_plugins.json — it has computed paths/timestamps).
# Args: $1 = op (list|toggle); for toggle: $2 = plugin key (name@marketplace), $3 = enable|disable.
# Emits JSON.
set -u

op="${1:-list}"
case "$op" in

  list)
    python3 - <<'PY' 2>/dev/null || printf '[]'
import os, json
home = os.path.expanduser("~")
def load(p):
    try: return json.load(open(p))
    except Exception: return {}
ip = load(os.path.join(home, ".claude", "plugins", "installed_plugins.json"))
en = load(os.path.join(home, ".claude", "settings.json")).get("enabledPlugins", {}) or {}
out = []
for key, arr in (ip.get("plugins") or {}).items():
    info = (arr or [{}])[0] if isinstance(arr, list) else {}
    nm, _, mkt = key.partition("@")
    out.append({"key": key, "name": nm, "marketplace": mkt,
                "version": info.get("version", ""), "scope": info.get("scope", ""),
                "enabled": bool(en.get(key, False))})
out.sort(key=lambda x: x["name"].lower())
print(json.dumps(out))
PY
    ;;

  toggle)
    key="${2:-}"; act="${3:-}"
    case "$key" in '' | *[!A-Za-z0-9@._/-]*) printf '{"ok":false,"error":"bad key"}'; exit 0 ;; esac
    case "$act" in enable|disable) ;; *) printf '{"ok":false,"error":"bad action"}'; exit 0 ;; esac
    command -v claude >/dev/null 2>&1 || { printf '{"ok":false,"error":"claude CLI not found"}'; exit 0; }
    if claude plugin "$act" "$key" >/dev/null 2>&1; then
      [ "$act" = "enable" ] && printf '{"ok":true,"enabled":true}' || printf '{"ok":true,"enabled":false}'
    else
      printf '{"ok":false,"error":"plugin %s failed"}' "$act"
    fi
    ;;

  *) printf '{"ok":false,"error":"bad op"}' ;;
esac
