import type { Register, EngineInterface } from 'claude-code'

// Display math in an assistant reply ($$...$$ or \[...\]) is typeset with
// tectonic, rasterised with pdftocairo, and drawn inline as an Image over the
// kitty graphics protocol (Ghostty, kitty). Inline $...$ is left as text.
//
// Inside tmux the engine's image upload does not reach the terminal unless
// Claude Code runs under scripts/cc-tmux-bridge.py (which sets
// CC_TMUX_BRIDGE=1); without the bridge, formulas are shown as LaTeX source.

const DPI = 400 // rasterisation; above the screen's pixels per point, but every formula is held decoded by the terminal
const PT_PER_ROW = 8 // points of typeset height per terminal row; lower = bigger
const CELL_ASPECT = 2.1 // cell height / cell width, used when no measured size is available
const TEXT_COLOR = 'white' // the terminal is dark; change for a light theme

type Piece = { kind: 'md'; text: string } | { kind: 'tex'; src: string }

// Fenced blocks and inline code spans are skipped: a `$$` quoted in prose
// must not pair with a real delimiter.
const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/
const DISPLAY = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g

function split(text: string): Piece[] {
  const out: Piece[] = []
  for (const chunk of text.split(FENCE)) {
    if (!chunk) continue
    if (chunk.startsWith('```') || chunk.startsWith('~~~') || chunk.startsWith('`')) {
      out.push({ kind: 'md', text: chunk })
      continue
    }
    let last = 0
    for (const m of chunk.matchAll(DISPLAY)) {
      const src = (m[1] ?? m[2] ?? '').trim()
      if (m.index! > last) out.push({ kind: 'md', text: chunk.slice(last, m.index) })
      out.push({ kind: 'tex', src })
      last = m.index! + m[0].length
    }
    if (last < chunk.length) out.push({ kind: 'md', text: chunk.slice(last) })
  }
  return out
}

const hashes = new Map<string, Promise<string>>() // formula source -> cache key
function sha(text: string): Promise<string> {
  let p = hashes.get(text)
  if (!p) {
    p = crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(buf =>
      [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16),
    )
    hashes.set(text, p)
  }
  return p
}

