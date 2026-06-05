import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	extractStructuredOrTextJson,
	mcpContentToText,
	soloToolResultIsError,
	type McpToolCallResult,
	type SoloCallToolLike,
} from "./solo-mcp-client.ts";

const SoloTermProcessParams = Type.Object({
	action: Type.String({
		description:
			"Process operation: list, status, output, close, or close_subagents. close_subagents safely closes Pi --soloterm child-agent panes in the current/effective project.",
	}),
	projectId: Type.Optional(Type.Number({ description: "Solo project id. Defaults to Solo's effective/current project." })),
	processId: Type.Optional(Type.Number({ description: "Solo process id for status, output, or close." })),
	lines: Type.Optional(Type.Number({ description: "Rendered output line count for action=output. Defaults to 200." })),
	raw: Type.Optional(Type.Boolean({ description: "Use get_process_raw_output for action=output when available." })),
	includeExited: Type.Optional(Type.Boolean({ description: "Include exited/stopped processes when listing or closing subagents. Defaults to false for close_subagents." })),
	nameIncludes: Type.Optional(Type.String({ description: "Optional case-insensitive process name filter for list or close_subagents." })),
	commandIncludes: Type.Optional(Type.String({ description: "Optional case-insensitive command filter for list or close_subagents." })),
	includeAllAgents: Type.Optional(
		Type.Boolean({
			description:
				"For close_subagents, also close processes Solo explicitly reports as agents, excluding the current process. Defaults to false; Pi-spawned subagents are matched by --soloterm.",
		}),
	),
	dryRun: Type.Optional(Type.Boolean({ description: "For close_subagents, report matching processes without closing them." })),
	allowCurrent: Type.Optional(Type.Boolean({ description: "Allow action=close to close the current Pi/Solo process. Defaults to false." })),
});

type SoloTermProcessArgs = Static<typeof SoloTermProcessParams>;

export interface SoloTermProcessDeps {
	client: SoloCallToolLike;
	isActive: () => boolean;
	isClientReady: () => boolean;
}

export interface SoloProcessRecord {
	id?: number | string;
	process_id?: number | string;
	name?: string;
	project_id?: number | string;
	status?: string;
	command?: string;
	kind?: string;
	type?: string;
	pid?: number | null;
	[k: string]: unknown;
}

interface CloseResult {
	process: SoloProcessRecord;
	ok: boolean;
	error?: string;
}

function unavailable(message: string) {
	return { content: [{ type: "text" as const, text: message }], isError: true, details: { error: message } };
}

function coerceNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function currentProcessId(client: SoloCallToolLike): number | undefined {
	return coerceNumber(client.identity?.process_id ?? (client.identity as any)?.detected_process_id);
}

function effectiveProjectId(client: SoloCallToolLike, params: SoloTermProcessArgs): number | undefined {
	return params.projectId ?? coerceNumber(client.identity?.project?.id ?? (client.identity as any)?.effective_project_id);
}

function scopedArgs(projectId: number | undefined): Record<string, number> {
	return projectId == null ? {} : { project_id: projectId };
}

function processIdOf(process: SoloProcessRecord): number | undefined {
	return coerceNumber(process.process_id ?? process.id);
}

function processName(process: SoloProcessRecord): string {
	return String(process.name ?? "unnamed");
}

function processCommand(process: SoloProcessRecord): string {
	return String(process.command ?? "");
}

function processStatus(process: SoloProcessRecord): string {
	return String(process.status ?? "unknown");
}

function resultToText(result: McpToolCallResult): string {
	const structured = extractStructuredOrTextJson<any>(result);
	if (structured !== undefined) return JSON.stringify(structured, null, 2);
	return mcpContentToText(result);
}

export function extractProcesses(result: McpToolCallResult): SoloProcessRecord[] {
	const data = extractStructuredOrTextJson<any>(result);
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.processes)) return data.processes;
	if (Array.isArray(data?.items)) return data.items;
	return [];
}

function isActiveProcess(process: SoloProcessRecord): boolean {
	return !/^(exited|stopped|closed|terminated|dead)$/i.test(processStatus(process).trim());
}

function includesFilter(value: string, filter: string | undefined): boolean {
	return !filter?.trim() || value.toLowerCase().includes(filter.trim().toLowerCase());
}

function isExplicitAgent(process: SoloProcessRecord): boolean {
	const kind = String(process.kind ?? process.type ?? "").toLowerCase();
	return kind === "agent" || kind === "solo_agent" || kind.endsWith("agent");
}

function isPiSoloTermSubagent(process: SoloProcessRecord): boolean {
	const command = processCommand(process).toLowerCase();
	return /(^|\s|\/)pi(\s|$)/.test(command) && /(^|\s)--soloterm(\s|$)/.test(command);
}

