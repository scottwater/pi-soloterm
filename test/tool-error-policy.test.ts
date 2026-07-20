import assert from "node:assert/strict";
import test from "node:test";
import { registerSoloTermProcessTool } from "../src/solo-process-tool.ts";
import { registerSoloTermScratchpadTool } from "../src/solo-scratchpad-tool.ts";
import { registerSoloStatusTool } from "../src/solo-status-tool.ts";
import { registerSoloTermTaskTool } from "../src/solo-task-tool.ts";
import { registerSoloTermTodoTool } from "../src/solo-todo-tool.ts";

function captureTool(register: (pi: any) => void): any {
	let tool: any;
	register({
		registerTool(definition: any) { tool = definition; },
		on() {},
		appendEntry() {},
	});
	return tool;
}

const unavailableClient = {
	tools: [],
	hasTool: () => false,
	callTool: async () => ({}),
	refreshTools: async () => {},
	isMcpDisabled: () => false,
	state: "stopped",
};

test("every registered SoloTerm tool throws when its required SoloTerm mode is unavailable", async () => {
	const tools = [
		captureTool((pi) => registerSoloStatusTool(pi, { client: unavailableClient as any, isActive: () => false })),
		captureTool((pi) => registerSoloTermTaskTool(pi, { client: unavailableClient as any, isActive: () => false, isClientReady: () => false })),
		captureTool((pi) => registerSoloTermProcessTool(pi, { client: unavailableClient as any, isActive: () => false, isClientReady: () => false })),
		captureTool((pi) => registerSoloTermTodoTool(pi, { client: unavailableClient as any, isActive: () => false, isClientReady: () => false })),
		captureTool((pi) => registerSoloTermScratchpadTool(pi, { client: unavailableClient as any, isActive: () => false, isClientReady: () => false })),
	];

	for (const tool of tools) {
		await assert.rejects(tool.execute("test", { action: "list" }), /SoloTerm mode is (?:not active|inactive)/, tool.name);
	}
});

