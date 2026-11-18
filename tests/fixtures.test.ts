// Reply formats seen in practice, each with the steps the parser should find.
// Add a case here whenever a real reply is read wrongly.
import { expect, test } from 'claude-code/testing'

import { commandOf, parseReply, type ParsedRoot } from '../hooks/parse'

const texts = (roots: ParsedRoot[]) => roots.map(r => [r.title, r.steps.map(s => s.text)])

const CASES: { name: string; reply: string; want: (string | string[])[][] }[] = [
  {
    name: 'emoji heading, bold lead-ins',
    reply: '## 🚀 Next steps\n\n1. **Run the migration**: `npm run migrate`\n2. **Update the docs**',
    want: [['🚀 Next steps', ['**Run the migration**: `npm run migrate`', '**Update the docs**']]],
  },
  {
    name: 'lead-in sentence',
    reply: "Done.\n\nHere's what I'd suggest next:\n- Add a retry to the fetch\n- Log the status code",
    want: [["Here's what I'd suggest next", ['Add a retry to the fetch', 'Log the status code']]],
  },
  {
    name: 'bold "Next:" with the step inline',
    reply: 'All green.\n\n**Next:** run the integration tests.',
    want: [['Next', ['run the integration tests.']]],
  },
  {
    name: 'what is left, with checked boxes',
    reply: "### What's left\n- [ ] wire up auth\n- [x] add tests",
    want: [["What's left", ['wire up auth', 'add tests']]],
  },
  {
    name: 'a table of steps',
    reply: '## Next steps\n\n| Step | Why |\n| --- | --- |\n| Add tests | coverage |\n| Tag a release | ship it |',
    want: [['Next steps', ['Add tests', 'Tag a release']]],
  },
  {
    name: '"I can also" list',
    reply: 'I can also:\n- add a CLI flag\n- write a migration guide',
    want: [['I can also', ['add a CLI flag', 'write a migration guide']]],
  },
  {
    name: 'closing offer with "go ahead and"',
    reply: 'The fix is in.\n\nShould I go ahead and commit these changes?',
    want: [['Claude offered', ['Commit these changes']]],
  },
  {
    name: 'offer to run a slash command',
    reply: 'Tests pass.\n\nWant me to run `/code-review high` on the branch?',
    want: [['Claude offered', ['Run `/code-review high` on the branch']]],
  },
  {
    name: '"I could not…" is a report, not an offer',
    reply: 'I could not find the docs folder. I can see it was moved in the last commit.',
    want: [],
  },
  {
    name: 'a summary of changes is not a next step',
    reply: '## Changes\n- renamed `foo`\n- fixed the off-by-one\n\n## Testing\nAll 40 tests pass.',
    want: [],
  },
  {
    name: 'numbered list with nested detail and a closing question',
    reply:
      '## Next steps\n\n1. Add an `auto` mode\n   - only call the model when needed\n2. Show a status count\n\nWant me to start on 1?',
    want: [['Next steps', ['Add an `auto` mode', 'Show a status count']]],
  },
]

for (const c of CASES) {
  test(`reply: ${c.name}`, async () => {
    expect(texts(parseReply(c.reply))).toEqual(c.want)
  })
}

test('a checked box comes through as done', async () => {
  const [root] = parseReply('### Remaining\n- [ ] a b\n- [x] c d')
  expect(root!.steps.map(s => s.isDone === true)).toEqual([false, true])
})

test('slash-command steps are recognised', async () => {
  expect(commandOf('/code-review high')).toBe('/code-review high')
  expect(commandOf('Run `/simplify`')).toBe('/simplify')
  expect(commandOf('Run the tests')).toBeUndefined()
})

test('explanation under a heading that only mentions a recommendation is not a step', async () => {
  const reply = `Three ways to go:

**A. A herdr pane next to Claude (my recommendation)**

- **How it fits together:**
  - The mod writes the step tree to a file after each turn.
  - A small viewer script runs in its own herdr pane.
- **Why it would help:** herdr draws its own panes, so the symbol widths are out of the picture.
- **What you lose:** clicking and hover cards.

## Next steps

- Restart the viewer and compare it with the image
- **Why it matters:** the old script is still running
- Open the pane inside Claude with \`/upnext\``
  const roots = parseReply(reply)
  expect(roots.map(r => r.title)).toEqual(['Next steps'])
  expect(roots[0]!.steps.map(s => s.text)).toEqual(['Restart the viewer and compare it with the image', 'Open the pane inside Claude with `/upnext`'])
})

test('a "Label:" group of statements is explanation; one with actions stays', async () => {
  const reply = `## Next steps

- **How it works:**
  - The viewer reads a file.
  - It never types into Claude's pane.
- **Docs:**
  - Document the new flag
  - Add a usage example`
  const steps = parseReply(reply)[0]!.steps
  expect(steps.map(s => s.text)).toEqual(['**Docs:**'])
  expect(steps[0]!.children.map(s => s.text)).toEqual(['Document the new flag', 'Add a usage example'])
})

test('one section adds at most ten steps', async () => {
  const items = Array.from({ length: 14 }, (_, i) => `- Add test case ${i + 1}`).join('\n')
  expect(parseReply(`## Next steps\n${items}`)[0]!.steps.length).toBe(10)
})

test('named ideas ("**Archive:** park a stream…") stay; commentary labels go', async () => {
  const reply = `**Optional ideas**

- **Stream colours:** a colour per stream, also used in the 1/2/3 row.
- **Archive:** park a stream without deleting it.
- **Trade-off:** more colours to learn.`
  expect(parseReply(reply)[0]!.steps.map(s => s.text.replace(/:\*\*.*/, ''))).toEqual(['**Stream colours', '**Archive'])
})
