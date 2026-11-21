import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'upnext',
  component: 'Pane',
  requestId: 'upnext',
  surface: 'terminal',
  props: { title: 'Up next', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const

type On = Parameters<TestBody>[1]
type Found = { key?: string; text?: string }

function engine(on: On, commitMessage: string, bashText: string) {
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'upnext' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: commitMessage, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: bashText }, text: bashText, isError: false }) as never)
  return { toasts }
}

const ANSWER = '## Next steps\n- Add expiry tests for refresh tokens\n- Fix the failing parser test\n- Document the new flag'

async function statusOf(ui: { findAll: (q: { type?: string }) => Promise<Found[]> }, re: RegExp) {
  return (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('run:') && re.test(b.text ?? ''))?.text?.charAt(0)
}

test('a commit ticks the steps its message covers, and only those', async ($, on) => {
  const { toasts } = engine(on, 'Add expiry tests for refresh tokens\n\nAlso tidy the fixtures.', '[main 1a2b3c4] Add expiry tests')
  await $.session.start({ cwd: '/t1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "Add expiry tests for refresh tokens"' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await statusOf(ui, /expiry tests/)).toBe('✓')
  expect(await statusOf(ui, /Document the new flag/)).toBe('○')
  expect(toasts.at(-1)).toContain('(committed)')
  await ui.unmount()
})

test('a passing test run ticks "fix the failing test"; a failing one does not', async ($, on) => {
  engine(on, '', 'tests/parse.test.ts:\n 12 pass\n 0 fail')
  await $.session.start({ cwd: '/t2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await statusOf(ui, /failing parser test/)).toBe('✓')
  expect(await statusOf(ui, /expiry tests/)).toBe('○')
  await ui.unmount()
})

test('a test run with failures ticks nothing', async ($, on) => {
  engine(on, '', ' 11 pass\n 1 fail')
  await $.session.start({ cwd: '/t3', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await statusOf(ui, /failing parser test/)).toBe('○')
  await ui.unmount()
})

test('a commit does not tick a step on stop-word overlap alone', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/t4', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Add the tests', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "Add the banner"' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await statusOf(ui, /Add the tests/)).toBe('○')
  await ui.unmount()
})

test('generic commit and push steps tick on git commit and git push', async ($, on) => {
  const { toasts } = engine(on, 'wip', 'Everything up-to-date')
  await $.session.start({ cwd: '/t5', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: '## Next steps\n- Commit the changes\n- Push to origin\n- Update the changelog', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "wip"' } as never)
  let ui = await $.ui.mount(PANE)
  expect(await statusOf(ui, /Commit the changes/)).toBe('✓')
  expect(await statusOf(ui, /Push to origin/)).toBe('○')
  expect(await statusOf(ui, /Update the changelog/)).toBe('○')
  expect(toasts.at(-1)).toContain('(committed)')
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  ui = await $.ui.mount(PANE)
  expect(await statusOf(ui, /Push to origin/)).toBe('✓')
  expect(await statusOf(ui, /Update the changelog/)).toBe('○')
  expect(toasts.at(-1)).toContain('(pushed)')
  await ui.unmount()
})

test('git merge ticks steps that wait on merging that branch', async ($, on) => {
  engine(on, 'Merge branch vec-bp1', 'Fast-forward')
  await $.session.start({ cwd: '/t6', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- Wait for BP1 result, then merge `vec-bp1` and run the keep rule\n- Update the changelog',
    turnId: 't1',
  })
  await $.tool.call({ tool: 'Bash', command: 'git merge vec-bp1' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await statusOf(ui, /merge vec-bp1/)).toBe('✓')
  expect(await statusOf(ui, /Update the changelog/)).toBe('○')
  await ui.unmount()
})
