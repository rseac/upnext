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

function engine(on: On, answers: string[] = []) {
  const asked: { model: string; prompt: string }[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('model.complete', (_, e) => {
    asked.push({ model: e.model, prompt: typeof e.prompt === 'string' ? e.prompt : '' })
    return { value: { isAnswered: true as const, text: answers.shift() ?? '{"top":[]}', usage: USAGE } }
  })
  return { asked }
}

type Finder = { findAll: (q: { type?: string; text?: RegExp }) => Promise<Found[]> }

/** The ranked rows' text, top to bottom. */
async function ranked(ui: Finder): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('top:')).map(r => r.text?.replace(/^\S+ /, '') ?? '')
}

/** The reason lines under the ranked rows, top to bottom. */
async function reasons(ui: Finder, of: string[]): Promise<string[]> {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text?.trim() ?? '')
  return of.filter(w => texts.includes(w))
}

test('the free ranking puts what you asked for and what is broken first, with why', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/r1', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'please update the changelog for the release', turnId: 't1' } as never)
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- Add a dark mode toggle (optional)\n- Fix the crash on startup\n- Update the changelog',
    turnId: 't1',
  })
  const ui = await $.ui.mount(PANE)
  expect(await ranked(ui)).toEqual(['Update the changelog', 'Fix the crash on startup', 'Add a dark mode toggle (optional)'])
  const why = ['you asked for this', 'fixes something broken', 'just suggested']
  expect(await reasons(ui, why)).toEqual(why)
  await ui.unmount()
})

test('with four or more open steps, Haiku re-ranks from a short brief, and p asks again', async ($, on) => {
  const { asked } = engine(on, ['{"top":[{"n":3,"why":"the release is blocked on it"},{"n":1,"why":"users hit it daily"}]}'])
  await $.session.start({ cwd: '/r2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- Speed up the search page\n- Add a dark mode toggle\n- Sign the release build\n- Tidy the README',
    turnId: 't1',
  })
  const ui = await $.ui.mount(PANE)
  for (let i = 0; i < 100 && !(await ranked(ui))[0]?.startsWith('Sign'); i++) await tick()
  const rows = await ranked(ui)
  expect(rows.slice(0, 2)).toEqual(['Sign the release build', 'Speed up the search page'])
  const why = ['the release is blocked on it', 'users hit it daily']
  expect(await reasons(ui, why)).toEqual(why)
  expect(asked.length).toBe(1)
  expect(asked[0]!.model).toBe('haiku')
  expect(asked[0]!.prompt).toContain('3. [Speed up the search] Sign the release build')
  expect(asked[0]!.prompt.length).toBeLessThan(3000)

  await ui.press({ key: 'rank' })
  expect(asked.length).toBe(2)
  await ui.unmount()
})

test('rank "off" shows the plain list, with no ranked section and no model call', { options: { rank: 'off' } }, async ($, on) => {
  const { asked } = engine(on)
  await $.session.start({ cwd: '/r3', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- One thing to do\n- Another thing to do\n- A third thing to do\n- A fourth thing', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  expect(await ranked(ui)).toEqual([])
  expect(asked.length).toBe(0)
  await ui.unmount()
})

test('Haiku ranking can drop non-actionable noise without dropping your own steps', async ($, on) => {
  engine(on, ['{"top":[{"n":1,"why":"fixes the crash"}],"drop":[2,5]}'])
  await $.session.start({ cwd: '/r4', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'add-mine', text: 'Keep my custom step' })
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- Fix the crash on startup\n- Pure status note with no action\n- Add unit tests\n- Update the README',
    turnId: 't1',
  })
  for (let i = 0; i < 100 && (await ui.findAll({ type: 'Button', text: /Pure status note/ })).length > 0; i++) await tick()
  expect((await ui.findAll({ type: 'Button', text: /Pure status note/ })).length).toBe(0)
  expect((await ui.findAll({ type: 'Button', text: /Keep my custom step/ })).filter(b => b.key?.startsWith('run:')).length).toBe(1)
  await ui.unmount()
})

test('moving on to a new topic puts the current turn first ahead of earlier blockers and requests', { options: { rank: 'local' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/r5', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'fix the auth login error', turnId: 't1' } as never)
  await $.turn.complete({
    ...TURN,
    answer: '## Auth follow-ups\n- Fix the auth login error\n- Rotate the session secret',
    turnId: 't1',
  })
  await $.turn.start({ text: 'now let us build the billing export', turnId: 't2' } as never)
  await $.turn.complete({
    ...TURN,
    answer: '## Billing follow-ups\n- Add CSV export for invoices\n- Wire the billing webhook',
    turnId: 't2',
  })
  const ui = await $.ui.mount(PANE)
  const rows = await ranked(ui)
  expect(rows.slice(0, 2)).toEqual(['Add CSV export for invoices', 'Wire the billing webhook'])
  await ui.unmount()
})

test('a turn that adds no steps boosts the existing stream and steps matching the active topic', { options: { rank: 'local' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/r6', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: '## Billing follow-ups\n- Wire the billing webhook\n- Export monthly invoices',
    turnId: 't1',
  })
  await $.turn.complete({
    ...TURN,
    answer: '## Auth follow-ups\n- Fix the auth login error\n- Rotate the session secret',
    turnId: 't2',
  })
  // Turn 3 discusses billing without adding any new steps and without running a step directly.
  await $.turn.start({ text: 'what retry policy should we use for billing?', turnId: 't3' } as never)
  await $.turn.complete({
    ...TURN,
    answer: 'For the billing webhook and monthly invoices, use exponential backoff with idempotency keys.',
    turnId: 't3',
  })
  const ui = await $.ui.mount(PANE)
  const rows = await ranked(ui)
  expect(rows[0]).toBe('Wire the billing webhook')
  await ui.unmount()
})

test('top-ranked steps with open sub-steps show +N in Pane', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/r7', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- Fix the crash on startup\n  - Reproduce on Linux\n  - Add a regression test\n- Tidy the README',
    turnId: 't1',
  })
  const ui = await $.ui.mount(PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  expect(texts.some(t => t === ' +2')).toBe(true)
  await ui.unmount()
})