function pngSize(base64: string): { width: number; height: number } | null {
  const b = Uint8Array.fromBase64(base64)
  if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null
  const v = new DataView(b.buffer, b.byteOffset)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

type Rendered = { png: string; width: number; height: number }
const done = new Map<string, Rendered | null>() // settled renders, by key
const pending = new Map<string, string>() // key -> source, waiting for the next batch
let batchTimer: ReturnType<typeof setTimeout> | null = null
let batchRunning = false
let home: Promise<string> | null = null

function cacheDir($: EngineInterface): Promise<string> {
  if (!home) home = $.env.get('HOME').then(h => `${h ?? '/tmp'}/.cache/claude-latex`)
  return home
}

// Answers at once: the settled picture, or `undefined` while it renders. The
// formulas of one redraw are compiled together (one tectonic run), and the
// batch settling asks the engine to draw this plugin's sites again, once.
function render($: EngineInterface, key: string, src: string): Rendered | null | undefined {
  if (done.has(key)) return done.get(key)
  if (!pending.has(key)) pending.set(key, src)
  // Every formula of a redraw is registered within the same hook call, so the
  // window only has to outlast the current tick.
  if (!batchTimer && !batchRunning) batchTimer = setTimeout(() => void runBatch($), 10)
  return undefined
}

async function runBatch($: EngineInterface): Promise<void> {
  batchTimer = null
  if (batchRunning || pending.size === 0) return
  batchRunning = true
  const items = [...pending].map(([key, src]) => ({ key, src }))
  pending.clear()
  try {
    const dir = await cacheDir($)
    const fresh: typeof items = []
    for (const it of items) (await $.fs.exists(`${dir}/${it.key}.png`)) ? void 0 : fresh.push(it)
    if (fresh.length > 0) {
      try {
        await compile($, dir, fresh)
      } catch (err) {
        // One bad formula fails the whole compile: retry them one at a time.
        $.ui.log(`latex-render: batch failed (${String(err).slice(0, 200)}); retrying singly`, { to: 'debug' })
        for (const it of fresh) {
          await compile($, dir, [it]).catch(e => $.ui.log(`latex-render: ${it.key}: ${String(e).slice(0, 200)}`, { to: 'debug' }))
        }
      }
    }
    for (const it of items) done.set(it.key, await load($, `${dir}/${it.key}.png`))
  } finally {
    batchRunning = false
    $.ui.invalidate('ui.render')
    if (pending.size > 0) batchTimer = setTimeout(() => void runBatch($), 0)
  }
}

// One tectonic run for several formulas: each display becomes its own tightly
// cropped page (the preview package), rasterised to <key>.png.
async function compile($: EngineInterface, dir: string, items: { key: string; src: string }[]): Promise<void> {
  const id = items.length === 1 ? items[0]!.key : `batch-${items.map(i => i.key.slice(0, 4)).join('')}`
  const tex = `${dir}/${id}.tex`
  await $.fs.write(
    tex,
    [
      '\\documentclass{article}',
      '\\usepackage{amsmath,amssymb,amsfonts,xcolor}',
      // Each formula is its own tight preview box around displaystyle math. (The
      // package's displaymath extraction keeps the display's whole line, which
      // leaves the formula centred in a canvas of transparent space.)
      '\\usepackage[active,tightpage]{preview}',
      '\\setlength\\PreviewBorder{3pt}',
      '\\begin{document}',
      ...items.map(i => `\\begin{preview}\\color{${TEXT_COLOR}}\\(\\displaystyle ${i.src} \\)\\end{preview}`),
      '\\end{document}',
      '',
    ].join('\n'),
  )
  // Even with --only-cached, tectonic contacts the bundle server on every run
  // and waits on it (seconds on a slow link, with almost no CPU used). Pointing
  // its proxy at a closed local port makes that attempt fail at once, so the
  // compile runs from the cache in well under a second. A package not cached
  // yet makes this run fail, and the fallback compiles with the network open.
  const offline = { https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' }
  // tectonic reruns TeX when the .aux changes, and a first pass always writes
  // one. Writing the two lines it would produce skips that second pass.
  await $.fs.write(`${dir}/${id}.aux`, `\\relax \n\\gdef \\@abspage@last{${items.length}}\n`)
  let tect = await $.process.run(['tectonic', '-o', dir, '--chatter', 'minimal', '--only-cached', tex], { env: offline, timeoutMs: 60000 })
  if (tect.exitCode !== 0) {
    tect = await $.process.run(['tectonic', '-o', dir, '--chatter', 'minimal', tex], { timeoutMs: 120000 })
  }
  if (tect.exitCode !== 0) throw new Error(`tectonic: ${tect.stderr.slice(0, 300)}`)
  // One pdftocairo run for every page (it names them <prefix>-<n>.png, n
  // zero-padded to the digits of the page count), then each page is moved to
  // its formula's cache name; one process instead of one per formula.
  const pdf = `${dir}/${id}.pdf`
  const prefix = `${dir}/${id}`
  const width = String(items.length).length
  // Ghostty draws cairo's PNG byte stream at a fraction of its size (the same
  // pixels re-saved by any other encoder draw right), so each page is re-saved
  // by sips on the way to its cache name; alpha survives.
  const moves = items
    // A page wider than 4096 px is downsampled first (never enlarged): the
    // engine refuses a larger Image, and with it the whole message's tree.
    .map((it, n) => {
      const page = `${prefix}-${String(n + 1).padStart(width, '0')}.png`
      return `w=$(sips -g pixelWidth "${page}" | awk '/pixelWidth/{print $2}'); if [ "$w" -gt 4096 ]; then sips --resampleWidth 4096 "${page}" >/dev/null; fi; sips -s format png "${page}" --out "${dir}/${it.key}.png" >/dev/null`
    })
    .join(' && ')
  const cairo = await $.process.run(
    ['sh', '-c', `pdftocairo -png -transp -r ${DPI} "${pdf}" "${prefix}" && ${moves} && rm -f "${prefix}"-*.png`],
    { timeoutMs: 30000 },
  )
  if (cairo.exitCode !== 0) throw new Error(`pdftocairo: ${cairo.stderr.slice(0, 300)}`)
}

async function load($: EngineInterface, png: string): Promise<Rendered | null> {
  try {
    const { base64 } = await $.fs.read(png, { as: 'bytes' })
    const size = pngSize(base64)
    return size ? { png: base64, ...size } : null
  } catch {
    return null
  }
}

// The terminal's cell size in pixels, as cc-tmux-bridge measures it and leaves
// in ~/.cache/cc-tmux-bridge.cellsize ("<width> <height>"); CELL_ASPECT else.
let cellAspect: Promise<number> | null = null
function measuredCellAspect($: EngineInterface): Promise<number> {
  if (!cellAspect) {
    cellAspect = (async () => {
      try {
        const home = (await $.env.get('HOME')) ?? ''
        const [w, h] = (await $.fs.read(`${home}/.cache/cc-tmux-bridge.cellsize`)).trim().split(/\s+/).map(Number)
        if (w! > 0 && h! > 0) return h! / w!
      } catch {}
      return CELL_ASPECT
    })()
  }
  return cellAspect
}

function cells(r: Rendered, maxColumns: number, aspectRatio: number): { columns: number; rows: number } {
  const heightPt = (r.height * 72) / DPI
  const aspect = (r.width / r.height) * aspectRatio // columns per row
  let rows = Math.max(1, Math.round(heightPt / PT_PER_ROW))
  // Err a little wide: the bridge trims the box to the picture's exact shape
  // (it can only shrink it), and a box too narrow would shrink the picture.
  let columns = Math.max(1, Math.ceil(rows * aspect * 1.04))
  if (columns > maxColumns) {
    columns = maxColumns
    rows = Math.max(1, Math.round(columns / aspect))
  }
  return { columns: Math.min(columns, 255), rows: Math.min(rows, 255) }
}

export const register: Register = on => {
  // The engine draws the streaming reply itself and raises AssistantMessage
  // only for committed blocks, so the first chance to draw a picture is when
  // its block is committed. Watching the model's text as it streams lets the
  // compile start the moment a formula closes, so the picture is ready then.
  on('turn.step', async function* ($, e, next) {
    const blocks = new Map<number, string>()
    const started = new Set<string>()
    for await (const chunk of next(e)) {
      if (chunk.kind === 'text') {
        const text = (blocks.get(chunk.index) ?? '') + chunk.text
        blocks.set(chunk.index, text)
        if (chunk.text.includes('$') || chunk.text.includes(']')) {
          for (const piece of split(text)) {
            if (piece.kind !== 'tex' || started.has(piece.src)) continue
            started.add(piece.src)
            void sha(piece.src).then(key => void render($, key, piece.src))
          }
        }
      }
      yield chunk
    }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const pieces = split(e.props.text)
    if (!pieces.some(p => p.kind === 'tex')) return next(e)

    const { Box, Text, Markdown, Image } = $.ui.resolve(e)
    const maxColumns = Math.min(255, Math.max(10, (e.viewport?.columns ?? 80) - 4))
    const bridged = await $.env.get('CC_TMUX_BRIDGE').then(Boolean, () => false)
    const inTmux = !bridged && (await $.env.get('TMUX').then(Boolean, () => false))
    const aspectRatio = await measuredCellAspect($)

    const keys = await Promise.all(pieces.map(p => (p.kind === 'tex' ? sha(p.src) : '')))
    const nodes = pieces.map((p, i) => {
      if (p.kind === 'md') {
        const text = p.text.replace(/^\n+|\n+$/g, '')
        return text ? <Markdown text={text.slice(0, 10000)} /> : null
      }
      if (inTmux) return <Markdown text={'```latex\n' + p.src + '\n```'} />
      const r = render($, keys[i]!, p.src)
      if (r === undefined) return <Markdown text={'$$ ' + p.src + ' $$'} dimColor />
      if (r === null) return <Markdown text={'```latex\n' + p.src + '\n```'} />
      const { columns, rows } = cells(r, maxColumns, aspectRatio)
      return (
        <Box marginLeft={2} marginTop={1} marginBottom={1}>
          <Image source={{ png: r.png }} columns={columns} rows={rows} alt={p.src} />
        </Box>
      )
    })

    return (
      <Box flexDirection="row">
        <Text>{e.props.isFirstOfReply ? '● ' : '  '}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {nodes}
        </Box>
      </Box>
    )
  })
}
