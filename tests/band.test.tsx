import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const BAND = {
  plugin: 'upnext',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, bodyColumns: 140 },
} as const
const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const

type On = Parameters<TestBody>[1]
type Found = { key?: string; text?: string }

function engine(on: On) {
  const opened: string[] = []
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
  on('prompt.fill', () => ({ isFilled: true }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  return { opened }
}

const ANSWER = '## Next steps\n- Fix the crash on startup\n- Try the new pane\n- Add integration tests for the parser\n- Tidy the README'

test('three lines above the prompt: the top steps with why; the pane does not open by itself', async ($, on) => {
  const { opened } = engine(on)
  await $.session.start({ cwd: '/b1', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  expect(opened).toEqual([])
  const band = await $.ui.mount(BAND as never)
  const rows = (await band.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide')
  expect(rows.length).toBe(3)
  expect(rows[0]!.text).toBe('○ Fix the crash on startup')
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text ?? '')
  expect(texts.some(t => t.includes('· fixes something broken'))).toBe(true)
  expect((await band.findAll({ type: 'Button', text: /hide/ })).length).toBe(1)

  // Selecting a number drafts the step into the prompt box instead of silently deleting it.
  const check = rows.find(r => r.text?.startsWith('☐'))!
  await band.press({ key: check.key! })
  const after = (await band.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide').map(b => b.text)
  expect(after).toContain('☐ Try the new pane')
  await band.unmount()
})

test('bandStyle "row" keeps the single line and trims trailing explanation clauses', { options: { bandStyle: 'row' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/b2', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- Run the full test suite — verifies that the parser handles edge cases cleanly\n- Try the new pane',
    turnId: 't1',
  })
  const band = await $.ui.mount(BAND as never)
  expect((await band.findAll({ type: 'Text', text: /✦ next/ })).length).toBe(1)
  const rows = (await band.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide')
  expect(rows.map(r => r.text)).toEqual(['● Run the full test suite', '● Try the new pane'])
  await band.unmount()
})

const rowsShown = async (band: { findAll: (q: { type?: string }) => Promise<Found[]> }) =>
  (await band.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide').length

test('the lines fit the rows Claude Code gives: two rows, two lines; one row, all three on one line', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/b3', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...TURN, answer: ANSWER, turnId: 't1' })
  const two = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 2 } } as never)
  expect(await rowsShown(two)).toBe(2)
  expect((await two.findAll({ type: 'Text', text: /✦ next/ })).length).toBe(0)
  await two.unmount()
  const one = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 1 } } as never)
  expect(await rowsShown(one)).toBe(3)
  expect((await one.findAll({ type: 'Text', text: /✦ next/ })).length).toBe(1)
  await one.unmount()
})

test('top-ranked steps with open sub-steps show +N next to their text in AbovePrompt', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/b4', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...TURN,
    answer: '## Next steps\n- Fix the crash on startup\n  - Reproduce on Linux\n  - Add a regression test\n- Tidy the README',
    turnId: 't1',
  })
  const band = await $.ui.mount(BAND as never)
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text ?? '')
  expect(texts.some(t => t === ' +2')).toBe(true)
  await band.unmount()
})

test('a plan consolidates with LLM suggestions, ranks the next plan frontier first, and opens in the pane on p', async ($, on) => {
  const { opened } = engine(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.session.start({ cwd: '/b5', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Write',
    toolUseId: 'w1',
    file_path: 'PLAN.md',
    content: [
      '# Vector Memory Plan',
      '',
      '## Phase 1: Extraction',
      '- [x] Extract load-side pointer bank signals',
      '- [ ] Derive max-plus timing constraints for bank conflict',
      '',
      '## Phase 2: Validation',
      '- [ ] Fit latency parameters',
      '- [ ] Run unseen batch 93 regression',
      '- [ ] Archive old trace logs',
    ].join('\n'),
  } as never)

  // Turn 1 suggests a tactical sub-step for the frontier plan step and a more concrete phrasing of step 3.
  await $.turn.complete({
    ...TURN,
    answer: [
      '## Next steps',
      '- Run `ptrb_next48np.elf` to measure bank conflict timing',
      '- Fit latency parameters on `batch92.json`',
    ].join('\n'),
    turnId: 't1',
  })

  const band = await $.ui.mount(BAND as never)
  const rows = (await band.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('b:') && b.key !== 'b:hide')
  // Frontier plan step ranks first (with its consolidated tactical sub-step +1), and the refined step 3 is not duplicated.
  expect(rows[0]!.text).toBe('○ Derive max-plus timing constraints for bank conflict')
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text ?? '')
  expect(texts.some(t => t === ' +1')).toBe(true)

  // Pressing p ("plan-open") in the band opens the pane focused on the Plan view.
  await band.press({ key: 'plan-open' })
  expect(opened).toContain('upnext')
  await band.unmount()

  const pane = await $.ui.mount({
    plugin: 'upnext',
    component: 'Pane',
    requestId: 'upnext',
    surface: 'terminal',
    props: { title: 'Up next', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as never)
  const paneTexts = (await pane.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
  expect(paneTexts).toContain('Plan: Vector Memory Plan (1/6 done)')
  await pane.unmount()
})
