// Pure text helpers: find next steps in a reply or in tool output, and split
// inline markdown into styled runs for drawing. No `$` here, so tests can
// call these directly.

export type ParsedStep = { text: string; children: ParsedStep[] }
export type ParsedRoot = {
  kind: 'reply' | 'offer' | 'tool'
  title: string
  steps: ParsedStep[]
}

// Headings and lead-ins that introduce things to do.
const CUE =
  /\b(next steps?|next up|what'?s next|where to go from here|going forward|suggest(?:ed|ions?)?|follow[- ]?ups?|to[- ]?dos?|action items?|recommend(?:ed|ations?)?|(?:some|a few|possible|your|other) options|you (?:could|can|might|may)(?: also)?|remaining|still to do|left to do|not (?:yet )?done|ideas|consider|further (?:work|improvements|steps)|possible (?:improvements|enhancements|extensions)|future work|want me to|would you like|should i|i can also|happy to|optional)\b/i
// Extra cues that only make sense in tool output (scaffolders, installers).
const TOOL_CUE = /\b(get(?:ting)? started|now run|to fix|then run|next,? run)\b/i

const FENCE = /^\s*(```|~~~)/
const LIST = /^(\s*)(?:[-*+•]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/
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

/** Drop link targets and HTML tags; keep `code`, **bold** and *italic* marks. */
export const tidy = (s: string) =>
  s
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
}

const prune = (steps: ParsedStep[]): ParsedStep[] =>
  steps
    .map(s => ({ ...s, children: prune(s.children) }))
    .filter(s => s.text.length > 0 && (s.children.length > 0 || !/[:]$/.test(s.text)))

/**
 * Finds sections that introduce next steps ("## Next steps", "**You could
 * also:**", "Suggested follow-ups:") and returns their lists as trees. Nested
 * list items become subtrees; a bold sub-heading inside a section becomes a
 * group node.
 */
export function parseSections(
  md: string,
  opts: { kind?: 'reply' | 'tool'; loose?: boolean } = {},
): ParsedRoot[] {
  const kind = opts.kind ?? 'reply'
  const roots: ParsedRoot[] = []
  let section: Section | undefined
  let inFence = false

  const close = () => {
    if (section) {
      const steps = prune(section.steps)
      if (steps.length > 0) roots.push({ kind, title: tidy(section.title), steps })
    }
    section = undefined
  }
  const isCue = (t: string) => CUE.test(t) || (opts.loose === true && TOOL_CUE.test(t))

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
        section = { title: h.text, level: h.level, steps: [], stack: [], sawItem: false }
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
      const node: ParsedStep = { text: tidy(m[2]!), children: [] }
      const stack = section.stack
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
      const parent = stack[stack.length - 1]?.node
      if (parent) parent.children.push(node)
      else (section.group ? section.group.children : section.steps).push(node)
      stack.push({ indent, node })
      section.sawItem = true
      continue
    }

    const indent = indentOf(line)
    const last = section.stack[section.stack.length - 1]
    if (opts.loose === true && indent >= 1 && !last) {
      // Tool output often lists commands indented, with no bullets.
      const node: ParsedStep = { text: tidy(line), children: [] }
      ;(section.group ? section.group.children : section.steps).push(node)
      section.sawItem = true
      continue
    }
    if (last && indent > last.indent) {
      // A wrapped continuation of the previous item.
      if (last.node.text.length < 240) last.node.text = tidy(`${last.node.text} ${line}`)
      continue
    }
    if (opts.loose === true && indent >= 1) {
      section.steps.push({ text: tidy(line), children: [] })
      continue
    }
    // Plain paragraph: before any item it is the section's intro; after, the end.
    if (section.sawItem) close()
  }
  close()
  return roots
}

const OFFER =
  /^(?:(?:if you(?:'d| would) like|if you want|if helpful|optionally|alternatively|also|next)[, ]+)?(?:i can(?: also)?|i could(?: also)?|want me to|would you like me to|do you want me to|should i|shall i|i(?:'d| would) be happy to|happy to|let me know if you(?:'d| would) like me to|let me know if i should)\s+(.+?)\s*[?.!]*$/i
const VERB =
  /^(?:add|run|write|create|update|fix|make|set|open|start|try|look|check|commit|push|refactor|remove|delete|build|deploy|move|rename|install|test|wire|draft|turn|go|show|change|split|merge|keep|use|switch|publish|share|review|explain|dig|investigate|clean|port|convert|extend|implement|also|then)\b/i

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
      let phrase = m[1]!.replace(/\s+(?:too|as well|for you|next|now)$/i, '')
      if (/^(?:help|answer|clarify)\b/i.test(phrase)) continue
      const parts = phrase
        .split(/,\s*or\s+|\s+or\s+(?=\S)/i)
        .map(p => p.trim())
        .filter(p => p.length > 0)
      const alternatives = parts.length > 1 && parts.slice(1).every(p => VERB.test(p)) ? parts : [phrase]
      for (const alt of alternatives) {
        phrase = tidy(alt.replace(/^(?:i\s+)?(?:also|then)\s+/i, ''))
        if (phrase.split(' ').length < 2) continue
        steps.push({ text: phrase.charAt(0).toUpperCase() + phrase.slice(1), children: [] })
      }
    }
  }
  return steps.length > 0 ? [{ kind: 'offer', title: 'Claude offered', steps }] : []
}

const RUN_HINT = /\b(?:run|try(?: running)?|execute|use|type)\s*:?\s+[`'"]([^`'"\n]{2,120})[`'"]/gi

/** Command hints and next-steps sections in a tool's text output. */
export function parseToolText(text: string): ParsedRoot[] {
  const clipped = text.length > 20000 ? text.slice(-20000) : text
  const roots = parseSections(clipped, { kind: 'tool', loose: true })
  const seen = new Set(roots.flatMap(r => r.steps.map(s => keyOf(s.text))))
  const hints: ParsedStep[] = []
  for (const line of clipped.split(/\r?\n/)) {
    // git status prints "(use "git add <file>..." ...)" on every run: noise.
    if (/^\s*\(use\b/i.test(line)) continue
    for (const m of line.matchAll(RUN_HINT)) {
      const cmd = m[1]!.trim()
      if (/[<>]/.test(cmd)) continue
      const step = `Run \`${cmd}\``
      const k = keyOf(step)
      if (seen.has(k)) continue
      seen.add(k)
      hints.push({ text: step, children: [] })
      if (hints.length >= 5) break
    }
    if (hints.length >= 5) break
  }
  if (hints.length > 0) roots.push({ kind: 'tool', title: 'Hints', steps: hints })
  return roots
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
