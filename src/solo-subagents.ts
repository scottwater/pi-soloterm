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

export type SoloTaskStatus =
	| "completed"
	| "timeout"
	| "started"
	| "failed"
	| "no_output"
	| "exited"
	| "crashed"
	| "stopped"
	| "closed"
	| "terminated"
	| "dead";

export interface SpawnedSoloTask {
	id: string;
	name: string;
	processId: number;
	artifactScratchpadId?: number;
	artifactScratchpadName?: string;
	output?: string;
	artifactContent?: string;
	status: SoloTaskStatus;
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
	signal?: AbortSignal,
): Promise<ResolvedSoloAgentTool> {
	const result = await callToolAbortable(client, "list_agent_tools", {}, signal);
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
	const model = spec.model?.trim();
	if (model?.toLowerCase() === "pi") {
		throw new Error('model: "pi" selects a model pattern, not the Pi agent tool. Use agentTool: "pi" to choose the Pi agent.');
	}
	const args = [...(spec.piFlags?.length ? spec.piFlags : ["--soloterm"] )];
	if (model) args.push("--model", model);
	if (spec.thinking?.trim()) args.push("--thinking", spec.thinking.trim());
	return args;
}

async function precreateScratchpad(
	client: SoloCallToolLike,
	spec: SoloTaskSpec,
	signal: AbortSignal | undefined,
): Promise<{ name: string; id?: number } | undefined> {
	if (spec.useScratchpad !== true || !client.hasTool("scratchpad_write")) return undefined;
	const name = buildArtifactScratchpadName(spec.role, spec.name);
	const content = `# ${name}\n\nReserved for SoloTerm task artifact.\n\nTask: ${spec.name}\n`;
	try {
		const result = await callToolAbortable(client, "scratchpad_write", {
			name,
			content,
			tags: ["solo", "subagent", ...(spec.role ? [safeSlug(spec.role)] : [])],
		}, signal);
		if (soloToolResultIsError(result)) return { name };
		return { name, id: extractScratchpadId(result) };
	} catch {
		return { name };
	}
}

export interface SoloTaskRuntime {
	now: () => number;
	delay: (ms: number, signal?: AbortSignal) => Promise<void>;
	readyPollMs: number;
	idlePollMs: number;
	idleGraceMs: number;
	idleConsecutive: number;
	readyTransientErrorLimit: number;
	cleanupTimeoutMs: number;
}

function cancellationError(signal: AbortSignal): Error {
	const reason = signal.reason instanceof Error ? signal.reason.message : signal.reason == null ? "operation aborted" : String(signal.reason);
	const error = new Error(`solo_task cancelled: ${reason}`);
	error.name = "AbortError";
	return error;
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancellationError(signal);
}

