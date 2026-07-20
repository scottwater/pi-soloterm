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
			"Process operation: list, status, output, send, close, or close_subagents. close_subagents safely closes Pi --soloterm child-agent panes in the current/effective project.",
	}),
	projectId: Type.Optional(Type.Number({ description: "Solo project id. Defaults to Solo's effective/current project." })),
	processId: Type.Optional(Type.Number({ description: "Solo process id for status, output, send, or close." })),
	input: Type.Optional(Type.String({ description: "Non-empty input to send for action=send. Sent with submit semantics." })),
	message: Type.Optional(Type.String({ description: "Alias for input when action=send." })),
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
	allowCurrent: Type.Optional(Type.Boolean({ description: "Allow close to target the current process, or explicitly waive current-session protection when identity is unavailable. Defaults to false." })),
});

type SoloTermProcessArgs = Static<typeof SoloTermProcessParams>;

export interface SoloProcessRuntime {
	delay: (ms: number, signal?: AbortSignal) => Promise<void>;
	verificationPollMs: number;
	verificationAttempts: number;
	closeRetryPollMs: number;
}

export interface SoloTermProcessDeps {
	client: SoloCallToolLike;
	isActive: () => boolean;
	isClientReady: () => boolean;
	runtime?: SoloProcessRuntime;
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

function unavailable(message: string): never {
	throw new Error(message);
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

function destructiveScopeError(client: SoloCallToolLike, params: SoloTermProcessArgs, requireCurrentIdentity = true): string | undefined {
	const missing: string[] = [];
	if (effectiveProjectId(client, params) == null) missing.push("project identity (pass projectId explicitly)");
	if (requireCurrentIdentity && currentProcessId(client) == null && params.allowCurrent !== true) missing.push("current-process identity (pass allowCurrent=true to explicitly waive this protection)");
	if (!missing.length) return undefined;
	const diagnostic = client.identityError ? ` Identity diagnostic: ${client.identityError}.` : " Run solo_status for identity diagnostics.";
	return `Refusing destructive process operation without ${missing.join(" and ")}.${diagnostic}`;
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

function cancellationError(signal: AbortSignal): Error {
	const reason = signal.reason instanceof Error ? signal.reason.message : signal.reason == null ? "operation aborted" : String(signal.reason);
	const error = new Error(`solo_process cancelled: ${reason}`);
	error.name = "AbortError";
	return error;
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancellationError(signal);
}

async function callToolAbortable(client: SoloCallToolLike, name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
	throwIfCancelled(signal);
	const request = Promise.resolve().then(() => signal
		? client.callTool(name, args, signal)
		: client.callTool(name, args));
	if (!signal) return request;
	return new Promise((resolve, reject) => {
		let finished = false;
		const abort = () => {
			if (finished) return;
			finished = true;
			reject(cancellationError(signal));
		};
		signal.addEventListener("abort", abort, { once: true });
		request.then(
			(result) => {
				if (finished) return;
				finished = true;
				signal.removeEventListener("abort", abort);
				resolve(result);
			},
			(error) => {
				if (finished) return;
				finished = true;
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

async function listProcesses(client: SoloCallToolLike, projectId?: number, signal?: AbortSignal): Promise<{ result: McpToolCallResult; processes: SoloProcessRecord[] }> {
	const result = await callToolAbortable(client, "list_processes", scopedArgs(projectId), signal);
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

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfCancelled(signal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(finish, ms);
		function finish(): void {
			signal?.removeEventListener("abort", abort);
			resolve();
		}
		function abort(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(cancellationError(signal!));
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

const DEFAULT_PROCESS_RUNTIME: SoloProcessRuntime = {
	delay: abortableDelay,
	verificationPollMs: 150,
	verificationAttempts: 5,
	closeRetryPollMs: 300,
};

async function closeOne(
	client: SoloCallToolLike,
	process: SoloProcessRecord,
	projectId: number | undefined,
	signal: AbortSignal | undefined,
	runtime: SoloProcessRuntime,
): Promise<CloseResult> {
	const processId = processIdOf(process);
	if (processId == null) return { process, ok: false, error: "missing process id" };
	let lastError = "unknown close_process error";
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt > 0) await runtime.delay(runtime.closeRetryPollMs * attempt, signal);
		try {
			const result = await callToolAbortable(client, "close_process", { ...scopedArgs(projectId), process_id: processId }, signal);
			if (!soloToolResultIsError(result)) return { process, ok: true };
			lastError = mcpContentToText(result) || "close_process returned an error";
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (!/database is locked|busy|locked|timeout/i.test(lastError)) break;
	}
	return { process, ok: false, error: lastError };
}

type CloseVerification =
	| { status: "verified"; remaining: SoloProcessRecord[] }
	| { status: "transport_failed"; error: string }
	| { status: "still_active"; remaining: SoloProcessRecord[] };

async function verifyClosed(
	client: SoloCallToolLike,
	projectId: number | undefined,
	isTarget: (process: SoloProcessRecord) => boolean,
	signal: AbortSignal | undefined,
	runtime: SoloProcessRuntime,
): Promise<CloseVerification> {
	const attempts = Math.max(1, runtime.verificationAttempts);
	for (let attempt = 0; attempt < attempts; attempt++) {
		throwIfCancelled(signal);
		try {
			const listed = await listProcesses(client, projectId, signal);
			if (soloToolResultIsError(listed.result)) {
				return { status: "transport_failed", error: resultToText(listed.result) || "list_processes failed" };
			}
			const remaining = listed.processes.filter((process) => isTarget(process) && isActiveProcess(process));
			if (!remaining.length) return { status: "verified", remaining: [] };
			if (attempt === attempts - 1) return { status: "still_active", remaining };
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			return { status: "transport_failed", error: error instanceof Error ? error.message : String(error) };
		}
		await runtime.delay(runtime.verificationPollMs, signal);
	}
	return { status: "verified", remaining: [] };
}

function summarizeCloseResults(targets: SoloProcessRecord[], results: CloseResult[], verification: CloseVerification): string {
	const requested = results.filter((result) => result.ok);
	const failed = results.filter((result) => !result.ok);
	const sections = [`Close requests succeeded for ${requested.length}/${targets.length} Solo subagent process${targets.length === 1 ? "" : "es"}.`];
	if (requested.length) sections.push(`Close requested:\n${requested.map((result) => `- ${formatProcess(result.process)}`).join("\n")}`);
	if (failed.length) sections.push(`Close request failed:\n${failed.map((result) => `- ${formatProcess(result.process)}: ${result.error ?? "unknown error"}`).join("\n")}`);
	if (verification.status === "verified") sections.push("Verified closed: all successful close requests are no longer active.");
	if (verification.status === "transport_failed") sections.push(`Verification transport failed after successful close request(s): ${verification.error}`);
	if (verification.status === "still_active") sections.push(formatProcesses(verification.remaining, "Still active after verification grace"));
	return sections.join("\n\n");
}

export function registerSoloTermProcessTool(pi: ExtensionAPI, deps: SoloTermProcessDeps): void {
	pi.registerTool<typeof SoloTermProcessParams, Record<string, unknown>>({
		name: "solo_process",
		label: "SoloTerm Process",
		description:
			"List, inspect, read output from, send input to, or close Solo-managed processes. Includes a safe close_subagents action for Pi-spawned SoloTerm subagent panes.",
		promptSnippet: "Manage SoloTerm/Solo MCP processes: list, status, output, send, close, or close_subagents.",
		promptGuidelines: [
			"Use solo_process when asked to inspect, read output from, send input to, stop, close, or clean up existing Solo-managed processes.",
			"Monitor spawned agents with action=status and action=output. Use action=send with processId and non-empty input when an agent requires an answer or approval.",
			"Use action=close_subagents to close Pi-spawned SoloTerm child agents; it excludes the current process and defaults to --soloterm child panes only.",
			"Call solo_status first if SoloTerm/MCP readiness has not already been checked.",
		],
		parameters: SoloTermProcessParams,
		async execute(_toolCallId, params: SoloTermProcessArgs, signal: AbortSignal | undefined) {
			if (!deps.isActive()) return unavailable("SoloTerm mode is not active. Run /soloterm on or start Pi with --soloterm.");
			if (!deps.isClientReady()) return unavailable("Solo MCP is not ready or enabled.");

			const action = String(params.action ?? "list").trim().toLowerCase().replace(/-/g, "_");
			const projectId = effectiveProjectId(deps.client, params);
			const runtime = deps.runtime ?? DEFAULT_PROCESS_RUNTIME;
			const has = (name: string) => deps.client.hasTool(name) || deps.client.canAttemptTool?.(name) === true;
			try {
				if (action === "list") {
					if (!has("list_processes")) return unavailable("Solo list_processes MCP tool is not available.");
					const { result, processes } = await listProcesses(deps.client, projectId, signal);
					if (soloToolResultIsError(result)) return unavailable(resultToText(result) || "list_processes failed.");
					const filtered = filterListedProcesses(processes, params);
					return { content: [{ type: "text" as const, text: formatProcesses(filtered) }], details: { projectId, processes: filtered } };
				}

				if (action === "status") {
					if (!has("get_process_status")) return unavailable("Solo get_process_status MCP tool is not available.");
					if (params.processId == null) return unavailable("solo_process status requires processId.");
					const result = await callToolAbortable(deps.client, "get_process_status", { ...scopedArgs(projectId), process_id: params.processId }, signal);
					const text = resultToText(result);
					if (soloToolResultIsError(result)) throw new Error(text || "get_process_status failed.");
					return { content: [{ type: "text" as const, text }], details: { result } };
				}

				if (action === "output") {
					const tool = params.raw === true && has("get_process_raw_output") ? "get_process_raw_output" : "get_process_output";
					if (!has(tool)) return unavailable(`Solo ${tool} MCP tool is not available.`);
					if (params.processId == null) return unavailable("solo_process output requires processId.");
					const result = await callToolAbortable(deps.client, tool, { ...scopedArgs(projectId), process_id: params.processId, lines: params.lines ?? 200 }, signal);
					const text = mcpContentToText(result) || resultToText(result);
					if (soloToolResultIsError(result)) throw new Error(text || `${tool} failed.`);
					return { content: [{ type: "text" as const, text }], details: { result } };
				}

				if (action === "send") {
					if (!has("send_input")) return unavailable("Solo send_input MCP tool is not available.");
					if (params.processId == null) return unavailable("solo_process send requires processId.");
					const input = [params.input, params.message].find((value) => typeof value === "string" && value.trim().length > 0);
					if (input == null) return unavailable("solo_process send requires non-empty input or message.");
					const result = await callToolAbortable(deps.client, "send_input", { process_id: params.processId, input, submit: true }, signal);
					const text = resultToText(result);
					if (soloToolResultIsError(result)) throw new Error(text || "send_input failed.");
					return {
						content: [{ type: "text" as const, text: `Sent input to Solo process #${params.processId}.` }],
						details: { result },
					};
				}

				if (action === "close") {
					if (!has("close_process")) return unavailable("Solo close_process MCP tool is not available.");
					if (params.processId == null) return unavailable("solo_process close requires processId.");
					const scopeError = destructiveScopeError(deps.client, params);
					if (scopeError) return unavailable(scopeError);
					const currentId = currentProcessId(deps.client);
					if (params.allowCurrent !== true && currentId != null && params.processId === currentId) {
						return unavailable("Refusing to close the current Solo/Pi process. Pass allowCurrent=true only if you really intend to close this session.");
					}
					const process = { id: params.processId, name: `process ${params.processId}` };
					const result = await closeOne(deps.client, process, projectId, signal, runtime);
					if (!result.ok) throw new Error(`Close request failed for Solo process #${params.processId}: ${result.error ?? "unknown close error"}`);
					if (!has("list_processes")) {
						return {
							content: [{ type: "text" as const, text: `Close request succeeded for Solo process #${params.processId}; verification unavailable.` }],
							details: { projectId, result, verification: undefined },
						};
					}
					const verification = await verifyClosed(
						deps.client,
						projectId,
						(item) => processIdOf(item) === params.processId,
						signal,
						runtime,
					);
					if (verification.status === "transport_failed") {
						throw new Error(`Close request succeeded for Solo process #${params.processId}, but verification transport failed: ${verification.error}`);
					}
					if (verification.status === "still_active") {
						throw new Error(`Close request succeeded for Solo process #${params.processId}, but the process is still active after verification grace.`);
					}
					return {
						content: [{ type: "text" as const, text: `Closed and verified Solo process #${params.processId}.` }],
						details: { projectId, result, verification },
					};
				}

				if (action === "close_subagents" || action === "close_subagent") {
					if (!has("list_processes")) return unavailable("Solo list_processes MCP tool is not available.");
					if (!has("close_process")) return unavailable("Solo close_process MCP tool is not available.");
					const scopeError = destructiveScopeError(deps.client, params, params.dryRun !== true);
					if (scopeError) return unavailable(scopeError);
					const currentId = currentProcessId(deps.client);
					const { result, processes } = await listProcesses(deps.client, projectId, signal);
					if (soloToolResultIsError(result)) return unavailable(resultToText(result) || "list_processes failed.");
					const targets = processes.filter((process) => matchesCloseSubagentFilter(process, params, currentId));
					if (params.dryRun === true) {
						return { content: [{ type: "text" as const, text: formatProcesses(targets, "Matching Solo subagents (dry run)") }], details: { projectId, targets, dryRun: true } };
					}
					const results: CloseResult[] = [];
					for (const target of targets) results.push(await closeOne(deps.client, target, projectId, signal, runtime));
					const requestedIds = new Set(results.filter((closeResult) => closeResult.ok).map((closeResult) => processIdOf(closeResult.process)));
					const verification: CloseVerification = requestedIds.size === 0
						? { status: "verified", remaining: [] }
						: await verifyClosed(
							deps.client,
							projectId,
							(process) => requestedIds.has(processIdOf(process)),
							signal,
							runtime,
						);
					const failed = results.some((closeResult) => !closeResult.ok) || verification.status !== "verified";
					const summary = summarizeCloseResults(targets, results, verification);
					if (failed) throw new Error(summary);
					return {
						content: [{ type: "text" as const, text: summary }],
						details: {
							projectId,
							closed: results.filter((closeResult) => closeResult.ok).map((closeResult) => processIdOf(closeResult.process)),
							failed: results.filter((closeResult) => !closeResult.ok).map((closeResult) => ({ processId: processIdOf(closeResult.process), error: closeResult.error })),
							remaining: [],
							verification,
						},
					};
				}

				return unavailable(`Unknown solo_process action: ${action || "(empty)"}`);
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw error;
				const message = error instanceof Error ? error.message : String(error);
				return unavailable(`solo_process failed: ${message}`);
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("accent", "◫")} ${theme.fg("toolTitle", theme.bold("solo_process"))} ${theme.fg("accent", String(args.action ?? "list"))}`, 0, 0);
		},
		renderResult(result, _opts, theme, context) {
			const icon = context.isError ? theme.fg("error", "✘") : theme.fg("success", "✓");
			const content = result.content[0];
			const text = content?.type === "text" ? content.text : "";
			const first = text.split("\n").find((line) => line.trim()) ?? "solo_process";
			return new Text(`${icon} ${theme.fg("toolTitle", theme.bold("solo_process"))} ${theme.fg(context.isError ? "error" : "dim", first.slice(0, 160))}`, 0, 0);
		},
	});
}

export const __test__ = { extractProcesses, matchesCloseSubagentFilter };
