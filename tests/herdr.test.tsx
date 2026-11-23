import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: { title: 'Up next', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

declare const setTimeout: (fn: () => void, ms: number) => unknown
const tick = () => new Promise<void>(r => setTimeout(r, 10))

const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const
const RUN = (args: string) => ({ command: 'upnext', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })

type On = Parameters<TestBody>[1]

function engine(on: On, env: Record<string, string>, actions: string[] = []) {
  mock.env(on, env)
  const runs: string[][] = []
  const files: Record<string, string> = {}
  const opened: string[] = []
  const drafted: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.fill', (_, e) => {
    drafted.push(e.text)
    return { isFilled: true }
  })
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[2] === 'split' ? JSON.stringify({ result: { pane: { pane_id: 'w1:p9' } } }) : '{}'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const isActions = e.path.endsWith('.actions')
    const size = isActions ? (actions[0]?.length ?? 0) : 10
    return { value: { kind: 'file' as const, size, mtimeMs: 1, isLink: false } }
  })
  on('fs.read', () => ({ value: actions.shift() ?? '' }))
  return { runs, files, opened, drafted }
}

const HERDR = { HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: '/bin/herdr', HOME: '/home/t' }
const ANSWER = '## Auth follow-ups\n- Rotate the signing key\n- Audit the token store'