function awaitRequestCancellation(
	request: Promise<McpToolCallResult>,
	signal?: AbortSignal,
): Promise<McpToolCallResult> {
	throwIfCancelled(signal);
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

function callToolAbortable(
	client: SoloCallToolLike,
	name: string,
	args: unknown,
	signal?: AbortSignal,
): Promise<McpToolCallResult> {
	throwIfCancelled(signal);
	return awaitRequestCancellation(Promise.resolve().then(() => client.callTool(name, args, signal)), signal);
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

const DEFAULT_TASK_RUNTIME: SoloTaskRuntime = {
	now: Date.now,
	delay: abortableDelay,
	readyPollMs: 300,
	idlePollMs: 250,
	idleGraceMs: 1_500,
	idleConsecutive: 2,
	readyTransientErrorLimit: 3,
	cleanupTimeoutMs: 500,
};

function isClearlyTransientReadinessError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /temporar|timeout|timed out|connection|transport|not ready|starting|busy|pty|input\/output/i.test(message);
}

async function waitForReady(
	client: SoloCallToolLike,
	processId: number,
	signal: AbortSignal | undefined,
	runtime: SoloTaskRuntime,
	timeoutMs = 20_000,
): Promise<void> {
	const started = runtime.now();
	let transientErrors = 0;
	while (runtime.now() - started < timeoutMs) {
		throwIfCancelled(signal);
		try {
			const result = await callToolAbortable(client, "get_process_status", { process_id: processId }, signal);
			throwIfCancelled(signal);
			if (soloToolResultIsError(result)) {
				const message = `get_process_status failed: ${errorText(result)}`;
				if (!isClearlyTransientReadinessError(message) || ++transientErrors > runtime.readyTransientErrorLimit) {
					throw new Error(message);
				}
				await runtime.delay(runtime.readyPollMs, signal);
				continue;
			}
			const data = extractStructuredOrTextJson<any>(result);
			if (data?.agent_state?.idle === true) return;
			if (data?.status === "running") {
				// A process can report running before its PTY is ready to receive input.
				await runtime.delay(runtime.readyPollMs, signal);
				return;
			}
			transientErrors = 0;
		} catch (error) {
			throwIfCancelled(signal);
			if (!isClearlyTransientReadinessError(error) || ++transientErrors > runtime.readyTransientErrorLimit) throw error;
		}
		await runtime.delay(runtime.readyPollMs, signal);
	}
	throw new Error(`Solo process #${processId} was not ready after ${timeoutMs}ms.`);
}

interface ProcessCompletion {
	status: SoloTaskStatus;
	error?: string;
}

const FAILURE_PROCESS_STATUSES = new Set<SoloTaskStatus>([
	"failed",
	"exited",
	"crashed",
	"stopped",
	"closed",
	"terminated",
	"dead",
]);

export function classifyTerminalProcessStatus(value: unknown): ProcessCompletion | undefined {
	if (typeof value !== "string") return undefined;
	const status = value.trim().toLowerCase();
	if (!status || status === "running") return undefined;
	if (status === "completed" || status === "complete" || status === "succeeded" || status === "success") {
		return { status: "completed" };
	}
	if (FAILURE_PROCESS_STATUSES.has(status as SoloTaskStatus)) {
		return {
			status: status as SoloTaskStatus,
			error: `Solo process entered terminal status "${status}".`,
		};
	}
	return {
		status: "failed",
		error: `Solo process entered unrecognized terminal status "${status}".`,
	};
}

async function waitForIdle(
	client: SoloCallToolLike,
	processId: number,
	maxWaitMs: number,
	signal: AbortSignal | undefined,
	runtime: SoloTaskRuntime,
): Promise<ProcessCompletion> {
	const started = runtime.now();
	let sawBusy = false;
	let idleSince: number | undefined;
	let consecutiveIdle = 0;
	while (runtime.now() - started < maxWaitMs) {
		throwIfCancelled(signal);
		const result = await callToolAbortable(client, "get_process_status", { process_id: processId }, signal);
		throwIfCancelled(signal);
		if (soloToolResultIsError(result)) throw new Error(`get_process_status failed: ${errorText(result)}`);
		const data = extractStructuredOrTextJson<any>(result);
		const state = data?.agent_state;
		if (state?.thinking || state?.planning || state?.idle === false) {
			sawBusy = true;
			idleSince = undefined;
			consecutiveIdle = 0;
		}
		const completion = classifyTerminalProcessStatus(data?.status);
		if (completion) return completion;
		if (state?.idle === true) {
			idleSince ??= runtime.now();
			consecutiveIdle += 1;
			const stableWithoutBusy = runtime.now() - idleSince >= runtime.idleGraceMs
				&& consecutiveIdle >= runtime.idleConsecutive;
			if (sawBusy || stableWithoutBusy) return { status: "completed" };
		} else if (!sawBusy) {
			idleSince = undefined;
			consecutiveIdle = 0;
		}
		await runtime.delay(runtime.idlePollMs, signal);
	}
	return { status: "timeout" };
}

function normalizeCapturedOutput(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === '""') return undefined;
	return value;
}

async function readProcessOutput(client: SoloCallToolLike, processId: number, signal?: AbortSignal): Promise<string | undefined> {
	if (!client.hasTool("get_process_output")) return undefined;
	try {
		const result = await callToolAbortable(client, "get_process_output", { process_id: processId, lines: 200 }, signal);
		if (soloToolResultIsError(result)) return undefined;
		return normalizeCapturedOutput(mcpContentToText(result) || JSON.stringify(extractStructuredOrTextJson(result) ?? "", null, 2));
	} catch {
		throwIfCancelled(signal);
		return undefined;
	}
}

async function readScratchpadArtifact(
	client: SoloCallToolLike,
	artifact: { id?: number; name: string } | undefined,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!artifact || !client.hasTool("scratchpad_read")) return undefined;
	try {
		let id = artifact.id;
		if (id == null && client.hasTool("scratchpad_list")) {
			const listResult = await callToolAbortable(client, "scratchpad_list", {}, signal);
			const listData = extractStructuredOrTextJson<any>(listResult);
			const scratchpads = Array.isArray(listData?.scratchpads) ? listData.scratchpads : Array.isArray(listData) ? listData : [];
			id = scratchpads.find((scratchpad: any) => scratchpad?.name === artifact.name)?.id;
		}
		if (typeof id !== "number") return undefined;
		const result = await callToolAbortable(client, "scratchpad_read", { scratchpad_id: id, mode: "full" }, signal);
		if (soloToolResultIsError(result)) return undefined;
		const data = extractStructuredOrTextJson<any>(result);
		return data?.scratchpad?.content ?? data?.content ?? mcpContentToText(result);
	} catch {
		throwIfCancelled(signal);
		return undefined;
	}
}

