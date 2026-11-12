import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Inflight, Root, RootKind, Step, StepStatus } from '../types'
import {
  flat,
  keyOf,
  parseReply,
  parseToolText,
  plain,
  runsOf,
  widthOf,
  wrapRuns,
  type ParsedRoot,
  type ParsedStep,
} from './parse'

const PANE = 'next-steps'
const TITLE = 'Next steps'
const MAX_ROOTS = 24

// Bump a tag when that value's fields change: older stored values are then
// read as the initial value instead of being misread.
const rootsA = atom({ plugin: 'next-steps-pane', key: 'roots' } as const, [], { shape: 'roots-1' })
const pendingA = atom({ plugin: 'next-steps-pane', key: 'pending' } as const, [], { shape: 'pending-1' })
const inflightA = atom({ plugin: 'next-steps-pane', key: 'inflight' } as const, [], { shape: 'inflight-1' })
const turnA = atom({ plugin: 'next-steps-pane', key: 'turn' } as const, 0)
const closedA = atom({ plugin: 'next-steps-pane', key: 'isClosedByPerson' } as const, false)

// ---- Tree helpers ----------------------------------------------------------

const uid = () => crypto.randomUUID().slice(0, 8)

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s)

function promptFor(kind: RootKind, text: string, ancestors: string[], source?: string): string {
  const t = plain(text)
  switch (kind) {
    case 'offer':
      return `Yes, please ${lowerFirst(t).replace(/[.?!]+$/, '')}.`
    case 'todo':
      return `Work on this item from the todo list next: ${t}`
    case 'tool':
      return source ? `${t}\n\n(Suggested by the output of \`${source}\`.)` : t
    case 'reply':
      return ancestors.length > 0 ? `${t}\n\n(This is part of: ${ancestors.map(plain).join(' › ')}.)` : t
  }
}

function toSteps(kind: RootKind, parsed: ParsedStep[], base: string, ancestors: string[], source?: string): Step[] {
  return parsed.map((p, i) => {
    const id = `${base}.${i}`
    return {
      id,
      text: p.text,
      prompt: promptFor(kind, p.text, ancestors, source),
      status: 'open',
      isCollapsed: false,
      children: toSteps(kind, p.children, id, [...ancestors, p.text], source),
    }
  })
}

function toRoot(p: ParsedRoot, turn: number, source?: string): Root {
  const id = uid()
  return {
    id,
    kind: p.kind,
    title: p.title,
    source,
    turn,
    isCollapsed: false,
    steps: toSteps(p.kind, p.steps, id, [], source),
  }
}

const allSteps = (steps: Step[]): Step[] => steps.flatMap(s => [s, ...allSteps(s.children)])

const mapSteps = (steps: Step[], fn: (s: Step) => Step | undefined): Step[] =>
  steps.flatMap(s => {
    const next = fn({ ...s, children: mapSteps(s.children, fn) })
    return next ? [next] : []
  })

const mapAll = (roots: Root[], fn: (s: Step) => Step | undefined): Root[] =>
  roots.map(r => ({ ...r, steps: mapSteps(r.steps, fn) })).filter(r => r.steps.length > 0)

function find(roots: Root[], id: string): { root: Root; step: Step; ancestors: Step[] } | undefined {
  for (const root of roots) {
    const walk = (steps: Step[], ancestors: Step[]): { step: Step; ancestors: Step[] } | undefined => {
      for (const step of steps) {
        if (step.id === id) return { step, ancestors }
        const hit = walk(step.children, [...ancestors, step])
        if (hit) return hit
      }
      return undefined
    }
    const hit = walk(root.steps, [])
    if (hit) return { root, ...hit }
  }
  return undefined
}

const bullets = (steps: Step[], depth = 0): string =>
  steps
    .filter(s => s.status !== 'done')
    .map(s => `${'  '.repeat(depth)}- ${plain(s.text)}${s.children.length ? '\n' + bullets(s.children, depth + 1) : ''}`)
    .join('\n')