export function matchesCloseSubagentFilter(
	process: SoloProcessRecord,
	params: Pick<SoloTermProcessArgs, "includeExited" | "nameIncludes" | "commandIncludes" | "includeAllAgents">,
	currentId?: number,
): boolean {
	const id = processIdOf(process);
	if (id == null) return false;
	if (currentId != null && id === currentId) return false;
	if (params.includeExited !== true && !isActiveProcess(process)) return false;
	if (!includesFilter(processName(process), params.nameIncludes)) return false;
	if (!includesFilter(processCommand(process), params.commandIncludes)) return false;
	return isPiSoloTermSubagent(process) || (params.includeAllAgents === true && isExplicitAgent(process));
}

function formatProcess(process: SoloProcessRecord): string {
	const id = processIdOf(process) ?? "?";
	const command = processCommand(process);
	const pid = process.pid == null ? "" : ` pid=${process.pid}`;
	return `#${id} [${processStatus(process)}] ${processName(process)}${pid}${command ? ` — ${command}` : ""}`;
}

function formatProcesses(processes: readonly SoloProcessRecord[], heading = "Solo processes"): string {
	if (!processes.length) return `${heading}: none`;
	return `${heading}: ${processes.length}\n${processes.map(formatProcess).join("\n")}`;
}

async function listProcesses(client: SoloCallToolLike, projectId?: number): Promise<{ result: McpToolCallResult; processes: SoloProcessRecord[] }> {
	const result = await client.callTool("list_processes", scopedArgs(projectId));
	return { result, processes: extractProcesses(result) };
}