test("solo_task throws for a mixed parallel result and includes failure output", async () => {
	const taskTool = captureTool((pi) => registerSoloTermTaskTool(pi, {
		client: unavailableClient as any,
		isActive: () => true,
		isClientReady: () => true,
		runTask: async (_client: any, spec: any) => spec.name === "good"
			? { id: "1", name: spec.name, processId: 10, status: "completed", output: "done" }
			: { id: "2", name: spec.name, processId: 11, status: "crashed", error: "child crashed", output: "fatal: boom" },
	} as any));

	await assert.rejects(
		taskTool.execute("test", { tasks: [{ name: "good", task: "ok" }, { name: "bad", task: "fail" }] }),
		(error: Error) => /solo_task failed: Parallel SoloTerm tasks: 1\/2 completed/.test(error.message)
			&& /bad \(crashed, Solo #11\)/.test(error.message)
			&& /child crashed/.test(error.message)
			&& /fatal: boom/.test(error.message),
	);
});

test("parallel cancellation cleans up a process returned at the cancellation boundary", async () => {
	let taskTool: any;
	const starts: string[] = [];
	const closed: number[] = [];
	const controller = new AbortController();
	const client = {
		...unavailableClient,
		hasTool: (name: string) => name === "close_process",
		callTool: async (name: string, args: any) => {
			if (name === "close_process") closed.push(args.process_id);
			return {};
		},
	};
	registerSoloTermTaskTool(
		{ registerTool(definition: any) { taskTool = definition; } } as any,
		{
			client: client as any,
			isActive: () => true,
			isClientReady: () => true,
			runTask: async (_client, spec, signal) => {
				assert.equal(signal, controller.signal);
				starts.push(spec.task);
				controller.abort(new Error("user stopped tool"));
				return { id: "first", name: spec.name, processId: 17, status: "started" };
			},
		},
	);

	await assert.rejects(
		taskTool.execute("test", { concurrency: 1, tasks: [{ task: "one" }, { task: "two" }] }, controller.signal),
		/solo_task cancelled: user stopped tool; cleaned up Solo process #17/,
	);
	assert.deepEqual(starts, ["one"]);
	assert.deepEqual(closed, [17]);
});

test("parallel cancellation cleans up wait:false results that completed before another worker cancels", async () => {
	let taskTool: any;
	const starts: string[] = [];
	const closed: number[] = [];
	const controller = new AbortController();
	let cancelSecond!: () => void;
	const secondMayCancel = new Promise<void>((resolve) => { cancelSecond = resolve; });
	const client = {
		...unavailableClient,
		hasTool: (name: string) => name === "close_process",
		callTool: async (name: string, args: any) => {
			if (name === "close_process") closed.push(args.process_id);
			return {};
		},
	};
	registerSoloTermTaskTool(
		{ registerTool(definition: any) { taskTool = definition; } } as any,
		{
			client: client as any,
			isActive: () => true,
			isClientReady: () => true,
			runTask: async (_client, spec) => {
				starts.push(spec.task);
				if (spec.task === "already returned") {
					cancelSecond();
					return { id: "first", name: spec.name, processId: 31, status: "started" };
				}
				await secondMayCancel;
				controller.abort(new Error("reviewed cancellation"));
				return { id: "second", name: spec.name, processId: 32, status: "started" };
			},
		},
	);

	await assert.rejects(
		taskTool.execute("test", {
			concurrency: 2,
			tasks: [{ task: "already returned", wait: false }, { task: "cancels" }],
		}, controller.signal),
		(error: Error) => /Solo process #31/.test(error.message) && /Solo process #32/.test(error.message),
	);
	assert.deepEqual(starts.sort(), ["already returned", "cancels"]);
	assert.deepEqual(closed.sort((a, b) => a - b), [31, 32]);
});

test("parallel cancellation waits for every started worker cleanup and starts no replacements", async () => {
	let taskTool: any;
	const starts: string[] = [];
	const closeCalls: number[] = [];
	const closeResolvers = new Map<number, () => void>();
	const controller = new AbortController();
	const client = {
		...unavailableClient,
		hasTool: (name: string) => name === "close_process",
		callTool: async (name: string, args: any) => {
			if (name !== "close_process") return {};
			const id = args.process_id as number;
			closeCalls.push(id);
			await new Promise<void>((resolve) => closeResolvers.set(id, resolve));
			return {};
		},
	};
	registerSoloTermTaskTool(
		{ registerTool(definition: any) { taskTool = definition; } } as any,
		{
			client: client as any,
			isActive: () => true,
			isClientReady: () => true,
			runTask: async (_client, spec, signal) => {
				starts.push(spec.task);
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				const processId = spec.task === "one" ? 21 : 22;
				return { id: spec.task, name: spec.name, processId, status: "started" };
			},
		},
	);

	let settled = false;
	const pending = taskTool.execute("test", {
		concurrency: 2,
		tasks: [{ task: "one" }, { task: "two" }, { task: "must not start" }],
	}, controller.signal).finally(() => { settled = true; });
	while (starts.length < 2) await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("stop parallel"));
	while (closeCalls.length < 1) await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts.sort(), ["one", "two"]);

	const firstCleanupId = closeCalls[0]!;
	closeResolvers.get(firstCleanupId)?.();
	while (closeCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false, "execute must wait for the other started worker cleanup");
	const secondCleanupId = closeCalls[1]!;
	closeResolvers.get(secondCleanupId)?.();
	await assert.rejects(pending, (error: Error) => /Solo process #21/.test(error.message) && /Solo process #22/.test(error.message));
	assert.equal(settled, true);
});

test("MCP operation failures throw with the Solo diagnostic", async () => {
	const client = {
		...unavailableClient,
		hasTool: (name: string) => name === "get_process_status" || name === "scratchpad_list",
		callTool: async () => ({ isError: true, content: [{ type: "text", text: "Solo denied the operation" }] }),
	};
	const processTool = captureTool((pi) => registerSoloTermProcessTool(pi, { client: client as any, isActive: () => true, isClientReady: () => true }));
	const scratchpadTool = captureTool((pi) => registerSoloTermScratchpadTool(pi, { client: client as any, isActive: () => true, isClientReady: () => true }));

	await assert.rejects(processTool.execute("test", { action: "status", processId: 1 }), /solo_process failed: Solo denied the operation/);
	await assert.rejects(scratchpadTool.execute("test", { action: "list" }), /solo_scratchpad failed: Solo denied the operation/);
});
