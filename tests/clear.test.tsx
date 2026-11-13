import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: { title: 'Up next', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const
const CLEAR = { reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as const

type On = Parameters<TestBody>[1]
type Found = { key?: string; text?: string }

function engine(on: On, kept: Record<string, unknown> = {}) {
  on('session.id', () => ({ value: 'sess-c' }))
  const drafted: string[] = []
  const sent: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.fill', (_, e) => {
    drafted.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('store.set', (_, e) => {
    kept[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: kept[e.key] }))
  return { drafted, sent, kept }
}

const runButton = async (ui: { findAll: (q: { type?: string; text?: RegExp }) => Promise<Found[]> }, re: RegExp) =>
  (await ui.findAll({ type: 'Button', text: re })).find(b => b.key?.startsWith('run:'))

test('after /clear, steps are earlier: same text in the pane, a self-contained prompt on click', async ($, on) => {
  const { drafted } = engine(on)
  await $.session.start({ cwd: '/c1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: 'I fixed the parser and checked the fixtures pass. Want me to add the integration tests for the herdr viewer?',
    turnId: 't1',
  })
  await $.session.end(CLEAR)

  const ui = await $.ui.mount(PANE)
  const header = (await ui.findAll({ type: 'Button', text: /earlier/ })).find(b => b.key?.startsWith('tg:'))!
  await ui.press({ key: header.key! })
  const step = (await runButton(ui, /Add the integration tests/))!
  expect(step.text).toContain('Add the integration tests for the herdr viewer')
  await ui.press({ key: step.key! })
  expect(drafted.at(-1)).toBe(
    'Add the integration tests for the herdr viewer.\n\n(This step is from an earlier conversation, under "Add the integration tests". Check the current state of the code first: some of this may have changed or already be done.)',
  )
  await ui.unmount()
})

test('/clear puts queued and running steps back to open and stops a run in order', async ($, on) => {
  const { sent } = engine(on)
  await $.session.start({ cwd: '/c2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Add the tests\n- Update the README', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const seq = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('seq:'))!
  await ui.press({ key: seq.key! })
  expect(sent.length).toBe(1)
  expect((await ui.findAll({ type: 'Button', text: /Stop/ })).length).toBe(1)

  await $.session.end(CLEAR)
  expect((await ui.findAll({ type: 'Button', text: /Stop/ })).length).toBe(0)
  const header = (await ui.findAll({ type: 'Button', text: /earlier/ })).find(b => b.key?.startsWith('tg:'))!
  await ui.press({ key: header.key! })
  expect((await runButton(ui, /Add the tests/))!.text).toMatch(/^○/)
  await ui.unmount()
})

test('if the list is ever found empty, the saved steps come back before a turn saves over them', async ($, on) => {
  const kept: Record<string, unknown> = {}
  engine(on, kept)
  await $.session.start({ cwd: '/c3', surface: 'terminal', isInteractive: true })
  kept['roots:session:sess-c'] = [
    {
      id: 'r1',
      kind: 'stream',
      title: 'Auth',
      turn: 4,
      isCollapsed: false,
      steps: [{ id: 'r1.0', text: 'Rotate the signing key', prompt: 'Rotate the signing key', status: 'open', isCollapsed: false, children: [] }],
    },
  ]
  await $.turn.start({ text: 'hello', turnId: 't1' } as never)
  await $.turn.complete({ ...TURN, answer: 'ok', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Button', text: /Auth · earlier/ })).length).toBe(1)
  expect(JSON.stringify(kept['roots:session:sess-c'])).toContain('Rotate the signing key')
  await ui.unmount()
})
