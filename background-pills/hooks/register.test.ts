import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clock, endedTasks, sleepMs, textBar } from './register'

type FakeAgent = { taskStatus: string } & Record<string, unknown>

/** The world beneath the mod: the status line, the running agents, a store, a clock. */
function harness(on: On, agents: FakeAgent[] = []) {
  const lines: Array<string | undefined> = []
  const store = new Map<string, unknown>()
  let n = 0

  on('ui.status', (_$, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('agent.list', () => ({ value: agents as never }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'pills' } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${++n}` },
  }))

  const clk = mock.clock(on, { now: 1_000_000 })

  return { clock: clk, last: () => lines[lines.length - 1], lines, store }
}

/** What the desktop band drew: each picture's words and its SVG. */
async function pictures(ui: { findAll: (q: { type: string }) => Promise<Array<{ props: unknown }>> }) {
  const svgs = await ui.findAll({ type: 'Svg' })

  return svgs.map(x => {
    const props = x.props as { alt?: unknown; source?: unknown }

    return { alt: String(props.alt), source: String(props.source) }
  })
}

const BAND = {
  plugin: 'background-pills',
  component: 'AbovePrompt',
  requestId: 'background-pills',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const HINT = {
  plugin: 'background-pills',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

/** Where a typed command comes from and shows. */
const RUN = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

function ended(id: string) {
  return {
    text: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`,
    origin: { kind: 'task-notification' },
    wait: false,
  } as const
}

test('a command that sleeps is a pill that fills, with the percent and an exact countdown', async ($, on) => {
  const h = harness(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 60 && echo done', run_in_background: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await h.clock.advance(1000)
  expect((await pictures(ui)).map(x => x.alt)).toEqual(['sleep 60 && echo done · 1% · 0:59'])

  await h.clock.advance(29_000)

  const [pill] = await pictures(ui)

  expect(pill?.alt).toBe('sleep 60 && echo done · 50% · 0:30')
  // The fill covers half the pill, the words on top.
  expect(pill?.source).toMatch(/<rect clip-path="url\(#k-c-b1\)" x="0" y="0" width="[\d.]+" height="26" fill="#d97757" fill-opacity="0.3"\/>/)
  expect(pill?.source).toContain('>50%</text>')
  // The band is on screen: the status line stays quiet.
  expect(h.lines.every(x => x === undefined)).toBe(true)

  // It ends well: green with a ✓ for a moment, then gone.
  await $.prompt.submit(ended('b1'))
  await h.clock.advance(500)
  expect((await pictures(ui)).map(x => x.alt)).toEqual(['sleep 60 && echo done · done'])
  expect((await pictures(ui))[0]?.source).toContain('>✓</text>')

  await h.clock.advance(3000)
  expect(await pictures(ui)).toEqual([])
  await ui.unmount()
})

test('a command that ran before counts down from its earlier time', async ($, on) => {
  const h = harness(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true })
  await h.clock.advance(30_000)
  await $.prompt.submit(ended('b1'))
  await h.clock.advance(1000)

  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await h.clock.advance(10_000)
  expect((await pictures(ui)).map(x => x.alt)).toEqual(['npm test · 33% · ~0:20'])
  expect(await ui.find({ type: 'Text', text: /usually 0:30/ })).toBeDefined()
  await ui.unmount()
})

test('a workflow pill: percent, estimated end, phase and agents in its detail', async ($, on) => {
  const h = harness(on)

  on('tool.call', { tool: 'Workflow' }, () => ({
    result: {
      status: 'async_launched',
      taskId: 'w1',
      runId: 'wf_1',
      workflowName: 'deliveries',
      transcriptDir: '/t/wf_1',
    },
  }))
  on('agent.spawn', (_$, e) => ({ model: 'm', agentId: e.description === 'uno' ? 'a1' : 'a2' }))
  on('fs.read', (_$, e) => ({
    value: JSON.stringify({
      workflowPhase: e.path.endsWith('agent-a2.meta.json') ? 'Review' : 'Update',
      description: 'x',
    }),
  }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))

  const SPAWN = {
    tool_use_id: 'toolu_wf',
    prompt: 'p',
    subagentType: 'workflow-subagent',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as const

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'Workflow',
    script:
      "export const meta = {\n  name: 'deliveries',\n  description: 'd',\n  phases: [{ title: 'Update', detail: 'a [b]' }, { title: 'Review' }, { title: 'Cross-check' }],\n}\nawait agent('x')",
  })
  await $.agent.spawn({ ...SPAWN, description: 'uno', workflow: { runId: 'wf_1', agentIndex: 1 } })
  await $.agent.spawn({ ...SPAWN, description: 'due', workflow: { runId: 'wf_1', agentIndex: 2 } })
  await h.clock.advance(20_000)
  await $.turn.complete({
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  })

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await h.clock.advance(2000)
  // A third done after 20 s: about 40 s more, counted from the last end.
  expect((await pictures(desk)).map(x => x.alt)).toEqual(['deliveries · 33% · ~0:38'])
  expect(
    await desk.find({ type: 'Text', text: 'phase 2 of 3: Review · 1 of 2 agents done · running for 0:22' }),
  ).toBeDefined()
  await desk.unmount()

  // The terminal has no fill: a text bar instead.
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: '▰▰▱▱▱▱' })).toBeDefined()
  await term.unmount()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await h.clock.advance(1000)

  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await pictures(after)).toEqual([])
  await after.unmount()
})

