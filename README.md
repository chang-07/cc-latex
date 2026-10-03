# cc-latex

Typeset LaTeX inline in Claude Code replies.

A Claude Code mod (function-hooks plugin) that redraws assistant messages so
every display-math block (`$$...$$` or `\[...\]`) is compiled with `tectonic`,
rasterised with `pdftocairo`, and drawn in the transcript as an image over the
kitty graphics protocol. Inline `$x^2$` stays as text.

## Requirements

- Claude Code 2.1.287+ with mods (function hooks) available
- A terminal that supports kitty graphics: **Ghostty** or **kitty**. (WezTerm and iTerm2 may work; untested.)
- Not inside tmux. tmux blocks the graphics protocol even with `allow-passthrough on`.
- `tectonic` and poppler (`pdftocairo`) on `PATH`: `brew install tectonic poppler`

## Install

```sh
git clone https://github.com/chang-07/cc-latex
CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 claude --plugin-dir ~/code/cc-latex/latex-render
```

`CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` skips the engine's terminal probe, which
otherwise decides too conservatively that images can't be shown.

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
| `CELL_ASPECT` | `2.1` | Cell height / width of your terminal font. |
| `TEXT_COLOR` | `white` | Formula colour; use `black` on a light theme. |
| `DPI` | `600` | Rasterisation resolution; keep high, the picture is scaled to its cell box. |

## Development

```sh
claude plugin validate latex-render
claude plugin test latex-render
```
