import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: { title: 'Up next', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const

type On = Parameters<TestBody>[1]

function engine(on: On) {
  const drafted: string[] = []
  const sent: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => {
    drafted.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return { drafted, sent }
}

const ANSWER = '## Auth follow-ups\n- Rotate the signing key\n- Audit the token store\n\n## Docs follow-ups\n- Document the new flag'

test('a number drafts that step; j moves the highlight, s sends it, x drops it', async ($, on) => {
  const { drafted, sent } = engine(on)
  await $.session.start({ cwd: '/n1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const numbers = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('n:'))
  expect(numbers.length).toBe(3)
  // In view order: Rotate (1), Audit (2), Document (3).
  await ui.press({ key: numbers[0]!.key! })
  expect(drafted.at(-1)).toBe('Rotate the signing key')

  await ui.press({ key: 'k-down' })
  await ui.press({ key: 'k-send' })
  expect(sent.at(-1)).toBe('Audit the token store')
  await ui.press({ key: 'k-down' })
  await ui.press({ key: 'k-drop' })
  expect((await ui.findAll({ type: 'Button', text: /Document the new flag/ })).length).toBe(0)
  await ui.unmount()
})

test('m marks steps across streams; r runs the marked ones in order', async ($, on) => {
  const { sent } = engine(on)
  await $.session.start({ cwd: '/n2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'k-mark' }) // the first step: Rotate the signing key (Auth); m moves on
  await ui.press({ key: 'k-down' })
  await ui.press({ key: 'k-mark' }) // Document the new flag (Docs)
  expect((await ui.findAll({ type: 'Button', text: /run 2 marked/ })).length).toBe(1)
  await ui.press({ key: 'k-run' })
  expect(sent).toEqual(['Rotate the signing key'])
  await $.turn.start({ text: 'Rotate the signing key', turnId: 't2' } as never)
  await $.turn.complete({ ...TURN, answer: 'Rotated the signing key and updated the config.', turnId: 't2' })
  expect(sent).toEqual(['Rotate the signing key', 'Document the new flag'])
  await ui.unmount()
})
