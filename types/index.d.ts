export type StepStatus = 'open' | 'queued' | 'running' | 'done' | 'failed'

/** One thing to do. `prompt` is what gets sent when it runs. */
export type Step = {
  id: string
  text: string
  prompt: string
  status: StepStatus
  isCollapsed: boolean
  children: Step[]
  /** The background agent working on it, while one is. */
  agentId?: string
  /** What kind of group it first came from (an offer's prompt reads differently). */
  origin?: RootKind
  /** The turn it arrived in, to mark new steps. */
  addedTurn?: number
}

/** Where a group of steps came from. */
export type RootKind = 'reply' | 'offer' | 'tool' | 'todo' | 'likely' | 'mine' | 'stream'

/**
 * A top-level group in the tree. A `stream` gathers the steps of one line of
 * work across turns; the others are one tool hint set, the todo list, a guess.
 */
export type Root = {
  id: string
  kind: RootKind
  title: string
  /** A short note on where it came from, such as the Bash command. */
  source?: string
  turn: number
  isCollapsed: boolean
  steps: Step[]
  /** Parked: kept, but out of the tree, the band and the count until restored. */
  isArchived?: boolean
  /** A stream's colour, an index into the pane's palette, fixed when it starts. */
  color?: number
  /** The turn a "this stream is idle" toast last went out for it. */
  nudgedTurn?: number
}

/** A prompt the pane sent (or put in the prompt box), waiting for its turn to finish. */
export type Inflight = {
  stepIds: string[]
  prompt: string
  turnId?: string
}

/** A group being run one step per turn, in order. */
export type Autopilot = {
  rootId: string
  /** Step ids still to send, in order. */
  queue: string[]
  /** The step whose turn is running now. */
  current?: string
  total: number
}

declare module 'claude-code' {
  interface PluginState {
    'upnext': {
      roots: Shaped<Root[]>
      pending: Shaped<Root[]>
      inflight: Shaped<Inflight[]>
      turn: number
      isClosedByPerson: boolean
      /** The turn whose steps the model is still finding; 0 when none. */
      loadingTurn: number
      /** The 1/2/3 row above the prompt stays hidden through this turn. */
      bandHiddenTurn: number
      autopilot: Shaped<Autopilot | null>
      /** The step whose text is being edited in the pane. */
      editing: string | null
      /** The group a new step is being added to. */
      adding: string | null
      isTidying: boolean
      /** The one stream the pane shows (`/upnext <name>`); null shows them all. */
      filter: string | null
      showArchived: boolean
      /** The herdr pane the viewer runs in, once opened. */
      herdrViewer: string | null
    }
  }
}
