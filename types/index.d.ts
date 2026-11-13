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
}

/** Where a group of steps came from. */
export type RootKind = 'reply' | 'offer' | 'tool' | 'todo' | 'likely' | 'mine'

/** A top-level group in the tree: one section of one reply, one tool hint set, the todo list. */
export type Root = {
  id: string
  kind: RootKind
  title: string
  /** A short note on where it came from, such as the Bash command. */
  source?: string
  turn: number
  isCollapsed: boolean
  steps: Step[]
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
    }
  }
}
