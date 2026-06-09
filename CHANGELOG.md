# Changelog

## 0.1.1 - 2026-06-09

- Update Solo task guardrails so `model: "pi"` fails with a clear message instead of passing `--model pi` to a child Pi process. Use `agentTool: "pi"` to choose the Pi agent.
- Add Solo process management for listing, reading, and closing Pi-spawned subagent panes from Pi.
- Add fallback Solo skill discovery so Pi sessions expose Solo guidance when no other Solo skill is installed.

## 0.1.0 - 2026-06-09

- Add SoloTerm mode for Pi sessions, with native tools for Solo status, task dispatch, process inspection, todos, and scratchpads.
- Spawn Pi child agents through Solo MCP, pass `--soloterm` to those children, and capture their output for parent sessions.
- Package Solo guidance, setup notes, and validation commands with the extension.
