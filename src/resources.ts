const SOLOTERM_PROMPT = `
<SOLOTERM>
You are running Pi with the pi-soloterm extension enabled.

SoloTerm tool mapping:
- Environment/status check -> solo_status
- Solo-backed subagent dispatch -> solo_task
- Multiple parallel Solo-backed tasks -> one solo_task call with tasks: [...]
- Existing Solo process list/status/output/input/close -> solo_process
- Solo todos / task tracking -> solo_todo
- Solo scratchpads / artifacts -> solo_scratchpad

Use solo_status before relying on Solo-backed delegation, process management, todos, or scratchpads. Monitor spawned agents with solo_process status/output and use action=send only when they require input or approval. If the user asks to use the Solo MCP server, use these focused tools; do not claim Pi has no MCP access. Timers, locks, projects, ports, and broader catalog operations are not exposed as native Pi tools. If Solo MCP is unavailable, explain that Solo must be running with MCP enabled instead of improvising manual panes.
</SOLOTERM>
`.trim();

export function buildSoloTermSystemPrompt(current: string, active: boolean): string {
	return active ? `${current}\n\n${SOLOTERM_PROMPT}` : current;
}
