import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { KanbanAgent, KanbanBoard, KanbanRuntime, KanbanStatus, KanbanTask } from '../types'

const PANE = 'kanban'
const TITLE = 'Kanban'
const TOOL = 'mcp__kanban__board'
const WIDE = 72
const POLL_MS = 3000
const MAX_AGENT_ROWS = 10
const ACTIVE_AGENT = ['pending', 'running', 'waiting', 'idle']

const EMPTY: KanbanBoard = { goal: '', tasks: [], updatedAt: 0 }
const NO_RUNTIME: KanbanRuntime = { agents: [] }
const board = atom({ plugin: 'kanban', key: 'board' } as const, EMPTY)
const runtime = atom({ plugin: 'kanban', key: 'runtime' } as const, NO_RUNTIME)
const showDone = atom({ plugin: 'kanban', key: 'showDone' } as const, false)

const COLUMNS: { status: KanbanStatus; label: string; mark: string; color: string }[] = [
  { status: 'in_progress', label: 'EN CURSO', mark: '▸', color: 'warning' },
  { status: 'pending', label: 'PENDIENTE', mark: '○', color: 'subtle' },
  { status: 'completed', label: 'HECHO', mark: '✓', color: 'success' },
]

const STATUSES: readonly KanbanStatus[] = ['pending', 'in_progress', 'completed']

const STATUS_LOOK: Record<KanbanStatus, { mark: string; color: string }> = {
  pending: { mark: '○', color: 'subtle' },
  in_progress: { mark: '▸', color: 'warning' },
  completed: { mark: '✓', color: 'success' },
}

const AGENT_MARKS: Record<string, { mark: string; color: string; label: string }> = {
  pending: { mark: '◌', color: 'subtle', label: 'en cola' },
  running: { mark: '●', color: 'warning', label: 'trabajando' },
  waiting: { mark: '◐', color: 'warning', label: 'esperando' },
  idle: { mark: '◐', color: 'subtle', label: 'inactivo' },
  completed: { mark: '✓', color: 'success', label: 'terminado' },
  failed: { mark: '✗', color: 'error', label: 'falló' },
  killed: { mark: '■', color: 'error', label: 'detenido' },
}

const GUIDANCE = [
  '# Kanban board',
  `A kanban pane beside the conversation shows the person your plan and progress. For any task that takes more than a couple of steps, call ${TOOL} before you start working, with the goal and its milestones (3 to 8, short titles, in order): the one you are starting is in_progress, the rest pending.`,
  `Call ${TOOL} again each time a milestone finishes or the plan changes, always sending the full list. Keep one milestone in_progress while you work alone; when milestones really run at the same time (subagents you launched, background work), mark each of them in_progress and set its \`agent\` to who is doing it (the subagent's type or name). Mark every milestone completed when the goal is met. Skip the board for one-shot answers and quick questions. Write the goal and titles in the language you are using with the person.`,
  'The pane shows your model, effort and running subagents by itself; never report them through the board.',
].join('\n')

function toStatus(value: unknown): KanbanStatus {
  return STATUSES.includes(value as KanbanStatus) ? (value as KanbanStatus) : 'pending'
}

function parseTasks(raw: unknown): KanbanTask[] {
  if (!Array.isArray(raw)) return []

  return raw
    .filter(item => item && typeof item === 'object' && typeof item.title === 'string' && item.title.trim())
    .slice(0, 50)
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : String(index + 1),
      title: item.title.trim(),
      status: toStatus(item.status),
      ...(typeof item.agent === 'string' && item.agent.trim() ? { agent: item.agent.trim() } : {}),
    }))
}

