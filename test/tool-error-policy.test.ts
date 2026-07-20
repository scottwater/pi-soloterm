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
