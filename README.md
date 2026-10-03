# cc-latex

Typeset LaTeX inline in Claude Code replies.

A Claude Code mod (function-hooks plugin) that redraws assistant messages so
every display-math block (`$$...$$` or `\[...\]`) is compiled with `tectonic`,
rasterised with `pdftocairo`, and drawn in the transcript as an image over the
kitty graphics protocol. Inline `$x^2$` stays as text.

## Requirements

- Claude Code 2.1.287+ with mods (function hooks) available
- A terminal that supports kitty graphics: **Ghostty** or **kitty**. (WezTerm and iTerm2 may work; untested.)
- `tectonic` and poppler (`pdftocairo`) on `PATH`: `brew install tectonic poppler`

## Install

```sh
git clone https://github.com/chang-07/cc-latex
claude --plugin-dir ~/code/cc-latex/latex-render
```

Ask Claude something with display math and the formulas appear typeset.

If you only see the LaTeX source, dimmed, where a formula should be, Claude
Code's terminal probe decided images aren't supported. Skip the probe with:

```sh
CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 claude --plugin-dir ~/code/cc-latex/latex-render
```

## Using tmux?

tmux drops the kitty graphics protocol, so by itself the mod shows formulas as
`latex` code blocks when it detects tmux. `scripts/cc-tmux-bridge.py` fixes
that. It runs Claude Code in a pty and wraps each graphics command in tmux's
passthrough envelope so it reaches the real terminal. Claude Code already uses
kitty's Unicode-placeholder mode under tmux, so no other change is needed.

```sh
tmux set -g allow-passthrough on        # also put this in ~/.tmux.conf
python3 ~/code/cc-latex/scripts/cc-tmux-bridge.py claude --plugin-dir ~/code/cc-latex/latex-render
```

The bridge also answers Claude Code's image probe (no env flag needed),
measures the terminal's cell size so formulas are sized exactly, and triggers
a tmux redraw after each image to clear pixels the terminal may keep on
overwritten cells.

To make it automatic, put a `claude` wrapper earlier in `PATH` than the real
launcher that runs the bridge when `$TMUX` is set:

```sh
mkdir -p ~/.local/bridge-bin && cat > ~/.local/bridge-bin/claude <<'EOF'
#!/bin/sh
REAL="$HOME/.local/bin/claude"
BRIDGE="$HOME/code/cc-latex/scripts/cc-tmux-bridge.py"
if [ -n "$TMUX" ] && [ -z "$CC_TMUX_BRIDGE" ] && [ -t 1 ] && [ -f "$BRIDGE" ]; then
  exec python3 "$BRIDGE" "$REAL" "$@"
fi
exec "$REAL" "$@"
EOF
chmod +x ~/.local/bridge-bin/claude
echo 'export PATH="$HOME/.local/bridge-bin:$PATH"' >> ~/.zshrc
```

`scripts/tmux-placeholder-test.py` draws a PNG in the current tmux pane with
placeholders, handy to check that your terminal + tmux combination can show
images at all.

## How it works

`hooks/register.tsx` hooks `ui.render` for the `AssistantMessage` site. It
splits the message text around display-math blocks (skipping code fences),
returns the surrounding markdown as `Markdown` elements and each formula as an
`Image`. Rendering runs in the background: a formula not yet typeset shows as
dim `$$ ... $$` text, and when its PNG is ready the hook calls
`$.ui.invalidate('ui.render')` so the message redraws with the picture.

Rendered PNGs are cached in `~/.cache/claude-latex/` by a hash of the LaTeX
source, white on transparent (dark terminals).

## Tuning

Constants at the top of `hooks/register.tsx`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `PT_PER_ROW` | `8` | Points of typeset height per terminal row. Lower = bigger. |
| `CELL_ASPECT` | `2.1` | Cell height / width of your terminal font, used when the bridge hasn't measured it. |
| `TEXT_COLOR` | `white` | Formula colour; use `black` on a light theme. |
| `DPI` | `600` | Rasterisation resolution; keep high, the picture is scaled to its cell box. |

## Development

```sh
claude plugin validate latex-render
claude plugin test latex-render
```
