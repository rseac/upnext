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
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

declare const setTimeout: (fn: () => void, ms: number) => unknown
const tick = () => new Promise<void>(r => setTimeout(r, 10))

type On = Parameters<TestBody>[1]
type Found = { key?: string; text?: string }

function engine(on: On, judge: string[] = []) {
  const toasts: string[] = []
  const briefs: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('model.complete', (_, e) => {
    const prompt = typeof e.prompt === 'string' ? e.prompt : ''
    // Ranking briefs get an empty ranking; done-check briefs get the next judgement.
    const text = prompt.startsWith('A developer typed') ? (briefs.push(prompt), judge.shift() ?? '{"done":[]}') : '{"top":[]}'
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  return { toasts, briefs }
}

const ANSWER = '## Next steps\n- Rotate the signing key\n- Add expiry tests for refresh tokens\n- Update the changelog for the release'

const texts = async (ui: { findAll: (q: { type?: string }) => Promise<Found[]> }) =>
  (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('run:')).map(b => b.text?.replace(/^\S+ /, ''))

test('a typed prompt that asks for a step clears it when the turn ends', async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start({ cwd: '/y1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  await $.turn.start({ text: 'ok, please rotate the signing key now', turnId: 't2' } as never)
  await $.turn.complete({ ...TURN, answer: 'Rotated the signing key and updated the config.', turnId: 't2' })
  const ui = await $.ui.mount(PANE)
  expect(await texts(ui)).not.toContain('Rotate the signing key')
  expect(toasts.some(t => t.includes('done and cleared: Rotate the signing key'))).toBe(true)
  await ui.unmount()
})

test('"do 2" means step 2 in the pane', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/y2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const second = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('n:'))[1]!
  const id = second.key!.slice(2)
  const target = (await ui.findAll({ type: 'Button' })).find(b => b.key === `top:${id}`)!.text!.replace(/^\S+ /, '')
  await $.turn.start({ text: 'do 2', turnId: 't2' } as never)
  await $.turn.complete({ ...TURN, answer: 'Done: that is finished now.', turnId: 't2' })
  expect(await texts(ui)).not.toContain(target)
  expect((await texts(ui)).length).toBe(2)
  await ui.unmount()
})

test('a paraphrase that matches no step: Haiku judges what the turn completed', async ($, on) => {
  const { briefs } = engine(on, ['{"done":[3]}'])
  await $.session.start({ cwd: '/y3', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  await $.turn.start({ text: 'write up what changed for 2.4 in the release notes file', turnId: 't2' } as never)
  await $.turn.complete({ ...TURN, answer: 'I added a 2.4 section to CHANGELOG.md listing the signing changes.', turnId: 't2' })
  const ui = await $.ui.mount(PANE)
  for (let i = 0; i < 100 && (await texts(ui)).includes('Update the changelog for the release'); i++) await tick()
  expect(briefs.length).toBe(1)
  expect(briefs[0]).toContain('write up what changed for 2.4')
  expect(briefs[0]).toContain('3. Update the changelog for the release')
  expect(await texts(ui)).not.toContain('Update the changelog for the release')
  expect((await texts(ui)).length).toBe(2)
  await ui.unmount()
})

test('doneCheck can drop superseded steps without dropping your own steps', async ($, on) => {
  const { briefs } = engine(on, ['{"done":[],"drop":[2,4]}'])
  await $.session.start({ cwd: '/y4', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'add-mine', text: 'Keep my own reminder' })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  await $.turn.start({ text: 'let us use opaque sessions instead of refresh rotation', turnId: 't2' } as never)
  await $.turn.complete({ ...TURN, answer: 'Sounds good, we will use opaque sessions instead of refresh rotation.', turnId: 't2' })
  for (let i = 0; i < 100 && (await texts(ui)).includes('Add expiry tests for refresh tokens'); i++) await tick()
  expect(briefs.length).toBe(1)
  expect(briefs[0]).toContain('"drop":[<step numbers>]')
  expect(await texts(ui)).not.toContain('Add expiry tests for refresh tokens')
  expect(await texts(ui)).toContain('Keep my own reminder')
  await ui.unmount()
})

test('system task notifications do not overwrite the developer prompt in doneCheck, and long replies keep their tail', async ($, on) => {
  const { briefs } = engine(on, ['{"done":[1]}'])
  await $.session.start({ cwd: '/y5', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'finish the branch predictor calibration', turnId: 't1' } as never)
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  await $.turn.start({
    text: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>',
    turnId: 't2',
  } as never)
  const longAnswer = `${'Status report row. '.repeat(120)}\n\nClosing summary: rotated the signing key and verified all checks.`
  await $.turn.complete({ ...TURN, answer: longAnswer, turnId: 't2' })
  const ui = await $.ui.mount(PANE)
  for (let i = 0; i < 100 && (await texts(ui)).includes('Rotate the signing key'); i++) await tick()
  expect(briefs.length).toBe(1)
  expect(briefs[0]).toContain('finish the branch predictor calibration')
  expect(briefs[0]).not.toContain('<task-notification>')
  expect(briefs[0]).toContain('Closing summary: rotated the signing key')
  await ui.unmount()
})
