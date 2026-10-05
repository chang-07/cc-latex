#!/bin/sh
# Install (or remove) the latex-render mod for every Claude Code session.
#
#   scripts/install.sh            add this checkout's mod to ~/.claude/settings.json
#   scripts/install.sh --remove   take it out again
#
# Installing first makes sure tectonic and poppler are present (through
# Homebrew) and has tectonic fetch its TeX bundle, so the first formula in a
# session isn't a minute's wait. It then sets CLAUDE_CODE_PLUGIN_DIRS in the
# settings file's "env" block, which Claude Code reads at startup and loads
# exactly like a --plugin-dir. Other settings, and other folders already
# listed in that variable, are kept.
set -eu

# CC_LATEX_MOD overrides where the mod lives (the Homebrew formula points it at
# a path that stays the same across upgrades).
MOD="${CC_LATEX_MOD:-$(cd "$(dirname "$0")/.." && pwd)/latex-render}"
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
ACTION="add"
[ "${1:-}" = "--remove" ] && ACTION="remove"

[ -f "$MOD/hooks/hooks.json" ] || { echo "cannot find the mod at $MOD" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

if [ "$ACTION" = "add" ]; then
  [ "$(uname -s)" = "Darwin" ] || echo "warning: the mod re-saves images with macOS's sips; it will not render on $(uname -s)" >&2

  # tectonic typesets, poppler's pdftocairo rasterises.
  missing=""
  command -v tectonic >/dev/null || missing="$missing tectonic"
  command -v pdftocairo >/dev/null || missing="$missing poppler"
  if [ -n "$missing" ]; then
    if command -v brew >/dev/null; then
      echo "Installing$missing with Homebrew..."
      # shellcheck disable=SC2086
      brew install $missing
    else
      echo "Missing:$missing. Install Homebrew (https://brew.sh) and rerun, or install them yourself." >&2
      exit 1
    fi
  fi

  # tectonic downloads its TeX bundle on first use, and fonts as formulas first
  # need them (about a minute in all). Compiling a broad sample of math here
  # means formulas in a session appear at once.
  warm="$(mktemp -d)"
  cat > "$warm/warm.tex" <<'TEX'
\documentclass{article}
\usepackage{amsmath,amssymb,amsfonts,xcolor}
\usepackage[active,tightpage]{preview}
\begin{document}
\begin{preview}\color{white}\(\displaystyle
  \int_0^\infty \sum_{n=1}^{N} \prod_i \frac{\partial^2 u}{\partial x^2}
  \sqrt[3]{\alpha\beta\Gamma\Omega} \le \left(\frac{a}{b}\right)^{x_{i_j}^{2^k}}
  \mathbf{u}\cdot\nabla \boldsymbol{\sigma} \mathbb{R} \mathcal{L} \mathfrak{g} \mathrm{d}x\,\mathit{f} \mathsf{T} \mathtt{t}
  \underbrace{x+y}_{n} \overline{z} \hat{a} \vec{v} \to \Rightarrow \iff \approx \equiv \in \subseteq \cup \otimes \oint \iint
  \lim_{x\to 0} \sin x \log x \quad \text{if } x \ne 0 \quad \bigg\{ \Big[ \big( \langle \| \rangle \big) \Big] \bigg\}
  \begin{pmatrix} a & b \\ c & d \end{pmatrix} \begin{cases} 1 & x>0 \\ 0 & \text{otherwise} \end{cases}
  \binom{n}{k} \dots \cdots \vdots \ddots \aleph \hbar \ell \infty \emptyset \forall \exists \neg \pm \times \div
\)\end{preview}
\end{document}
TEX
  if ! https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 \
       tectonic -o "$warm" --chatter minimal --only-cached "$warm/warm.tex" >/dev/null 2>&1; then
    echo "Fetching tectonic's TeX bundle (about a minute, one time)..."
    tectonic -o "$warm" --chatter minimal "$warm/warm.tex" >/dev/null 2>&1 \
      || echo "warning: could not fetch the TeX bundle now; the first formula will fetch it instead" >&2
  fi
  rm -rf "$warm"
fi

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
