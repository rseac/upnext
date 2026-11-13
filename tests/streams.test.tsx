import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: {
    title: 'Up next',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const
const BAND = {
  plugin: 'upnext',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, bodyColumns: 120 },
} as const

// The test runner has timers; the hooks module's own environment types none.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const tick = () => new Promise<void>(r => setTimeout(r, 10))

const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type On = Parameters<TestBody>[1]
type Found = { key?: string; text?: string }
type Finder = { findAll: (q: { type?: string; text?: RegExp }) => Promise<Found[]> }

function engine(on: On, fork: string[] = []) {
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('model.fork', () => ({
    value: { isAnswered: true as const, text: fork.shift() ?? '{"groups":[],"likely":[],"outcomes":[]}', usage: USAGE },
  }))
  return { toasts }
}

/** The stream headers, top to bottom, as "name: step, step". */
async function streams(ui: Finder): Promise<string[]> {
  const buttons = await ui.findAll({ type: 'Button' })
  const out: string[] = []
  for (const b of buttons) {
    if (b.key?.startsWith('tg:') && b.text?.includes('●')) out.push(b.text.replace(/^[▾▸] ● /, '').replace(/ · .*$/, '') + ':')
    else if (b.key?.startsWith('run:') && out.length > 0) out[out.length - 1] += ` ${b.text?.replace(/^\S+ /, '').replace(/ •$/, '')};`
  }
  return out
}

const headerKey = async (ui: Finder, name: RegExp) =>
  (await ui.findAll({ type: 'Button', text: name })).find(b => b.key?.startsWith('tg:'))!.key!.slice(3)

test('steps from several turns are sorted into streams by what they are about', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/s1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Move the token check into middleware\n- Add token expiry tests', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new CLI flags', turnId: 't2' })
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- Add token expiry tests for refresh tokens\n- Move the token check into the middleware',
    turnId: 't3',
  })

  const ui = await $.ui.mount(PANE)
  expect(await streams(ui)).toEqual([
    'Auth: Move the token check into middleware; Add token expiry tests; Add token expiry tests for refresh tokens;',
    'Docs: Document the new CLI flags;',
  ])
  await ui.unmount()
})

test('a stream can be renamed and merged; a step can move to a new stream', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/s2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new CLI flags\n- Fix broken README links', turnId: 't2' })

  const ui = await $.ui.mount(PANE)
  const auth = await headerKey(ui, /Auth/)
  await ui.press({ key: `rn:${auth}` })
  await ui.input({ key: `edit:${auth}`, text: 'Security' })
  expect((await streams(ui)).map(s => s.split(':')[0])).toEqual(['Docs', 'Security'])

  const docs = await headerKey(ui, /Docs/)
  await ui.press({ key: `rn:${docs}` })
  await ui.press({ key: `mg:${docs}:${auth}` })
  expect(await streams(ui)).toEqual(['Security: Rotate the signing key; Document the new CLI flags; Fix broken README links;'])

  const links = (await ui.findAll({ type: 'Button', text: /Fix broken README links/ })).find(b => b.key?.startsWith('run:'))!
  const id = links.key!.slice(4)
  await ui.press({ key: `et:${id}` })
  await ui.press({ key: `mv:${id}:new` })
  expect(await streams(ui)).toEqual(['Fix broken README links: Fix broken README links;', 'Security: Rotate the signing key; Document the new CLI flags;'])
  await ui.unmount()
})

