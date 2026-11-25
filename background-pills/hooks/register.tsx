// background-pills: one row of pills above the message box, one pill for each
// piece of background work of this session, shown only while it runs:
// - the pill fills with colour as the work moves toward its end (a workflow's
//   phases and agents, a command whose length is known), with the percent and
//   the time left; work with no known end shows a pulsing dot and its time;
// - pointing at a pill shows its detail on the same row (phase and agents,
//   what an agent is doing and its tokens, where a command's length comes from);
// - work that ends well turns green with a ✓ for two seconds, then goes;
// - pills that do not fit the row are counted in a last «+N».
// While the band is collapsed (or no surface draws it) a short status line
// under the prompt says the same in a few words. Both go when nothing runs.
//
// Sources, all of this session:
// - Workflow tool calls (name and phases from the script's meta, run and task ids);
// - agent.spawn of a workflow's agents, turn.complete of each (done);
//   the phase from the agent's meta file the run writes in its transcript folder;
// - Bash / PowerShell calls answered with a backgroundTaskId;
// - task notifications (prompt.submit, origin task-notification) for each end;
// - classic.Stop's background_tasks, the session's own list of what is in flight;
// - $.agent.list() for every other running agent, read every second.
// How long finished commands and workflows took is kept across sessions in
// $.store, so the next run of the same one gets a countdown.

import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type {
  FinishedPill,
  Work,
  Live,
  LiveAgent,
  TrackedOther,
  TrackedShell,
  TrackedWorkflow,
} from '../types'

const EMPTY: Work = { workflows: [], shells: [], others: [], finished: [] }
const NO_LIVE: Live = { now: 0, agents: [] }

const work = atom({ plugin: 'background-pills', key: 'work' } as const, EMPTY, { shape: 'v1' })
const live = atom({ plugin: 'background-pills', key: 'live' } as const, NO_LIVE)

const TICK_MS = 1000
/** A workflow whose task id is still unknown is kept this long without the session listing it. */
const UNCONFIRMED_MS = 120_000
/** The status line waits this long for the band before it speaks. */
const STATUS_GRACE_MS = 2500
/** How long a finished pill stays green. */
const DONE_MS = 2000
/** The longest name a pill shows. */
const NAME_MAX = 24

const HISTORY_KEY = 'durations'
const HISTORY_RUNS = 5
const HISTORY_KEYS = 80

const ORANGE = '#d97757'

type Dollar = EngineInterface
type ListedTask = {
  id: string
  type: string
  description: string
  command?: string
  name?: string
}
type History = Record<string, number[]>

// ---------------------------------------------------------------- parsing

/** Index just past the `]` that closes the `[` at `open`, skipping quoted text. */
function closingBracket(text: string, open: number): number {
  let depth = 0
  let quote = ''

  for (let i = open; i < text.length; i++) {
    const c = text[i]

    if (quote !== '') {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }

    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i + 1
  }

  return text.length
}

