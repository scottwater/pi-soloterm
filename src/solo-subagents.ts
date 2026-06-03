/**
 * Solo-native task/subagent helpers for SoloTerm.
 *
 * This is intentionally smaller than pi-solo's full subagent integration. It
 * gives the SoloTerm compatibility tool enough Solo MCP functionality to
 * spawn Pi agents, send one task prompt, wait for idle, read output/artifacts,
 * and optionally close the pane.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
	extractStructuredOrTextJson,
	mcpContentToText,
	soloToolResultIsError,
	type McpToolCallResult,
	type SoloCallToolLike,
} from "./solo-mcp-client.ts";

export interface SpawnedSoloTask {
	id: string;
	name: string;
	processId: number;
	artifactScratchpadId?: number;
	artifactScratchpadName?: string;
	output?: string;
	artifactContent?: string;
	status: "completed" | "timeout" | "started" | "failed" | "no_output";
	error?: string;
}

export interface SoloTaskSpec {
	name: string;
	task: string;
	role?: string;
	agentTool?: string | number;
	model?: string;
	thinking?: string;
	maxWaitMs?: number;
	wait?: boolean;
	closeOnComplete?: boolean;
	useScratchpad?: boolean;
	piFlags?: string[];
}

interface AgentToolRecord {
	id?: number;
	name?: string;
	command?: string;
	enabled?: boolean;
	[k: string]: unknown;
}

export interface ResolvedSoloAgentTool {
	id: number;
	name?: string;
	command?: string;
	isPi: boolean;
}

function errorText(result: McpToolCallResult): string {
	return mcpContentToText(result) || "unknown Solo MCP error";
}

function safeSlug(value: string, fallback = "task", max = 48): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, max);
	return slug || fallback;
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

export function buildArtifactScratchpadName(role: string | undefined, taskName: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
	return `${safeSlug(role ?? "solo")}/${ts}-${safeSlug(taskName)}`;
}

export function buildSoloTaskPrompt(spec: SoloTaskSpec, artifact?: { name: string; id?: number }): string {
	const role = spec.role?.trim() ? `\n\n## Role\n\nYou are acting as: ${spec.role.trim()}.` : "";
	const artifactInstructions = artifact
		? `\n\n## Artifact\n\nA Solo scratchpad has been reserved for your result: "${artifact.name}"${artifact.id != null ? ` (id ${artifact.id})` : ""}. Before your final response, write a self-contained artifact/result there. If you are running in Pi with SoloTerm enabled, use solo_scratchpad with action=write and include scratchpadId${artifact.id != null ? `=${artifact.id}` : " when one is provided"}; do not use Pi's mcp gateway for Solo scratchpads. If a non-Pi harness exposes Solo MCP scratchpad tools directly, use scratchpad_write with scratchpad_id, name, and expected_revision. If neither is available, include the full artifact in your final response.`
		: "";
	return `Complete this delegated SoloTerm task.${role}${artifactInstructions}\n\n## Reporting\n\nFinish with a concise, self-contained summary. If you are blocked, say exactly what blocked you and what context you need.\n\n---\n\n${spec.task}`;
}

export function extractProcessId(result: McpToolCallResult): number | undefined {
	const data = extractStructuredOrTextJson<any>(result);
	const id = data?.process_id ?? data?.id;
	return typeof id === "number" ? id : undefined;
}

export function extractScratchpadId(result: McpToolCallResult): number | undefined {
	const data = extractStructuredOrTextJson<any>(result);
	const id = data?.scratchpad_id ?? data?.id ?? data?.scratchpad?.id;
	return typeof id === "number" ? id : undefined;
}

function extractAgentTools(result: McpToolCallResult): AgentToolRecord[] {
	const data = extractStructuredOrTextJson<any>(result);
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.tools)) return data.tools;
	return [];
}

export async function resolveSoloAgentTool(
	client: SoloCallToolLike,
	requested?: string | number,
): Promise<ResolvedSoloAgentTool> {
	const result = await client.callTool("list_agent_tools", {});
	if (soloToolResultIsError(result)) throw new Error(`list_agent_tools failed: ${errorText(result)}`);

	const enabled = extractAgentTools(result).filter((tool) => tool.enabled !== false);
	let selected: AgentToolRecord | undefined;
	if (typeof requested === "number") {
		selected = enabled.find((tool) => tool.id === requested) ?? { id: requested };
	} else if (requested?.trim()) {
		const query = requested.trim().toLowerCase();
		selected = enabled.find((tool) => String(tool.name ?? "").toLowerCase() === query);
		selected ??= enabled.find((tool) => String(tool.command ?? "").trim().toLowerCase() === query);
	}
	selected ??= enabled.find((tool) => String(tool.command ?? "").trim() === "pi");
	selected ??= enabled.find((tool) => String(tool.name ?? "").trim().toLowerCase() === "pi");

	if (typeof selected?.id !== "number") {
		throw new Error(
			"No Solo agent tool configured for Pi. In Solo Settings → Agents, add a Generic agent tool with command `pi`.",
		);
	}
	const command = String(selected.command ?? "").trim().toLowerCase();
	const name = String(selected.name ?? "").trim().toLowerCase();
	return { id: selected.id, name: selected.name, command: selected.command, isPi: command === "pi" || name === "pi" };
}

export async function resolveSoloAgentToolId(client: SoloCallToolLike, requested?: string | number): Promise<number> {
	return (await resolveSoloAgentTool(client, requested)).id;
}

export function buildPiExtraArgs(spec: SoloTaskSpec, isPiAgent: boolean): string[] {
	if (!isPiAgent) return [];
	const args = [...(spec.piFlags?.length ? spec.piFlags : ["--soloterm"] )];
	if (spec.model?.trim()) args.push("--model", spec.model.trim());
	if (spec.thinking?.trim()) args.push("--thinking", spec.thinking.trim());
	return args;
}

async function precreateScratchpad(
	client: SoloCallToolLike,
	spec: SoloTaskSpec,
): Promise<{ name: string; id?: number } | undefined> {
	if (spec.useScratchpad !== true || !client.hasTool("scratchpad_write")) return undefined;
	const name = buildArtifactScratchpadName(spec.role, spec.name);
	const content = `# ${name}\n\nReserved for SoloTerm task artifact.\n\nTask: ${spec.name}\n`;
	try {
		const result = await client.callTool("scratchpad_write", {
			name,
			content,
			tags: ["solo", "subagent", ...(spec.role ? [safeSlug(spec.role)] : [])],
		});
		if (soloToolResultIsError(result)) return { name };
		return { name, id: extractScratchpadId(result) };
	} catch {
		return { name };
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(client: SoloCallToolLike, processId: number, timeoutMs = 20_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const result = await client.callTool("get_process_status", { process_id: processId });
			const data = extractStructuredOrTextJson<any>(result);
			if (data?.agent_state?.idle === true) return;
			if (data?.status === "running") {
				// A process can report running before its PTY is ready to receive input.
				await delay(500);
				return;
			}
		} catch {
			// Keep waiting for a freshly spawned process.
		}
		await delay(300);
	}
}

async function waitForIdle(
	client: SoloCallToolLike,
	processId: number,
	maxWaitMs: number,
): Promise<"completed" | "timeout"> {
	const started = Date.now();
	let sawBusy = false;
	while (Date.now() - started < maxWaitMs) {
		try {
			const result = await client.callTool("get_process_status", { process_id: processId });
			const data = extractStructuredOrTextJson<any>(result);
			const state = data?.agent_state;
			if (state?.thinking || state?.planning || state?.idle === false) sawBusy = true;
			if (state?.idle === true && sawBusy) return "completed";
			const status = typeof data?.status === "string" ? data.status.toLowerCase() : "";
			if (status && status !== "running") return "completed";
		} catch {
			// Status failures may be transient while Solo starts the agent.
		}
		await delay(1_000);
	}
	return "timeout";
}

function normalizeCapturedOutput(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === '""') return undefined;
	return value;
}

async function readProcessOutput(client: SoloCallToolLike, processId: number): Promise<string | undefined> {
	if (!client.hasTool("get_process_output")) return undefined;
	try {
		const result = await client.callTool("get_process_output", { process_id: processId, lines: 200 });
		if (soloToolResultIsError(result)) return undefined;
		return normalizeCapturedOutput(mcpContentToText(result) || JSON.stringify(extractStructuredOrTextJson(result) ?? "", null, 2));
	} catch {
		return undefined;
	}
}

async function readScratchpadArtifact(
	client: SoloCallToolLike,
	artifact: { id?: number; name: string } | undefined,
): Promise<string | undefined> {
	if (!artifact || !client.hasTool("scratchpad_read")) return undefined;
	try {
		let id = artifact.id;
		if (id == null && client.hasTool("scratchpad_list")) {
			const listResult = await client.callTool("scratchpad_list", {});
			const listData = extractStructuredOrTextJson<any>(listResult);
			const scratchpads = Array.isArray(listData?.scratchpads) ? listData.scratchpads : Array.isArray(listData) ? listData : [];
			id = scratchpads.find((scratchpad: any) => scratchpad?.name === artifact.name)?.id;
		}
		if (typeof id !== "number") return undefined;
		const result = await client.callTool("scratchpad_read", { scratchpad_id: id, mode: "full" });
		if (soloToolResultIsError(result)) return undefined;
		const data = extractStructuredOrTextJson<any>(result);
		return data?.scratchpad?.content ?? data?.content ?? mcpContentToText(result);
	} catch {
		return undefined;
	}
}

async function closeProcess(client: SoloCallToolLike, processId: number): Promise<void> {
	if (!client.hasTool("close_process")) return;
	try {
		await client.callTool("close_process", { process_id: processId });
	} catch {
		// Best effort cleanup.
	}
}

async function sendInputWithRetry(client: SoloCallToolLike, processId: number, prompt: string): Promise<void> {
	let lastError = "unknown send_input error";
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt > 0) await delay(750 * attempt);
		try {
			const result = await client.callTool("send_input", { process_id: processId, input: prompt, submit: true });
			if (!soloToolResultIsError(result)) return;
			lastError = errorText(result);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (!/pty|input\/output|not ready|busy|starting/i.test(lastError)) break;
	}
	throw new Error(`send_input failed: ${lastError}`);
}

export async function runSoloTask(client: SoloCallToolLike, spec: SoloTaskSpec): Promise<SpawnedSoloTask> {
	for (const required of ["list_agent_tools", "send_input", "get_process_status"]) {
		if (!client.hasTool(required)) throw new Error(`Solo MCP tool '${required}' is required for solo_task.`);
	}
	if (!client.hasTool("spawn_agent")) {
		throw new Error("Solo MCP tool 'spawn_agent' is required. Update Solo and enable MCP + Agents integration.");
	}

	const artifact = await precreateScratchpad(client, spec);
	const agentTool = await resolveSoloAgentTool(client, spec.agentTool);
	const spawnResult = await client.callTool("spawn_agent", {
		agent_tool_id: agentTool.id,
		name: spec.name.slice(0, 48) || "SoloTerm task",
		include_agent_instructions: true,
		extra_args: buildPiExtraArgs(spec, agentTool.isPi),
	});
	if (soloToolResultIsError(spawnResult)) throw new Error(`spawn_agent failed: ${errorText(spawnResult)}`);
	const processId = extractProcessId(spawnResult);
	if (processId == null) throw new Error(`spawn_agent did not return process_id: ${mcpContentToText(spawnResult)}`);

	await waitForReady(client, processId);
	const prompt = buildSoloTaskPrompt(spec, artifact);
	await sendInputWithRetry(client, processId, prompt);

	const shouldWait = spec.wait !== false;
	let status: SpawnedSoloTask["status"] = shouldWait ? await waitForIdle(client, processId, spec.maxWaitMs ?? 30 * 60_000) : "started";
	const output = shouldWait ? await readProcessOutput(client, processId) : undefined;
	const artifactContent = shouldWait ? await readScratchpadArtifact(client, artifact) : undefined;
	if (shouldWait && status === "completed" && !output && !artifactContent) status = "no_output";
	if (shouldWait && spec.closeOnComplete === true) await closeProcess(client, processId);

	return {
		id: randomUUID(),
		name: spec.name,
		processId,
		artifactScratchpadName: artifact?.name,
		artifactScratchpadId: artifact?.id,
		output: output ? truncate(output, 40_000) : undefined,
		artifactContent: artifactContent ? truncate(artifactContent, 40_000) : undefined,
		status,
	};
}

export function summarizeSoloTask(result: SpawnedSoloTask): string {
	const process = result.processId > 0 ? `Solo #${result.processId}` : "not spawned";
	const title = `### ${result.name} (${result.status}, ${process})`;
	const artifact = result.artifactScratchpadName
		? `\nArtifact: ${result.artifactScratchpadName}${result.artifactScratchpadId != null ? ` (#${result.artifactScratchpadId})` : ""}`
		: "";
	const body = result.error ? `Error: ${result.error}` : result.artifactContent || result.output || "(no output captured)";
	return `${title}${artifact}\n\n${body}`;
}

export function defaultTaskName(task: string, role?: string): string {
	const firstLine = task.split("\n").find((line) => line.trim())?.trim() ?? "task";
	const prefix = role ? `${role}: ` : "";
	return `${prefix}${basename(firstLine).slice(0, 60)}`;
}