test("the model's choice of stream is followed", async ($, on) => {
  engine(on, [
    '{"groups":[{"title":"Next steps","stream":"Docs","steps":[{"text":"Add a usage example","children":[]}]}],"likely":[],"outcomes":[]}',
  ])
  await $.session.start({ cwd: '/s3', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new CLI flags', turnId: 't1' })
  await $.turn.complete({
    ...TURN,
    answer: 'I wrote the section on flags and checked it renders; it reads well now, though a short example would help readers.',
    turnId: 't2',
  })
  const ui = await $.ui.mount(PANE)
  for (let i = 0; i < 100 && !(await streams(ui)).join().includes('usage example'); i++) await tick()
  expect(await streams(ui)).toEqual(['Docs: Document the new CLI flags; Add a usage example;'])
  await ui.unmount()
})

test('the 1/2/3 row offers the most important steps first', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/s4', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key\n- Audit the token store', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new CLI flags\n- Fix broken README links', turnId: 't2' })
  const ui = await $.ui.mount(BAND as never)
  const labels = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide').map(b => b.text)
  // "Fix broken…" fixes something broken; then each stream's first step.
  expect(labels).toEqual(['● Fix broken README links', '● Document the new CLI flags', '● Rotate the signing key'])
  await ui.unmount()
})

const RUN = (args: string) => ({ command: 'upnext', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })

test('⊟ archives a stream out of the tree and the band; restore brings it back', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/s5', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new CLI flags', turnId: 't2' })
  const ui = await $.ui.mount(PANE)
  const auth = await headerKey(ui, /Auth/)
  await ui.press({ key: `ar:${auth}` })
  expect((await streams(ui)).map(s => s.split(':')[0])).toEqual(['Docs'])
  expect((await ui.findAll({ type: 'Button', text: /Archived · 1/ })).length).toBe(1)

  const band = await $.ui.mount(BAND as never)
  const labels = (await band.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide').map(b => b.text)
  expect(labels).toEqual(['● Document the new CLI flags'])
  await band.unmount()

  await ui.press({ key: 'arch-tg' })
  await ui.press({ key: `ar-back:${auth}` })
  expect((await streams(ui)).map(s => s.split(':')[0])).toEqual(['Docs', 'Auth'])
  await ui.unmount()
})

test('an archived stream comes back when a reply continues it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/s6', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `ar:${await headerKey(ui, /Auth/)}` })
  expect(await streams(ui)).toEqual([])
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Audit the token store', turnId: 't2' })
  expect(await streams(ui)).toEqual(['Auth: Rotate the signing key; Audit the token store;'])
  await ui.unmount()
})

test('/upnext <stream> shows only that stream; /upnext all shows them all', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/s7', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new CLI flags', turnId: 't2' })
  const r = await $.command.run(RUN('auth'))
  expect(r.text).toContain('only “Auth”')
  const ui = await $.ui.mount(PANE)
  expect((await streams(ui)).map(s => s.split(':')[0])).toEqual(['Auth'])
  expect((await $.command.run(RUN('nothing-like-it'))).text).toContain('No stream matches')
  await $.command.run(RUN('all'))
  expect((await streams(ui)).map(s => s.split(':')[0])).toEqual(['Docs', 'Auth'])
  await ui.press({ key: `fo:${await headerKey(ui, /Docs/)}` })
  expect((await streams(ui)).map(s => s.split(':')[0])).toEqual(['Docs'])
  await ui.press({ key: 'focus-all' })
  expect((await streams(ui)).length).toBe(2)
  await ui.unmount()
})

test('a stream left idle gets one nudge', async ($, on) => {
  const { toasts } = engine(on)
  await $.session.start({ cwd: '/s8', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key', turnId: 't1' })
  for (let i = 2; i <= 14; i++) await $.turn.complete({ ...TURN, answer: 'ok', turnId: `t${i}` })
  const nudges = toasts.filter(t => t.includes('idle'))
  expect(nudges.length).toBe(1)
  expect(nudges[0]).toContain('“Auth” has been idle 10+ turns')
})

test('streams get different colours', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/s9', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new CLI flags', turnId: 't2' })
  const ui = await $.ui.mount(PANE)
  const glyphs = (await ui.findAll({ type: 'Text', text: /^● $/ })) as { props?: { color?: string } }[]
  const colors = glyphs.map(g => g.props?.color)
  expect(colors.length).toBe(2)
  expect(colors[0]).not.toBe(colors[1])
  await ui.unmount()
})
