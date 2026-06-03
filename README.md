# pi-soloterm

Optional Pi extension that exposes SoloTerm MCP features as native Pi tools.

This package is intentionally generic. It does not know about, load, or configure any skill bundle. Its job is only to let Pi use SoloTerm's MCP server for status, child agent processes, todos, and scratchpads.

## Install

```bash
pi install ~/projects/pi-soloterm
```

For live child-agent testing, install it with `pi install`; `pi -e` only affects the current parent process.

## Enable SoloTerm tools

```bash
pi --soloterm
```

Or inside Pi:

```text
/soloterm on
/soloterm off
/soloterm status
```

When active, the footer/status line shows `◫ soloterm`.

## Tools

- `solo_status` — verifies SoloTerm/Pi mode, Solo MCP state, session identity, and feature support.
- `solo_task` — spawns Solo agent panes through Solo MCP, sends prompts, waits for idle output, and optionally uses scratchpad artifacts.
- `solo_todo` — mirrors task lists to Solo todos when available and keeps a Pi fallback.
- `solo_scratchpad` — lists, reads, and writes Solo scratchpads.

## Solo setup

1. Install and run Solo from <https://soloterm.com>.
2. In Solo, open **Settings → MCP** and enable the MCP server.
3. Optional but recommended: enable Scratchpads and Todos.
4. In **Settings → Agents**, add a Generic agent tool with command:

```bash
pi
```

`solo_task` looks for an enabled Solo agent tool whose command or name is `pi`. Child Pi agents get `--soloterm` when they are Pi agents, so install this package globally with `pi install` before testing child agents.

## Troubleshooting

### `solo_status` says MCP is disabled or unavailable

Make sure Solo is running and MCP is enabled in **Settings → MCP**. If Solo uses a non-default app data directory, set `SOLOTERM_APP_DATA_DIR`. If Solo is installed somewhere unusual, set `SOLO_MCP_HELPER` to the bundled helper path.

### `solo_task` cannot find a Pi agent tool

In Solo **Settings → Agents**, add or enable a Generic agent tool with command `pi`.

## Validation

```bash
npm test
npm pack --dry-run
```

## License and attribution

MIT. See `NOTICE.md`.
