import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: { title: 'Up next', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const

type On = Parameters<TestBody>[1]
type Found = { key?: string; text?: string }
type Finder = { findAll: (q: { type?: string; text?: RegExp }) => Promise<Found[]> }

function engine(on: On) {
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
}

const steps = async (ui: Finder) =>
  (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('run:')).map(b => b.text?.replace(/^\S+ /, '').replace(/ •$/, ''))

const idle = async ($: Parameters<TestBody>[0], from: number, to: number) => {
  for (let i = from; i <= to; i++) await $.turn.complete({ ...TURN, answer: 'ok', turnId: `t${i}` })
}

test('a done step leaves by itself three turns after it was done', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/a1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Add tests\n- [x] Ship it', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  await idle($, 2, 3)
  expect(await steps(ui)).toContain('Ship it')
  await idle($, 4, 4)
  expect(await steps(ui)).toEqual(['Add tests'])
  await ui.unmount()
})

test('an untouched step fades, moves to "older", and restore brings it back on top', { options: { fadeAfter: 2, oldAfter: 4 } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/a2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Rotate the signing key', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new flag', turnId: 't2' })
  const ui = await $.ui.mount(PANE)
  await idle($, 3, 6)
  // Rotate is 5 turns untouched (past 4): it waits under "older"; Document is 4, faded but still there.
  expect(await steps(ui)).toEqual(['Document the new flag'])
  expect((await ui.findAll({ type: 'Button', text: /older · 1/ })).length).toBe(1)
  await ui.press({ key: 'old-tg' })
  const back = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('old-back:'))!
  await ui.press({ key: back.key! })
  expect(await steps(ui)).toEqual(['Rotate the signing key', 'Document the new flag'])
  await ui.unmount()
})

test('a step suggested again refreshes the one already there: no copy, and it moves up', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/a3', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Add integration tests for the parser\n- Update the changelog', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Add integration tests for the parser', turnId: 't2' })
  const ui = await $.ui.mount(PANE)
  expect(await steps(ui)).toEqual(['Add integration tests for the parser', 'Update the changelog'])
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Update the changelog.', turnId: 't3' })
  const now = await steps(ui)
  expect(now.filter(s => s?.startsWith('Update the changelog')).length).toBe(1)
  expect(now[0]).toMatch(/^Update the changelog/)
  await ui.unmount()
})
