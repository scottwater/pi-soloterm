import assert from "node:assert/strict";
import test from "node:test";
import { __test__, registerSoloTermProcessTool } from "../src/solo-process-tool.ts";

function processExecutor(client: any) {
	let tool: any;
	registerSoloTermProcessTool({ registerTool(value: any) { tool = value; } } as any, {
		client,
		isActive: () => true,
		isClientReady: () => true,
	});
	return (params: any) => tool.execute("test", params);
}

function result(data: unknown, isError = false) {
	return { structuredContent: data, isError };
}

test("extractProcesses supports common Solo MCP list shapes", () => {
	assert.deepEqual(__test__.extractProcesses({ structuredContent: [{ id: 1 }] }), [{ id: 1 }]);
	assert.deepEqual(__test__.extractProcesses({ structuredContent: { processes: [{ id: 2 }] } }), [{ id: 2 }]);
	assert.deepEqual(__test__.extractProcesses({ structuredContent: { items: [{ id: 3 }] } }), [{ id: 3 }]);
});

test("close_subagents filter targets Pi --soloterm children and excludes current process", () => {
	const params = { includeExited: false };
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 10, status: "Running", name: "Task 1 Implementer", command: "pi --soloterm" }, params, 99),
		true,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 99, status: "Running", name: "Current", command: "pi --soloterm" }, params, 99),
		false,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 11, status: "Running", name: "Bare Pi", command: "pi" }, params, 99),
		false,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 13, status: "Running", name: "Path Pi", command: "/usr/local/bin/pi --soloterm" }, params, 99),
		true,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 12, status: "Exited", name: "Old Task", command: "pi --soloterm" }, params, 99),
		false,
	);
});

test("close_subagents can include explicit Solo agent records", () => {
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 20, status: "Running", name: "Claude Child", command: "claude", kind: "agent" }, { includeAllAgents: true }, 99),
		true,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 21, status: "Running", name: "Terminal", command: "/bin/zsh", kind: "terminal" }, { includeAllAgents: true }, 99),
		false,
	);
});

test("close refuses missing identity and reports diagnostics", async () => {
	const calls: any[] = [];
	const execute = processExecutor({
		tools: [], identityError: "identify_session timed out",
		hasTool: (name: string) => name === "close_process",
		callTool: async (...args: any[]) => { calls.push(args); return result({}); },
	});
	const response = await execute({ action: "close", processId: 12 });
	assert.equal(response.isError, true);
	assert.match(response.content[0].text, /project identity/);
	assert.match(response.content[0].text, /current-process identity/);
	assert.match(response.content[0].text, /identify_session timed out/);
	assert.equal(calls.length, 0);
});

test("close permits explicit safety overrides and scopes close and verification", async () => {
	const calls: any[] = [];
	const execute = processExecutor({
		tools: [],
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string, args: any) => {
			calls.push([name, args]);
			return name === "list_processes" ? result({ processes: [] }) : result({ ok: true });
		},
	});
	const response = await execute({ action: "close", processId: 12, projectId: 7, allowCurrent: true });
	assert.equal(response.isError, false);
	assert.deepEqual(calls, [
		["close_process", { project_id: 7, process_id: 12 }],
		["list_processes", { project_id: 7 }],
	]);
});

test("close protects the identified current session unless explicitly allowed", async () => {
	const calls: any[] = [];
	const client = {
		tools: [], identity: { process_id: 12, project: { id: 7 } },
		hasTool: (name: string) => name === "close_process",
		callTool: async (...args: any[]) => { calls.push(args); return result({ ok: true }); },
	};
	const execute = processExecutor(client);
	assert.equal((await execute({ action: "close", processId: 12 })).isError, true);
	assert.equal(calls.length, 0);
	assert.equal((await execute({ action: "close", processId: 12, allowCurrent: true })).isError, false);
	assert.deepEqual(calls[0], ["close_process", { project_id: 7, process_id: 12 }]);
});

test("close_subagents scopes listing and closing and excludes the current session", async () => {
	const calls: any[] = [];
	let listings = 0;
	const execute = processExecutor({
		tools: [], identity: { process_id: 5, project: { id: 9 } },
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string, args: any) => {
			calls.push([name, args]);
			if (name === "close_process") return result({ ok: true });
			listings++;
			return result({ processes: listings === 1 ? [
				{ id: 5, status: "Running", command: "pi --soloterm" },
				{ id: 6, status: "Running", command: "pi --soloterm" },
			] : [] });
		},
	});
	const response = await execute({ action: "close_subagents" });
	assert.equal(response.isError, false);
	assert.deepEqual(calls, [
		["list_processes", { project_id: 9 }],
		["close_process", { project_id: 9, process_id: 6 }],
		["list_processes", { project_id: 9 }],
	]);
});

test("close_subagents dry run requires project scope but not current-process identity", async () => {
	const calls: any[] = [];
	const execute = processExecutor({
		tools: [], identityError: "identity unavailable",
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string, args: any) => {
			calls.push([name, args]);
			return result({ processes: [{ id: 6, status: "Running", command: "pi --soloterm" }] });
		},
	});
	assert.equal((await execute({ action: "close_subagents", dryRun: true })).isError, true);
	const response = await execute({ action: "close_subagents", projectId: 9, dryRun: true });
	assert.equal(response.isError, undefined);
	assert.match(response.content[0].text, /#6/);
	assert.deepEqual(calls, [["list_processes", { project_id: 9 }]]);
});

test("close_subagents requires overrides without identity and surfaces verification failures", async () => {
	let listings = 0;
	const execute = processExecutor({
		tools: [],
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string) => {
			if (name === "close_process") return result({ ok: true });
			listings++;
			return listings === 1
				? result({ processes: [{ id: 6, status: "Running", command: "pi --soloterm" }] })
				: { content: [{ type: "text", text: "verification unavailable" }], isError: true };
		},
	});
	assert.equal((await execute({ action: "close_subagents", projectId: 9 })).isError, true);
	const response = await execute({ action: "close_subagents", projectId: 9, allowCurrent: true });
	assert.equal(response.isError, true);
	assert.match(response.content[0].text, /Verification failed: verification unavailable/);
});
