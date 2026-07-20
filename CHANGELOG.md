# Changelog

## 0.2.0 - 2026-07-20

- Fix `/soloterm on` and `/soloterm off` to reload Pi resources through Pi's supported command API; the toggle previously failed at the reload step.
- Report SoloTerm tool failures as genuine Pi tool errors, so failed operations are recorded as failed tool calls instead of appearing successful.
- Update Solo task waits so fast-finishing child agents complete promptly instead of waiting out the full task timeout, and terminal child states (crashed, exited) are reported with their real status.
- Update Solo task waits to tolerate transient status failures: observation blips are retried under a bounded budget, and a sustained outage fails the task while leaving the child pane open instead of closing possibly in-progress work.
- Add cancellation support across SoloTerm tools: aborting `solo_task` interrupts polling, retries, and serialized MCP requests, cleans up already-spawned workers within bounded timeouts, and reports orphan risk when cleanup cannot be confirmed.
- Add a `send` action to `solo_process` so a parent agent can monitor running Solo processes and answer their questions or approval prompts.
- Update Solo todo mirroring to reconcile instead of duplicate: Pi session todos stay authoritative with stable IDs, Solo bindings persist across updates and completions, and mirror failures surface as warnings. `list` shows the local authoritative state.
- Update destructive process operations to require project and session identity (or explicit overrides) and to verify closures with bounded polling before reporting success.
- Update Solo MCP lifecycle recovery: SoloTerm can be disabled and re-enabled without restarting Pi, transport failures invalidate stale capabilities, interrupted startups cannot leak state into reconnects, and session startup no longer blocks on MCP warm-up.
- Add a strict TypeScript type-check gate to `npm test` and align development dependencies with Pi 0.80.6, resolving API and result-shape drift exposed by the compiler.
- Update the bundled `solo` skill to describe the focused Pi tool surface accurately, including agent monitoring guidance and removal of unsupported acceptance, timer, and full-catalog claims.

## 0.1.1 - 2026-06-09

- Rename the npm package to `pi-solo-term-tools` for the first public publish.
- Update Solo task guardrails so `model: "pi"` fails with a clear message instead of passing `--model pi` to a child Pi process. Use `agentTool: "pi"` to choose the Pi agent.
- Add Solo process management for listing, reading, and closing Pi-spawned subagent panes from Pi.
- Add fallback Solo skill discovery so Pi sessions expose Solo guidance when no other Solo skill is installed.

## 0.1.0 - 2026-06-09

- Add SoloTerm mode for Pi sessions, with native tools for Solo status, task dispatch, process inspection, todos, and scratchpads.
- Spawn Pi child agents through Solo MCP, pass `--soloterm` to those children, and capture their output for parent sessions.
- Package Solo guidance, setup notes, and validation commands with the extension.
