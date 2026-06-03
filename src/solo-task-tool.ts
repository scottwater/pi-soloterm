import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { defaultTaskName, runSoloTask, summarizeSoloTask, type SoloTaskSpec, type SpawnedSoloTask } from "./solo-subagents.ts";
import type { SoloCallToolLike } from "./solo-mcp-client.ts";

const SingleTaskParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Display name for the Solo child agent pane." })),
	task: Type.String({ description: "Complete prompt/task to send to the child agent." }),
	role: Type.Optional(
		Type.String({
			description:
				"Optional role label such as implementer, spec-reviewer, code-quality-reviewer, code-reviewer, scout, or general.",
		}),
	),
	agentTool: Type.Optional(
		Type.String({
			description:
				"Solo agent tool name or command. Defaults to the enabled Solo agent tool whose command or name is `pi`.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Optional Pi --model value for the child agent." })),
	thinking: Type.Optional(Type.String({ description: "Optional Pi --thinking value for the child agent." })),
	wait: Type.Optional(
		Type.Boolean({
			description:
				"Wait for the child agent to go idle and return captured output. Defaults to true. Set false for fire-and-forget.",
		}),
	),
	maxWaitMs: Type.Optional(Type.Number({ description: "Maximum wait for a child agent before returning timeout." })),
	closeOnComplete: Type.Optional(Type.Boolean({ description: "Close the Solo pane after completion. Defaults to false." })),
	useScratchpad: Type.Optional(Type.Boolean({ description: "Reserve a Solo scratchpad artifact when scratchpad tools are available. Defaults to false." })),
});

const SoloTermTaskParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Display name for the Solo child agent pane." })),
	task: Type.Optional(Type.String({ description: "Complete prompt/task to send to the child agent." })),
	role: Type.Optional(Type.String({ description: "Optional role label such as implementer, spec-reviewer, code-quality-reviewer, code-reviewer, scout, or general." })),
	agentTool: Type.Optional(Type.String({ description: "Solo agent tool name or command. Defaults to the enabled Solo agent tool whose command or name is `pi`." })),
	model: Type.Optional(Type.String({ description: "Optional Pi --model value for the child agent." })),
	thinking: Type.Optional(Type.String({ description: "Optional Pi --thinking value for the child agent." })),
	wait: Type.Optional(Type.Boolean({ description: "Wait for the child agent to go idle and return captured output. Defaults to true. Set false for fire-and-forget." })),
	maxWaitMs: Type.Optional(Type.Number({ description: "Maximum wait for a child agent before returning timeout." })),
	closeOnComplete: Type.Optional(Type.Boolean({ description: "Close the Solo pane after completion. Defaults to false." })),
	useScratchpad: Type.Optional(Type.Boolean({ description: "Reserve a Solo scratchpad artifact when scratchpad tools are available. Defaults to false." })),
	tasks: Type.Optional(Type.Array(SingleTaskParams, { description: "Independent tasks to dispatch in parallel." })),
	concurrency: Type.Optional(Type.Number({ description: "Maximum concurrent child agents. Defaults to 4." })),
});

type SoloTermTaskArgs = Static<typeof SoloTermTaskParams>;
type SingleTaskArgs = Static<typeof SingleTaskParams>;

export interface SoloTermTaskDeps {
	client: SoloCallToolLike;
	isActive: () => boolean;
	isClientReady: () => boolean;
	getChildPiFlags?: () => string[];
}

function normalizeSingleTask(params: SingleTaskArgs, piFlags: string[] = ["--soloterm"]): SoloTaskSpec {
	return {
		name: params.name?.trim() || defaultTaskName(params.task, params.role),
		task: params.task,
		role: params.role,
		agentTool: params.agentTool,
		model: params.model,
		thinking: params.thinking,
		wait: params.wait,
		maxWaitMs: params.maxWaitMs,
		closeOnComplete: params.closeOnComplete,
		useScratchpad: params.useScratchpad,
		piFlags,
	};
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		new Array(limit).fill(null).map(async () => {
			while (true) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await fn(items[index]!, index);
			}
		}),
	);
	return results;
}

