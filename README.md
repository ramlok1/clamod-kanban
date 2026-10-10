# kanban — a live plan pane for Claude Code

A Claude Code mod that docks a kanban board beside the conversation, showing what Claude is working on:

- **Goal and progress**: the goal, one colored segment per milestone (done / in progress / pending) and the percentage.
- **Three columns**: EN CURSO, PENDIENTE, HECHO. Several milestones in progress at once are flagged as parallel, each with the agent working on it. Finished milestones fold once there are more than two.
- **Model and effort**: the model and effort of the main loop, read from every model request (not from what Claude says).
- **Agents**: every subagent with its task, type, model, effort and status (working, done, failed, stopped).

Claude fills the board through the mod's own tool, `mcp__kanban__board`, and a short system-prompt section asks it to do so for any multi-step task. Sessions that offer Claude Code's own task tools (TodoWrite, TaskCreate, TaskUpdate) are mirrored too.

The interface text is in Spanish.

## Install

From a Claude Code terminal session:

```
/plugin install kanban --marketplace ramlok1/clamod-kanban
```

Answer `y` to add the marketplace, then pick the user scope.

Or from any shell (also works for the Claude desktop app's Code tab, which loads plugins installed at the user scope):

```bash
claude plugin marketplace add ramlok1/clamod-kanban
claude plugin install kanban@clamod-kanban
```

Start a new session afterwards. If the pane does not show on its own (narrow window), run `/kanban`.

## Use

- `/kanban` opens the pane; `/kanban clear` empties the board.
- The **Limpiar** button in the pane empties it too.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

`tsc -p .` type-checks once Claude Code has loaded the mod from this folder (it writes `.claude-plugin/types/`). To try changes in a session: `claude --plugin-dir <this folder>`.
