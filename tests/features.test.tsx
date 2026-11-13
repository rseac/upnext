import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The test runner has timers; the hooks module's own environment types none.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const stores: Record<string, unknown>[] = []
const tick = () => new Promise<void>(r => setTimeout(r, 10))

type Finder = { findAll: (q: { type?: string; text?: RegExp }) => Promise<{ key?: string; text?: string }[]> }
/** A step's row (its run button), not a stream header that shares its words. */
const stepRow = async (ui: Finder, text: RegExp) => (await ui.findAll({ type: 'Button', text })).find(b => b.key?.startsWith('run:'))

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: {
    title: 'Up next',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TURN = { durationMs: 1, isAborted: false } as const
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const LONG = 'I refactored the loader and moved the cache into its own module; everything builds and the old call sites still work.'

type On = Parameters<TestBody>[1]

function engine(on: On, fork: string[] = [], store?: Record<string, unknown>, sessionId = 'sess-1') {
  on('session.id', () => ({ value: sessionId }))
  if (store === undefined) {
    // Keep the store in a map the test can read.
    const kept: Record<string, unknown> = {}
    on('store.set', (_, e) => {
      kept[e.key] = e.value
      return { value: undefined }
    })
    on('store.get', (_, e) => ({ value: kept[e.key] }))
    stores.push(kept)
  } else {
    mock.store(on, store)
  }
  const sent: string[] = []
  const drafted: string[] = []
  const status: (string | undefined)[] = []
  const written: Record<string, string> = {}
  const forks: string[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [{ name: 'real-skill', description: 'does things', source: 'user' as const }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', (_, e) => {
    drafted.push(e.text)
    return { isFilled: true }
  })
  on('prompt.suggest', () => ({ isShown: true }))
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true as const, text: fork.shift() ?? '{"groups":[],"likely":[],"outcomes":[]}', usage: USAGE } }
  })
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  return { sent, drafted, status, written, forks, toasts }
}

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100 && !(await check()); i++) await tick()
}

test('auto: a reply with no listed steps gets a guess at what comes next', async ($, on) => {
  const { forks } = engine(on, ['{"groups":[],"likely":[{"text":"Run the loader tests"}],"outcomes":[]}'])
  await $.session.start({ cwd: '/proj-a', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: LONG, turnId: 't1' })

  const ui = await $.ui.mount(PANE)
  await waitFor(async () => (await ui.find({ type: 'Text', text: /Likely next/ })) !== undefined)
  expect(await ui.find({ type: 'Text', text: /Likely next/ })).toBeDefined()
  expect(await stepRow(ui, /Run the loader tests/)).toBeDefined()
  expect(forks[0]).toContain('/real-skill')
  await ui.unmount()
})

test('auto: a reply that lists its steps needs no model call', async ($, on) => {
  const { forks } = engine(on)
  await $.session.start({ cwd: '/proj-b', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: `${LONG}\n\n## Next steps\n- Add tests\n- Tag a release`, turnId: 't1' })
  await tick()
  expect(forks).toEqual([])
})

test('a step that runs a missing slash command is dropped', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj-c', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: '## Next steps\n- /no-such-thing now\n- /real-skill go\n- Add tests', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  expect(await stepRow(ui, /no-such-thing/)).toBeUndefined()
  expect(await stepRow(ui, /real-skill/)).toBeDefined()
  await ui.unmount()
})

test('a step sent from the pane is checked by the model, and marked ✗ when not done', async ($, on) => {
  const { sent } = engine(on, ['{"groups":[],"likely":[],"outcomes":[{"n":1,"done":false}]}'])
  await $.session.start({ cwd: '/proj-d', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: '## Next steps\n- Fix the flaky test', turnId: 't1' })

  const ui = await $.ui.mount(PANE)
  const row = await stepRow(ui, /Fix the flaky test/)
  await ui.press({ key: row!.key!.replace('run:', 'alt:') })
  expect(sent).toEqual(['Fix the flaky test'])

  await $.turn.start({ text: 'Fix the flaky test', turnId: 't2' })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: 'I looked into it.', turnId: 't2' })
  await waitFor(async () => /✗/.test((await stepRow(ui, /Fix the flaky test/))?.text ?? ''))
  expect((await stepRow(ui, /Fix the flaky test/))?.text).toContain('✗')
  await ui.unmount()
})

test('a prompt the person types that matches a step marks it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj-e', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: '## Next steps\n- Add unit tests for the parser', turnId: 't1' })
  await $.turn.start({ text: 'ok, add unit tests for the parser please', turnId: 't2' })

  const ui = await $.ui.mount(PANE)
  expect((await stepRow(ui, /Add unit tests/))?.text).toContain('◐')
  await $.turn.complete({ ...TURN, reason: 'answer', answer: 'Added them; all pass.', turnId: 't2' })
  expect((await stepRow(ui, /Add unit tests/))?.text).toContain('✓')
  await ui.unmount()
})

test('⇶ offers background agents for a group of two or more steps', async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start({ cwd: '/proj-f', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: '## Next steps\n- Add tests\n- Update the docs', turnId: 't1' })

  const ui = await $.ui.mount(PANE)
  const bg = await ui.find({ type: 'Button', text: /⇶/ })
  expect(bg).toBeDefined()
  // The test kit starts no real agent (only the engine gives one an id), so
  // the steps stay open and the person is told; a session tracks them by id.
  await ui.press({ key: bg!.key! })
  expect(toasts.length).toBe(2)
  expect((await stepRow(ui, /Add tests/))?.text).toContain('○')
  await ui.unmount()
})

