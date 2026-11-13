import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: { title: 'Up next', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const
const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const
// A compaction always leaves at least one message.
const MESSAGES = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type On = Parameters<TestBody>[1]

function engine(on: On) {
  const told: (string | undefined)[] = []
  const drafted: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.fill', (_, e) => {
    drafted.push(e.text)
    return { isFilled: true }
  })
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('session.compact', (_, e) => {
    told.push(e.instructions)
    return { messages: MESSAGES }
  })
  return { told, drafted }
}

test('compaction tells the summarizer which open steps to keep context for', async ($, on) => {
  const { told } = engine(on)
  await $.session.start({ cwd: '/k1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key\n- [x] Remove the old table', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the `--quiet` flag', turnId: 't2' })
  await $.session.compact({ trigger: 'auto', instructions: 'Focus on the parser.', messages: MESSAGES })
  const note = told[0]!
  expect(note.startsWith('Focus on the parser.\n\n')).toBe(true)
  expect(note).toContain('- Docs: Document the --quiet flag')
  expect(note).toContain('- Auth: Rotate the signing key')
  expect(note).not.toContain('Remove the old table')
  expect(note.indexOf('Docs')).toBeLessThan(note.indexOf('Auth'))
})

test('steps past the first fifteen become "earlier" once the compaction is done', async ($, on) => {
  const { drafted } = engine(on)
  await $.session.start({ cwd: '/k2', surface: 'terminal', isInteractive: true })
  const old = Array.from({ length: 10 }, (_, i) => `- Fix old bug ${i + 1}`).join('\n')
  const fresh = Array.from({ length: 10 }, (_, i) => `- Write new test ${i + 1}`).join('\n')
  await $.turn.complete({ ...TURN, answer: `## Bug follow-ups\n${old}`, turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: `## Testing follow-ups\n${fresh}`, turnId: 't2' })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })

  const ui = await $.ui.mount(PANE)
  const runs = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('run:'))
  const last = runs.find(b => b.text?.includes('Fix old bug 10'))!
  await ui.press({ key: last.key! })
  expect(drafted.at(-1)).toContain('from an earlier conversation')
  const first = runs.find(b => b.text?.includes('Write new test 1'))!
  await ui.press({ key: first.key! })
  expect(drafted.at(-1)).toBe('Write new test 1')
  await ui.unmount()
})

test('nothing is added when no step is open', async ($, on) => {
  const { told } = engine(on)
  await $.session.start({ cwd: '/k3', surface: 'terminal', isInteractive: true })
  await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  expect(told).toEqual([undefined])
})
