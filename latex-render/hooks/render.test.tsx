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
  // Under test there is no process or fs, so the render falls back to a fence
  // (or, with tools, an Image); either way the formula itself is shown.
  const image = await ui.find({ type: 'Image' })
  const fence = await ui.find({ type: 'Markdown', text: /```latex/ })
  expect(image !== undefined || fence !== undefined).toBe(true)
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
