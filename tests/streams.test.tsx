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
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('model.fork', () => ({
    value: { isAnswered: true as const, text: fork.shift() ?? '{"groups":[],"likely":[],"outcomes":[]}', usage: USAGE },
  }))
}

/** The stream headers, top to bottom, as "name: step, step". */
async function streams(ui: Finder): Promise<string[]> {
  const buttons = await ui.findAll({ type: 'Button' })
  const out: string[] = []
  for (const b of buttons) {
    if (b.key?.startsWith('tg:') && b.text?.includes('⬢')) out.push(b.text.replace(/^[▾▸] ⬢ /, '').replace(/ · .*$/, '') + ':')
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

test('the 1/2/3 row offers the top step of each stream first', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/s4', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Auth follow-ups\n- Rotate the signing key\n- Audit the token store', turnId: 't1' })
  await $.turn.complete({ ...TURN, answer: '## Docs follow-ups\n- Document the new CLI flags\n- Fix broken README links', turnId: 't2' })
  const ui = await $.ui.mount(BAND as never)
  const labels = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide').map(b => b.text)
  expect(labels).toEqual(['Document the new CLI flags', 'Rotate the signing key', 'Fix broken README links'])
  await ui.unmount()
})
