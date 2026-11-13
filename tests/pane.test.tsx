import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The test runner has timers; the hooks module's own environment types none.
declare const setTimeout: (fn: () => void, ms: number) => unknown

type Finder = { findAll: (q: { type?: string; text?: RegExp }) => Promise<{ key?: string; text?: string }[]> }
/** A step's row (its run button), not a stream header that shares its words. */
const stepRow = async (ui: Finder, text: RegExp) => (await ui.findAll({ type: 'Button', text })).find(b => b.key?.startsWith('run:'))

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  props: {
    title: 'Up next',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const ANSWER = `All set.

## Next steps
- Add unit tests
  - cover nested lists
- Update the README`

const TURN = { reason: 'answer', durationMs: 1, isAborted: false } as const

type On = Parameters<TestBody>[1]

function engine(on: On) {
  const sent: string[] = []
  const drafted: string[] = []
  const ghost: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', (_, e) => {
    drafted.push(e.text)
    return { isFilled: true }
  })
  on('prompt.suggest', (_, e) => {
    ghost.push(e.text)
    return { isShown: true }
  })
  return { sent, drafted, ghost }
}

test('a turn fills the pane; a click drafts, ▶ sends', async ($, on) => {
  const { sent, drafted, ghost } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  expect(ghost[0]).toContain('Add unit tests')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /⬢/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cover nested lists/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await stepRow(ui, /Update the README/)
  await ui.press({ key: row!.key! })
  expect(drafted).toEqual(['Update the README'])
  expect(sent).toEqual([])

  await ui.press({ key: row!.key!.replace('run:', 'alt:') })
  expect(sent).toEqual(['Update the README'])
  await ui.unmount()
})

test('the band offers the top steps with 1/2/3, and 0 hides it', async ($, on) => {
  const { drafted } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })

  const band = {
    plugin: 'upnext',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, bodyColumns: 100 },
  } as const
  const ui = await $.ui.mount(band as never)
  expect(await ui.find({ type: 'Button', text: /Add unit tests/ })).toBeDefined()
  const second = await ui.find({ type: 'Button', text: /Update the README/ })
  await ui.press({ key: second!.key! })
  expect(drafted).toEqual(['Update the README'])
  await ui.press({ key: 'b:hide' })
  expect(await ui.find({ type: 'Button', text: /Add unit tests/ })).toBeUndefined()
  await ui.unmount()
})

test('hidden characters never reach the pane', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const sneaky = `## Next steps\n- Fix the \u001b[31mbuild\u001b[0m​ now\n- Hidden \u{E0041}\u{E0042} words`
  await $.turn.complete({ ...TURN, answer: sneaky, turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await stepRow(ui, /Fix the/)
  expect(row?.text).toContain('Fix the build now')
  expect(await stepRow(ui, /Hidden/)).toBeUndefined()
  await ui.unmount()
})

test('an empty pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing queued up/ })).toBeDefined()
  await ui.unmount()
})

test('the model extractor reads a fork of the session', { options: { extractor: 'model' } }, async ($, on) => {
  engine(on)
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const replies = [
    '{"groups":[{"title":"From the fork","steps":[{"text":"Ship the `v2` branch","children":[]}]}]}',
  ]
  on('model.fork', () => ({ value: { isAnswered: true as const, text: replies.shift() ?? '{"groups":[]}', usage } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: 'I finished the refactor and the tests pass; the branch is ready to go out whenever you are, with nothing left open.', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The model's answer lands after the turn ends: wait for the pane to redraw.
  for (let i = 0; i < 100 && (await ui.find({ type: 'Text', text: /From the fork/ })) === undefined; i++) {
    await new Promise<void>(r => setTimeout(r, 10))
  }
  expect(await ui.find({ type: 'Text', text: /From the fork/ })).toBeDefined()
  expect(await stepRow(ui, /Ship the/)).toBeDefined()
  await ui.unmount()
})
