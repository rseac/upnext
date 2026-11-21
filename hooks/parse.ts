// Pure text helpers: find next steps in a reply or in tool output, and split
// inline markdown into styled runs for drawing. No `$` here, so tests can
// call these directly.

export type ParsedStep = {
  text: string
  children: ParsedStep[]
  isDone?: boolean
  stream?: string
  forYou?: 'check' | 'decide'
}
export type ParsedRoot = {
  kind: 'reply' | 'offer' | 'tool' | 'likely'
  title: string
  steps: ParsedStep[]
  /** The stream the model put it in, when a model read the reply. */
  stream?: string
  /** True when the section came from a softer cue (e.g. "Ideas", "Consider") with no clear action. */
  isWeak?: boolean
}

// Headings and lead-ins that introduce things to do.
const CUE =
  /(?:^\W*(?:up )?next\W*$)|\b(next steps?|next up|what'?s next|what'?s left|what remains|still open|open items|before (?:merging|shipping|release)|where to go from here|going forward|suggest(?:ed|ions?)?|follow[- ]?ups?|to[- ]?dos?|action items?|recommend(?:ed|ations?)?|(?:some|a few|possible|your|other) options|you (?:could|can|might|may)(?: also)?|remaining|still to do|left to do|not (?:yet )?done|ideas|consider|further (?:work|improvements|steps)|possible (?:improvements|enhancements|extensions)|future work|want me to|would you like|should i|i can also|happy to|optional)\b/i
// Softer cues that often mix commentary with suggestions; verified by the model in auto mode when no step is clearly an action.
const WEAK_CUE =
  /\b(ideas?|consider|options|optional|notes?|still open|open items|what remains|remaining|not (?:yet )?done|further (?:work|improvements)|possible (?:improvements|enhancements|extensions)|future work)\b/i
const STRONG_CUE = /\b(next steps?|next up|what'?s next|what'?s left|follow[- ]?ups?|to[- ]?dos?|action items?|before (?:merging|shipping|release))\b/i

const FENCE = /^\s*(```|~~~)/
const LIST = /^(\s*)(?:[-*+•]|\d{1,3}[.)])\s+(?:\[([ xX])\]\s+)?(.+)$/
const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const BOLD_LINE = /^\s{0,3}(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*:?\s*$/
const BOLD_INLINE = /^\s{0,3}\*\*([^*]+?):?\*\*:?\s+(.+)$/
const LEAD_IN = /^\s{0,3}([^\s\-*+#>|`].{2,100}?):\s*$/

const indentOf = (s: string) => {
  let n = 0
  for (const c of s) {
    if (c === ' ') n += 1
    else if (c === '\t') n += 4
    else break
  }
  return n
}

// Step text comes from replies and tool output, which can carry text from
// files and web pages. Before it is drawn or sent, keep only what a person can
// see: no terminal escape sequences; no control, format, unassigned,
// private-use or surrogate characters; no variation selectors or blank-looking
// letters; at most three combining marks in a row. Text holding Unicode tag
// characters is dropped whole: their only use in a prompt is to hide words.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const TAGS = /[\u{E0000}-\u{E007F}]/u
const UNSEEN = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Variation_Selector}ᅟᅠㅤﾠ]/gu
const COMBINING_RUN = /(\p{M}{3})\p{M}+/gu

/** Visible text only, whitespace folded, at most `max` code points ('' if unsafe). */
export function clean(text: string, max = 500): string {
  if (TAGS.test(text)) return ''
  const safe = text
    .replace(ESCAPES, '')
    .replace(/\s+/g, ' ')
    .replace(UNSEEN, '')
    .replace(COMBINING_RUN, '$1')
    .replace(/ {2,}/g, ' ')
    .trim()
  const points = [...safe]
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : safe
}

/** Clean, then drop link targets and HTML tags; keep `code`, **bold** and *italic* marks. */
export const tidy = (s: string) =>
  clean(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*$/, '')
    .trim()

/** The text with inline marks removed except backticks: for prompts and dedupe. */
export const plain = (s: string) =>
  s.replace(/\*\*|__/g, '').replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2').trim()

export const keyOf = (s: string) =>
  plain(s)
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

type Heading = { level: number; text: string; inline?: string }

