---
name: solo
description: Use when the user asks to use Solo or the Solo MCP server to spawn coding agents, manage scratchpads, inspect processes, or manage todos.
metadata:
  trigger: Responding to requests to use Solo
---

# Solo

Solo is a desktop application for managing coding agents and project-scoped coordination state. If the user asks Solo to do something, use the Solo MCP server and its enabled feature tools. Do not defer to, check, or invoke a Solo CLI.

## Pi behavior

If running under Pi, detected by `PI_CODING_AGENT=true`, use the `pi-soloterm` extension tools for Solo MCP server features:

- `solo_status` — verify SoloTerm/MCP availability, identity, and feature support.
- `solo_task` — spawn Solo-managed coding agents/processes and send them prompts.
- `solo_scratchpad` — list, read, or write Solo scratchpads.
- `solo_todo` — manage Solo todos when available, with Pi session fallback.

When a user asks to use Solo MCP in Pi, call `solo_status` first. If it reports ready/available, proceed with the relevant `solo_*` tool. Do not say Pi lacks MCP support when these tools are available; `pi-soloterm` is the bridge.

If a required `solo_*` tool is missing, tell the user to install/enable `pi-soloterm`. If `solo_status` reports Solo MCP unavailable, tell the user to run Solo and enable **Settings → MCP**.

## Non-Pi behavior

If not running under Pi, use the current harness's equivalent MCP tools. If exact tool names are unclear, inspect the MCP tool catalog rather than guessing.

## What Solo can do

The core MCP tools cover high-level project and process management:

- Select or inspect the effective Solo project, status, and stats.
- Discover local services, ports, processes, and terminal output.
- Start, stop, restart, rename, close, or send input to Solo-managed processes.
- Spawn terminals or coding agents, bind sessions, and check identity.
- Use project-scoped coordination locks and setup/support helpers.

Solo may also expose optional feature tools through the same MCP server:

- **Scratchpads:** list, read, write, rename, tag, append, clear, delete, archive, transfer, save, and load project scratchpads.
- **Todos:** create, list, read, update, tag, transfer, block/unblock, complete, lock/unlock, delete, and comment on project todos.
- **Timers:** create one-shot timers, create idle-triggered timers, cancel, pause, resume, and list timers.
- **Key-value storage:** read and write project-scoped JSON key-value data.

These feature tools are controlled by Solo settings. Scratchpads, todos, and timers usually inherit MCP server enablement unless explicitly configured; key-value tools may need to be enabled separately.

## Usage guidance

- Prefer Solo tools when the task is about Solo-managed agents, scratchpads, todos, timers, project coordination, or Solo process/output state.
- When spawning a new agent, monitor it for questions and permission requests.
- Approve requests only when they are safe and necessary.
- For parallel work, use one `solo_task` call with `tasks: [...]` when the Pi bridge is available.