function promptForStep(step: Step): string {
  const open = step.children.filter(c => c.status !== 'done')
  return open.length > 0 ? `${step.prompt}\n\nThat includes:\n${bullets(open)}` : step.prompt
}

function promptForRoot(root: Root): string {
  const list = bullets(root.steps)
  switch (root.kind) {
    case 'offer':
      return `Yes, please do all of these:\n${list}`
    case 'todo':
      return `Continue with the open items on the todo list:\n${list}`
    default:
      return `Please work through these next steps (${plain(root.title)}):\n${list}`
  }
}

/** Steps of `incoming` already open somewhere in `existing` are dropped. */
function dedupe(existing: Root[], incoming: Root[]): Root[] {
  const open = new Set(
    existing.flatMap(r => allSteps(r.steps)).filter(s => s.status !== 'done').map(s => keyOf(s.text)),
  )
  return mapAll(incoming, s => (s.children.length === 0 && open.has(keyOf(s.text)) ? undefined : s))
}

// ---- Reading a turn --------------------------------------------------------

const MODEL_SYSTEM = `You read the final message an AI coding assistant sent at the end of a turn and pull out the concrete next steps it suggests, recommends or offers to do, as a tree.

Answer with JSON only, no prose and no code fence:
{"groups":[{"title":"short heading","steps":[{"text":"imperative action, under 100 characters","children":[...]}]}]}

Rules:
- Only actions someone could ask the assistant to do next. Skip summaries of work already done, explanations and questions about preferences.
- Keep the assistant's own grouping and nesting where it has one; otherwise one group titled "Next steps".
- Keep inline code in backticks.
- If there are none, answer {"groups":[]}.`

type ModelGroup = { title?: unknown; steps?: unknown }
type ModelStep = { text?: unknown; children?: unknown }

function fromModel(text: string): ParsedRoot[] | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let data: { groups?: unknown }
  try {
    data = JSON.parse(text.slice(start, end + 1)) as { groups?: unknown }
  } catch {
    return undefined
  }
  if (!Array.isArray(data.groups)) return undefined
  const steps = (list: unknown, depth: number): ParsedStep[] =>
    !Array.isArray(list) || depth > 4
      ? []
      : (list as ModelStep[])
          .filter(s => typeof s?.text === 'string' && s.text.trim() !== '')
          .slice(0, 20)
          .map(s => ({ text: String(s.text).trim().slice(0, 300), children: steps(s.children, depth + 1) }))
  return (data.groups as ModelGroup[])
    .map(g => ({
      kind: 'reply' as const,
      title: typeof g?.title === 'string' && g.title.trim() ? g.title.trim().slice(0, 80) : TITLE,
      steps: steps(g?.steps, 0),
    }))
    .filter(g => g.steps.length > 0)
}

async function extract($: EngineInterface, answer: string, useModel: boolean): Promise<ParsedRoot[]> {
  const heuristic = parseReply(answer)
  if (!useModel || answer.trim().length < 40) return heuristic
  const r = await $.model.complete({ model: 'haiku', system: MODEL_SYSTEM, prompt: answer.slice(-16000) })
  if (!r.isAnswered) return heuristic
  const parsed = fromModel(r.text)
  return parsed === undefined ? heuristic : parsed
}

async function addRoots($: EngineInterface, incoming: Root[], autoOpen: boolean) {
  let added = 0
  await update($, rootsA, roots => {
    const fresh = dedupe(roots, incoming)
    added = fresh.length
    if (fresh.length === 0) return roots
    // Newest first; earlier groups fold away (the todo list stays as it is).
    const older = roots.map(r => (r.kind === 'todo' ? r : { ...r, isCollapsed: true }))
    return [...fresh, ...older].slice(0, MAX_ROOTS)
  })
  if (added > 0 && autoOpen && !(await read($, closedA))) {
    await $.ui.open({ id: PANE, title: TITLE })
  }
}

// ---- Running steps ---------------------------------------------------------

