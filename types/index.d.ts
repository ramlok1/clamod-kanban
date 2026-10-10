export type KanbanStatus = 'pending' | 'in_progress' | 'completed'

export type KanbanTask = { id: string; title: string; status: KanbanStatus; agent?: string }

export type KanbanBoard = { goal: string; tasks: KanbanTask[]; updatedAt: number }

/** The model and effort a loop's latest request was sent with. */
export type KanbanLoop = { model: string; effort?: string }

/** One subagent of the session, as the pane lists it. */
export type KanbanAgent = {
  id: string
  description: string
  type: string
  status: string
  model?: string
  effort?: string
  startedAt: number
}

export type KanbanRuntime = { main?: KanbanLoop; agents: KanbanAgent[] }

declare module 'claude-code' {
  interface PluginState {
    kanban: { board: KanbanBoard; runtime: KanbanRuntime; showDone: boolean }
  }
}
