import type { Register, EngineInterface } from 'claude-code'

// Display math in an assistant reply ($$...$$ or \[...\]) is typeset with
// tectonic, rasterised with pdftocairo, and drawn inline as an Image (kitty
// graphics: Ghostty, kitty; tmux needs `allow-passthrough on`). Inline $...$
// is left as text. Elsewhere (no Image element, a render failure) the engine
// draws the reply as usual.

const DPI = 600 // rasterisation; the picture is scaled to its cell box, so keep this above the screen's pixels per point
const PT_PER_ROW = 8 // points of typeset height per terminal row; lower = bigger
const CELL_ASPECT = 2.1 // cell height / cell width
const TEXT_COLOR = 'white' // the terminal is dark; change for a light theme

type Piece = { kind: 'md'; text: string } | { kind: 'tex'; src: string }

const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/
const DISPLAY = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g

function split(text: string): Piece[] {
  const out: Piece[] = []
  for (const chunk of text.split(FENCE)) {
    if (!chunk) continue
    if (chunk.startsWith('```') || chunk.startsWith('~~~')) {
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

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

function pngSize(base64: string): { width: number; height: number } | null {
  const b = Uint8Array.fromBase64(base64)
  if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null
  const v = new DataView(b.buffer, b.byteOffset)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

type Rendered = { file: string; png: string; width: number; height: number }
const done = new Map<string, Rendered | null>() // settled renders, by hash
const inflight = new Set<string>()

// Answers at once: the settled picture, or `undefined` while it renders. A
// render that settles asks the engine to draw this plugin's sites again.
function render($: EngineInterface, key: string, src: string): Rendered | null | undefined {
  if (done.has(key)) return done.get(key)
  if (!inflight.has(key)) {
    inflight.add(key)
    void renderOnce($, key, src)
      .catch(err => {
        $.ui.log(`latex-render: ${String(err)}`, { to: 'debug' })
        return null
      })
      .then(r => {
        done.set(key, r)
        inflight.delete(key)
        $.ui.invalidate('ui.render')
      })
  }
  return undefined
}

async function renderOnce($: EngineInterface, key: string, src: string): Promise<Rendered | null> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const dir = `${home}/.cache/claude-latex`
  const png = `${dir}/${key}.png`

  if (!(await $.fs.exists(png))) {
    const tex = `${dir}/${key}.tex`
    await $.fs.write(
      tex,
      [
        '\\documentclass[preview,border=3pt,varwidth=true]{standalone}',
        '\\usepackage{amsmath,amssymb,amsfonts,xcolor}',
        '\\begin{document}',
        `\\color{${TEXT_COLOR}}`,
        `\\[ ${src} \\]`,
        '\\end{document}',
        '',
      ].join('\n'),
    )
    const tect = await $.process.run(['tectonic', '-o', dir, '--chatter', 'minimal', tex], { timeoutMs: 60000 })
    if (tect.exitCode !== 0) throw new Error(`tectonic: ${tect.stderr.slice(0, 300)}`)
    const cairo = await $.process.run(
      ['pdftocairo', '-png', '-transp', '-r', String(DPI), '-singlefile', `${dir}/${key}.pdf`, `${dir}/${key}`],
      { timeoutMs: 30000 },
    )
    if (cairo.exitCode !== 0) throw new Error(`pdftocairo: ${cairo.stderr.slice(0, 300)}`)
  }

  const { base64 } = await $.fs.read(png, { as: 'bytes' })
  const size = pngSize(base64)
  if (!size) throw new Error('not a PNG')
  return { file: png, png: base64, ...size }
}

function cells(r: Rendered, maxColumns: number): { columns: number; rows: number } {
  const heightPt = (r.height * 72) / DPI
  const aspect = (r.width / r.height) * CELL_ASPECT // columns per row
  let rows = Math.max(1, Math.round(heightPt / PT_PER_ROW))
  let columns = Math.max(1, Math.round(rows * aspect))
  if (columns > maxColumns) {
    columns = maxColumns
    rows = Math.max(1, Math.round(columns / aspect))
  }
  return { columns: Math.min(columns, 255), rows: Math.min(rows, 255) }
}

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const pieces = split(e.props.text)
    if (!pieces.some(p => p.kind === 'tex')) return next(e)

    const { Box, Text, Markdown, Image } = $.ui.resolve(e)
    const maxColumns = Math.max(10, (e.viewport?.columns ?? 80) - 4)

    const keys = await Promise.all(pieces.map(p => (p.kind === 'tex' ? sha(p.src) : '')))
    const nodes = pieces.map((p, i) => {
      if (p.kind === 'md') {
        const text = p.text.replace(/^\n+|\n+$/g, '')
        return text ? <Markdown text={text.slice(0, 10000)} /> : null
      }
      const r = render($, keys[i]!, p.src)
      if (r === undefined) return <Markdown text={'$$ ' + p.src + ' $$'} dimColor />
      if (r === null) return <Markdown text={'```latex\n' + p.src + '\n```'} />
      const { columns, rows } = cells(r, maxColumns)
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