async function runPrompt($: EngineInterface, stepIds: string[], prompt: string) {
  await update($, inflightA, list => [...list, { stepIds, prompt }].slice(-20))
  await update($, rootsA, roots =>
    mapAll(roots, s => (stepIds.includes(s.id) && s.status !== 'done' ? { ...s, status: 'queued' } : s)),
  )
  // Queues behind a running turn; resolves as its own turn starts.
  void $.prompt.submit({ text: prompt, asUser: true })
}

async function runStep($: EngineInterface, id: string) {
  const hit = find(await read($, rootsA), id)
  if (!hit) return
  const ids = [hit.step, ...allSteps(hit.step.children)].filter(s => s.status !== 'done').map(s => s.id)
  await runPrompt($, ids.length > 0 ? ids : [hit.step.id], promptForStep(hit.step))
}

async function runRoot($: EngineInterface, rootId: string) {
  const root = (await read($, rootsA)).find(r => r.id === rootId)
  if (!root) return
  const ids = allSteps(root.steps).filter(s => s.status !== 'done').map(s => s.id)
  if (ids.length === 0) return
  await runPrompt($, ids, promptForRoot(root))
}

async function editStep($: EngineInterface, id: string) {
  const hit = find(await read($, rootsA), id)
  if (!hit) return
  const prompt = promptForStep(hit.step)
  // If it is sent unchanged, the step is still tracked to done.
  await update($, inflightA, list => [...list, { stepIds: [id], prompt }].slice(-20))
  await $.prompt.fill({ text: prompt, mode: 'replace' })
}

const dismissStep = ($: EngineInterface, id: string) =>
  update($, rootsA, roots => mapAll(roots, s => (s.id === id ? undefined : s)))

const dismissRoot = ($: EngineInterface, id: string) =>
  update($, rootsA, roots => roots.filter(r => r.id !== id))

const toggle = ($: EngineInterface, id: string) =>
  update($, rootsA, roots =>
    roots.map(r =>
      r.id === id
        ? { ...r, isCollapsed: !r.isCollapsed }
        : { ...r, steps: mapSteps(r.steps, s => (s.id === id ? { ...s, isCollapsed: !s.isCollapsed } : s)) },
    ),
  )

const clearDone = ($: EngineInterface) =>
  update($, rootsA, roots =>
    mapAll(roots, s => (s.status === 'done' && allSteps(s.children).every(c => c.status === 'done') ? undefined : s)),
  )

const foldAll = ($: EngineInterface) =>
  update($, rootsA, roots => {
    const anyOpen = roots.some(r => !r.isCollapsed)
    return roots.map(r => ({ ...r, isCollapsed: anyOpen }))
  })

const markDone = (roots: Root[], ids: string[], status: StepStatus) =>
  mapAll(roots, s => (ids.includes(s.id) && s.status !== 'done' ? { ...s, status } : s))

// ---- Tool output -----------------------------------------------------------

const todoStatus = (s: string): StepStatus => (s === 'completed' ? 'done' : s === 'in_progress' ? 'running' : 'open')

async function setTodoRoot($: EngineInterface, id: string, title: string, steps: Step[]) {
  const turn = await read($, turnA)
  await update($, rootsA, roots => {
    const old = roots.find(r => r.id === id)
    const rest = roots.filter(r => r.id !== id)
    if (steps.length === 0) return rest
    const root: Root = { id, kind: 'todo', title, turn, isCollapsed: old?.isCollapsed ?? false, steps }
    return [root, ...rest].slice(0, MAX_ROOTS)
  })
}

// ---- The module ------------------------------------------------------------

