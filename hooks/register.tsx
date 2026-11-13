import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Inflight, Root, RootKind, Step, StepStatus } from '../types'
import {
  clean,
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
const BAND_ITEMS = 3

// Bump a tag when that value's fields change: older stored values are then
// read as the initial value instead of being misread.
const rootsA = atom({ plugin: 'next-steps-pane', key: 'roots' } as const, [], { shape: 'roots-1' })
const pendingA = atom({ plugin: 'next-steps-pane', key: 'pending' } as const, [], { shape: 'pending-1' })
const inflightA = atom({ plugin: 'next-steps-pane', key: 'inflight' } as const, [], { shape: 'inflight-1' })
const turnA = atom({ plugin: 'next-steps-pane', key: 'turn' } as const, 0)
const closedA = atom({ plugin: 'next-steps-pane', key: 'isClosedByPerson' } as const, false)
const loadingA = atom({ plugin: 'next-steps-pane', key: 'loadingTurn' } as const, 0)
const bandHiddenA = atom({ plugin: 'next-steps-pane', key: 'bandHiddenTurn' } as const, 0)

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

function find(roots: Root[], id: string): { root: Root; step: Step } | undefined {
  for (const root of roots) {
    const step = allSteps(root.steps).find(s => s.id === id)
    if (step) return { root, step }
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

/** Open top-level steps, newest group first: what the band and ghost text offer. */
function topSteps(roots: Root[], n: number): { root: Root; step: Step }[] {
  const out: { root: Root; step: Step }[] = []
  for (const root of roots) {
    for (const step of root.steps) {
      if (step.status === 'open') out.push({ root, step })
      if (out.length >= n) return out
    }
  }
  return out
}

// ---- Finding steps with the model ------------------------------------------

const FORK_PROMPT = `Do not continue the task and do not use tools. Instead, look at your last reply in this conversation and list the concrete next steps it suggests, recommends or offers to do, as a tree.

Answer with ONLY JSON, no prose and no code fence:
{"groups":[{"title":"short heading","steps":[{"text":"imperative action, under 100 characters","children":[...]}]}]}

Rules:
- Only actions the user could ask you to do next. Skip summaries of work already done, explanations and questions about preferences.
- Keep the reply's own grouping and nesting where it has one; otherwise one group titled "Next steps".
- Name the actual files, tests or commands. Keep inline code in backticks.
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
          .map(s => ({ text: typeof s?.text === 'string' ? clean(s.text, 300) : '', children: steps(s?.children, depth + 1) }))
          .filter(s => s.text !== '')
          .slice(0, 20)
  return (data.groups as ModelGroup[])
    .map(g => ({
      kind: 'reply' as const,
      title: (typeof g?.title === 'string' ? clean(g.title, 80) : '') || TITLE,
      steps: steps(g?.steps, 0),
    }))
    .filter(g => g.steps.length > 0)
}

/** Asks a fork of this session (shares its prompt cache); falls back to the parser. */
async function extractWithModel($: EngineInterface, answer: string): Promise<ParsedRoot[]> {
  const heuristic = parseReply(answer)
  try {
    const r = await $.model.fork({ prompt: FORK_PROMPT, effort: 'low' })
    if (!r.isAnswered) return heuristic
    return fromModel(r.text) ?? heuristic
  } catch (error) {
    $.ui.log(`next-steps-pane: model call failed: ${String(error)}`)
    return heuristic
  }
}

// Options, set by register (it runs again on every reload).
const cfg = { sendOnClick: false, autoOpen: true, ghostText: true }

// ---- Acting on steps -----------------------------------------------------

const forget = ($: EngineInterface, prompt: string, ids: string[]) =>
  Promise.all([
    update($, inflightA, list => list.filter(f => f.prompt !== prompt || f.turnId !== undefined)),
    update($, rootsA, roots => mapAll(roots, s => (ids.includes(s.id) && s.status === 'queued' ? { ...s, status: 'open' } : s))),
  ])

async function send($: EngineInterface, stepIds: string[], prompt: string) {
  await update($, inflightA, list => [...list, { stepIds, prompt }].slice(-20))
  await update($, rootsA, roots =>
    mapAll(roots, s => (stepIds.includes(s.id) && s.status !== 'done' ? { ...s, status: 'queued' } : s)),
  )
  // Queues behind a running turn; resolves as its own turn starts.
  void $.prompt.submit({ text: prompt, asUser: true }).then(
    async r => {
      if (r.drop === undefined) return
      await forget($, prompt, stepIds)
      $.ui.toast('next-steps-pane: the prompt was not sent')
    },
    async error => {
      await forget($, prompt, stepIds)
      $.ui.toast(`next-steps-pane: could not send: ${String(error)}`)
    },
  )
}

async function draft($: EngineInterface, stepIds: string[], prompt: string) {
  // If it is sent unchanged, its steps are still tracked to done.
  await update($, inflightA, list => [...list, { stepIds, prompt }].slice(-20))
  try {
    const r = await $.prompt.fill({ text: prompt, mode: 'replace' })
    if (!r.isFilled) $.ui.toast('next-steps-pane: could not fill the prompt box (close any dialog first)')
  } catch (error) {
    $.ui.toast(`next-steps-pane: could not fill the prompt box: ${String(error)}`)
  }
}

const openIds = (steps: Step[]) => steps.filter(s => s.status !== 'done').map(s => s.id)

/** `how`: 'send' sends now, 'draft' fills the prompt box. Tool output is always drafted. */
async function actOnStep($: EngineInterface, id: string, how: 'send' | 'draft') {
  const hit = find(await read($, rootsA), id)
  if (!hit) return
  const ids = openIds([hit.step, ...allSteps(hit.step.children)])
  const prompt = promptForStep(hit.step)
  const stepIds = ids.length > 0 ? ids : [hit.step.id]
  if (how === 'send' && hit.root.kind !== 'tool') await send($, stepIds, prompt)
  else await draft($, stepIds, prompt)
}

async function actOnRoot($: EngineInterface, rootId: string) {
  const root = (await read($, rootsA)).find(r => r.id === rootId)
  if (!root) return
  const ids = openIds(allSteps(root.steps))
  if (ids.length === 0) return
  if (root.kind === 'tool') await draft($, ids, promptForRoot(root))
  else await send($, ids, promptForRoot(root))
}

const click = ($: EngineInterface, id: string) => actOnStep($, id, cfg.sendOnClick ? 'send' : 'draft')
const other = ($: EngineInterface, id: string) => actOnStep($, id, cfg.sendOnClick ? 'draft' : 'send')

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

const setStatus = (roots: Root[], ids: string[], status: StepStatus) =>
  mapAll(roots, s => (ids.includes(s.id) && s.status !== 'done' ? { ...s, status } : s))

async function addRoots($: EngineInterface, incoming: Root[]) {
  let added = 0
  const roots = await update($, rootsA, roots => {
    const fresh = dedupe(roots, incoming)
    added = fresh.length
    if (fresh.length === 0) return roots
    // Newest first; earlier groups fold away (todo and task lists stay as they are).
    const older = roots.map(r => (r.kind === 'todo' ? r : { ...r, isCollapsed: true }))
    return [...fresh, ...older].slice(0, MAX_ROOTS)
  })
  if (added === 0) return
  if (cfg.autoOpen && !(await read($, closedA))) await $.ui.open({ id: PANE, title: TITLE })
  if (cfg.ghostText) {
    // The top step, as dim text in the prompt box: Tab takes it as a draft.
    const top = topSteps(roots, 1)[0]
    if (top) void $.prompt.suggest({ text: promptForStep(top.step) }).catch(() => undefined)
  }
}

// ---- Tool output -----------------------------------------------------------

const todoStatus = (s: string): StepStatus => (s === 'completed' ? 'done' : s === 'in_progress' ? 'running' : 'open')

async function setListRoot($: EngineInterface, id: string, title: string, steps: Step[]) {
  const turn = await read($, turnA)
  await update($, rootsA, roots => {
    const old = roots.find(r => r.id === id)
    const rest = roots.filter(r => r.id !== id)
    if (steps.length === 0) return rest
    const root: Root = { id, kind: 'todo', title, turn, isCollapsed: old?.isCollapsed ?? false, steps }
    return [root, ...rest].slice(0, MAX_ROOTS)
  })
}

const listStep = (id: string, text: string, status: StepStatus): Step | undefined => {
  const t = clean(text, 300)
  return t === '' ? undefined : { id, text: t, prompt: promptFor('todo', t, []), status, isCollapsed: false, children: [] }
}


/** The model's reading of a reply, off the turn's path. */
async function modelPass($: EngineInterface, answer: string, turn: number) {
  const parsed = await extractWithModel($, answer)
  // A newer turn ended while the model worked: its steps are newer, drop these.
  if ((await read($, turnA)) !== turn) return
  await update($, loadingA, n => (n === turn ? 0 : n))
  await addRoots($, parsed.map(p => toRoot(p, turn)))
}

// ---- The module ------------------------------------------------------------

export const register: Register = (on, options) => {
  const useModel = options.extractor === 'model'
  cfg.sendOnClick = options.clickAction === 'send'
  cfg.autoOpen = options.autoOpen !== false
  cfg.ghostText = options.ghostText !== false
  const { sendOnClick, autoOpen } = cfg
  const scanTools = options.scanToolOutput !== false
  const showBand = options.band !== false
  const minAnswerChars = typeof options.minAnswerChars === 'number' ? options.minAnswerChars : 80

  // ---- Hooks ---------------------------------------------------------------

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
      if (ids.length > 0) await update($, rootsA, roots => setStatus(roots, ids, 'running'))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    // Close out the steps this turn ran.
    let ids: string[] = []
    await update($, inflightA, list => {
      ids = list.filter(f => f.turnId === e.turnId).flatMap(f => f.stepIds)
      return list.filter(f => f.turnId !== e.turnId)
    })
    if (ids.length > 0) {
      await update($, rootsA, roots => setStatus(roots, ids, e.reason === 'answer' ? 'done' : 'open'))
    }

    const turn = await update($, turnA, n => (n ?? 0) + 1)
    const pending = (await read($, pendingA)).map(r => ({ ...r, turn }))
    await update($, pendingA, () => [])
    const answer = e.reason === 'answer' ? e.answer : ''

    if (!useModel || answer.trim().length < minAnswerChars) {
      await addRoots($, [...parseReply(answer).map(p => toRoot(p, turn)), ...pending])
      return result
    }

    // Tool hints now; the model's reading of the reply when it answers.
    if (pending.length > 0) await addRoots($, pending)
    await update($, loadingA, () => turn)
    void modelPass($, answer, turn)
    return result
  })

  if (scanTools) {
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      const r = await next(e)
      if (e.agentId !== undefined || typeof r.text !== 'string' || r.text.length === 0) return r
      const found = parseToolText(r.text)
      if (found.length > 0) {
        const cmd = clean(String((e as { command?: unknown }).command ?? '').split('\n')[0] ?? '', 60)
        const roots = found.map(p => toRoot({ ...p, title: p.title === 'Hints' ? 'Hints from Bash' : p.title }, 0, cmd || undefined))
        await update($, pendingA, list => [...list, ...roots].slice(-8))
      }
      return r
    }).catch(($, e, next) => next(e))

    on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
      const r = await next(e)
      if (e.agentId !== undefined || r.isError || r.deny !== undefined) return r
      const todos = ((e as { todos?: unknown }).todos ?? []) as { content: string; status: string }[]
      const steps = todos.flatMap((t, i) => listStep(`todo.${i}.${keyOf(t.content).slice(0, 40)}`, t.content, todoStatus(t.status)) ?? [])
      await setListRoot($, 'todo', 'Todo list', steps)
      return r
    }).catch(($, e, next) => next(e))

    on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
      const r = await next(e)
      if (e.agentId !== undefined || r.isError || r.deny !== undefined) return r
      const task = (r.result as { task?: { id?: string; subject?: string } } | undefined)?.task
      const step = task?.id ? listStep(`task.${task.id}`, task.subject ?? String((e as { subject?: unknown }).subject ?? ''), 'open') : undefined
      if (!step) return r
      const old = (await read($, rootsA)).find(x => x.id === 'tasks')?.steps ?? []
      await setListRoot($, 'tasks', 'Tasks', [...old.filter(s => s.id !== step.id), step])
      return r
    }).catch(($, e, next) => next(e))

    on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
      const r = await next(e)
      if (e.agentId !== undefined || r.isError || r.deny !== undefined) return r
      const input = e as { taskId?: unknown; status?: unknown; subject?: unknown }
      const id = `task.${String(input.taskId ?? '')}`
      const old = (await read($, rootsA)).find(x => x.id === 'tasks')?.steps ?? []
      if (!old.some(s => s.id === id)) return r
      const steps = old.flatMap((s): Step[] => {
        if (s.id !== id) return [s]
        if (input.status === 'deleted') return []
        const status = typeof input.status === 'string' ? todoStatus(input.status) : s.status
        return [listStep(s.id, typeof input.subject === 'string' ? input.subject : s.text, status) ?? s]
      })
      await setListRoot($, 'tasks', 'Tasks', steps)
      return r
    }).catch(($, e, next) => next(e))
  }

  // ---- The row above the prompt: 1/2/3 drafts a step, 0 hides ----------------

  if (showBand) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next): Promise<RenderElement> => {
      const below = await next(e)
      if (e.props.hasSurvey || e.props.isWorking) return below
      const turn = await read($, turnA)
      if ((await read($, bandHiddenA)) >= turn) return below
      const top = topSteps(await read($, rootsA), BAND_ITEMS)
      if (top.length === 0) return below
      const { Box, Text, Button } = $.ui.resolve(e)
      const room = Math.max(12, Math.floor((e.props.bodyColumns - 14) / top.length) - 5)
      const label = (s: Step) => {
        const t = plain(s.text).replace(/`/g, '')
        return widthOf(t) > room ? `${[...t].slice(0, room - 1).join('')}…` : t
      }
      return (
        <Box flexDirection="column">
          {below}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text color="claude">✦ next</Text>
            {top.map(({ step }, i) => (
              <Button key={`b:${step.id}`} plain hotkey={String(i + 1)} onPress={() => void click($, step.id)}>
                {label(step)}
              </Button>
            ))}
            <Button key="b:hide" plain dimColor hotkey="0" onPress={() => void update($, bandHiddenA, () => turn)}>
              hide
            </Button>
          </Box>
        </Box>
      )
    })
  }

  // ---- The pane ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const roots = await read($, rootsA)
    const isLoading = (await read($, loadingA)) !== 0
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
    // The second control on a row does what a click does not.
    const alt = sendOnClick ? { glyph: '✎', color: 'suggestion' } : { glyph: '▶', color: 'success' }

    const rule = <Text dimColor>{'─'.repeat(cols)}</Text>

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="claude" bold>
            ✦ Next steps
          </Text>
          {isLoading ? (
            <Text color="claude" dimColor>
              finding steps…
            </Text>
          ) : (
            <Text dimColor>
              {open} open{done > 0 ? ` · ${done} done` : ''}
            </Text>
          )}
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
            <Text bold>{isLoading ? 'Reading the last reply…' : 'Nothing queued up'}</Text>
            <Text dimColor>When a reply suggests next steps or</Text>
            <Text dimColor>offers to do more, they land here.</Text>
          </Box>
        </Box>
      )
    }

    const stepRows = (root: Root, list: Step[], guides: boolean[]): JSX.Element[] =>
      list.flatMap((step, i) => {
        const isLast = i === list.length - 1
        const lead = ' ' + guides.map(g => (g ? '   ' : '│  ')).join('')
        const first = lead + (isLast ? '└─ ' : '├─ ')
        const more = lead + (isLast ? '   ' : '│  ')
        const hasKids = step.children.length > 0
        const st = STATUS[step.status]
        const isDone = step.status === 'done'
        // Tool output is only ever drafted, so it gets no send control.
        const hasAlt = !(root.kind === 'tool' && !sendOnClick)
        const textW = cols - widthOf(first) - 2 - 2 - (hasAlt ? 5 : 3)
        const lines = wrapRuns(runsOf(step.text), textW, 3)
        const body: (string | JSX.Element)[] = [<Text color={st.color}>{st.glyph}</Text>, ' ']
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
            <Button key={`run:${step.id}`} plain hover={{ color: 'claude' }} onPress={() => void click($, step.id)}>
              {body}
            </Button>
            <Box flexGrow={1} />
            {hasAlt && (
              <Button key={`alt:${step.id}`} plain dimColor hover={{ color: alt.color }} onPress={() => void other($, step.id)}>
                {alt.glyph}
              </Button>
            )}
            {hasAlt && <Text> </Text>}
            <Button key={`x:${step.id}`} plain dimColor hover={{ color: 'error' }} onPress={() => void dismissStep($, step.id)}>
              ✕
            </Button>
          </Box>
        )
        const kids = hasKids && !step.isCollapsed ? stepRows(root, step.children, [...guides, isLast]) : []
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
      const left = allSteps(root.steps).filter(s => s.status !== 'done').length
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
            <Text color={left === 0 ? 'success' : kind.color}>{left === 0 ? '✓ ' : `${left} `}</Text>
            {left > 0 && (
              <Button key={`ra:${root.id}`} plain dimColor hover={{ color: 'success' }} onPress={() => void actOnRoot($, root.id)}>
                {root.kind === 'tool' ? '✎' : '▶'}
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
          {!root.isCollapsed && stepRows(root, root.steps, [])}
        </Box>
      )
    }

    const anyExpanded = roots.some(r => !r.isCollapsed)
    const hint = sendOnClick
      ? 'Click a step to send it · ✎ edit first · ▶ send group · ✕ dismiss'
      : 'Click a step to draft it · ▶ send now · ▶ on a group sends it all · ✕ dismiss'

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
          <Text dimColor>{hint}</Text>
        </Box>
      </Box>
    )
  })
}