test('an agent pill: a pulsing dot, its time, what it does; green when it completes', async ($, on) => {
  const agent: FakeAgent = {
    id: 'ag1',
    description: 'Find files',
    type: 'Explore',
    status: 'running',
    kind: 'local_agent',
    taskStatus: 'running',
    label: 'Find files\nReading src/app.ts',
    startTime: 1_000_000 - 65_000,
    cwd: '/',
    tokenCount: 12_400,
    tokenSamples: [1000, 4000, 9000, 12_400],
  }
  const h = harness(on, [agent])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await h.clock.advance(1000)
  const [pill] = await pictures(ui)

  expect(pill?.alt).toBe('Find files · 1:06')
  // No known end: a dot that breathes and a light that passes.
  expect(pill?.source).toContain('<animate attributeName="opacity"')
  expect(pill?.source).toContain('<animate attributeName="x"')
  expect(await ui.find({ type: 'Text', text: 'Reading src/app.ts · 12.4k tokens' })).toBeDefined()

  agent.taskStatus = 'completed'
  await h.clock.advance(1000)
  expect((await pictures(ui)).map(x => x.alt)).toEqual(['Find files · done'])

  await h.clock.advance(3000)
  expect(await pictures(ui)).toEqual([])
  await ui.unmount()
})

test('background tasks that only wait, such as monitors, get no pill', async ($, on) => {
  const h = harness(on)

  on('classic.Stop', () => ({}))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'm1', type: 'monitor', status: 'running', description: 'live updates for artifact' },
      { id: 'm2', type: 'monitor', status: 'running', description: 'live updates for artifact' },
    ],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await h.clock.advance(4000)
  expect(await pictures(ui)).toEqual([])
  expect(h.last()).toBe(undefined)
  await ui.unmount()
})

test('pills that do not fit the row are counted in +N', async ($, on) => {
  const h = harness(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (let i = 1; i <= 6; i++) {
    await $.tool.call({ tool: 'Bash', command: `sleep ${100 + i}`, run_in_background: true })
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 60 } })

  await h.clock.advance(1000)

  const alts = (await pictures(ui)).map(x => x.alt)
  const names = alts.filter(a => a.startsWith('sleep 10'))
  const more = alts.find(a => /^\d more$/.test(a))

  expect(more).toBeDefined()
  expect(names.length + Number(String(more).split(' ')[0])).toBe(6)
  expect(names.length).toBeLessThan(6)
  await ui.unmount()
})