const headingOf = (line: string): Heading | undefined => {
  if (LIST.test(line)) return undefined
  const h = HEADING.exec(line)
  if (h) return { level: h[1]!.length, text: h[2]! }
  const b = BOLD_LINE.exec(line)
  if (b) return { level: 7, text: b[1]! }
  const bi = BOLD_INLINE.exec(line)
  if (bi && CUE.test(bi[1]!)) return { level: 7, text: bi[1]!, inline: bi[2]! }
  const l = LEAD_IN.exec(line)
  if (l) return { level: 8, text: l[1]! }
  return undefined
}

type Section = {
  title: string
  level: number
  steps: ParsedStep[]
  group?: ParsedStep
  stack: { indent: number; node: ParsedStep }[]
  sawItem: boolean
  tableRows: number
}

const TAG_PREFIX = /^(?:\*\*|__)?\[([^\][\n]{1,32})\](?:\*\*|__)?\s*:?\s+(.+)$/

/** Extracts leading `[Stream]` and `[check]` / `[decide]` tags from a step bullet. */
export function parseStepTags(raw: string): { text: string; stream?: string; forYou?: 'check' | 'decide' } {
  let text = raw.trim()
  let stream: string | undefined
  let forYou: 'check' | 'decide' | undefined
  for (let i = 0; i < 2; i++) {
    // Do not strip markdown links like `[text](url)`.
    if (/^\[[^\]]+\]\(/.test(text)) break
    const m = TAG_PREFIX.exec(text)
    if (!m) break
    const tag = clean(m[1]!, 32)
    const lower = tag.toLowerCase()
    if (lower === 'x' || lower === '') break
    if (lower === 'check' || lower === 'try' || lower === 'verify') {
      forYou = 'check'
      text = m[2]!.trim()
    } else if (lower === 'decide' || lower === 'ask' || lower === 'choice' || lower === '?') {
      forYou = 'decide'
      text = m[2]!.trim()
    } else if (stream === undefined) {
      stream = tag
      text = m[2]!.trim()
    } else {
      break
    }
  }
  return { text, ...(stream ? { stream } : {}), ...(forYou ? { forYou } : {}) }
}

const prune = (steps: ParsedStep[]): ParsedStep[] =>
  steps
    .map(s => ({ ...s, children: prune(s.children) }))
    .filter(s => s.text.length > 0 && (s.children.length > 0 || !/[:]$/.test(s.text)))

// Words a step starts with when it is something to do.
const ACTION =
  /^(?:please\s+)?(?:add|run|re-?run|write|create|update|fix|make|set(?:\s+up)?|open|start|try|look|check|commit|push|refactor|remove|delete|drop|build|deploy|move|rename|install|test|wire|draft|turn|go|show|change|split|merge|keep|use|switch|publish|share|review|explain|dig|investigate|clean|port|convert|extend|implement|verify|confirm|document|ask|decide|pick|choose|enable|disable|configure|restart|retry|measure|profile|benchmark|compare|replace|rewrite|simplify|tighten|link|note|record|log|bump|release|tag|cut|upgrade|downgrade|pin|mock|stub|cover|handle|support|validate|audit|rotate|revert|reset|widen|narrow|close|send|watch|see|read|follow|schedule|plan|prototype|sketch|design|tune|adjust|increase|decrease|reduce|raise|lower|limit|cap|guard|protect|secure|wrap|catch|ship|land|approve|assign|triage|label|file|report|invite|archive|tidy|restore|enable|resolve|reproduce|debug|trace|monitor|fetch|pull|rebase|squash|sign|lint|format|type-?check|generate|regenerate|seed|migrate|backfill|export|import|load|save|store|cache|split|combine|batch|parallelize|deduplicate|sort|filter|expose|hide|inline|extract|rework|polish|finish|complete|continue|resume|stop|pause|skip|ignore|allow|deny|block|unblock|grant|revoke|ping|email|message|tell|let|get|give|put|take|bring|walk|step|land)\b/i

