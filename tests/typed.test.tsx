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
  on('prompt.submit', (_, e) => ({ text: e.text }))
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
  (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('run:')).map(b => b.text?.replace(/^\S+ /, '').replace(/ •$/, ''))

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
  const submitted = await $.prompt.submit({ text: '2', asUser: true })
  expect((submitted as { text?: string }).text).toBe(target)
  await $.turn.start({ text: (submitted as { text?: string }).text ?? 'do 2', turnId: 't2' } as never)
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

test('shorthand with an identifier, "do it", "1 and 3", and edited drafts all clear the steps they target', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/y6', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: [
      '## Next steps',
      '- Take one waveform of `thresh` to test the BJU2 extra vset/i2v uop hypothesis',
      '- Rotate the signing key for the auth service',
      '- Update the changelog for the release',
      '- Decide whether to keep or delete `build/vec-wt-archive/` (1.5 GB)',
    ].join('\n'),
    turnId: 't1',
  })
  // Shorthand that only names 2 words + identifier out of 11 words in the step.
  await $.turn.start({ text: 'take a waveform of thresh', turnId: 't2' } as never)
  await $.turn.complete({ ...TURN, answer: 'Took the thresh waveform.', turnId: 't2' })
  let ui = await $.ui.mount(PANE)
  expect(await texts(ui)).not.toContain('Take one waveform of `thresh` to test the BJU2 extra vset/i2v uop hypothesis')

  // Answering a decide step directly by its path without repeating the whole sentence.
  await $.turn.start({ text: 'delete build/vec-wt-archive', turnId: 't3' } as never)
  await $.turn.complete({ ...TURN, answer: 'Deleted build/vec-wt-archive.', turnId: 't3' })
  expect((await texts(ui)).some(t => t?.includes('vec-wt-archive'))).toBe(false)

  // "do it" targets the top remaining step; "both" targets the remaining two.
  await $.turn.start({ text: 'do both', turnId: 't4' } as never)
  await $.turn.complete({ ...TURN, answer: 'Rotated the key and updated the changelog.', turnId: 't4' })
  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})

test('a later reply that marks an open checklist step [x] completes and clears it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/y7', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: '## What remains\n- [ ] Calibrate RTL latencies\n- [ ] Integrate simulator',
    turnId: 't1',
  })
  await $.turn.complete({
    ...TURN,
    answer: '## What remains\n- [x] Calibrate RTL latencies\n- [ ] Integrate simulator',
    turnId: 't2',
  })
  const ui = await $.ui.mount(PANE)
  expect(await texts(ui)).toEqual(['Integrate simulator'])
  await ui.unmount()
})

test('prompt.section hands Claude the open list, and the next reply replaces unpinned auto-suggestions while keeping pinned steps', async ($, on) => {
  engine(on)
  on('prompt.section', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/y8', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'add-mine', text: 'Pin my release checklist' })
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- [Auth] Rotate the signing key\n- [Auth] Add expiry tests for refresh tokens\n- [Issues] #42 Fix token refresh race',
    turnId: 't1',
  })

  const section = await $.prompt.section({ name: 'output_efficiency', text: 'Be concise.' } as never)
  expect((section as { text?: string }).text).toContain('Currently open steps:')
  expect((section as { text?: string }).text).toContain('- [Auth] Rotate the signing key')

  // Next turn emits the updated surviving Next steps list: omitted auto-suggestions are replaced, while Your steps and #42 stay.
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- [Auth] Add expiry tests for refresh tokens\n- [Auth] Wire the revoke endpoint',
    turnId: 't2',
  })
  const openNow = await texts(ui)
  expect(openNow).toContain('Add expiry tests for refresh tokens')
  expect(openNow).toContain('Wire the revoke endpoint')
  expect(openNow).toContain('Pin my release checklist')
  expect(openNow).toContain('#42 Fix token refresh race')
  expect(openNow).not.toContain('Rotate the signing key')

  // Omitted/completed step is preserved in Completed (Pane + /upnext done) for review after the fact.
  expect((await ui.findAll({ type: 'Button', text: /Completed · 1/ })).length).toBe(1)
  await ui.press({ key: 'done-tg' })
  expect((await ui.findAll({ type: 'Text', text: /Auth: Rotate the signing key/ })).length).toBe(1)
  const doneOut = await $.command.run({
    command: 'upnext',
    args: 'done',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(doneOut.text).toContain('- [x] [Auth] Rotate the signing key')
  await ui.unmount()
})
