import { expect, test } from 'claude-code/testing'

import { clean, forYouOf, parseChecklist, parseOffers, parseReply, wrapRuns, runsOf } from '../hooks/parse'

const REPLY = `Done: the parser now handles nested lists.

## Next steps

1. Add unit tests for the parser
   - cover nested lists
   - cover \`code\` spans
2. Update the README

## Summary

Nothing else changed.

Want me to wire up CI, or publish the package?`

test('a reply gives one tree per section, plus its offers', async () => {
  const roots = parseReply(REPLY)
  expect(roots.map(r => r.title)).toEqual(['Next steps', 'Claude offered'])
  const steps = roots[0]!.steps
  expect(steps.map(s => s.text)).toEqual(['Add unit tests for the parser', 'Update the README'])
  expect(steps[0]!.children.map(s => s.text)).toEqual(['cover nested lists', 'cover `code` spans'])
  expect(roots[1]!.steps.map(s => s.text)).toEqual(['Wire up CI', 'Publish the package'])
})

test('bold sub-headings become groups', async () => {
  const roots = parseReply(`**Suggested follow-ups:**\n\n### Tests\n- a b\n### Docs\n- c d`)
  expect(roots[0]!.steps.map(s => s.text)).toEqual(['Tests', 'Docs'])
  expect(roots[0]!.steps[1]!.children[0]!.text).toBe('c d')
})

test('lists outside a next-steps section are ignored', async () => {
  expect(parseReply(`## What changed\n- renamed a file\n- fixed a bug`)).toEqual([])
})

test('code blocks are skipped', async () => {
  expect(parseReply('```\n## Next steps\n- nope\n```')).toEqual([])
})

test('wrapping keeps to the width and ends in an ellipsis', async () => {
  const lines = wrapRuns(runsOf('one two three four five six seven eight nine ten'), 10, 2)
  expect(lines.length).toBe(2)
  expect(lines[1]!.map(r => r.text).join('').endsWith('…')).toBe(true)
})

test('clean drops escapes, invisible characters and tag-smuggled text', async () => {
  expect(clean('a\u001b[1mb\u001b[0m​c')).toBe('abc')
  expect(clean('ok\u{E0041}')).toBe('')
})

test('steps for the person are told apart from prompts for Claude', async () => {
  const cases: [string, 'check' | 'decide' | undefined][] = [
    ['Try the new pane', 'check'],
    ['Press `p` once to see the ranking', 'check'],
    ['Check that finished steps disappear about three turns after ✓', 'check'],
    ['Restart the viewer and compare it with the image', 'check'],
    ['Work for a few turns and check the order', 'check'],
    ['Open the pane inside Claude with `/upnext`', 'check'],
    ['Pick a license (MIT if unsure)', 'decide'],
    ['Say whether to build ageing as described', 'decide'],
    ['Choose the layout: A + B, or keep the split', 'decide'],
    ['Add integration tests for the parser', undefined],
    ['Fix the crash on startup', undefined],
    ['Check the logs for the timeout error', undefined],
    ['Try increasing the timeout to 30 seconds', undefined],
    ['Open a PR for the parser fix', undefined],
    ['/review the README changes', undefined],
  ]
  for (const [text, want] of cases) expect([text, forYouOf(text)]).toEqual([text, want])
})

test('soft cues with no clear action are marked weak, while strong cues are not', async () => {
  const weak = parseReply('## Ideas\n- Performance could matter later\n- Memory usage in large repos')
  expect(weak[0]?.isWeak).toBe(true)
  const strong = parseReply('## Next steps\n- Performance could matter later\n- Memory usage in large repos')
  expect(strong[0]?.isWeak).toBeUndefined()
  const actionIdea = parseReply('## Ideas\n- Add caching for large repos')
  expect(actionIdea[0]?.isWeak).toBeUndefined()
})

test('parseChecklist reads open items by stream and skips completed ones', async () => {
  const md = `# Next steps\n\n## Auth (archived)\n\n- [x] Rotate keys\n- [ ] Audit token store\n  - [ ] Check refresh TTL\n\n## Docs\n\n- [ ] Update README\n`
  const roots = parseChecklist(md)
  expect(roots.map(r => r.title)).toEqual(['Auth', 'Docs'])
  expect(roots[0]!.steps.map(s => s.text)).toEqual(['Audit token store'])
  expect(roots[0]!.steps[0]!.children.map(s => s.text)).toEqual(['Check refresh TTL'])
  expect(roots[1]!.steps.map(s => s.text)).toEqual(['Update README'])
})

test('parseOffers skips vague conversational sign-offs while keeping concrete offers', async () => {
  expect(parseOffers('Let me know if you would like me to make any changes or go into more detail.')).toEqual([])
  expect(parseOffers('I can elaborate on that or walk you through the changes.')).toEqual([])
  expect(parseOffers('Want me to tweak anything else?')).toEqual([])
  const kept = parseOffers('I can run the test suite or walk you through it.')
  expect(kept.length).toBe(1)
  expect(kept[0]!.steps.map(s => s.text)).toEqual(['Run the test suite'])
})

test('leading [Stream] and [check]/[decide] tags split sections by stream and set forYou', async () => {
  const roots = parseReply(
    '## Next steps\n- [Auth] Rotate the signing key\n- [Auth] [check] Try logging in with an expired token\n- [Docs] [decide] Pick whether to document the legacy flag',
  )
  expect(roots.map(r => [r.title, r.stream])).toEqual([
    ['Auth', 'Auth'],
    ['Docs', 'Docs'],
  ])
  expect(roots[0]!.steps.map(s => [s.text, s.forYou])).toEqual([
    ['Rotate the signing key', undefined],
    ['Try logging in with an expired token', 'check'],
  ])
  expect(roots[1]!.steps.map(s => [s.text, s.forYou])).toEqual([['Pick whether to document the legacy flag', 'decide']])
})
