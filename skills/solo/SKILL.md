---
name: solo
description: Use when the user asks to use Solo (MCP) to spawn coding agents, manage scratchpads or todos, inspect Solo-managed processes, or when another skill delegates its agent dispatch to Solo.
---

# Solo

Solo is a desktop application for managing coding agents and project-scoped coordination state. This integration reaches Solo through its MCP server; use the focused tools below rather than substituting CLI commands.

## Pi behavior

If running under Pi, detected by `PI_CODING_AGENT=true`, use the focused `pi-soloterm` tool surface:

- `solo_status` — verify SoloTerm/MCP availability, identity, enabled agent tools, and feature support.
- `solo_task` — spawn Solo-managed coding agents/processes and send their initial prompts. For parallel work, use one call with `tasks: [...]`.
- `solo_process` — list processes, inspect status, read output, send input, and close processes.
- `solo_scratchpad` — list, read, or write Solo scratchpads.
- `solo_todo` — track todos in authoritative Pi session state, mirrored to Solo when available; `list` shows the local state, not Solo's.

Call `solo_status` first. If it reports ready, proceed with the relevant `solo_*` tool.

This is intentionally a focused Pi surface, not the complete Solo MCP catalog. Timers, locks, project management, ports, and broader catalog operations are not currently exposed as native Pi tools. Do not work around that boundary with a generic MCP passthrough: the operation-specific tools enforce safety guards.

If a required `solo_*` tool is missing, tell the user to install or enable `pi-soloterm`. If `solo_status` reports Solo MCP unavailable, tell the user to run Solo and enable **Settings → MCP**.

## Non-Pi behavior

If not running under Pi, use the current harness's Solo MCP tools directly. Direct non-Pi MCP harnesses may independently discover optional tools from the server catalog; do not infer their availability from Pi's focused tool surface.

## Spawned agents

After spawning an agent, monitor it with `solo_process` using `action: "status"` and `action: "output"`. If its output shows a permission request or follow-up question that must be answered, use `action: "send"` with its `processId` and a non-empty `input`. Approve only requests needed to complete the assigned task. No approval is automatic.

Unless the user names a different agent, spawn workers under the same named agent tool the current process was started with; resolve it as described in the next section.

Exception for simple tasks: step down one tier instead. When the current process runs the `fable` agent, spawn simple-task workers with `sol`; when it runs `sol`, use `terra`. Simple means mechanical work with a narrow, verifiable outcome—locating a file or symbol, running a one-off command and reporting output, or fetching or summarizing a single document. Anything requiring judgment—writing or reviewing code, debugging, or multi-step research—is substantive and stays on the current process's agent tool.

## Agent dispatch for delegating skills

When another skill routes workers through Solo, confirm availability before committing: probe with `solo_status` under Pi or `whoami` with direct MCP. Tool visibility alone is not proof. Proceed only when the probe confirms this process is Solo-managed and agent spawning is available. If it fails, report that to the delegating workflow instead of dispatching.

Spawned workers must run under the same named agent tool the current process was started with, not merely the same harness. Named tools can wrap one harness with different flags, models, or arguments, while a generic default may silently select another configuration.

Under Pi, use the process id from `solo_status` with `solo_process` action `status`; match its process name and launch command to an enabled agent tool reported by `solo_status`, accepting only an exact tool-name match as authoritative. Pass that tool explicitly as `agentTool` on every `solo_task`. Do not pass separate `model` or `thinking` overrides when the selected agent tool already defines them. With direct MCP, use the equivalent agent-tool identity returned by `whoami` and pass it explicitly on every spawn. If the current process cannot be mapped unambiguously to an enabled tool, stop and ask the user which enabled agent tool to use.