function progressBar(done: number, total: number, width: number): string {
  if (total === 0) return ''
  const filled = Math.round((done / total) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-4-5-20250929` → `Sonnet 4.5`, `haiku` → `Haiku`. */
function prettyModel(id: string): string {
  const bare = id.replace(/\[.*\]$/, '')
  const match = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(bare)
  const name = match?.[1] ?? bare
  const label = name.charAt(0).toUpperCase() + name.slice(1)
  if (!match) return label

  return `${label} ${match[2]}${match[3] ? `.${match[3]}` : ''}`
}

function effortText(effort: string | number | undefined): string | undefined {
  if (effort === undefined) return undefined

  return typeof effort === 'number' ? `${effort} tok` : effort
}

/** Finished agents are kept for a while, newest first, behind every active one. */
function trimAgents(agents: KanbanAgent[]): KanbanAgent[] {
  const active = agents.filter(agent => ACTIVE_AGENT.includes(agent.status))
  const finished = agents.filter(agent => !ACTIVE_AGENT.includes(agent.status))

  return [...active, ...finished.slice(-Math.max(0, MAX_AGENT_ROWS - active.length))]
}

// Best effort: a board update must never fail because the pane could not open.
async function showPane($: EngineInterface) {
  try {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (!isUp) await $.ui.open({ id: PANE, title: TITLE })
  } catch {
    // No surface to draw on (headless run, tests): the board state is kept anyway.
  }
}

/** Records the model and effort of a loop's request, writing only on a change. */
async function noteStep($: EngineInterface, agentId: string | undefined, model: string, rawEffort: string | number | undefined) {
  const effort = effortText(rawEffort)
  const now = await read($, runtime)
  if (agentId === undefined) {
    if (now.main?.model === model && now.main?.effort === effort) return
    await update($, runtime, previous => ({ ...previous, main: { model, effort } }))

    return
  }
  const known = now.agents.find(agent => agent.id === agentId)
  if (known?.model === model && known?.effort === effort) return
  await update($, runtime, previous => ({
    ...previous,
    agents: known
      ? previous.agents.map(agent => (agent.id === agentId ? { ...agent, model, effort } : agent))
      : trimAgents([
          ...previous.agents,
          { id: agentId, description: 'subagente', type: '', status: 'running', model, effort, startedAt: Date.now() },
        ]),
  }))
}

/** Folds the engine's agent list into the pane's rows; an agent it dropped has ended. */
async function syncAgents($: EngineInterface) {
  const listed = await $.agent.list()
  const now = await read($, runtime)
  const byId = new Map(listed.map(info => [info.id, info]))
  const next = now.agents.map(agent => {
    const info = byId.get(agent.id)
    if (info) return { ...agent, status: info.status, description: info.description || agent.description, type: info.type || agent.type }

    return ACTIVE_AGENT.includes(agent.status) ? { ...agent, status: 'completed' } : agent
  })
  for (const info of listed) {
    if (!next.some(agent => agent.id === info.id)) {
      next.push({ id: info.id, description: info.description, type: info.type, status: info.status, startedAt: Date.now() })
    }
  }
  if (JSON.stringify(next) === JSON.stringify(now.agents)) return
  await update($, runtime, previous => ({ ...previous, agents: trimAgents(next) }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'board',
      description:
        'Updates the kanban pane the person sees beside the conversation. Send the goal and the FULL ordered list of milestones every time; the list replaces the previous one. Status is pending, in_progress or completed. Several milestones may be in_progress only when they run in parallel; tag those with `agent`.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The goal the milestones lead to, one short line.' },
          tasks: {
            type: 'array',
            description: 'Every milestone, in order.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable id, e.g. "1", "2".' },
                title: { type: 'string', description: 'Short milestone title.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                agent: { type: 'string', description: 'Who works on it when not you alone: a subagent type or name.' },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'kanban',
      description: 'Open the kanban pane (add "clear" to empty the board)',
    })
    $.clock.every(POLL_MS, () => {
      syncAgents($).catch(() => {})
    })
    void showPane($)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL) || e.traits.includes('bare')) return composed

    return {
      sections: [...composed.sections, { id: 'kanban:guidance', text: GUIDANCE, scope: 'session' as const }],
    }
  })

  on('command.run', { command: 'kanban' }, async ($, e) => {
    if (String(e.args ?? '').trim() === 'clear') {
      await update($, board, () => EMPTY)
      await update($, runtime, previous => ({ ...previous, agents: previous.agents.filter(agent => ACTIVE_AGENT.includes(agent.status)) }))

      return { text: 'Kanban board cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Kanban pane opened.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as { goal?: unknown; tasks?: unknown }
    const tasks = parseTasks(input.tasks)
    await update($, board, previous => ({
      goal: typeof input.goal === 'string' && input.goal.trim() ? input.goal.trim() : previous.goal,
      tasks,
      updatedAt: Date.now(),
    }))
    void showPane($)
    const done = tasks.filter(task => task.status === 'completed').length

    return { result: `Board updated: ${done}/${tasks.length} completed.` }
  })

  // Every model request, main's or a subagent's: the model and effort it is sent with.
  on('turn.step', async function* ($, e, next) {
    await noteStep($, e.agentId, e.model, e.effort).catch(() => {})

    return yield* next(e)
  })

  // A subagent the model (or a plugin) starts: its task, type and resolved model.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if ('agentId' in spawned && spawned.agentId) {
      const row: KanbanAgent = {
        id: spawned.agentId,
        description: e.description || 'subagente',
        type: e.subagentType,
        status: 'running',
        model: spawned.model,
        startedAt: Date.now(),
      }
      await update($, runtime, previous => ({
        ...previous,
        agents: trimAgents([...previous.agents.filter(agent => agent.id !== row.id), row]),
      }))
      void showPane($)
    }

    return spawned
  }).catch(($, e, next) => next(e))

  // Mirror Claude Code's own task tools too, for sessions that offer them.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    const todos = parseTasks(
      (e.todos ?? []).map((todo, index) => ({ id: String(index + 1), title: todo.content, status: todo.status })),
    )
    await update($, board, previous => ({ ...previous, tasks: todos, updatedAt: Date.now() }))
    void showPane($)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const created = ran.isError || ran.deny !== undefined ? undefined : (ran.result as { task?: { id?: string } })?.task
    if (created?.id) {
      const task: KanbanTask = { id: created.id, title: e.subject, status: 'pending' }
      await update($, board, previous => ({ ...previous, tasks: [...previous.tasks, task], updatedAt: Date.now() }))
      void showPane($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError || ran.deny !== undefined) return ran
    const { taskId, status, subject, owner } = e
    await update($, board, previous => ({
      ...previous,
      tasks:
        status === 'deleted'
          ? previous.tasks.filter(task => task.id !== taskId)
          : previous.tasks.map(task =>
              task.id === taskId
                ? {
                    ...task,
                    title: subject ?? task.title,
                    status: status ? toStatus(status) : task.status,
                    ...(owner ? { agent: owner } : {}),
                  }
                : task,
            ),
      updatedAt: Date.now(),
    }))

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { goal, tasks } = await read($, board)
    const { main, agents } = await read($, runtime)
    const isShowingDone = await read($, showDone)
    const width = e.props.bodyColumns
    const done = tasks.filter(task => task.status === 'completed').length
    const activeAgents = agents.filter(agent => ACTIVE_AGENT.includes(agent.status)).length
    const percent = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100)
    const isWide = width >= WIDE

    const divider = <Text dimColor>{'─'.repeat(Math.max(4, width))}</Text>

    const sectionTitle = (label: string, color: string, count?: string) => (
      <Text>
        <Text bold color={color}>
          {label}
        </Text>
        {count !== undefined && <Text dimColor> {count}</Text>}
      </Text>
    )

    // One segment per milestone, colored by its status: the whole plan at a glance.
    const segments = (
      <Text wrap="truncate-end">
        {tasks.slice(0, Math.max(4, width - 14)).map(task => (
          <Text key={task.id} color={STATUS_LOOK[task.status].color}>
            {task.status === 'pending' ? '▱' : '▰'}
          </Text>
        ))}
        <Text bold> {percent}%</Text>
        <Text dimColor>
          {' '}
          · {done}/{tasks.length}
        </Text>
      </Text>
    )

    const runtimeLine = main && (
      <Text wrap="truncate-end">
        <Text color="claude">◆ </Text>
        <Text bold>{prettyModel(main.model)}</Text>
        {main.effort !== undefined && <Text dimColor>{'  ·  effort '}</Text>}
        {main.effort !== undefined && <Text color="claude">{main.effort}</Text>}
      </Text>
    )

    const header = (
      <Box flexDirection="column">
        {goal !== '' ? (
          <Text bold wrap="wrap">
            {goal}
          </Text>
        ) : (
          <Text bold>Plan de trabajo</Text>
        )}
        {tasks.length > 0 && segments}
        {runtimeLine}
      </Box>
    )

    const agentNote = (task: KanbanTask) =>
      task.agent !== undefined && task.status !== 'completed' && <Text dimColor>{`  ↳ ${task.agent}`}</Text>

    const doneToggle = (count: number) => (
      <Button
        key="toggle-done"
        label={`✓ ${count} ${count === 1 ? 'hito hecho' : 'hitos hechos'} ${isShowingDone ? '(ocultar)' : '(ver)'}`}
        plain
        dimColor
        onPress={() => update($, showDone, isShown => !isShown)}
      />
    )

    // Kanban: one framed column per status, side by side when the pane is wide.
    const columns = () => (
      <Box flexDirection={isWide ? 'row' : 'column'} columnGap={1} rowGap={1}>
        {COLUMNS.map(spec => {
          const items = tasks.filter(task => task.status === spec.status)
          const isFolded = spec.status === 'completed' && items.length > 2 && !isShowingDone

          return (
            <Box
              key={spec.status}
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              width={isWide ? '33%' : undefined}
              borderStyle="round"
              borderColor={spec.status === 'in_progress' && items.length > 0 ? 'warning' : 'subtle'}
              paddingX={1}
            >
              {sectionTitle(
                spec.label,
                spec.color,
                spec.status === 'in_progress' && items.length > 1 ? `${items.length} · paralelo` : String(items.length),
              )}
              {items.length === 0 && <Text dimColor>—</Text>}
              {isFolded
                ? doneToggle(items.length)
                : items.map(task => (
                    <Box key={task.id} flexDirection="column">
                      <Text wrap="wrap" bold={spec.status === 'in_progress'} dimColor={spec.status === 'completed'}>
                        <Text color={spec.color}>{spec.mark}</Text> {task.title}
                      </Text>
                      {agentNote(task)}
                    </Box>
                  ))}
              {spec.status === 'completed' && items.length > 2 && isShowingDone && doneToggle(items.length)}
            </Box>
          )
        })}
      </Box>
    )

    const agentsBlock = agents.length > 0 && (
      <Box flexDirection="column">
        {sectionTitle(
          'AGENTES',
          'suggestion',
          activeAgents > 0 ? `· ${activeAgents} ${activeAgents === 1 ? 'activo' : 'activos'}` : '· sin actividad',
        )}
        {agents.map(agent => {
          const look = AGENT_MARKS[agent.status] ?? { mark: '·', color: 'subtle', label: agent.status }
          const details = [agent.type, agent.model && prettyModel(agent.model), agent.effort].filter(Boolean).join(' · ')
          const isActive = ACTIVE_AGENT.includes(agent.status)

          return (
            <Box key={agent.id} flexDirection="column" paddingLeft={1}>
              <Text wrap="wrap" bold={isActive} dimColor={!isActive}>
                <Text color={look.color}>{look.mark}</Text> {agent.description}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {details !== '' ? `${details} · ` : ''}
                <Text color={isActive ? look.color : undefined}>{look.label}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    )

    const footer = (
      <Box flexDirection="row" columnGap={2}>
        <Button key="clear" label="Limpiar" plain dimColor onPress={() => update($, board, () => EMPTY)} />
      </Box>
    )

    if (tasks.length === 0) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {header}
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text bold>◇ Sin plan activo</Text>
            <Text dimColor wrap="wrap">
              Cuando Claude empiece un trabajo de varios pasos, sus hitos aparecerán aquí.
            </Text>
          </Box>
          {agentsBlock}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {header}
        {divider}
        {columns()}
        {agentsBlock && divider}
        {agentsBlock}
        {divider}
        {footer}
      </Box>
    )
  })
}
