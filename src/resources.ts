const SOLOTERM_PROMPT = `
<SOLOTERM>
You are running Pi with the pi-soloterm extension enabled.

SoloTerm tool mapping:
- Environment/status check -> solo_status
- Solo-backed subagent dispatch -> solo_task
- Multiple parallel Solo-backed tasks -> one solo_task call with tasks: [...]
- Existing Solo process list/status/output/close -> solo_process
- Solo todos / task tracking -> solo_todo
- Solo scratchpads / artifacts -> solo_scratchpad

Use solo_status before relying on Solo-backed delegation, process management, todos, or scratchpads. If the user asks to use the Solo MCP server, use these tools; do not claim Pi has no MCP access. If Solo MCP is unavailable, explain that Solo must be running with MCP enabled instead of improvising manual panes.
</SOLOTERM>
`.trim();

export function buildSoloTermSystemPrompt(current: string, active: boolean): string {
	return active ? `${current}\n\n${SOLOTERM_PROMPT}` : current;
}