test('paneStyle "split": steps open a herdr pane with the viewer instead of the pane inside Claude', { options: { paneStyle: 'split', autoOpen: true } }, async ($, on) => {
  const { runs, files, opened } = engine(on, HERDR)
  await $.session.start({ cwd: '/h1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })

  expect(opened).toEqual([])
  const split = runs.find(r => r[2] === 'split')!
  expect(split.slice(0, 4)).toEqual(['/bin/herdr', 'pane', 'split', 'w1:p1'])
  const run = runs.find(r => r[2] === 'run')!
  expect(run[3]).toBe('w1:p9')
  expect(run[4]).toContain('upnext-herdr.py')
  expect(run[4]).toContain("'/home/t/.claude/upnext/herdr/w1-p1.json'")

  const state = JSON.parse(files['/home/t/.claude/upnext/herdr/w1-p1.json']!) as { claudePane: string; roots: { title: string; steps: { text: string }[] }[] }
  expect(state.claudePane).toBe('w1:p1')
  expect(state.roots[0]!.title).toBe('Auth')
  expect(state.roots[0]!.steps.map(s => s.text)).toEqual(['Rotate the signing key', 'Audit the token store'])

  const label = runs.filter(r => r[2] === 'report-metadata').at(-1)!
  expect(label).toEqual([
    '/bin/herdr', 'pane', 'report-metadata', 'w1:p1', '--source', 'upnext',
    '--title', '2 next', '--token', 'upnext=2 next · Auth: Rotate the signing key',
  ])
})

test('keys pressed in the viewer reach the mod: a step is drafted, another dropped', async ($, on) => {
  const actions: string[] = []
  const { drafted, files } = engine(on, HERDR, actions)
  await $.session.start({ cwd: '/h2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const state = JSON.parse(files['/home/t/.claude/upnext/herdr/w1-p1.json']!) as {
    roots: { steps: { id: string }[] }[]
  }
  const [a, b] = state.roots[0]!.steps
  actions.push(`{"seq":1,"verb":"draft","id":"${a!.id}"}\n{"seq":2,"verb":"dismiss","id":"${b!.id}"}\n`)
  // The timer does not run in tests; the end of a turn also picks requests up.
  await $.turn.complete({ ...TURN, answer: 'ok', turnId: 't2' })
  for (let i = 0; i < 50 && drafted.length === 0; i++) await tick()
  expect(drafted).toEqual(['Rotate the signing key'])
  for (let i = 0; i < 100 && files['/home/t/.claude/upnext/herdr/w1-p1.json']!.includes('Audit'); i++) await tick()
  expect(files['/home/t/.claude/upnext/herdr/w1-p1.json']).not.toContain('Audit')
})

test('outside herdr (with autoOpen) the pane inside Claude opens, and /upnext herdr says why not', { options: { autoOpen: true } }, async ($, on) => {
  const { runs, opened } = engine(on, { HOME: '/home/t' })
  await $.session.start({ cwd: '/h3', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  expect(opened).toEqual(['upnext'])
  expect(runs).toEqual([])
  expect((await $.command.run(RUN('herdr'))).text).toContain('not running inside herdr')
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Button', text: /Rotate the signing key/ })).length).toBe(1)
  await ui.unmount()
})

test('paneStyle "claude" keeps the pane inside Claude in herdr; /upnext herdr and split open on request', { options: { paneStyle: 'claude', autoOpen: true } }, async ($, on) => {
  const { runs, opened } = engine(on, HERDR)
  await $.session.start({ cwd: '/h4', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  expect(opened).toEqual(['upnext'])
  expect(runs).toEqual([])
  expect((await $.command.run(RUN('herdr'))).text).toBe('Opened Up next as a herdr popup.')
  expect((await $.command.run(RUN('split'))).text).toContain('Opened Up next in a herdr pane')
  expect(runs.some(r => r[2] === 'split')).toBe(true)
})

test('inside herdr by default, nothing opens unasked: the sidebar gets the top step, /upnext herdr opens the popup', async ($, on) => {
  const { runs, opened } = engine(on, HERDR)
  await $.session.start({ cwd: '/h5', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  expect(opened).toEqual([])
  expect(runs.some(r => r[2] === 'split')).toBe(false)
  expect(runs.filter(r => r[2] === 'report-metadata').at(-1)).toContain('upnext=2 next · Auth: Rotate the signing key')
  expect((await $.command.run(RUN('herdr'))).text).toBe('Opened Up next as a herdr popup.')
  expect(runs.at(-1)).toEqual(['/bin/herdr', 'plugin', 'pane', 'open', '--plugin', 'upnext', '--entrypoint', 'popup'])
})

test('a step handed to another agent goes to it as one line, and shows as running', async ($, on) => {
  const actions: string[] = []
  const { runs, files } = engine(on, HERDR, actions)
  await $.session.start({ cwd: '/h6', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const state = JSON.parse(files['/home/t/.claude/upnext/herdr/w1-p1.json']!) as { roots: { steps: { id: string }[] }[] }
  const id = state.roots[0]!.steps[0]!.id
  actions.push(`{"seq":1,"verb":"handoff","id":"${id}","pane":"w2:p3","label":"codex w2:p3"}\n`)
  await $.turn.complete({ ...TURN, answer: 'ok', turnId: 't2' })
  for (let i = 0; i < 50 && !runs.some(r => r[2] === 'prompt'); i++) await tick()
  const prompt = runs.find(r => r[1] === 'agent' && r[2] === 'prompt')!
  expect(prompt.slice(0, 4)).toEqual(['/bin/herdr', 'agent', 'prompt', 'w2:p3'])
  expect(prompt[4]).toContain('Rotate the signing key')
  expect(prompt[4]).toContain('Handed over from a Claude Code session working in /h6')
  expect(prompt[4]!.includes('\n')).toBe(false)
  for (let i = 0; i < 50 && !files['/home/t/.claude/upnext/herdr/w1-p1.json']!.includes('codex'); i++) await tick()
  expect(files['/home/t/.claude/upnext/herdr/w1-p1.json']).toContain('"handedTo":"codex w2:p3"')
})

test('marked steps handed to an agent go as one numbered prompt', async ($, on) => {
  const actions: string[] = []
  const { runs, files } = engine(on, HERDR, actions)
  await $.session.start({ cwd: '/h7', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const state = JSON.parse(files['/home/t/.claude/upnext/herdr/w1-p1.json']!) as { roots: { steps: { id: string }[] }[] }
  const [a, b] = state.roots[0]!.steps
  actions.push(`{"seq":1,"verb":"handoff","id":"${a!.id}","ids":["${a!.id}","${b!.id}"],"pane":"w2:p3","label":"codex w2:p3"}\n`)
  await $.turn.complete({ ...TURN, answer: 'ok', turnId: 't2' })
  for (let i = 0; i < 50 && !runs.some(r => r[2] === 'prompt'); i++) await tick()
  const text = runs.find(r => r[1] === 'agent' && r[2] === 'prompt')![4]!
  expect(text).toContain('in order: (1) Rotate the signing key (2) Audit the token store')
})

test('tidy and clear-done actions from the herdr viewer reach the mod', { options: { clearDoneAfter: -1 } }, async ($, on) => {
  const actions: string[] = []
  const { files } = engine(on, HERDR, actions)
  on('model.fork', () => ({
    value: {
      isAnswered: true as const,
      text: '{"done":[1],"drop":[]}',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  await $.session.start({ cwd: '/h8', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  actions.push('{"seq":1,"verb":"tidy","id":""}\n')
  await $.turn.complete({ ...TURN, answer: 'ok', turnId: 't2' })
  for (let i = 0; i < 100 && !files['/home/t/.claude/upnext/herdr/w1-p1.json']!.includes('"status":"done"'); i++) await tick()
  expect(files['/home/t/.claude/upnext/herdr/w1-p1.json']).toContain('"status":"done"')
  actions.push('{"seq":2,"verb":"clear-done","id":""}\n')
  await $.turn.complete({ ...TURN, answer: 'ok', turnId: 't3' })
  for (let i = 0; i < 100 && JSON.stringify(JSON.parse(files['/home/t/.claude/upnext/herdr/w1-p1.json']!).roots).includes('Rotate the signing key'); i++) {
    await tick()
  }
  const state = JSON.parse(files['/home/t/.claude/upnext/herdr/w1-p1.json']!) as { roots: unknown; completed: unknown }
  expect(JSON.stringify(state.roots)).not.toContain('Rotate the signing key')
  expect(JSON.stringify(state.completed)).toContain('Rotate the signing key')
})
