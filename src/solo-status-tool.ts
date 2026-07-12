import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { extractStructuredOrTextJson, soloToolResultIsError, type SoloMcpClient } from "./solo-mcp-client.ts";

const SoloStatusParams = Type.Object({
	refresh: Type.Optional(Type.Boolean({ description: "Reconnect/refresh Solo MCP tool metadata before reporting status. Defaults to true." })),
});

type SoloStatusArgs = Static<typeof SoloStatusParams>;

export interface SoloStatusDeps {
	client: SoloMcpClient;
	isActive: () => boolean;
}

const TASK_TOOLS = ["list_agent_tools", "spawn_agent", "send_input", "get_process_status"];
const PROCESS_TOOLS = ["list_processes", "get_process_status", "get_process_output", "close_process"];
const SCRATCHPAD_TOOLS = ["scratchpad_list", "scratchpad_read", "scratchpad_write"];
const TODO_TOOLS = ["todo_create", "todo_list", "todo_update", "todo_complete"];

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

function missing(client: SoloMcpClient, tools: readonly string[]): string[] {
	return tools.filter((tool) => !client.hasTool(tool));
}

async function listAgentTools(client: SoloMcpClient): Promise<string | undefined> {
	if (!client.hasTool("list_agent_tools")) return undefined;
	try {
		const result = await client.callTool("list_agent_tools", {});
		if (soloToolResultIsError(result)) return undefined;
		const data = extractStructuredOrTextJson<any>(result);
		const tools = Array.isArray(data?.tools) ? data.tools : Array.isArray(data) ? data : [];
		const enabled = tools.filter((tool: any) => tool?.enabled !== false).slice(0, 12);
		if (!enabled.length) return undefined;
		return enabled
			.map((tool: any) => {
				const id = tool?.id != null ? `#${tool.id}` : "#?";
				const name = String(tool?.name ?? "unnamed");
				const command = String(tool?.command ?? "").trim();
				return command ? `${id} ${name} (${command})` : `${id} ${name}`;
			})
			.join(", ");
	} catch {
		return undefined;
	}
}

export function renderSoloStatus(deps: SoloStatusDeps, agentTools?: string, refreshError?: string): string {
	const client = deps.client;
	const taskMissing = missing(client, TASK_TOOLS);
	const processMissing = missing(client, PROCESS_TOOLS);
	const scratchpadMissing = missing(client, SCRATCHPAD_TOOLS);
	const todoMissing = missing(client, TODO_TOOLS);
	const project = client.identity?.project;
	const identity = client.identity
		? [
				client.identity.process_id != null ? `process_id=${client.identity.process_id}` : undefined,
				client.identity.actor ? `actor=${client.identity.actor}` : undefined,
				project?.name ? `project=${project.name}` : undefined,
				project?.path ? `path=${project.path}` : undefined,
			]
				.filter(Boolean)
				.join(", ")
		: "not reported";

	return [
		"SoloTerm status",
		`- pi-soloterm mode: ${deps.isActive() ? "active" : "inactive"}`,
		`- Solo MCP state: ${client.state}`,
		`- Solo MCP disabled: ${yesNo(client.isMcpDisabled())}`,
		`- Solo MCP tools discovered: ${client.tools.length}`,
		`- Session identity: ${identity}`,
		client.identityError ? `- Identity diagnostic: ${client.identityError}` : undefined,
		refreshError ? `- Refresh failed: ${refreshError}` : undefined,
		client.lastError && client.lastError !== refreshError ? `- Last error: ${client.lastError}` : undefined,
		`- Subagent support: ${taskMissing.length ? `missing ${taskMissing.join(", ")}` : "available"}`,
		`- Process support: ${processMissing.length ? `missing ${processMissing.join(", ")}` : "available"}`,
		`- Scratchpad support: ${scratchpadMissing.length ? `missing ${scratchpadMissing.join(", ")}` : "available"}`,
		`- Todo support: ${todoMissing.length ? `missing ${todoMissing.join(", ")} (Pi fallback is used by solo_todo)` : "available"}`,
		agentTools ? `- Enabled agent tools: ${agentTools}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

export function registerSoloStatusTool(pi: ExtensionAPI, deps: SoloStatusDeps): void {
	pi.registerTool({
		name: "solo_status",
		label: "SoloTerm Status",
		description: "Verify that Pi is running with SoloTerm integration and report Solo MCP availability, identity, and feature support.",
		promptSnippet: "Use solo_status before SoloTerm-backed workflows to verify SoloTerm and Solo MCP availability.",
		promptGuidelines: [
			"Call solo_status before using Solo-backed subagents, todos, scratchpads, or process status.",
			"If Solo MCP is unavailable, ask the user to run inside SoloTerm and enable Solo MCP instead of improvising manual panes.",
		],
		parameters: SoloStatusParams as any,
		async execute(_toolCallId, params: SoloStatusArgs) {
			if (!deps.isActive()) {
				return { content: [{ type: "text" as const, text: "SoloTerm mode is inactive. Run /soloterm on or start Pi with --soloterm." }] };
			}
			let refreshError: string | undefined;
			try {
				if (params.refresh !== false) await deps.client.refreshTools();
			} catch (error) {
				refreshError = error instanceof Error ? error.message : String(error);
			}
			const agentTools = refreshError ? undefined : await listAgentTools(deps.client);
			return { content: [{ type: "text" as const, text: renderSoloStatus(deps, agentTools, refreshError) }] };
		},
		renderCall(_args: Record<string, any>, theme: any) {
			return new Text(`${theme.fg("accent", "◫")} ${theme.fg("toolTitle", theme.bold("solo_status"))}`, 0, 0);
		},
		renderResult(result: any, _opts: any, theme: any) {
			const text = String(result.content?.[0]?.text ?? "solo_status");
			const error = /failed|missing|disabled|inactive/i.test(text) && !/available/.test(text);
			return new Text(`${theme.fg(error ? "error" : "success", error ? "✘" : "✓")} ${theme.fg("toolTitle", theme.bold("solo_status"))}`, 0, 0);
		},
	});
}
