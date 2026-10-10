import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__kanban__board'
const SURFACES = ['terminal', 'desktop'] as const

const PANE = (bodyColumns: number) =>
  ({
    plugin: 'kanban',
    component: 'Pane',
    requestId: 'kanban',
    props: {
      title: 'Kanban',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const PLAN = {
  tool: TOOL,
  goal: 'Publicar la landing',
  tasks: [
    { id: '1', title: 'Redactar copy', status: 'completed' },
    { id: '2', title: 'Armar layout', status: 'in_progress' },
    { id: '3', title: 'Subir al hosting', status: 'pending' },
  ],
} as const

test('the board tool fills the pane, on every surface that docks it', async $ => {
  const ran = await $.tool.call(PLAN)
  expect(ran.deny).toBeUndefined()
  expect(String(ran.result)).toContain('1/3')

  for (const surface of SURFACES) {
    for (const width of [40, 90]) {
      const ui = await $.ui.mount({ ...PANE(width), surface })
      expect(await ui.find({ type: 'Text', text: /Publicar la landing/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /33%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /▸ Armar layout/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Subir al hosting/ })).toBeDefined()
      await ui.unmount()
    }
  }

  const ui = await $.ui.mount({ ...PANE(40), surface: 'desktop' })
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /Sin plan activo/ })).toBeDefined()
  await ui.unmount()
})

test('the milestones are laid out in the three kanban columns', async $ => {
  await $.tool.call(PLAN)
  for (const surface of SURFACES) {
    for (const width of [40, 90]) {
      const ui = await $.ui.mount({ ...PANE(width), surface })
      expect(await ui.find({ type: 'Text', text: /EN CURSO/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /PENDIENTE/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /HECHO/ })).toBeDefined()
      expect(await ui.find({ key: 'view-line' })).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('finished milestones fold once there are several, and unfold on a press', async $ => {
  await $.tool.call({
    tool: TOOL,
    goal: 'Meta A',
    tasks: [
      { title: 'Uno', status: 'completed' },
      { title: 'Dos', status: 'completed' },
      { title: 'Tres', status: 'completed' },
      { title: 'Cuatro', status: 'in_progress' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE(40), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Uno/ })).toBeUndefined()
  expect(await ui.find({ key: 'toggle-done' })).toBeDefined()
  await ui.press({ key: 'toggle-done' })
  expect(await ui.find({ type: 'Text', text: /Uno/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /75%/ })).toBeDefined()
  await ui.unmount()
})

test('a new list keeps the goal; parallel milestones carry who works on them', async $ => {
  await $.tool.call({ tool: TOOL, goal: 'Auditoría', tasks: [{ title: 'Uno', status: 'in_progress' }] })
  await $.tool.call({
    tool: TOOL,
    tasks: [
      { title: 'Revisar web', status: 'in_progress', agent: 'Explore' },
      { title: 'Revisar CRM', status: 'in_progress', agent: 'brain-explorer' },
      { title: 'Informe', status: 'pending' },
    ],
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(40), surface })
    expect(await ui.find({ type: 'Text', text: /Auditoría/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 · paralelo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ brain-explorer/ })).toBeDefined()
    await ui.unmount()
  }
})
