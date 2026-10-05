import { test, expect } from 'claude-code/testing'

const PLUGIN = 'latex-render'
const PROPS = { isFirstOfReply: true }

// Stands in for the engine's own drawing beneath the plugin: a hook that
// calls next(e) lands here.
const engineDraws = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">{e.props.text}</Text>
  })

test('a reply without display math is left to the engine', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { ...PROPS, text: 'Just text with inline $x^2$ only.' },
  })
  // The hook called next(e): the engine's stand-in drew it.
  expect(JSON.stringify(await ui.drawn()).includes('inline $x^2$ only')).toBe(true)
  expect(await ui.find({ type: 'Image' })).toBe(undefined)
})

test('display math draws between the surrounding markdown', async $ => {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'm2',
    props: { ...PROPS, text: 'Before.\n\n$$\\int_0^1 x^2\\,dx$$\n\nAfter.' },
  })
  expect(await ui.find({ type: 'Markdown', text: 'Before.' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: 'After.' })).toBeDefined()
  // The formula is always shown: pending (dim $$ ... $$ while the batch
  // compiles), failed (a latex fence; under test there is no process or fs),
  // or rendered (an Image).
  const image = await ui.find({ type: 'Image' })
  const shown = await ui.find({ type: 'Markdown', text: /\\int_0\^1/ })
  expect(image !== undefined || shown !== undefined).toBe(true)
})

test('math inside a code fence is not touched', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'm3',
    props: { ...PROPS, text: '```\n$$not math$$\n```' },
  })
  expect(JSON.stringify(await ui.drawn()).includes('$$not math$$')).toBe(true)
  expect(await ui.find({ type: 'Image' })).toBe(undefined)
})

test('the system prompt says how to write math', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const ours = composed.sections.find(s => s.id === 'latex-render:math')
  expect(ours?.scope).toBe('session')
  expect(ours?.text.includes('$$')).toBe(true)
  expect(composed.sections[0]?.id).toBe('intro')
})
