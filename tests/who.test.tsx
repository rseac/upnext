import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: { title: 'Up next', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const BAND = {
  plugin: 'upnext',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, bodyColumns: 160 },
} as const
const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const

type On = Parameters<TestBody>[1]
type Found = { key?: string; text?: string }

function engine(on: On) {
  const drafted: string[] = []
  const sent: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
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

const ANSWER = '## Next steps\n- Try the new pane\n- Pick a license (MIT if unsure)\n- Add integration tests for the parser'

const row = async (ui: { findAll: (q: { type?: string }) => Promise<Found[]> }, re: RegExp) =>
  (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('run:') && re.test(b.text ?? ''))!

test('clicking a check step drafts it instead of silently deleting it; a decision starts your answer', async ($, on) => {
  const { drafted, sent } = engine(on)
  await $.session.start({ cwd: '/w1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  expect((await row(ui, /Try the new pane/)).text?.charAt(0)).toBe('☐')
  expect((await row(ui, /Pick a license/)).text?.charAt(0)).toBe('?')
  expect((await row(ui, /integration tests/)).text?.charAt(0)).toBe('○')

  await ui.press({ key: (await row(ui, /Try the new pane/)).key! })
  expect(drafted).toEqual(['Try the new pane'])

  await ui.press({ key: (await row(ui, /Pick a license/)).key! })
  expect(drafted).toEqual(['Try the new pane', 'Pick a license (MIT if unsure): '])
  expect(sent).toEqual([])
  // Your steps have no send button.
  const alts = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('alt:')).length
  expect(alts).toBe(1)
  await ui.unmount()
})

test("your steps stay out of a stream's ▶; above the prompt they show with their marks", async ($, on) => {
  const { sent } = engine(on)
  await $.session.start({ cwd: '/w2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const band = await $.ui.mount(BAND as never)
  const labels = (await band.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide').map(b => b.text)
  expect(labels.sort()).toEqual(['? Pick a license (MIT if unsure)', '○ Add integration tests for the parser', '☐ Try the new pane'])
  await band.unmount()

  const ui = await $.ui.mount(PANE)
  const all = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('ra:'))!
  await ui.press({ key: all.key! })
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('Add integration tests for the parser')
  expect(sent[0]).not.toContain('Try the new pane')
  expect(sent[0]).not.toContain('Pick a license')
  await ui.unmount()
})

test('w switches who does a step: Claude → check → decide → Claude', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/w3', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Add integration tests for the parser\n- Fix the crash on startup\n- Update the changelog', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  // The highlight starts on the top-ranked step: "Fix the crash" (it fixes something broken).
  const mark = async () => (await row(ui, /Fix the crash/)).text?.charAt(0)
  expect(await mark()).toBe('○')
  await ui.press({ key: 'k-who' })
  expect(await mark()).toBe('☐')
  await ui.press({ key: 'k-who' })
  expect(await mark()).toBe('?')
  await ui.press({ key: 'k-who' })
  expect(await mark()).toBe('○')
  await ui.unmount()
})
