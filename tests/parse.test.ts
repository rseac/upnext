import { expect, test } from 'claude-code/testing'

import { parseReply, parseToolText, wrapRuns, runsOf } from '../hooks/parse'

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

test('tool output gives command hints', async () => {
  const roots = parseToolText('found 3 vulnerabilities\nRun `npm audit fix` to fix them.\n  (use "git add <file>..." to stage)')
  expect(roots).toEqual([{ kind: 'tool', title: 'Hints', steps: [{ text: 'Run `npm audit fix`', children: [] }] }])
})

test('wrapping keeps to the width and ends in an ellipsis', async () => {
  const lines = wrapRuns(runsOf('one two three four five six seven eight nine ten'), 10, 2)
  expect(lines.length).toBe(2)
  expect(lines[1]!.map(r => r.text).join('').endsWith('…')).toBe(true)
})
