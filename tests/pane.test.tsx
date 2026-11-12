import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'next-steps-pane',
  component: 'Pane',
  requestId: 'next-steps',
  props: {
    title: 'Next steps',
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

test('a turn fills the pane, and a click runs the step', async ($, on) => {
  const sent: string[] = []
  on('command.register', () => ({ value: { command: 'next-steps' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Next steps/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Update the README/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cover nested lists/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Button', text: /Update the README/ })
  expect(row).toBeDefined()
  await ui.press({ key: row!.key! })
  expect(sent).toEqual(['Update the README'])
  await ui.unmount()
})

test('an empty pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing queued up/ })).toBeDefined()
  await ui.unmount()
})
