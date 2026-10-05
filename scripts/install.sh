#!/bin/sh
# Install (or remove) the latex-render mod for every Claude Code session.
#
#   scripts/install.sh            add this checkout's mod to ~/.claude/settings.json
#   scripts/install.sh --remove   take it out again
#
# It sets CLAUDE_CODE_PLUGIN_DIRS in the settings file's "env" block, which
# Claude Code reads at startup and loads exactly like a --plugin-dir. Other
# settings, and other folders already listed in that variable, are kept.
set -eu

MOD="$(cd "$(dirname "$0")/.." && pwd)/latex-render"
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
ACTION="add"
[ "${1:-}" = "--remove" ] && ACTION="remove"

[ -f "$MOD/hooks/hooks.json" ] || { echo "cannot find the mod at $MOD" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

MOD="$MOD" SETTINGS="$SETTINGS" ACTION="$ACTION" python3 - <<'EOF'
import json, os, sys

mod, path, action = os.environ["MOD"], os.environ["SETTINGS"], os.environ["ACTION"]
home = os.path.expanduser("~")
shown = "~" + mod[len(home):] if mod.startswith(home + os.sep) else mod

settings = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            settings = json.load(f)
    except ValueError as e:
        sys.exit(f"{path} is not valid JSON ({e}); fix it first, nothing was changed")
    if not isinstance(settings, dict):
        sys.exit(f"{path} does not hold a JSON object; nothing was changed")

env = settings.get("env")
if not isinstance(env, dict):
    env = {}
dirs = [d for d in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(os.pathsep) if d]
same = lambda d: os.path.realpath(os.path.expanduser(d)) == os.path.realpath(mod)
had = any(same(d) for d in dirs)
dirs = [d for d in dirs if not same(d)]
if action == "add":
    dirs.append(shown)

if dirs:
    env["CLAUDE_CODE_PLUGIN_DIRS"] = os.pathsep.join(dirs)
else:
    env.pop("CLAUDE_CODE_PLUGIN_DIRS", None)
if env:
    settings["env"] = env
else:
    settings.pop("env", None)

os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".cc-latex.tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)

if action == "add":
    print(("Already installed" if had else "Installed") + f": {shown}")
    print(f"  in {path}")
    print("Start a new Claude Code session to use it.")
else:
    print(("Removed" if had else "Was not installed") + f": {shown}")
EOF
