---
name: solo
description: Use when the user asks to use Solo (MCP) to spawn coding agents, manage scratchpads, todos, or timers, to inspect Solo-managed processes, or when another skill delegates its agent dispatch to Solo.
---

# Solo

Solo is a desktop application for managing coding agents and project-scoped coordination state. It is reached only through its MCP server — there is no Solo CLI.

## Pi behavior

If running under Pi, detected by `PI_CODING_AGENT=true`, use the `pi-soloterm` extension tools for Solo MCP server features:

- `solo_status` — verify SoloTerm/MCP availability, identity, and feature support.
- `solo_task` — spawn Solo-managed coding agents/processes and send them prompts. For parallel work, use one call with `tasks: [...]`.
- `solo_scratchpad` — list, read, or write Solo scratchpads.
- `solo_todo` — manage Solo todos when available, with Pi session fallback.

Call `solo_status` first. If it reports ready, proceed with the relevant `solo_*` tool — these tools are full Solo MCP support under Pi; `pi-soloterm` is the bridge.

If a required `solo_*` tool is missing, tell the user to install/enable `pi-soloterm`. If `solo_status` reports Solo MCP unavailable, tell the user to run Solo and enable **Settings → MCP**.

## Non-Pi behavior

If not running under Pi, use the current harness's Solo MCP tools directly. If exact tool names are unclear, inspect the MCP tool catalog.

## Feature tools

Beyond core project/process management, Solo exposes optional feature tools — scratchpads, todos, timers, and key-value storage — gated by Solo settings. Scratchpads, todos, and timers usually inherit MCP server enablement; key-value tools may need to be enabled separately. Discover the exact tools from the MCP catalog.

## Spawned agents

When spawning a new agent, monitor it for questions and permission requests; approve only requests needed to complete the prompt you gave it.

Unless the user names a different agent, spawn workers under the same named agent tool the current process was started with — resolve it as described in the next section.

Exception for simple tasks: step down one tier instead. When the current process runs the `fable` agent, spawn simple-task workers with `sol`; when it runs `sol`, use `terra`. Simple means mechanical work with a narrow, verifiable outcome — locating a file or symbol, running a one-off command and reporting output, fetching or summarizing a single document. Anything requiring judgment — writing or reviewing code, debugging, multi-step research — is substantive and stays on the current process's agent tool.

## Agent dispatch for delegating skills

When another skill (such as a review quorum) routes its worker agents through Solo, confirm availability before committing: probe with `solo_status` (Pi) or `whoami` (direct MCP). Tool visibility alone is not proof — proceed only when the probe confirms this process is Solo-managed with agent spawning available. If the probe fails or spawning is unavailable, report that to the delegating workflow instead of dispatching.

Spawned workers must run under the same named agent tool the current process was started with — not merely the same harness. Several named agent tools can wrap one harness while setting different configuration flags, models, or arguments, and the generic default resolves only by harness type, so relying on it can silently dispatch workers to a different agent.

Resolve the current process's configured agent tool before dispatch. Under Pi, use the process id from `solo_status` with `solo_process status`; match its process name and launch command to an enabled agent tool reported by `solo_status`, accepting only an exact tool-name match as authoritative. Pass that tool explicitly as `agentTool` on every `solo_task`. Do not pass separate `model` or `thinking` overrides when the selected agent tool already defines them. With direct MCP, use the equivalent agent-tool identity returned by `whoami` and pass it explicitly on every spawn. If the current process cannot be mapped unambiguously to an enabled tool, stop and ask the user which enabled agent tool to use.

When the delegating skill supplies its own acceptance layer, disable Solo acceptance gates by passing `acceptance: "none"` on each `solo_task`.