function filterListedProcesses(processes: SoloProcessRecord[], params: SoloTermProcessArgs): SoloProcessRecord[] {
	return processes.filter((process) => {
		if (params.includeExited !== true && !isActiveProcess(process)) return false;
		if (!includesFilter(processName(process), params.nameIncludes)) return false;
		if (!includesFilter(processCommand(process), params.commandIncludes)) return false;
		return true;
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeOne(client: SoloCallToolLike, process: SoloProcessRecord, projectId?: number): Promise<CloseResult> {
	const processId = processIdOf(process);
	if (processId == null) return { process, ok: false, error: "missing process id" };
	let lastError = "unknown close_process error";
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt > 0) await delay(300 * attempt);
		try {
			const result = await client.callTool("close_process", { ...scopedArgs(projectId), process_id: processId });
			if (!soloToolResultIsError(result)) return { process, ok: true };
			lastError = mcpContentToText(result) || "close_process returned an error";
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (!/database is locked|busy|locked|timeout/i.test(lastError)) break;
	}
	return { process, ok: false, error: lastError };
}

function summarizeCloseResults(targets: SoloProcessRecord[], results: CloseResult[], remaining?: SoloProcessRecord[]): string {
	const closed = results.filter((result) => result.ok);
	const failed = results.filter((result) => !result.ok);
	const sections = [`Closed ${closed.length}/${targets.length} Solo subagent process${targets.length === 1 ? "" : "es"}.`];
	if (closed.length) sections.push(`Closed:\n${closed.map((result) => `- ${formatProcess(result.process)}`).join("\n")}`);
	if (failed.length) sections.push(`Failed:\n${failed.map((result) => `- ${formatProcess(result.process)}: ${result.error ?? "unknown error"}`).join("\n")}`);
	if (remaining) sections.push(formatProcesses(remaining, "Remaining matching Solo subagents"));
	return sections.join("\n\n");
}

export function registerSoloTermProcessTool(pi: ExtensionAPI, deps: SoloTermProcessDeps): void {
	pi.registerTool({
		name: "solo_process",
		label: "SoloTerm Process",
		description:
			"List, inspect, read output from, or close Solo-managed processes. Includes a safe close_subagents action for Pi-spawned SoloTerm subagent panes.",
		promptSnippet: "Manage SoloTerm/Solo MCP processes: list, status, output, close, or close_subagents.",
		promptGuidelines: [
			"Use solo_process when asked to inspect, read output from, stop, close, or clean up existing Solo-managed processes.",
			"Use action=close_subagents to close Pi-spawned SoloTerm child agents; it excludes the current process and defaults to --soloterm child panes only.",
			"Call solo_status first if SoloTerm/MCP readiness has not already been checked.",
		],
		parameters: SoloTermProcessParams as any,
		async execute(_toolCallId, params: SoloTermProcessArgs) {
			if (!deps.isActive()) return unavailable("SoloTerm mode is not active. Run /soloterm on or start Pi with --soloterm.");
			if (!deps.isClientReady()) return unavailable("Solo MCP is not ready or enabled.");

			const action = String(params.action ?? "list").trim().toLowerCase().replace(/-/g, "_");
			const projectId = effectiveProjectId(deps.client, params);
			const has = (name: string) => deps.client.hasTool(name);
			try {
				if (action === "list") {
					if (!has("list_processes")) return unavailable("Solo list_processes MCP tool is not available.");
					const { result, processes } = await listProcesses(deps.client, projectId);
					if (soloToolResultIsError(result)) return unavailable(resultToText(result) || "list_processes failed.");
					const filtered = filterListedProcesses(processes, params);
					return { content: [{ type: "text" as const, text: formatProcesses(filtered) }], details: { projectId, processes: filtered } };
				}

				if (action === "status") {
					if (!has("get_process_status")) return unavailable("Solo get_process_status MCP tool is not available.");
					if (params.processId == null) return unavailable("solo_process status requires processId.");
					const result = await deps.client.callTool("get_process_status", { ...scopedArgs(projectId), process_id: params.processId });
					return { content: [{ type: "text" as const, text: resultToText(result) }], isError: soloToolResultIsError(result), details: { result } };
				}

				if (action === "output") {
					const tool = params.raw === true && has("get_process_raw_output") ? "get_process_raw_output" : "get_process_output";
					if (!has(tool)) return unavailable(`Solo ${tool} MCP tool is not available.`);
					if (params.processId == null) return unavailable("solo_process output requires processId.");
					const result = await deps.client.callTool(tool, { ...scopedArgs(projectId), process_id: params.processId, lines: params.lines ?? 200 });
					return { content: [{ type: "text" as const, text: mcpContentToText(result) || resultToText(result) }], isError: soloToolResultIsError(result), details: { result } };
				}

				if (action === "close") {
					if (!has("close_process")) return unavailable("Solo close_process MCP tool is not available.");
					if (params.processId == null) return unavailable("solo_process close requires processId.");
					const currentId = currentProcessId(deps.client);
					if (params.allowCurrent !== true && currentId != null && params.processId === currentId) {
						return unavailable("Refusing to close the current Solo/Pi process. Pass allowCurrent=true only if you really intend to close this session.");
					}
					const process = { id: params.processId, name: `process ${params.processId}` };
					const result = await closeOne(deps.client, process, projectId);
					return {
						content: [{ type: "text" as const, text: result.ok ? `Closed Solo process #${params.processId}.` : `Failed to close Solo process #${params.processId}: ${result.error}` }],
						isError: !result.ok,
						details: { projectId, result },
					};
				}

				if (action === "close_subagents" || action === "close_subagent") {
					if (!has("list_processes")) return unavailable("Solo list_processes MCP tool is not available.");
					if (!has("close_process")) return unavailable("Solo close_process MCP tool is not available.");
					const currentId = currentProcessId(deps.client);
					const { result, processes } = await listProcesses(deps.client, projectId);
					if (soloToolResultIsError(result)) return unavailable(resultToText(result) || "list_processes failed.");
					const targets = processes.filter((process) => matchesCloseSubagentFilter(process, params, currentId));
					if (params.dryRun === true) {
						return { content: [{ type: "text" as const, text: formatProcesses(targets, "Matching Solo subagents (dry run)") }], details: { projectId, targets, dryRun: true } };
					}
					const results: CloseResult[] = [];
					for (const target of targets) results.push(await closeOne(deps.client, target, projectId));
					const after = await listProcesses(deps.client, projectId).catch(() => undefined);
					const remaining = after?.processes.filter((process) => matchesCloseSubagentFilter(process, params, currentId));
					const failed = results.some((closeResult) => !closeResult.ok);
					return {
						content: [{ type: "text" as const, text: summarizeCloseResults(targets, results, remaining) }],
						isError: failed,
						details: { projectId, closed: results.filter((closeResult) => closeResult.ok).map((closeResult) => processIdOf(closeResult.process)), failed: results.filter((closeResult) => !closeResult.ok), remaining },
					};
				}

				return unavailable(`Unknown solo_process action: ${action || "(empty)"}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return unavailable(`solo_process failed: ${message}`);
			}
		},
		renderCall(args: Record<string, unknown>, theme: any) {
			return new Text(`${theme.fg("accent", "◫")} ${theme.fg("toolTitle", theme.bold("solo_process"))} ${theme.fg("accent", String(args.action ?? "list"))}`, 0, 0);
		},
		renderResult(result: any, _opts: any, theme: any) {
			const icon = result.isError ? theme.fg("error", "✘") : theme.fg("success", "✓");
			const first = String(result.content?.[0]?.text ?? "").split("\n").find((line) => line.trim()) ?? "solo_process";
			return new Text(`${icon} ${theme.fg("toolTitle", theme.bold("solo_process"))} ${theme.fg(result.isError ? "error" : "dim", first.slice(0, 160))}`, 0, 0);
		},
	});
}

export const __test__ = { extractProcesses, matchesCloseSubagentFilter };