export const register: Register = (on, options) => {
  const useModel = options.extractor === 'model'
  const autoOpen = options.autoOpen !== false
  const scanTools = options.scanToolOutput !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'next-steps',
      description: 'Show the next-steps pane (or: /next-steps clear)',
      argumentHint: '[clear]',
    })
    if (autoOpen && (await read($, rootsA)).length > 0 && !(await read($, closedA))) {
      void $.ui.open({ id: PANE, title: TITLE })
    }
    return next(e)
  })

  on('command.run', { command: 'next-steps' }, async ($, e) => {
    if (/\bclear\b/i.test(e.args ?? '')) {
      await update($, rootsA, () => [])
      return { text: 'Cleared the next-steps pane.' }
    }
    await update($, closedA, () => false)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Next-steps pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, closedA, () => true)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A step the pane sent has started its turn: mark it running.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const text = e.text.trim()
      let ids: string[] = []
      await update($, inflightA, list => {
        const i = list.findIndex(f => f.turnId === undefined && f.prompt.trim() === text)
        if (i < 0) return list
        ids = list[i]!.stepIds
        return list.map((f, j): Inflight => (j === i ? { ...f, turnId: e.turnId } : f))
      })
      if (ids.length > 0) await update($, rootsA, roots => markDone(roots, ids, 'running'))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    // Close out a step this turn ran.
    let ids: string[] = []
    await update($, inflightA, list => {
      ids = list.filter(f => f.turnId === e.turnId).flatMap(f => f.stepIds)
      return list.filter(f => f.turnId !== e.turnId)
    })
    if (ids.length > 0) {
      await update($, rootsA, roots => markDone(roots, ids, e.reason === 'answer' ? 'done' : 'open'))
    }

    const turn = await update($, turnA, n => (n ?? 0) + 1)
    const pending = await read($, pendingA)
    await update($, pendingA, () => [])
    const answer = e.reason === 'answer' ? e.answer : ''

    if (!useModel) {
      const roots = parseReply(answer).map(p => toRoot(p, turn))
      await addRoots($, [...roots, ...pending.map(r => ({ ...r, turn }))], autoOpen)
      return result
    }
    // A model call takes a moment: do it off the turn's path.
    $.clock.after(0, () => {
      void extract($, answer, true).then(parsed =>
        addRoots($, [...parsed.map(p => toRoot(p, turn)), ...pending.map(r => ({ ...r, turn }))], autoOpen),
      )
    })
    return result
  })

  if (scanTools) {
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      const r = await next(e)
      if (e.agentId !== undefined || typeof r.text !== 'string' || r.text.length === 0) return r
      const found = parseToolText(r.text)
      if (found.length > 0) {
        const cmd = String((e as { command?: unknown }).command ?? '').split('\n')[0]!.trim()
        const source = widthOf(cmd) > 60 ? cmd.slice(0, 57) + '…' : cmd
        const roots = found.map(p => toRoot({ ...p, title: p.title === 'Hints' ? 'Hints from Bash' : p.title }, 0, source))
        await update($, pendingA, list => [...list, ...roots].slice(-8))
      }
      return r
    }).catch(($, e, next) => next(e))

    on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
      const r = await next(e)
      if (e.agentId !== undefined || r.isError || r.deny !== undefined) return r
      const todos = ((e as { todos?: unknown }).todos ?? []) as { content: string; status: string }[]
      const steps: Step[] = todos.map((t, i) => ({
        id: `todo.${i}.${keyOf(t.content).slice(0, 40)}`,
        text: t.content,
        prompt: promptFor('todo', t.content, []),
        status: todoStatus(t.status),
        isCollapsed: false,
        children: [],
      }))
      await setTodoRoot($, 'todo', 'Todo list', steps)
      return r
    }).catch(($, e, next) => next(e))

    on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
      const r = await next(e)
      if (e.agentId !== undefined || r.isError || r.deny !== undefined) return r
      const task = (r.result as { task?: { id?: string; subject?: string } } | undefined)?.task
      const subject = task?.subject ?? String((e as { subject?: unknown }).subject ?? '')
      if (!task?.id || !subject) return r
      const roots = await read($, rootsA)
      const old = roots.find(x => x.id === 'tasks')?.steps ?? []
      const step: Step = {
        id: `task.${task.id}`,
        text: subject,
        prompt: promptFor('todo', subject, []),
        status: 'open',
        isCollapsed: false,
        children: [],
      }
      await setTodoRoot($, 'tasks', 'Tasks', [...old.filter(s => s.id !== step.id), step])
      return r
    }).catch(($, e, next) => next(e))

    on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
      const r = await next(e)
      if (e.agentId !== undefined || r.isError || r.deny !== undefined) return r
      const input = e as { taskId?: unknown; status?: unknown; subject?: unknown }
      const id = `task.${String(input.taskId ?? '')}`
      const roots = await read($, rootsA)
      const old = roots.find(x => x.id === 'tasks')?.steps ?? []
      if (!old.some(s => s.id === id)) return r
      const steps = old.flatMap((s): Step[] => {
        if (s.id !== id) return [s]
        if (input.status === 'deleted') return []
        const text = typeof input.subject === 'string' ? input.subject : s.text
        const status = typeof input.status === 'string' ? todoStatus(input.status) : s.status
        return [{ ...s, text, status, prompt: promptFor('todo', text, []) }]
      })
      await setTodoRoot($, 'tasks', 'Tasks', steps)
      return r
    }).catch(($, e, next) => next(e))
  }

  // ---- Drawing -------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const roots = await read($, rootsA)
    const cols = Math.max(24, e.props.bodyColumns)
    const steps = roots.flatMap(r => allSteps(r.steps))
    const done = steps.filter(s => s.status === 'done').length
    const open = steps.length - done

    const KIND: Record<RootKind, { glyph: string; color: string }> = {
      reply: { glyph: '✦', color: 'claude' },
      offer: { glyph: '◇', color: 'suggestion' },
      tool: { glyph: '❯', color: 'bashBorder' },
      todo: { glyph: '☰', color: 'planMode' },
    }
    const STATUS: Record<StepStatus, { glyph: string; color: string }> = {
      open: { glyph: '○', color: 'inactive' },
      queued: { glyph: '◌', color: 'permission' },
      running: { glyph: '◐', color: 'warning' },
      done: { glyph: '✓', color: 'success' },
    }

    const rule = <Text dimColor>{'─'.repeat(cols)}</Text>

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color="claude" bold>
              ✦ Next steps
            </Text>
          </Text>
          <Text dimColor>
            {open} open{done > 0 ? ` · ${done} done` : ''}
          </Text>
        </Box>
        {rule}
      </Box>
    )

    if (roots.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="column" alignItems="center" paddingY={1}>
            <Text color="claude">✦</Text>
            <Text bold>Nothing queued up</Text>
            <Text dimColor>When a reply suggests next steps or</Text>
            <Text dimColor>offers to do more, they land here.</Text>
          </Box>
        </Box>
      )
    }

    const stepRows = (list: Step[], guides: boolean[]): JSX.Element[] =>
      list.flatMap((step, i) => {
        const isLast = i === list.length - 1
        const lead = ' ' + guides.map(g => (g ? '   ' : '│  ')).join('')
        const first = lead + (isLast ? '└─ ' : '├─ ')
        const more = lead + (isLast ? '   ' : '│  ')
        const hasKids = step.children.length > 0
        const st = STATUS[step.status]
        const isDone = step.status === 'done'
        const textW = cols - widthOf(first) - 2 - 2 - 5
        const lines = wrapRuns(runsOf(step.text), textW, 3)
        const body: (string | JSX.Element)[] = [
          <Text color={st.color}>{st.glyph}</Text>,
          ' ',
        ]
        lines.forEach((line, n) => {
          if (n > 0) body.push('\n  ')
          for (const run of line) {
            body.push(
              <Text
                dimColor={isDone}
                strikethrough={isDone}
                color={run.style === 'code' && !isDone ? 'suggestion' : undefined}
                bold={run.style === 'bold'}
                italic={run.style === 'italic'}
              >
                {run.text}
              </Text>,
            )
          }
        })
        const prefix = [first, ...lines.slice(1).map(() => more)].join('\n')
        const row = (
          <Box key={`s:${step.id}`} flexDirection="row" alignItems="flex-start">
            <Text dimColor>{prefix}</Text>
            {hasKids ? (
              <Button key={`tg:${step.id}`} plain dimColor onPress={() => void toggle($, step.id)}>
                {step.isCollapsed ? '▸ ' : '▾ '}
              </Button>
            ) : (
              <Text>{'  '}</Text>
            )}
            <Button key={`run:${step.id}`} plain hover={{ color: 'claude' }} onPress={() => void runStep($, step.id)}>
              {body}
            </Button>
            <Box flexGrow={1} />
            <Button key={`ed:${step.id}`} plain dimColor hover={{ color: 'suggestion' }} onPress={() => void editStep($, step.id)}>
              ✎
            </Button>
            <Text> </Text>
            <Button key={`x:${step.id}`} plain dimColor hover={{ color: 'error' }} onPress={() => void dismissStep($, step.id)}>
              ✕
            </Button>
          </Box>
        )
        const kids = hasKids && !step.isCollapsed ? stepRows(step.children, [...guides, isLast]) : []
        if (hasKids && step.isCollapsed) {
          const hidden = allSteps(step.children).filter(s => s.status !== 'done').length
          kids.push(
            <Text dimColor>
              {more}
              {'    '}… {hidden} more
            </Text>,
          )
        }
        return [row, ...kids]
      })

    const rootBlock = (root: Root, index: number) => {
      const kind = KIND[root.kind]
      const all = allSteps(root.steps)
      const left = all.filter(s => s.status !== 'done').length
      const meta = root.kind === 'todo' ? '' : root.turn > 0 ? ` · turn ${root.turn}` : ''
      const titleW = cols - 4 - 4 - widthOf(meta) - 8
      const title = widthOf(root.title) > titleW ? root.title.slice(0, Math.max(4, titleW - 1)) + '…' : root.title
      return (
        <Box flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          <Box key={`r:${root.id}`} flexDirection="row">
            <Button key={`tg:${root.id}`} plain hover={{ color: kind.color }} onPress={() => void toggle($, root.id)}>
              <Text dimColor>{root.isCollapsed ? '▸ ' : '▾ '}</Text>
              <Text color={kind.color}>{kind.glyph} </Text>
              <Text bold>{plain(title)}</Text>
              <Text dimColor>{meta}</Text>
            </Button>
            <Box flexGrow={1} />
            <Text color={left === 0 ? 'success' : kind.color}>
              {left === 0 ? '✓ ' : `${left} `}
            </Text>
            {left > 0 && (
              <Button key={`ra:${root.id}`} plain dimColor hover={{ color: 'success' }} onPress={() => void runRoot($, root.id)}>
                ▶
              </Button>
            )}
            <Text> </Text>
            <Button key={`rx:${root.id}`} plain dimColor hover={{ color: 'error' }} onPress={() => void dismissRoot($, root.id)}>
              ✕
            </Button>
          </Box>
          {root.source !== undefined && !root.isCollapsed && (
            <Text dimColor>
              {'   '}$ {root.source}
            </Text>
          )}
          {!root.isCollapsed && stepRows(root.steps, [])}
        </Box>
      )
    }

    const anyExpanded = roots.some(r => !r.isCollapsed)

    return (
      <Box flexDirection="column">
        {header}
        {roots.map(rootBlock)}
        <Box flexDirection="column" marginTop={1}>
          {rule}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key="fold" plain hotkey="z" dimColor onPress={() => void foldAll($)}>
              {anyExpanded ? 'Fold all' : 'Unfold all'}
            </Button>
            {done > 0 && (
              <Button key="clear-done" plain hotkey="c" dimColor onPress={() => void clearDone($)}>
                Clear done
              </Button>
            )}
            <Button key="clear-all" plain hotkey="x" dimColor onPress={() => void update($, rootsA, () => [])}>
              Clear all
            </Button>
          </Box>
          <Text dimColor>Click a step to run it · ▶ run group · ✎ edit first · ✕ dismiss</Text>
        </Box>
      </Box>
    )
  })
}