function unavailable(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { error: text },
	};
}

async function runTaskSafely(client: SoloCallToolLike, spec: SoloTaskSpec): Promise<SpawnedSoloTask> {
	try {
		return await runSoloTask(client, spec);
	} catch (error) {
		return {
			id: randomUUID(),
			name: spec.name,
			processId: 0,
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function taskSucceeded(result: SpawnedSoloTask): boolean {
	return result.status === "completed" || result.status === "started";
}

export function registerSoloTermTaskTool(pi: ExtensionAPI, deps: SoloTermTaskDeps): void {
	pi.registerTool({
		name: "solo_task",
		label: "SoloTerm Task",
		description:
			"Dispatch Solo-native child agents for SoloTerm workflows. Provides SoloTerm-backed task/subagent dispatch. Supports a single task (task/name/role) or parallel tasks via tasks[].",
		promptSnippet:
			"Use solo_task when skills ask for SoloTerm subagent dispatch, including implementer/reviewer agents or parallel independent investigations.",
		promptGuidelines: [
			"Use solo_task, not ad-hoc bash or manual panes, when a skill asks to dispatch a SoloTerm subagent.",
			"Use solo_task with tasks[] for independent parallel investigations requested by skills.",
		],
		parameters: SoloTermTaskParams as any,
		async execute(_toolCallId, params: SoloTermTaskArgs) {
			if (!deps.isActive()) return unavailable("SoloTerm mode is not active. Run /soloterm on or start Pi with --soloterm.");
			if (!deps.isClientReady()) {
				return unavailable("Solo MCP is not ready. Make sure Solo is running, MCP is enabled in Solo Settings → MCP, and a Pi agent tool is configured in Solo Settings → Agents.");
			}

			const tasks = Array.isArray(params.tasks) && params.tasks.length > 0 ? params.tasks : undefined;
			const piFlags = deps.getChildPiFlags?.() ?? ["--soloterm"];
			try {
				if (tasks) {
					const results = await mapWithConcurrency(tasks, params.concurrency ?? 4, async (task) => runTaskSafely(deps.client, normalizeSingleTask(task, piFlags)));
					const succeeded = results.filter(taskSucceeded).length;
					return {
						content: [
							{
								type: "text" as const,
								text: `Parallel SoloTerm tasks: ${succeeded}/${results.length} completed\n\n${results.map(summarizeSoloTask).join("\n\n---\n\n")}`,
							},
						],
						details: { mode: "parallel", results },
						isError: succeeded !== results.length,
					};
				}

				if (!params.task) {
					return unavailable("solo_task requires either a single task string or a non-empty tasks array.");
				}

				const result = await runTaskSafely(deps.client, normalizeSingleTask(params as SingleTaskArgs, piFlags));
				return {
					content: [{ type: "text" as const, text: summarizeSoloTask(result) }],
					details: { mode: "single", result },
					isError: !taskSucceeded(result),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `solo_task failed: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
		renderCall(args: Record<string, any>, theme: any) {
			if (Array.isArray(args.tasks) && args.tasks.length > 0) {
				return new Text(
					`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold("solo_task"))} ${theme.fg("accent", `${args.tasks.length} parallel tasks`)}`,
					0,
					0,
				);
			}
			const name = args.name ?? args.role ?? "task";
			const preview = typeof args.task === "string" ? args.task.split("\n").find((line: string) => line.trim()) ?? "" : "";
			return new Text(
				`${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold("solo_task"))} ${theme.fg("accent", String(name))}\n${theme.fg("dim", preview.slice(0, 120))}`,
				0,
				0,
			);
		},
		renderResult(result: any, _opts: any, theme: any) {
			const isError = result.isError || result.details?.error;
			const icon = isError ? theme.fg("error", "✘") : theme.fg("success", "✓");
			const text = result.content?.[0]?.text ?? "";
			const first = String(text).split("\n").find((line) => line.trim()) ?? "solo_task";
			return new Text(`${icon} ${theme.fg("toolTitle", theme.bold("solo_task"))} ${theme.fg(isError ? "error" : "dim", first.slice(0, 160))}`, 0, 0);
		},
	});
}