/** Whether an item reads as something to do: an action word, a command, or a slash command. */
function isAction(text: string): boolean {
  const t = plain(text).replace(/^[`'"]/, '')
  return ACTION.test(t) || /^\//.test(t) || /^`[^`]+`$/.test(plain(text))
}

// Labels that introduce commentary on an option, not an option of its own:
// "Why it would help: …", "What you lose: …", "Size: …", "Trade-off: …".
const COMMENTARY =
  /^(?:why|what|how|when|where|who|which|size|cost|effort|trade-?offs?|downsides?|upsides?|pros?|cons?|notes?|caveats?|risks?|impact|effect|results?|examples?|limits?|limitations?|status|tested|checks?|cause|reasons?|because|context|background|summary|tl;?dr|currently|so far|in short|the (?:catch|fix|problem|cause|idea|point|upshot)|benefits?|drawbacks?|gotchas?)\b/i

const STATEMENT_START =
  /^(?:the|this|that|these|those|it|its|it's|a|an|each|both|every|you|your|we|there|here|they|nothing|everything|one|all|no|none)\b/i
const STATEMENT_VERB =
  /\b(?:is|are|was|were|has|have|had|can'?t|cannot|couldn'?t|doesn'?t|don'?t|didn'?t|won'?t|isn'?t|aren'?t|wasn'?t|weren'?t|runs?|ran|stays?|remained)\b/i

/** A sentence about how things are ("The mod writes…", "Rows with X are 1–3% high"), not something to do. */
function isStatement(text: string): boolean {
  const t = plain(text)
  return !isAction(t) && (STATEMENT_START.test(t) || STATEMENT_VERB.test(t))
}

/**
 * Drops items that explain rather than act: "Why it helps: …" labels whose
 * label is no action, and "How it works:" groups whose items are statements.
 */
function dropExplanations(steps: ParsedStep[]): ParsedStep[] {
  return steps.flatMap(s => {
    const t = plain(s.text)
    const label = /^([^:`]{1,48}):\s+\S/.exec(t)
    if (label && COMMENTARY.test(label[1]!.trim())) return []
    if (/:$/.test(t) && !isAction(t)) {
      const kids = dropExplanations(s.children)
      return kids.length > 0 && !kids.every(k => isStatement(k.text)) ? [{ ...s, children: kids }] : []
    }
    return [{ ...s, children: dropExplanations(s.children) }]
  })
}

/** At most this many top-level steps from one section. */
const MAX_SECTION_STEPS = 10

/** A section whose items are all statements is an explanation, not a to-do list. */
function keepSteps(steps: ParsedStep[]): ParsedStep[] {
  const kept = dropExplanations(steps)
  const all = kept.flatMap(s => [s, ...s.children])
  if (all.length >= 1 && all.every(s => isStatement(s.text))) return []
  return kept.slice(0, MAX_SECTION_STEPS)
}

/**
 * Finds sections that introduce next steps ("## Next steps", "**You could
 * also:**", "Suggested follow-ups:") and returns their lists as trees. Nested
 * list items become subtrees; a bold sub-heading inside a section becomes a
 * group node.
 */
export function parseSections(md: string): ParsedRoot[] {
  const roots: ParsedRoot[] = []
  let section: Section | undefined
  let inFence = false

  const close = () => {
    if (section) {
      const steps = prune(keepSteps(section.steps))
      if (steps.length > 0) {
        const title = tidy(section.title)
        const isWeak =
          WEAK_CUE.test(title) &&
          !STRONG_CUE.test(title) &&
          !steps.some(s => isAction(s.text) || s.stream !== undefined || s.forYou !== undefined)
        if (steps.some(s => s.stream !== undefined)) {
          const byStream = new Map<string, { title: string; stream?: string; steps: ParsedStep[] }>()
          for (const step of steps) {
            const key = (step.stream ?? title).toLowerCase()
            const cur = byStream.get(key)
            if (cur) cur.steps.push(step)
            else byStream.set(key, { title: step.stream ?? title, ...(step.stream ? { stream: step.stream } : {}), steps: [step] })
          }
          for (const g of byStream.values()) {
            roots.push({ kind: 'reply', title: g.title, steps: g.steps, ...(g.stream ? { stream: g.stream } : {}), ...(isWeak ? { isWeak } : {}) })
          }
        } else {
          roots.push({ kind: 'reply', title, steps, ...(isWeak ? { isWeak } : {}) })
        }
      }
    }
    section = undefined
  }
  // A cue in brackets ("Option A (my recommendation)") qualifies a heading; it is not the heading.
  const isCue = (t: string) => {
    const bare = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    return CUE.test(bare)
  }

  for (const raw of md.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence || raw.trim() === '') continue
    const line = raw.replace(/\s+$/, '')

    const h = headingOf(line)
    if (h) {
      // A deeper heading is a group. Under a bold or "label:" cue, a markdown
      // heading is a group too, as long as it opens the section or follows one.
      const isGroup =
        section !== undefined &&
        h.inline === undefined &&
        (h.level > section.level ||
          (section.level >= 7 && h.level <= 6 && !isCue(h.text) && (!section.sawItem || section.group !== undefined)))
      if (section && isGroup) {
        const group: ParsedStep = { text: tidy(h.text), children: [] }
        section.steps.push(group)
        section.group = group
        section.stack = []
        continue
      }
      close()
      if (isCue(h.text)) {
        section = { title: h.text, level: h.level, steps: [], stack: [], sawItem: false, tableRows: 0 }
        if (h.inline !== undefined) {
          section.steps.push({ text: tidy(h.inline), children: [] })
          close()
        }
      }
      continue
    }
    if (!section) continue

    const m = LIST.exec(line)
    if (m) {
      const indent = indentOf(m[1]!)
      const tagged = parseStepTags(tidy(m[3]!))
      const node: ParsedStep = {
        text: tagged.text,
        children: [],
        ...(tagged.stream ? { stream: tagged.stream } : {}),
        ...(tagged.forYou ? { forYou: tagged.forYou } : {}),
      }
      if (m[2] === 'x' || m[2] === 'X') node.isDone = true
      const stack = section.stack
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
      const parent = stack[stack.length - 1]?.node
      if (parent) parent.children.push(node)
      else (section.group ? section.group.children : section.steps).push(node)
      stack.push({ indent, node })
      section.sawItem = true
      continue
    }

    // A table: its first column holds the steps; the first row is the header.
    if (TABLE_RULE.test(line)) continue
    const row = TABLE_ROW.exec(line)
    if (row) {
      section.tableRows += 1
      const cell = tidy(row[1]!.split('|')[0] ?? '')
      if (section.tableRows > 1 && cell !== '' && !/^[-#\d.\s]*$/.test(cell)) {
        ;(section.group ? section.group.children : section.steps).push({ text: cell, children: [] })
        section.sawItem = true
      }
      continue
    }
    const indent = indentOf(line)
    const last = section.stack[section.stack.length - 1]
    if (last && indent > last.indent) {
      // A wrapped continuation of the previous item.
      if (last.node.text.length < 240) last.node.text = tidy(`${last.node.text} ${line}`)
      continue
    }
    // Plain paragraph: before any item it is the section's intro; after, the end.
    if (section.sawItem) close()
  }
  close()
  return roots
}

const OFFER =
  /^(?:(?:if you(?:'d| would) like|if you want|if helpful|optionally|alternatively|also|next)[, ]+)?(?:(?:i can|i could)(?: also)?(?!\s+(?:not|never|only|barely|see|tell)\b)|want me to|would you like me to|do you want me to|should i|shall i|i(?:'d| would) be happy to|happy to|let me know if you(?:'d| would) like me to|let me know if i should)\s+(.+?)\s*[?.!]*$/i
const VERB =
  /^(?:add|run|write|create|update|fix|make|set|open|start|try|look|check|commit|push|refactor|remove|delete|build|deploy|move|rename|install|test|wire|draft|turn|go|show|change|split|merge|keep|use|switch|publish|share|review|explain|dig|investigate|clean|port|convert|extend|implement|walk|elaborate|also|then)\b/i
const VAGUE_OFFER =
  /^(?:help|answer|clarify|make any (?:changes|adjustments|tweaks)|(?:change|tweak|adjust) anything|go into more detail|elaborate(?: on)?|walk (?:you )?through (?:it|this|the changes))\b/i

/**
 * Finds offers in the closing paragraphs ("Want me to add tests or update the
 * README?") and returns them as one root, one step per alternative.
 */
export function parseOffers(md: string): ParsedRoot[] {
  const paras: string[] = []
  let inFence = false
  let cur: string[] = []
  const flush = () => {
    if (cur.length > 0) paras.push(cur.join(' '))
    cur = []
  }
  for (const raw of md.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      inFence = !inFence
      flush()
      continue
    }
    if (inFence) continue
    if (raw.trim() === '' || LIST.test(raw) || HEADING.test(raw)) {
      flush()
      continue
    }
    cur.push(raw.trim())
  }
  flush()

  const steps: ParsedStep[] = []
  for (const para of paras.slice(-2)) {
    for (const sentence of para.split(/(?<=[?.!])\s+/)) {
      const m = OFFER.exec(sentence.trim())
      if (!m) continue
      let phrase = m[1]!
        .replace(/\s+(?:too|as well|for you|next|now)$/i, '')
        .replace(/^(?:go ahead and|also|then)\s+/i, '')
      if (VAGUE_OFFER.test(phrase)) continue
      // "start on 1–3", "do all of these": only makes sense next to the list it points at.
      if (/\b(?:#?\d+(?:\s*[–-]\s*\d+)?|these|those|them|any of (?:these|them)|all of (?:these|them)|either)$/i.test(phrase)) continue
      const parts = phrase
        .split(/,\s*or\s+|\s+or\s+(?=\S)/i)
        .map(p => p.trim())
        .filter(p => p.length > 0)
      const alternatives = parts.length > 1 && parts.slice(1).every(p => VERB.test(p)) ? parts : [phrase]
      for (const alt of alternatives) {
        phrase = tidy(alt.replace(/^(?:i\s+)?(?:also|then)\s+/i, ''))
        if (VAGUE_OFFER.test(phrase) || phrase.split(' ').length < 2) continue
        steps.push({ text: phrase.charAt(0).toUpperCase() + phrase.slice(1), children: [] })
      }
    }
  }
  return steps.length > 0 ? [{ kind: 'offer', title: 'Claude offered', steps }] : []
}

/** Every step a reply suggests: its sections first, then its closing offers. */
export function parseReply(md: string): ParsedRoot[] {
  const sections = parseSections(md)
  const seen = new Set(sections.flatMap(r => flat(r.steps).map(s => keyOf(s.text))))
  const offers = parseOffers(md)
    .map(r => ({ ...r, steps: r.steps.filter(s => !seen.has(keyOf(s.text))) }))
    .filter(r => r.steps.length > 0)
  return [...sections, ...offers]
}

/** Parses an exported Markdown checklist (`## Stream` + `- [ ] step`) into open groups. */
export function parseChecklist(md: string): ParsedRoot[] {
  const roots: ParsedRoot[] = []
  let title = 'Carried over'
  let steps: ParsedStep[] = []
  let stack: { indent: number; node: ParsedStep }[] = []
  const flush = () => {
    if (steps.length > 0) roots.push({ kind: 'reply', title: tidy(title) || 'Carried over', steps, stream: tidy(title) || undefined })
    steps = []
    stack = []
  }
  for (const raw of md.split(/\r?\n/)) {
    const h = HEADING.exec(raw)
    if (h) {
      if (h[1]!.length >= 2) {
        flush()
        title = h[2]!.replace(/\s*\(archived\)\s*$/i, '')
      }
      continue
    }
    const m = LIST.exec(raw)
    if (!m || m[2]?.toLowerCase() === 'x') continue
    const indent = indentOf(m[1]!)
    const text = tidy(m[3]!)
    if (text === '') continue
    const node: ParsedStep = { text, children: [] }
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]?.node
    if (parent) parent.children.push(node)
    else steps.push(node)
    stack.push({ indent, node })
  }
  flush()
  return roots
}

/**
 * The slash command a step runs, if it is one: "/review high", "`/review`",
 * "Run `/review high`". Returns the command line without backticks.
 */
export function commandOf(text: string): string | undefined {
  const t = plain(text).trim()
  const m = /^(?:(?:run|use|invoke|try)\s+)?`?(\/[a-z][\w:.-]*(?:[^`\n]*)?)`?\.?$/i.exec(t)
  return m ? m[1]!.trim() : undefined
}

export const flat = (steps: ParsedStep[]): ParsedStep[] =>
  steps.flatMap(s => [s, ...flat(s.children)])

// ---- Drawing helpers ------------------------------------------------------

export type Run = { text: string; style: 'plain' | 'code' | 'bold' | 'italic' }

/** Splits inline markdown into styled runs. */
export function runsOf(s: string): Run[] {
  const out: Run[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|(?<!\w)_([^_\s][^_]*?)_(?!\w)/g
  let at = 0
  for (const m of s.matchAll(re)) {
    const i = m.index ?? 0
    if (i > at) out.push({ text: s.slice(at, i), style: 'plain' })
    if (m[1] !== undefined) out.push({ text: m[1], style: 'code' })
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ text: (m[2] ?? m[3])!, style: 'bold' })
    else out.push({ text: (m[4] ?? m[5])!, style: 'italic' })
    at = i + m[0].length
  }
  if (at < s.length) out.push({ text: s.slice(at), style: 'plain' })
  return out
}

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0x1f300 && cp <= 0x1faff)

export const widthOf = (s: string) => {
  let w = 0
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

const cut = (s: string, w: number) => {
  let out = ''
  let used = 0
  for (const ch of s) {
    const cw = widthOf(ch)
    if (used + cw > w) break
    out += ch
    used += cw
  }
  return out
}

/**
 * Word-wraps styled runs to `width` cells, at most `maxLines` lines, the last
 * ending in "…" when text was left out. Returns one list of runs per line.
 */
export function wrapRuns(runs: Run[], width: number, maxLines: number): Run[][] {
  const w = Math.max(4, width)
  type Word = { text: string; style: Run['style'] }
  const words: Word[] = []
  for (const r of runs) {
    for (const piece of r.text.split(/(\s+)/)) {
      if (piece === '') continue
      words.push({ text: /^\s+$/.test(piece) ? ' ' : piece, style: r.style })
    }
  }
  const lines: Run[][] = [[]]
  let used = 0
  let truncated = false
  const push = (word: Word) => {
    const line = lines[lines.length - 1]!
    const prev = line[line.length - 1]
    if (prev && prev.style === word.style) prev.text += word.text
    else line.push({ ...word })
    used += widthOf(word.text)
  }
  for (const word of words) {
    if (word.text === ' ') {
      if (used > 0 && used < w) push(word)
      continue
    }
    let text = word.text
    while (widthOf(text) > 0) {
      const room = w - used
      if (widthOf(text) <= room) {
        push({ text, style: word.style })
        text = ''
      } else if (used > 0 && widthOf(text) <= w) {
        if (lines.length >= maxLines) {
          truncated = true
          break
        }
        lines.push([])
        used = 0
      } else {
        // A word longer than the line: break it.
        if (room <= 0) {
          if (lines.length >= maxLines) {
            truncated = true
            break
          }
          lines.push([])
          used = 0
          continue
        }
        const head = cut(text, room)
        push({ text: head, style: word.style })
        text = text.slice(head.length)
      }
    }
    if (truncated) break
  }
  for (const line of lines) {
    const last = line[line.length - 1]
    if (last) last.text = last.text.replace(/\s+$/, '')
  }
  if (truncated) {
    const line = lines[lines.length - 1]!
    const last = line[line.length - 1]
    if (last) {
      const total = line.reduce((n, r) => n + widthOf(r.text), 0)
      if (total >= w) last.text = cut(last.text, Math.max(0, widthOf(last.text) - 1))
      last.text += '…'
    }
  }
  return lines
}

// Steps that are the person's to do, not prompts for Claude.
const CHECK =
  /^(?:please\s+)?(?:try(?! (?:a|an|another|increasing|reducing|using|adding|switching)\b)|press|click|tap|type|focus|watch|notice|restart|reload|widen|resize|look (?:at|over|through)|play with|(?:check|verify|see|confirm) (?:that|whether|if|how|what|the (?:pane|popup|viewer|sidebar|band|row|status line|window|page|ui|app|output|result))|open (?:the )?(?:pane|popup|viewer|app|page|browser|window|sidebar|settings|dashboard)|test (?:it|this|that|the \w+) (?:yourself|by hand|manually|out))\b/i
const DECIDE =
  /^(?:please\s+)?(?:pick|choose|decide|say (?:whether|which|if|what|how)|tell me|let me know|confirm (?:whether|which|if)|consider|think about|weigh|agree|approve|answer)\b/i
const YOURS = /\b(?:yourself|your (?:own|terminal|font|theme|window|keyboard|config|machine|browser|laptop|setup)|in your\b|a few (?:turns|replies|sessions)|after this turn|by hand|manually)\b|`?(?:prefix|ctrl|alt|cmd|shift)\+/i

/** Who a step is for: undefined for Claude, 'check' or 'decide' for the person. */
export function forYouOf(text: string): 'check' | 'decide' | undefined {
  const t = plain(text).replace(/^[`'"]/, '')
  if (commandOf(text) !== undefined) return undefined
  if (DECIDE.test(t)) return 'decide'
  if (CHECK.test(t) || YOURS.test(t)) return 'check'
  return undefined
}