test("open steps are saved under this session's id, and the status line counts them", async ($, on) => {
  const { status } = engine(on)
  const store = stores[stores.length - 1]!
  await $.session.start({ cwd: '/proj-g', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: '## Next steps\n- Add tests\n- [x] Ship it', turnId: 't1' })
  expect(status[status.length - 1]).toBe('✦ 1 next step')

  const saved = store['roots:session:sess-1'] as { steps: { text: string }[] }[]
  expect(saved[0]!.steps.map(s => s.text)).toEqual(['Add tests'])
})

test('a resumed session gets its saved steps back, folded', async ($, on) => {
  engine(on, [], {
    'roots:session:sess-1': [
    {
      id: 'old1',
      kind: 'reply',
      title: 'Next steps',
      turn: 7,
      isCollapsed: false,
      steps: [{ id: 'old1.0', text: 'Write the changelog', prompt: 'Write the changelog', status: 'open', isCollapsed: false, children: [] }],
    },
    ],
  })
  await $.session.start({ cwd: '/proj-h', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /earlier/ })).toBeDefined()
  await ui.unmount()
})

test('/upnext export writes a checklist', async ($, on) => {
  const { written, toasts } = engine(on)
  await $.session.start({ cwd: '/proj-i', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: '## Next steps\n- Add tests\n- [x] Ship it', turnId: 't1' })
  const r = await $.command.run({
    command: 'upnext',
    args: 'export plan.md',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(r.text).toBe('Wrote 2 steps to plan.md.')
  expect(toasts).toEqual([])
  const [path, text] = Object.entries(written)[0]!
  expect(path.endsWith('plan.md')).toBe(true)
  expect(text).toContain('- [ ] Add tests')
  expect(text).toContain('- [x] Ship it')
})

test('▶▶ runs a group one step per turn, and stops at one not done', async ($, on) => {
  const { sent } = engine(on)
  await $.session.start({ cwd: '/proj-j', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: '## Next steps\n- Add tests\n- Update the docs\n- Tag a release', turnId: 't1' })

  const ui = await $.ui.mount(PANE)
  const seq = await ui.find({ type: 'Button', text: /▶▶/ })
  await ui.press({ key: seq!.key! })
  expect(sent).toEqual(['Add tests'])
  expect(await ui.find({ type: 'Text', text: /step 1 of 3/ })).toBeDefined()

  await $.turn.start({ text: 'Add tests', turnId: 't2' })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: 'Added them.', turnId: 't2' })
  expect(sent).toEqual(['Add tests', 'Update the docs'])

  await $.turn.start({ text: 'Update the docs', turnId: 't3' })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: 'I could not find the docs folder.', turnId: 't3' })
  expect(sent.length).toBe(2)
  expect(await ui.find({ type: 'Text', text: /running in order/ })).toBeUndefined()
  expect((await stepRow(ui, /Update the docs/))?.text).toContain('✗')
  await ui.unmount()
})

test('you can add your own steps and edit any step', async ($, on) => {
  const { drafted } = engine(on)
  await $.session.start({ cwd: '/proj-k', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await ui.input({ key: 'add-mine', text: 'Benchmark the parser' })
  const row = await stepRow(ui, /Benchmark the parser/)
  expect(row).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Your steps/ })).toBeDefined()

  const id = row!.key!.replace('run:', '')
  await ui.press({ key: `et:${id}` })
  await ui.input({ key: `edit:${id}`, text: 'Benchmark the parser on large replies' })
  const edited = await stepRow(ui, /large replies/)
  await ui.press({ key: edited!.key! })
  expect(drafted).toEqual(['Benchmark the parser on large replies'])
  await ui.unmount()
})

test('Tidy marks done and removes steps the fork points at', async ($, on) => {
  const { toasts } = engine(on, ['{"done":[1],"drop":[2]}'])
  await $.session.start({ cwd: '/proj-l', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, reason: 'answer', answer: '## Next steps\n- Add tests\n- Port to Python\n- Tag a release', turnId: 't1' })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tidy' })
  expect((await stepRow(ui, /Add tests/))?.text).toContain('✓')
  expect(await stepRow(ui, /Port to Python/)).toBeUndefined()
  expect((await stepRow(ui, /Tag a release/))?.text).toContain('○')
  expect(toasts[toasts.length - 1]).toContain('tidied 1 done, 1 removed')
  await ui.unmount()
})

test("a new session starts empty, even in the same folder as another session's steps", async ($, on) => {
  engine(
    on,
    [],
    {
      'roots:session:other-session': [
        {
          id: 'x1',
          kind: 'stream',
          title: 'Auth',
          turn: 3,
          isCollapsed: false,
          steps: [{ id: 'x1.0', text: 'Rotate the signing key', prompt: 'Rotate the signing key', status: 'open', isCollapsed: false, children: [] }],
        },
      ],
    },
    'new-session',
  )
  await $.session.start({ cwd: '/proj-h', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Nothing queued up/ })).toBeDefined()
  await ui.unmount()
})