/** Name and phase titles from a workflow script's `export const meta = { ... }`. */
export function parseMeta(script: string): { name?: string; phases: string[] } {
  const at = script.search(/export\s+const\s+meta\s*=/)

  if (at < 0) return { phases: [] }

  const block = script.slice(at, at + 12_000)
  const name = /\bname\s*:\s*(['"`])((?:(?!\1)[^\\]|\\.)+)\1/.exec(block)?.[2]
  const phases: string[] = []
  const phasesAt = block.search(/\bphases\s*:\s*\[/)

  if (phasesAt >= 0) {
    const open = block.indexOf('[', phasesAt)
    const list = block.slice(open, closingBracket(block, open))

    for (const m of list.matchAll(/\btitle\s*:\s*(['"`])((?:(?!\1)[^\\]|\\.)+)\1/g)) {
      if (m[2] !== undefined) phases.push(m[2])
    }
  }

  return name === undefined ? { phases } : { name, phases }
}

/** The tasks a task notification reports as ended, each with its status. */
export function endedTasks(text: string): Array<{ id: string; status: string }> {
  const out: Array<{ id: string; status: string }> = []

  for (const block of text.split('<task-notification>')) {
    const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(block)?.[1]

    if (id === undefined) continue

    out.push({ id, status: /<status>\s*([^<\s]+)\s*<\/status>/.exec(block)?.[1] ?? '' })
  }

  return out
}

/** How long a command says it waits: its sleeps, added up; undefined when it has none. */
export function sleepMs(command: string): number | undefined {
  let total = 0

  for (const m of command.matchAll(
    /\bStart-Sleep\b(?:\s+-(Seconds|Milliseconds|ms|s|m)\b)?\s+(\d+(?:\.\d+)?)/gi,
  )) {
    const unit = (m[1] ?? 's').toLowerCase()
    const n = Number(m[2])

    total += unit === 'milliseconds' || unit === 'ms' || unit === 'm' ? n : n * 1000
  }

  for (const m of command.matchAll(/(?:^|[\s;&|(])sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=$|[\s;&|)])/g)) {
    const unit = m[2] ?? ''
    const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 1000

    total += Number(m[1]) * factor
  }

  for (const m of command.matchAll(/\btimeout\s+\/t\s+(\d+)/gi)) total += Number(m[1]) * 1000

  return total > 0 ? Math.round(total) : undefined
}

// ---------------------------------------------------------------- durations kept across sessions

export function historyKey(kind: 'cmd' | 'wf', text: string): string {
  return `${kind}:${text.replace(/\s+/g, ' ').trim().slice(0, 200)}`
}

/** The middle of the earlier runs' durations, or undefined when it never ran. */
export function usual(h: History, key: string): number | undefined {
  const runs = h[key]

  if (!Array.isArray(runs) || runs.length === 0) return undefined

  const sorted = [...runs].sort((a, b) => a - b)

  return sorted[Math.floor(sorted.length / 2)]
}

export function remember(h: History, key: string, ms: number): History {
  const next: History = {}
  const others = Object.keys(h).filter(k => k !== key)

  for (const k of others.slice(-(HISTORY_KEYS - 1))) {
    const runs = h[k]

    if (Array.isArray(runs)) next[k] = runs
  }

  next[key] = [...(h[key] ?? []), Math.round(ms)].slice(-HISTORY_RUNS)

  return next
}

// ---------------------------------------------------------------- figures

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

/** `m:ss`, or `h:mm:ss` past the hour. */
export function clock(ms: number, round: (x: number) => number = Math.floor): string {
  const s = Math.max(0, round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Time running; `≥` in front when the mod found the work already going. */
function since(isExact: boolean, ms: number): string {
  return `${isExact ? '' : '≥ '}${clock(ms)}`
}

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`

  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The phase the run has reached: the furthest one any of its agents runs or ran in. */
function currentPhase(w: TrackedWorkflow): string | undefined {
  const seen = Object.values(w.agents)
    .map(a => a.phase)
    .filter((p): p is string => typeof p === 'string' && p !== '')

  if (seen.length === 0) return undefined

  const ranked = seen.filter(p => w.phases.includes(p))

  if (ranked.length === 0) return seen[seen.length - 1]

  return ranked.reduce((a, b) => (w.phases.indexOf(b) > w.phases.indexOf(a) ? b : a))
}

export type WorkflowProgress = {
  /** Share done, 0..0.99, from the phases passed and the current phase's agents; none without phases. */
  fraction?: number
  /** Index of the current phase among the script's, -1 when unknown. */
  phaseIndex: number
  done: number
  started: number
  /** When the share last moved: the last agent's end, or the start. */
  changedAt: number
}

export function workflowProgress(w: TrackedWorkflow): WorkflowProgress {
  const agents = Object.values(w.agents)
  const done = agents.filter(a => a.isDone).length
  const started = agents.length
  const changedAt = Math.max(w.startedAt, ...agents.map(a => a.doneAt ?? 0))
  const phase = currentPhase(w)
  const phaseIndex = phase === undefined ? -1 : w.phases.indexOf(phase)
  const n = w.phases.length

  if (n === 0) return { phaseIndex, done, started, changedAt }

  const index = Math.max(0, phaseIndex)
  const isAnyPlaced = agents.some(a => a.phase !== undefined)
  const here = isAnyPlaced ? agents.filter(a => a.phase === w.phases[index]) : agents
  const share = here.length === 0 ? 0 : here.filter(a => a.isDone).length / here.length

  return { fraction: Math.min(0.99, (index + share) / n), phaseIndex, done, started, changedAt }
}

/** Time left to a workflow's end (negative: past its usual length), or undefined when no estimate holds. */
function workflowLeft(w: TrackedWorkflow, p: WorkflowProgress, now: number): number | undefined {
  if (!w.isExactStart) return undefined
  if (w.usualMs !== undefined) return w.usualMs - (now - w.startedAt)
  if (p.fraction === undefined) return undefined

  const before = p.changedAt - w.startedAt

  if (p.fraction < 0.1 || before < 15_000) return undefined

  const left = p.changedAt + (before * (1 - p.fraction)) / p.fraction - now

  return left > 0 ? left : undefined
}

// ---------------------------------------------------------------- pills

export type Pill = {
  key: string
  kind: 'workflow' | 'command' | 'agent' | 'other' | 'done'
  /** When the work started: pills keep that order, so they never jump. */
  start: number
  name: string
  /** 0..1, how far the fill goes; absent while the end is unknown. */
  fraction?: number
  percent?: string
  /** The time left (`~6:12` estimated, `0:16` exact), over (`+0:40`), or the time running. */
  time: string
  isCountdown: boolean
  /** What pointing at the pill shows. */
  detail: string
  isDone?: boolean
}

function workflowPill(w: TrackedWorkflow, now: number): Pill {
  const p = workflowProgress(w)
  const fraction = p.fraction === undefined ? undefined : Math.max(p.fraction, w.peak ?? 0)
  const spent = now - w.startedAt
  const phase = currentPhase(w)
  const n = w.phases.length
  const detail: string[] = []

  if (p.phaseIndex >= 0) detail.push(`phase ${p.phaseIndex + 1} of ${n}: ${w.phases[p.phaseIndex]}`)
  else if (phase !== undefined) detail.push(`phase ${phase}`)
  else if (n > 0) detail.push(`${n} phases`)

  detail.push(p.started === 0 ? 'starting' : `${p.done} of ${p.started} agents done`)
  detail.push(`running for ${since(w.isExactStart, spent)}`)

  const left = workflowLeft(w, p, now)
  let time = since(w.isExactStart, spent)
  let isCountdown = false

  if (left !== undefined && left > 0) {
    time = `~${clock(left, Math.ceil)}`
    isCountdown = true
  } else if (left !== undefined) {
    time = `+${clock(-left)}`
    detail.push('over its usual time')
  }

  return {
    key: `w-${w.runId}`,
    kind: 'workflow',
    start: w.startedAt,
    name: clip(w.name, NAME_MAX),
    ...(fraction === undefined ? {} : { fraction, percent: `${Math.floor(fraction * 100)}%` }),
    time,
    isCountdown,
    detail: detail.join(' · '),
  }
}

function shellPill(s: TrackedShell, now: number): Pill {
  const spent = now - s.startedAt
  const expected = s.expectedMs !== undefined && s.expectedMs > 0 ? s.expectedMs : undefined
  const how =
    s.expectedFrom === 'command'
      ? 'length stated in the command'
      : s.expectedFrom === 'history' && expected !== undefined
        ? `usually ${clock(expected)}`
        : 'length not known yet'
  const pill: Pill = {
    key: `c-${s.id}`,
    kind: 'command',
    start: s.startedAt,
    name: clip(s.command, NAME_MAX),
    time: since(s.isExactStart, spent),
    isCountdown: false,
    detail: `${clip(s.command, 80)} · ${how} · running for ${since(s.isExactStart, spent)}`,
  }

  if (expected === undefined || !s.isExactStart) return pill

  const left = expected - spent

  if (left <= 0) {
    return {
      ...pill,
      time: `+${clock(-left)}`,
      detail: `${pill.detail} · over its ${s.expectedFrom === 'history' ? 'usual' : 'expected'} time`,
    }
  }

  const fraction = Math.min(0.99, spent / expected)

  return {
    ...pill,
    fraction,
    percent: `${Math.floor(fraction * 100)}%`,
    time: `${s.expectedFrom === 'history' ? '~' : ''}${clock(left, Math.ceil)}`,
    isCountdown: true,
  }
}

function agentPill(a: LiveAgent, now: number): Pill {
  const lines = a.label.split('\n').map(x => x.trim()).filter(x => x !== '')
  const latest = lines[lines.length - 1]
  const doing = latest !== undefined && latest !== a.description ? clip(latest, 100) : undefined

  return {
    key: `a-${a.id}`,
    kind: 'agent',
    start: a.startTime,
    name: clip(a.description, NAME_MAX),
    time: clock(now - a.startTime),
    isCountdown: false,
    detail: [doing, a.tokenCount > 0 ? `${tokens(a.tokenCount)} tokens` : 'starting']
      .filter((x): x is string => x !== undefined)
      .join(' · '),
  }
}

function otherPill(o: TrackedOther, now: number): Pill {
  return {
    key: `o-${o.id}`,
    kind: 'other',
    start: o.startedAt,
    name: clip(o.description || o.type, NAME_MAX),
    time: since(false, now - o.startedAt),
    isCountdown: false,
    detail: `${o.type} in the background`,
  }
}

function donePill(f: FinishedPill): Pill {
  return {
    key: f.key,
    kind: 'done',
    start: f.start,
    name: f.name,
    time: 'done',
    isCountdown: false,
    detail: 'finished',
    isDone: true,
  }
}

/** Every pill, in the order the work started; empty when nothing runs. */
export function buildPills(l: Work, lv: Live, now: number): Pill[] {
  const pills = [
    ...l.workflows.map(w => workflowPill(w, now)),
    ...lv.agents.map(a => agentPill(a, now)),
    ...l.shells.map(s => shellPill(s, now)),
    ...l.others.map(o => otherPill(o, now)),
    ...(l.finished ?? []).filter(f => now - f.at < DONE_MS).map(donePill),
  ]

  return pills.sort((a, b) => a.start - b.start)
}

/** Cells a pill takes on the terminal: its words, its bar or glyph, the gap. */
export function cellWidth(p: Pill): number {
  const percent = p.percent === undefined ? 0 : p.percent.length + 1

  return 7 + p.name.length + percent + 1 + p.time.length
}

/**
 * The pills that fit a row `budget` wide (cells on the terminal, pixels on the
 * desktop), the rest to count in «+N», whose own room is kept while any is left.
 */
export function fitPills(
  pills: readonly Pill[],
  budget: number,
  widthOf: (p: Pill) => number,
  gap: number,
  moreWidth: number,
): { shown: Pill[]; hidden: Pill[] } {
  const shown: Pill[] = []
  let used = 0

  for (const [i, p] of pills.entries()) {
    const width = widthOf(p) + (shown.length > 0 ? gap : 0)
    const reserve = i < pills.length - 1 ? gap + moreWidth : 0

    if (shown.length > 0 && used + width + reserve > budget) break

    used += width
    shown.push(p)
  }

  return { shown, hidden: pills.slice(shown.length) }
}

/** The status line's few words, or undefined when nothing runs. */
export function statusText(pills: readonly Pill[]): string | undefined {
  const running = pills.filter(p => p.isDone !== true)

  if (running.length === 0) return undefined

  const words = running.slice(0, 3).map(p => [p.name, p.percent, p.time].filter(Boolean).join(' '))
  const more = running.length > 3 ? ` · +${running.length - 3}` : ''

  return `⏳ ${words.join(' · ')}${more}`
}

/** A text bar for the terminal, which draws no fill: ▰▰▰▱▱▱. */
export function textBar(fraction: number, cells = 6): string {
  const on = Math.max(0, Math.min(cells, Math.round(fraction * cells)))

  return `${'▰'.repeat(on)}${'▱'.repeat(cells - on)}`
}

// The desktop draws each pill as a picture of its own, so it looks the same
// everywhere: a rounded pill with no background of its own (the band's shows
// through), the fill clipped to it, the words on top. Its colours follow the
// light or dark scheme the app runs in.

export const PILL_HEIGHT = 26
const PILL_PAD = 11
const PILL_GAP = 6
const SVG_STYLE =
  '<style>' +
  '.bg{fill:none}.bd{fill:none;stroke:#d9d7cf}.tx{fill:#1f1e1d}.dim{fill:#6f6d67}.acc{fill:#c4623f}' +
  '.okbg{fill:#e3f3e9}.okbd{fill:none;stroke:#2f9e5b}.ok{fill:#2f9e5b}' +
  '@media (prefers-color-scheme: dark){.bd{stroke:#4a4944}.tx{fill:#ecebe6}.dim{fill:#a3a19a}' +
  '.acc{fill:#e5876a}.okbg{fill:#1f3a2a}.okbd{stroke:#3fb96f}.ok{fill:#3fb96f}}' +
  'text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12.5px}' +
  '.b{font-weight:600}.n{font-variant-numeric:tabular-nums}' +
  '</style>'

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** About how wide a text is at 12.5px in the system font, a little generous so nothing is cut. */
export function textWidth(text: string, isBold = false): number {
  let w = 0

  for (const c of text) {
    if (/[ilIj.,:;!|'’ ]/.test(c)) w += 3.7
    else if (/[mwMW@%]/.test(c)) w += 10.4
    else if (/[0-9~+]/.test(c)) w += 7.3
    else if (/[A-Z]/.test(c)) w += 8.3
    else w += 6.4
  }

  return Math.ceil(isBold ? w * 1.07 : w)
}

/** The words of a pill, left to right, with where each goes. */
function pillWords(p: Pill): { words: Array<{ text: string; cls: string; x: number }>; width: number } {
  const marks = p.isDone === true || p.fraction === undefined ? 14 : 0
  const words: Array<{ text: string; cls: string; x: number }> = []
  let x = PILL_PAD + marks

  words.push({ text: p.name, cls: 'tx b', x })
  x += textWidth(p.name, true) + 8

  if (p.percent !== undefined) {
    words.push({ text: p.percent, cls: 'tx n', x })
    x += textWidth(p.percent) + 8
  }

  words.push({ text: p.time, cls: p.isDone === true ? 'ok b' : 'acc n', x })
  x += textWidth(p.time)

  return { words, width: Math.ceil(x + PILL_PAD) }
}

/** How wide a pill's picture is, in pixels. */
export function pillPixels(p: Pill): number {
  return pillWords(p).width
}

/** One pill as an SVG picture: border, fill or passing light, dot or ✓, words. */
export function pillSvg(p: Pill): string {
  const { words, width: w } = pillWords(p)
  const h = PILL_HEIGHT
  const isDone = p.isDone === true
  // Ids of its own, in case a surface ever draws the pictures in one page.
  const id = p.key.replace(/[^A-Za-z0-9_-]/g, '_')
  const shape = `x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${(h - 1) / 2}"`
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    SVG_STYLE,
    '<defs>',
    `<clipPath id="k-${id}"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${(h - 2) / 2}"/></clipPath>`,
    `<linearGradient id="g-${id}" x1="0" x2="1"><stop offset="0" stop-color="${ORANGE}" stop-opacity="0"/>` +
      `<stop offset="0.5" stop-color="${ORANGE}" stop-opacity="0.38"/><stop offset="1" stop-color="${ORANGE}" stop-opacity="0"/></linearGradient>`,
    '</defs>',
    `<rect class="${isDone ? 'okbg' : 'bg'}" ${shape}/>`,
  ]

  if (!isDone && p.fraction !== undefined) {
    const fill = Math.max(0, Math.min(1, p.fraction)) * w

    parts.push(`<rect clip-path="url(#k-${id})" x="0" y="0" width="${fill.toFixed(1)}" height="${h}" fill="${ORANGE}" fill-opacity="0.3"/>`)
  } else if (!isDone) {
    const band = Math.round(w * 0.45)

    parts.push(
      `<rect clip-path="url(#k-${id})" x="${-band}" y="0" width="${band}" height="${h}" fill="url(#g-${id})">` +
        `<animate attributeName="x" from="${-band}" to="${w}" dur="2.2s" repeatCount="indefinite"/></rect>`,
      `<circle cx="${PILL_PAD + 4}" cy="${h / 2}" r="3.4" fill="${ORANGE}">` +
        `<animate attributeName="opacity" values="1;0.45;1" dur="1.6s" repeatCount="indefinite"/></circle>`,
    )
  }

  parts.push(`<rect class="${isDone ? 'okbd' : 'bd'}" ${shape}/>`)

  if (isDone) parts.push(`<text x="${PILL_PAD}" y="17.5" class="ok b">✓</text>`)

  for (const word of words) {
    parts.push(`<text x="${word.x}" y="17.5" class="${word.cls}">${esc(word.text)}</text>`)
  }

  parts.push('</svg>')

  return parts.join('')
}

/** What a pill says, read out where its picture cannot be seen. */
export function pillAlt(p: Pill): string {
  return [p.name, p.percent, p.time].filter((x): x is string => x !== undefined).join(' · ')
}

/** The «+N» pill: dashed, quiet. */
export function moreSvg(count: number): { source: string; width: number } {
  const text = `+${count}`
  const w = PILL_PAD * 2 + textWidth(text)
  const h = PILL_HEIGHT

  return {
    width: w,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${SVG_STYLE}` +
      `<rect class="bd" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${(h - 1) / 2}" stroke-dasharray="3 3"/>` +
      `<text x="${PILL_PAD}" y="17.5" class="dim n">${text}</text></svg>`,
  }
}

// ---------------------------------------------------------------- the tracker

function withWorkflow(
  t: Work,
  runId: string,
  create: () => TrackedWorkflow,
  change: (w: TrackedWorkflow) => TrackedWorkflow,
): Work {
  const had = t.workflows.some(w => w.runId === runId)
  const workflows = had
    ? t.workflows.map(w => (w.runId === runId ? change(w) : w))
    : [...t.workflows, change(create())]

  return { ...t, workflows }
}

/** Drops every task whose id is in `ended`: shells, workflows (by task id), others. */
export function dropTasks(t: Work, ended: ReadonlySet<string>): Work {
  return {
    ...t,
    workflows: t.workflows.filter(w => w.taskId === undefined || !ended.has(w.taskId)),
    shells: t.shells.filter(s => !ended.has(s.id)),
    others: t.others.filter(o => !ended.has(o.id)),
  }
}

function withFinished(t: Work, more: readonly FinishedPill[], now: number): Work {
  const keep = (t.finished ?? []).filter(f => now - f.at < DONE_MS && !more.some(m => m.key === f.key))

  return { ...t, finished: [...keep, ...more] }
}

/** Brings the tracker in line with the session's own list of background work. */
export function reconcile(t: Work, listed: readonly ListedTask[], now: number): Work {
  const ids = new Set(listed.map(x => x.id))
  const isShell = (x: ListedTask) => x.type === 'shell' || x.command !== undefined
  const isWorkflow = (x: ListedTask) => x.type === 'workflow'

  const workflows = t.workflows.filter(w =>
    w.taskId === undefined ? now - w.startedAt < UNCONFIRMED_MS : ids.has(w.taskId),
  )
  const known = new Set(workflows.map(w => w.taskId))

  for (const x of listed) {
    if (isWorkflow(x) && !known.has(x.id)) {
      workflows.push({
        runId: x.id,
        taskId: x.id,
        name: x.name ?? x.description,
        phases: [],
        startedAt: now,
        isExactStart: false,
        agents: {},
      })
    }
  }

  const shells: TrackedShell[] = t.shells.filter(s => ids.has(s.id))
  const tracked = new Set(shells.map(s => s.id))

  for (const x of listed) {
    if (isShell(x) && !isWorkflow(x) && !tracked.has(x.id)) {
      shells.push({ id: x.id, command: x.command ?? x.description, startedAt: now, isExactStart: false })
    }
  }

  const others: TrackedOther[] = listed
    .filter(x => !isShell(x) && !isWorkflow(x) && x.type !== 'subagent')
    .map(x => ({
      id: x.id,
      type: x.type,
      description: x.description,
      startedAt: t.others.find(o => o.id === x.id)?.startedAt ?? now,
    }))

  return { ...t, workflows, shells, others }
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'

  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

// ---------------------------------------------------------------- the mod

// Module state: a reload starts these over; what the band draws lives in $.state.
let timer: { cancel: () => void } | undefined
let ticks = 0
let shownStatus: string | undefined
let hasShownStatus = false
/** When the band last drew pills that are on screen, and whether the person collapsed it. */
let bandDrawnAt = 0
let isBandCollapsed = false
/** Since when something has been running, 0 while nothing is. */
let busySince = 0
/** How many times each workflow agent's meta file was looked for. */
const metaTries = new Map<string, number>()

async function readHistory($: Dollar): Promise<History> {
  try {
    const value = await $.store.get(HISTORY_KEY)

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as History) : {}
  } catch {
    return {}
  }
}

async function saveDurations($: Dollar, durations: ReadonlyArray<readonly [string, number]>): Promise<void> {
  let h = await readHistory($)

  for (const [key, ms] of durations) h = remember(h, key, ms)

  await $.store.set(HISTORY_KEY, h)
}

async function refresh($: Dollar): Promise<void> {
  const l = await read($, work)
  let listed: AgentInfo[] = []

  try {
    listed = await $.agent.list()
  } catch {
    listed = []
  }

  const inWorkflows = new Set(l.workflows.flatMap(w => Object.keys(w.agents)))
  const agents: LiveAgent[] = listed
    .filter(
      a =>
        a.kind === 'local_agent' &&
        (a.taskStatus === 'running' || a.taskStatus === 'pending') &&
        !inWorkflows.has(a.id),
    )
    .map(a => ({
      id: a.id,
      description: a.description || a.type,
      label: typeof a.label === 'string' ? a.label : '',
      startTime: typeof a.startTime === 'number' ? a.startTime : 0,
      tokenCount: typeof a.tokenCount === 'number' ? a.tokenCount : 0,
      tokenSamples: Array.isArray(a.tokenSamples) ? a.tokenSamples.slice(-16) : [],
    }))
  const now = await $.clock.now()
  const before = await read($, live)

  // An agent that left the running list having completed turns green for a moment.
  const running = new Set(agents.map(a => a.id))
  const justDone: FinishedPill[] = before.agents
    .filter(a => !running.has(a.id) && listed.some(x => x.id === a.id && x.taskStatus === 'completed'))
    .map(a => ({ key: `a-${a.id}`, name: clip(a.description, NAME_MAX), start: a.startTime, at: now }))
  const finished = (l.finished ?? []).filter(f => now - f.at < DONE_MS)
  const isStale = finished.length !== (l.finished ?? []).length

  // A workflow's fill never goes back when new agents join its phase.
  const peaks = new Map<string, number>()

  for (const w of l.workflows) {
    const f = workflowProgress(w).fraction

    if (f !== undefined && f > (w.peak ?? 0)) peaks.set(w.runId, f)
  }

  if (justDone.length > 0 || isStale || peaks.size > 0) {
    await update($, work, t => ({
      ...withFinished(t, justDone, now),
      workflows: t.workflows.map(w => {
        const peak = peaks.get(w.runId)

        return peak === undefined || peak <= (w.peak ?? 0) ? w : { ...w, peak }
      }),
    }))
  }

  const isBusy =
    l.workflows.length + l.shells.length + l.others.length + agents.length + finished.length + justDone.length > 0

  // The clock only runs while something shows: an idle band is never drawn again.
  if (isBusy || before.agents.length > 0 || before.now === 0) {
    await update($, live, () => ({ now, agents }))
  }

  busySince = isBusy ? (busySince === 0 ? now : busySince) : 0

  const isBandShowing = !isBandCollapsed && now - bandDrawnAt < 3000
  const text =
    isBusy && !isBandShowing && now - busySince >= STATUS_GRACE_MS
      ? statusText(buildPills(l, { now, agents }, now))
      : undefined

  if (!hasShownStatus || text !== shownStatus) {
    $.ui.status(text)
    shownStatus = text
    hasShownStatus = true
  }
}

/** Reads the phase of workflow agents whose meta file was not read yet. */
async function fillPhases($: Dollar): Promise<void> {
  const t = await read($, work)
  const found: Array<{ runId: string; agentId: string; phase: string; label?: string }> = []

  for (const w of t.workflows) {
    if (w.transcriptDir === undefined) continue

    for (const [agentId, a] of Object.entries(w.agents)) {
      const tries = metaTries.get(agentId) ?? 0

      if (a.phase !== undefined || tries >= 6 || found.length >= 12) continue

      metaTries.set(agentId, tries + 1)

      try {
        const text = await $.fs.read(joinPath(w.transcriptDir, `agent-${agentId}.meta.json`))
        const meta = JSON.parse(text) as { workflowPhase?: unknown; description?: unknown }
        const phase = typeof meta.workflowPhase === 'string' ? meta.workflowPhase : ''
        const label = typeof meta.description === 'string' ? meta.description : undefined

        found.push(label === undefined ? { runId: w.runId, agentId, phase } : { runId: w.runId, agentId, phase, label })
      } catch {
        // Not written yet: a later tick looks again.
      }
    }
  }

  if (found.length === 0) return

  await update($, work, t2 => ({
    ...t2,
    workflows: t2.workflows.map(w => {
      const mine = found.filter(f => f.runId === w.runId && w.agents[f.agentId] !== undefined)

      if (mine.length === 0) return w

      const agents = { ...w.agents }

      for (const f of mine) {
        const had = agents[f.agentId]

        if (had === undefined) continue

        agents[f.agentId] = {
          ...had,
          phase: f.phase,
          ...(f.label === undefined ? {} : { label: f.label }),
        }
      }

      return { ...w, agents }
    }),
  }))
}

async function tick($: Dollar): Promise<void> {
  ticks += 1

  if (ticks % 2 === 1) {
    try {
      await fillPhases($)
    } catch {
      // A phase stays unknown; the band still draws.
    }
  }

  try {
    await refresh($)
  } catch {
    // The next tick tries again.
  }
}

function ensureTimer($: Dollar): void {
  if (timer !== undefined) return

  timer = $.clock.every(TICK_MS, () => {
    void tick($)
  })
}

function soon($: Dollar): void {
  ensureTimer($)
  void tick($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    timer?.cancel()
    timer = undefined
    soon($)

    return started
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    $.ui.status(undefined)
    shownStatus = undefined
    hasShownStatus = false

    return next(e)
  })

  // The band above the message box: one row of pills.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const l = await read($, work)
    const lv = await read($, live)
    const now = lv.now > 0 ? lv.now : await $.clock.now()
    const pills = buildPills(l, lv, now)

    if (pills.length === 0) return next(e)

    isBandCollapsed = e.props.isCollapsed
    bandDrawnAt = now

    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const frame = ['◐', '◓', '◑', '◒'][Math.floor(now / 1000) % 4] ?? '◐'

    // The terminal: no pictures, so a text bar or a turning glyph.
    if (Svg === undefined) {
      const { shown, hidden } = fitPills(pills, Math.max(20, e.props.bodyColumns), cellWidth, 2, 4)

      return (
        <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" gap={2}>
          {shown.map(p => (
            <Box key={p.key} flexShrink={0} flexDirection="row" gap={1}>
              <Text color={p.isDone === true ? 'success' : 'claude'}>
                {p.isDone === true ? '✓' : p.fraction === undefined ? frame : textBar(p.fraction)}
              </Text>
              <Text bold>{p.name}</Text>
              {p.percent === undefined ? null : <Text>{p.percent}</Text>}
              <Text color={p.isDone === true ? 'success' : 'claude'}>{p.time}</Text>
            </Box>
          ))}
          {hidden.length === 0 ? null : <Text dimColor>{`+${hidden.length}`}</Text>}
        </Box>
      )
    }

    // About 8 pixels to a cell of the band, the desktop's own measure.
    const { shown, hidden } = fitPills(pills, Math.max(160, e.props.bodyColumns * 8), pillPixels, PILL_GAP, 44)
    const more = hidden.length === 0 ? undefined : moreSvg(hidden.length)

    return (
      <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" alignItems="center" gap="xs">
        {shown.map(p => (
          <Box key={p.key} flexShrink={0} flexDirection="row" alignItems="center" gap="xs">
            <Svg source={pillSvg(p)} alt={pillAlt(p)} width={pillPixels(p)} height={PILL_HEIGHT} />
            <Box display="none" hover={{ display: 'flex' }}>
              <Text dimColor wrap="truncate-end">
                {p.detail}
              </Text>
            </Box>
          </Box>
        ))}
        {more === undefined ? null : (
          <Box key="more" flexShrink={0} flexDirection="row" alignItems="center" gap="xs">
            <Svg source={more.source} alt={`${hidden.length} more`} width={more.width} height={PILL_HEIGHT} />
            <Box display="none" hover={{ display: 'flex' }}>
              <Text dimColor wrap="truncate-end">
                {hidden.map(p => p.name).join(', ')}
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  // A workflow starts: its name and phases, its run and task ids.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    let meta: { name?: string; phases: string[] } = { phases: [] }

    try {
      meta = parseMeta(typeof e.script === 'string' ? e.script : '')
    } catch {
      meta = { phases: [] }
    }

    const ran = await next(e)

    try {
      if (ran.deny !== undefined || ran.isError === true || ran.result === undefined) return ran

      const r = ran.result as {
        taskId?: string
        runId?: string
        workflowName?: string
        transcriptDir?: string
        scriptPath?: string
      }

      if (typeof r.taskId !== 'string' || r.taskId === '') return ran

      if (meta.phases.length === 0 && typeof r.scriptPath === 'string') {
        meta = parseMeta(await $.fs.read(r.scriptPath).catch(() => ''))
      }

      const now = await $.clock.now()
      const runId = typeof r.runId === 'string' && r.runId !== '' ? r.runId : r.taskId
      const taskId = r.taskId
      const name =
        r.workflowName ?? meta.name ?? (typeof e.name === 'string' ? e.name : undefined) ?? 'workflow'
      const usualMs = usual(await readHistory($), historyKey('wf', name))

      await update($, work, t =>
        withWorkflow(
          t,
          runId,
          () => ({ runId, name, phases: [], startedAt: now, isExactStart: true, agents: {} }),
          w => ({
            ...w,
            taskId,
            name,
            phases: meta.phases.length > 0 ? meta.phases : w.phases,
            ...(typeof r.transcriptDir === 'string' ? { transcriptDir: r.transcriptDir } : {}),
            ...(usualMs === undefined ? {} : { usualMs }),
          }),
        ),
      )
      soon($)
    } catch {
      // The run still goes on; the band shows less.
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A workflow's agent starts.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const wf = e.workflow

    try {
      if (wf === undefined || wf.runId === '' || spawned.deny !== undefined) return spawned

      const agentId = spawned.agentId

      if (agentId === undefined) return spawned

      const now = await $.clock.now()
      const runId = wf.runId

      await update($, work, t =>
        withWorkflow(
          t,
          runId,
          () => ({ runId, name: 'workflow', phases: [], startedAt: now, isExactStart: true, agents: {} }),
          w => ({ ...w, agents: { ...w.agents, [agentId]: { isDone: false } } }),
        ),
      )
      soon($)
    } catch {
      // Counted at the next start or end.
    }

    return spawned
  }).catch(($, e, next) => next(e))

  // An agent's run ends: a workflow's agent is done.
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId

    try {
      if (agentId !== undefined) {
        const t = await read($, work)

        if (t.workflows.some(w => w.agents[agentId] !== undefined)) {
          const now = await $.clock.now()

          await update($, work, t2 => ({
            ...t2,
            workflows: t2.workflows.map(w => {
              const had = w.agents[agentId]

              return had === undefined || had.isDone
                ? w
                : { ...w, agents: { ...w.agents, [agentId]: { ...had, isDone: true, doneAt: now } } }
            }),
          }))
        }

        soon($)
      }
    } catch {
      // The tick catches up.
    }

    return next(e)
  })

  // A shell command goes to the background (run_in_background, or ctrl+b).
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const ran = await next(e)

    try {
      if (ran.deny !== undefined || ran.isError === true || ran.result === undefined) return ran

      const id = (ran.result as { backgroundTaskId?: string }).backgroundTaskId

      if (typeof id !== 'string' || id === '') return ran

      const now = await $.clock.now()
      const command = typeof e.command === 'string' ? e.command : ''
      const slept = sleepMs(command)
      const before = slept === undefined ? usual(await readHistory($), historyKey('cmd', command)) : undefined
      const shell: TrackedShell =
        slept !== undefined
          ? { id, command, startedAt: now, isExactStart: true, expectedMs: slept, expectedFrom: 'command' }
          : before !== undefined
            ? { id, command, startedAt: now, isExactStart: true, expectedMs: before, expectedFrom: 'history' }
            : { id, command, startedAt: now, isExactStart: true }

      await update($, work, t =>
        t.shells.some(s => s.id === id) ? t : { ...t, shells: [...t.shells, shell] },
      )
      soon($)
    } catch {
      // Found again at the next turn's end.
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Claude stops a background task: it goes, with no ✓.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)

    try {
      const id = e.task_id ?? e.shell_id

      if (ran.deny === undefined && ran.isError !== true && typeof id === 'string') {
        await update($, work, t => dropTasks(t, new Set([id])))
        soon($)
      }
    } catch {
      // The notification ends it too.
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A background task's end reaches the session: its pill turns green if it
  // ended well, then goes; how long it took is kept for the next run.
  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.origin?.kind === 'task-notification') {
        const ended = endedTasks(e.text)

        if (ended.length > 0) {
          const now = await $.clock.now()
          const t = await read($, work)
          const durations: Array<readonly [string, number]> = []
          const done: FinishedPill[] = []

          for (const x of ended) {
            if (x.status !== 'completed') continue

            const shell = t.shells.find(s => s.id === x.id)
            const run = t.workflows.find(w => w.taskId === x.id)

            if (shell !== undefined) {
              done.push({ key: `c-${shell.id}`, name: clip(shell.command, NAME_MAX), start: shell.startedAt, at: now })

              if (shell.isExactStart && sleepMs(shell.command) === undefined) {
                durations.push([historyKey('cmd', shell.command), now - shell.startedAt])
              }
            }

            if (run !== undefined) {
              done.push({ key: `w-${run.runId}`, name: clip(run.name, NAME_MAX), start: run.startedAt, at: now })

              if (run.isExactStart) durations.push([historyKey('wf', run.name), now - run.startedAt])
            }
          }

          await update($, work, t2 => withFinished(dropTasks(t2, new Set(ended.map(x => x.id))), done, now))
          soon($)

          if (durations.length > 0) await saveDurations($, durations).catch(() => undefined)
        }
      }
    } catch {
      // classic.Stop's list settles it.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // At each turn's end the session lists what is still in flight.
  on('classic.Stop', async ($, e, next) => {
    try {
      const listed = e.background_tasks

      if (Array.isArray(listed)) {
        const now = await $.clock.now()

        await update($, work, t => reconcile(t, listed, now))
        soon($)
      }
    } catch {
      // The tracker keeps what the events said.
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