export interface CleanupOutcome {
	cleaned: boolean;
	diagnostic: string;
}

const cleanupQueues = new WeakMap<SoloCallToolLike, Promise<void>>();

function enqueueCleanup<T>(client: SoloCallToolLike, operation: () => Promise<T>): Promise<T> {
	const previous = cleanupQueues.get(client) ?? Promise.resolve();
	const current = previous.catch(() => {}).then(operation);
	cleanupQueues.set(client, current.then(() => {}, () => {}));
	return current;
}

export async function cleanupSoloProcess(
	client: SoloCallToolLike,
	processId: number,
	timeoutMs = DEFAULT_TASK_RUNTIME.cleanupTimeoutMs,
): Promise<CleanupOutcome> {
	if (!client.hasTool("close_process") && client.canAttemptTool?.("close_process") !== true) {
		return { cleaned: false, diagnostic: `cleanup unavailable; Solo process #${processId} remains open (orphan risk)` };
	}
	return enqueueCleanup(client, async () => {
		// Start this timeout only after this cleanup owns the per-client execution
		// slot. Time spent behind an earlier cleanup does not consume its window.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		try {
			const request = Promise.resolve().then(() => client.callTool("close_process", { process_id: processId }, controller.signal));
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort(new Error(`cleanup timed out after ${timeoutMs}ms`));
					reject(new Error(`cleanup timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			});
			const result = await Promise.race([request, timeout]);
			if (soloToolResultIsError(result)) {
				return { cleaned: false, diagnostic: `cleanup failed for Solo process #${processId}: ${errorText(result)} (orphan risk)` };
			}
			return { cleaned: true, diagnostic: `cleaned up Solo process #${processId}` };
		} catch (error) {
			return {
				cleaned: false,
				diagnostic: `cleanup failed for Solo process #${processId}: ${error instanceof Error ? error.message : String(error)} (orphan risk)`,
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	});
}

async function sendInputWithRetry(
	client: SoloCallToolLike,
	processId: number,
	prompt: string,
	signal: AbortSignal | undefined,
	runtime: SoloTaskRuntime,
): Promise<void> {
	let lastError = "unknown send_input error";
	for (let attempt = 0; attempt < 4; attempt++) {
		throwIfCancelled(signal);
		if (attempt > 0) await runtime.delay(750 * attempt, signal);
		throwIfCancelled(signal);
		try {
			const result = await callToolAbortable(client, "send_input", { process_id: processId, input: prompt, submit: true }, signal);
			throwIfCancelled(signal);
			if (!soloToolResultIsError(result)) return;
			lastError = errorText(result);
		} catch (error) {
			throwIfCancelled(signal);
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (!/pty|input\/output|not ready|busy|starting/i.test(lastError)) break;
	}
	throw new Error(`send_input failed: ${lastError}`);
}

export async function runSoloTask(
	client: SoloCallToolLike,
	spec: SoloTaskSpec,
	signal?: AbortSignal,
	runtime: SoloTaskRuntime = DEFAULT_TASK_RUNTIME,
): Promise<SpawnedSoloTask> {
	throwIfCancelled(signal);
	// This authoritative call lazily finishes startup/catalog loading before
	// hasTool checks, including when session warm-up is still in progress.
	const agentTool = await resolveSoloAgentTool(client, spec.agentTool, signal);
	for (const required of ["list_agent_tools", "send_input", "get_process_status"]) {
		if (!client.hasTool(required)) throw new Error(`Solo MCP tool '${required}' is required for solo_task.`);
	}
	if (!client.hasTool("spawn_agent")) {
		throw new Error("Solo MCP tool 'spawn_agent' is required. Update Solo and enable MCP + Agents integration.");
	}

	const artifact = await precreateScratchpad(client, spec, signal);
	throwIfCancelled(signal);
	const spawnArgs = {
		agent_tool_id: agentTool.id,
		name: spec.name.slice(0, 48) || "SoloTerm task",
		include_agent_instructions: true,
		extra_args: buildPiExtraArgs(spec, agentTool.isPi),
	};
	const spawnRequest = Promise.resolve().then(() => client.callTool("spawn_agent", spawnArgs, signal));
	let spawnResult: McpToolCallResult;
	try {
		spawnResult = await awaitRequestCancellation(spawnRequest, signal);
	} catch (error) {
		if (!signal?.aborted) throw error;
		// callToolAbortable owns a separate request only for legacy/fake clients, so
		// observe the original request for one bounded window where an identity may
		// still arrive. Real SoloMcpClient cancellation rejects it immediately.
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const late = await Promise.race([
			spawnRequest.then((result) => ({ result }), () => ({})),
			new Promise<{}>((resolve) => {
				graceTimer = setTimeout(() => resolve({}), runtime.cleanupTimeoutMs);
			}),
		]);
		if (graceTimer) clearTimeout(graceTimer);
		const lateResult = "result" in late ? late.result : undefined;
		const lateProcessId = lateResult && !soloToolResultIsError(lateResult) ? extractProcessId(lateResult) : undefined;
		const cancelled = cancellationError(signal);
		if (lateProcessId != null) {
			const cleanup = await cleanupSoloProcess(client, lateProcessId, runtime.cleanupTimeoutMs);
			cancelled.message += `; late spawn returned Solo process #${lateProcessId}; ${cleanup.diagnostic}`;
		} else {
			cancelled.message += "; spawn outcome is unknown because no process_id arrived before transport invalidation (orphan risk)";
		}
		throw cancelled;
	}
	if (soloToolResultIsError(spawnResult)) throw new Error(`spawn_agent failed: ${errorText(spawnResult)}`);
	const processId = extractProcessId(spawnResult);
	if (processId == null) throw new Error(`spawn_agent did not return process_id: ${mcpContentToText(spawnResult)}`);

	let cleanupOutcome: CleanupOutcome | undefined;
	try {
		throwIfCancelled(signal);
		await waitForReady(client, processId, signal, runtime);
		const prompt = buildSoloTaskPrompt(spec, artifact);
		await sendInputWithRetry(client, processId, prompt, signal, runtime);

		const shouldWait = spec.wait !== false;
		const completion: ProcessCompletion = shouldWait
			? await waitForIdle(client, processId, spec.maxWaitMs ?? 30 * 60_000, signal, runtime)
			: { status: "started" };
		let status = completion.status;
		throwIfCancelled(signal);
		const output = shouldWait ? await readProcessOutput(client, processId, signal) : undefined;
		throwIfCancelled(signal);
		const artifactContent = shouldWait ? await readScratchpadArtifact(client, artifact, signal) : undefined;
		throwIfCancelled(signal);
		if (shouldWait && status === "completed" && !output && !artifactContent) status = "no_output";
		if (shouldWait && spec.closeOnComplete === true) {
			cleanupOutcome = await cleanupSoloProcess(client, processId, runtime.cleanupTimeoutMs);
			throwIfCancelled(signal);
			if (!cleanupOutcome.cleaned) {
				return {
					id: randomUUID(), name: spec.name, processId,
					artifactScratchpadName: artifact?.name, artifactScratchpadId: artifact?.id,
					output: output ? truncate(output, 40_000) : undefined,
					artifactContent: artifactContent ? truncate(artifactContent, 40_000) : undefined,
					status: "failed", error: `closeOnComplete failed: ${cleanupOutcome.diagnostic}`,
				};
			}
		}
		throwIfCancelled(signal);
		return {
			id: randomUUID(), name: spec.name, processId,
			artifactScratchpadName: artifact?.name, artifactScratchpadId: artifact?.id,
			output: output ? truncate(output, 40_000) : undefined,
			artifactContent: artifactContent ? truncate(artifactContent, 40_000) : undefined,
			status, error: completion.error,
		};
	} catch (error) {
		cleanupOutcome ??= await cleanupSoloProcess(client, processId, runtime.cleanupTimeoutMs);
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
			const cancelled = signal?.aborted ? cancellationError(signal) : error as Error;
			cancelled.message = `${cancelled.message}; ${cleanupOutcome.diagnostic}`;
			throw cancelled;
		}
		return {
			id: randomUUID(), name: spec.name, processId,
			artifactScratchpadName: artifact?.name, artifactScratchpadId: artifact?.id,
			status: "failed",
			error: `${error instanceof Error ? error.message : String(error)}; ${cleanupOutcome.diagnostic}`,
		};
	}
}

export function summarizeSoloTask(result: SpawnedSoloTask): string {
	const process = result.processId > 0 ? `Solo #${result.processId}` : "not spawned";
	const title = `### ${result.name} (${result.status}, ${process})`;
	const artifact = result.artifactScratchpadName
		? `\nArtifact: ${result.artifactScratchpadName}${result.artifactScratchpadId != null ? ` (#${result.artifactScratchpadId})` : ""}`
		: "";
	const captured = result.artifactContent || result.output;
	const body = [result.error ? `Error: ${result.error}` : undefined, captured].filter(Boolean).join("\n\n") || "(no output captured)";
	return `${title}${artifact}\n\n${body}`;
}

export function defaultTaskName(task: string, role?: string): string {
	const firstLine = task.split("\n").find((line) => line.trim())?.trim() ?? "task";
	const prefix = role ? `${role}: ` : "";
	return `${prefix}${basename(firstLine).slice(0, 60)}`;
}
