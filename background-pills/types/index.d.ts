/** One agent of a workflow run, keyed by its agentId. */
export type TrackedAgent = {
  /** The workflow phase it runs in (`workflowPhase` of its meta file). */
  phase?: string
  /** What the script called it, when known. */
  label?: string
  isDone: boolean
  /** When the mod saw it end, ms since the epoch. */
  doneAt?: number
}

/** A workflow run in progress, keyed by its runId. */
export type TrackedWorkflow = {
  runId: string
  /** The background task id the Workflow tool answered, which its end notification names. */
  taskId?: string
  name: string
  /** Phase titles from the script's `meta.phases`, in order. */
  phases: string[]
  /** Where the run writes its agents' transcripts and meta files. */
  transcriptDir?: string
  startedAt: number
  /** False when the mod found the run already going: `startedAt` is then when it saw it. */
  isExactStart: boolean
  /** How long the earlier runs of this workflow took (ms), when it ran before. */
  usualMs?: number
  /** The highest share done the band has shown, so the bar never goes back. */
  peak?: number
  agents: Record<string, TrackedAgent>
}

/** A shell command running in the background. */
export type TrackedShell = {
  id: string
  command: string
  startedAt: number
  isExactStart: boolean
  /** How long it should take: from the command itself (a sleep) or from its earlier runs. */
  expectedMs?: number
  expectedFrom?: 'command' | 'history'
}

/** Any other background task the session lists (a monitor, a remote agent). */
export type TrackedOther = { id: string; type: string; description: string; startedAt: number }

/** A piece of work that just ended well: its pill stays green with a ✓ for a moment. */
export type FinishedPill = { key: string; name: string; start: number; at: number }

export type Work = {
  workflows: TrackedWorkflow[]
  shells: TrackedShell[]
  others: TrackedOther[]
  finished?: FinishedPill[]
}

/** A running agent outside any workflow, as the last tick read it. */
export type LiveAgent = {
  id: string
  description: string
  label: string
  startTime: number
  tokenCount: number
  tokenSamples: number[]
}

/** What changes every second: the clock the pills draw by, and the running agents. */
export type Live = { now: number; agents: LiveAgent[] }

/** Where the row of pills sits: above the message box (the band) or under it (the hint line). */
export type Place = 'above' | 'below'

declare module 'claude-code' {
  interface PluginState {
    'background-pills': {
      work: Shaped<Work>
      live: Live
      place: Place
    }
  }
}