test('with the band collapsed, the status line says it in a few words', async ($, on) => {
  const h = harness(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 120', run_in_background: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isCollapsed: true } })

  await h.clock.advance(6000)
  expect(h.last()).toBe('sleep 120 ▱▱▱▱▱▱ 5% 1:54')

  await $.prompt.submit(ended('b1'))
  await h.clock.advance(1000)
  expect(h.last()).toBe('✓ sleep 120 done')

  await h.clock.advance(2500)
  expect(h.last()).toBe(undefined)
  await ui.unmount()
})

test('/pills below moves the row under the message box, /pills above brings it back', async ($, on) => {
  const h = harness(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 60 && echo done', run_in_background: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const hint = await $.ui.mount({ ...HINT, surface: 'desktop' })

  await h.clock.advance(1000)
  // Above by default.
  expect((await pictures(band)).map(x => x.alt)).toEqual(['sleep 60 && echo done · 1% · 0:59'])
  expect(await pictures(hint)).toEqual([])

  const moved = await $.command.run({ command: 'pills', args: 'below', ...RUN })

  expect(moved.text).toBe('Background pills now show below the message box. The choice is kept for new sessions.')
  expect(h.store.get('position')).toBe('below')

  await h.clock.advance(1000)
  expect(await pictures(band)).toEqual([])
  expect((await pictures(hint)).map(x => x.alt)).toEqual(['sleep 60 && echo done · 3% · 0:58'])
  // Under the box the pills are smaller, to fit the line.
  expect((await pictures(hint))[0]?.source).toContain('font-size:11px')
  // The pictures show the pills: the status line stays quiet.
  expect(h.last()).toBe(undefined)

  await $.command.run({ command: 'pills', args: 'above', ...RUN })
  await h.clock.advance(1000)
  expect(await pictures(hint)).toEqual([])
  expect((await pictures(band)).map(x => x.alt)).toEqual(['sleep 60 && echo done · 5% · 0:57'])

  const told = await $.command.run({ command: 'pills', args: '', ...RUN })

  expect(told.text).toBe('Background pills show above the message box. Type /pills above or /pills below to move them.')
  await band.unmount()
  await hint.unmount()
})

test('the place picked in an earlier session is kept', async ($, on) => {
  const h = harness(on)

  h.store.set('position', 'below')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 60', run_in_background: true })

  const hint = await $.ui.mount({ ...HINT, surface: 'desktop' })

  await h.clock.advance(1000)
  expect((await pictures(hint)).map(x => x.alt)).toEqual(['sleep 60 · 1% · 0:59'])
  await hint.unmount()

  // The terminal draws no pictures under the box: the status line writes the pills.
  const term = await $.ui.mount({ ...HINT, surface: 'terminal' })

  await h.clock.advance(4000)
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(h.last()).toBe('sleep 60 ▰▱▱▱▱▱ 8% 0:55')
  await term.unmount()
})

test('lengths read from commands, ends from notifications, clocks, text bars', () => {
  expect(sleepMs('Start-Sleep -Seconds 600; "prova"')).toBe(600_000)
  expect(sleepMs('Start-Sleep 5')).toBe(5000)
  expect(sleepMs('Start-Sleep -s 3')).toBe(3000)
  expect(sleepMs('Start-Sleep -Milliseconds 1500')).toBe(1500)
  expect(sleepMs('sleep 2m && ls')).toBe(120_000)
  expect(sleepMs('timeout /t 30')).toBe(30_000)
  expect(sleepMs('npm test')).toBe(undefined)

  expect(
    endedTasks(
      '<task-notification><task-id>a</task-id><status>completed</status></task-notification>' +
        '<task-notification><task-id>b</task-id><status>failed</status></task-notification>',
    ),
  ).toEqual([
    { id: 'a', status: 'completed' },
    { id: 'b', status: 'failed' },
  ])

  expect(clock(3_725_000)).toBe('1:02:05')
  expect(clock(59_001, Math.ceil)).toBe('1:00')
  expect(clock(4_999)).toBe('0:04')
  expect(textBar(0.5)).toBe('▰▰▰▱▱▱')
  expect(textBar(0)).toBe('▱▱▱▱▱▱')
})
