import assert from "node:assert/strict";
import test from "node:test";
import { __test__, registerSoloTermProcessTool, type SoloProcessRuntime } from "../src/solo-process-tool.ts";

function processExecutor(client: any, runtime?: SoloProcessRuntime) {
	let tool: any;
	registerSoloTermProcessTool({ registerTool(value: any) { tool = value; } } as any, {
		client,
		isActive: () => true,
		isClientReady: () => true,
		runtime,
	});
	return (params: any, signal?: AbortSignal) => tool.execute("test", params, signal);
}

function fakeProcessRuntime(onDelay?: (signal?: AbortSignal) => void): SoloProcessRuntime {
	return {
		delay: async (_ms, signal) => { onDelay?.(signal); },
		verificationPollMs: 1,
		verificationAttempts: 3,
		closeRetryPollMs: 1,
	};
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

test("send submits non-empty input to an existing Solo process", async () => {
	const calls: any[] = [];
	const controller = new AbortController();
	let tool: any;
	registerSoloTermProcessTool({ registerTool(value: any) { tool = value; } } as any, {
		client: {
			tools: [],
			hasTool: (name: string) => name === "send_input",
			callTool: async (...args: any[]) => { calls.push(args); return result({ accepted: true }); },
		},
		isActive: () => true,
		isClientReady: () => true,
	});

	const response = await tool.execute("test", { action: "send", processId: 42, input: "approve" }, controller.signal);
	assert.equal("isError" in response, false);
	assert.deepEqual(calls, [["send_input", { process_id: 42, input: "approve", submit: true }, controller.signal]]);
	assert.match(response.content[0].text, /Sent input to Solo process #42/);
});

test("send can join MCP warm-up before the tool catalog is loaded", async () => {
	const calls: any[] = [];
	const execute = processExecutor({
		tools: [],
		hasTool: () => false,
		canAttemptTool: (name: string) => name === "send_input",
		callTool: async (...args: any[]) => { calls.push(args); return result({ accepted: true }); },
	});

	const response = await execute({ action: "send", processId: 8, input: "continue" });
	assert.deepEqual(calls[0]?.slice(0, 2), ["send_input", { process_id: 8, input: "continue", submit: true }]);
	assert.match(response.content[0].text, /Sent input to Solo process #8/);
});

test("send accepts message as an input alias and rejects missing or blank input", async () => {
	const calls: any[] = [];
	const execute = processExecutor({
		tools: [],
		hasTool: (name: string) => name === "send_input",
		callTool: async (...args: any[]) => { calls.push(args); return result({ accepted: true }); },
	});

	await execute({ action: "send", processId: 7, message: "continue" });
	assert.deepEqual(calls[0]?.slice(0, 2), ["send_input", { process_id: 7, input: "continue", submit: true }]);
	await assert.rejects(execute({ action: "send", input: "continue" }), /requires processId/);
	await assert.rejects(execute({ action: "send", processId: 7, input: "  " }), /requires non-empty input or message/);
	assert.equal(calls.length, 1);
});

test("send preserves Solo send_input failures as thrown tool errors", async () => {
	const execute = processExecutor({
		tools: [],
		hasTool: (name: string) => name === "send_input",
		callTool: async () => ({ isError: true, content: [{ type: "text", text: "permission denied" }] }),
	});

	await assert.rejects(execute({ action: "send", processId: 7, input: "yes" }), /solo_process failed: permission denied/);
});

test("close refuses missing identity and reports diagnostics", async () => {
	const calls: any[] = [];
	const execute = processExecutor({
		tools: [], identityError: "identify_session timed out",
		hasTool: (name: string) => name === "close_process",
		callTool: async (...args: any[]) => { calls.push(args); return result({}); },
	});
	await assert.rejects(
		execute({ action: "close", processId: 12 }),
		(error: Error) => /project identity/.test(error.message)
			&& /current-process identity/.test(error.message)
			&& /identify_session timed out/.test(error.message),
	);
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
	assert.equal("isError" in response, false);
	assert.deepEqual(calls, [
		["close_process", { project_id: 7, process_id: 12 }],
		["list_processes", { project_id: 7 }],
	]);
});

test("close reports a close request failure without claiming verification failed", async () => {
	let listCalls = 0;
	const execute = processExecutor({
		tools: [], identity: { process_id: 99, project: { id: 7 } },
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string) => {
			if (name === "list_processes") listCalls += 1;
			return { isError: true, content: [{ type: "text", text: "close denied" }] };
		},
	});

	await assert.rejects(
		execute({ action: "close", processId: 12 }),
		(error: Error) => /Close request failed for Solo process #12: close denied/.test(error.message)
			&& !/verification/i.test(error.message),
	);
	assert.equal(listCalls, 0);
});

test("close reports partial success when verification throws", async () => {
	const execute = processExecutor({
		tools: [], identity: { process_id: 99, project: { id: 7 } },
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string) => {
			if (name === "close_process") return result({ ok: true });
			throw new Error("verification transport unavailable");
		},
	});

	await assert.rejects(
		execute({ action: "close", processId: 12 }),
		(error: Error) => /Close request succeeded for Solo process #12/.test(error.message)
			&& /verification transport failed/.test(error.message)
			&& /verification transport unavailable/.test(error.message),
	);
});

test("close protects the identified current session unless explicitly allowed", async () => {
	const calls: any[] = [];
	const client = {
		tools: [], identity: { process_id: 12, project: { id: 7 } },
		hasTool: (name: string) => name === "close_process",
		callTool: async (...args: any[]) => { calls.push(args); return result({ ok: true }); },
	};
	const execute = processExecutor(client);
	await assert.rejects(execute({ action: "close", processId: 12 }), /Refusing to close the current Solo\/Pi process/);
	assert.equal(calls.length, 0);
	assert.equal("isError" in await execute({ action: "close", processId: 12, allowCurrent: true }), false);
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
	assert.equal("isError" in response, false);
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
	await assert.rejects(execute({ action: "close_subagents", dryRun: true }), /project identity/);
	const response = await execute({ action: "close_subagents", projectId: 9, dryRun: true });
	assert.equal("isError" in response, false);
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
	await assert.rejects(execute({ action: "close_subagents", projectId: 9 }), /current-process identity/);
	await assert.rejects(
		execute({ action: "close_subagents", projectId: 9, allowCurrent: true }),
		/Verification transport failed after successful close request\(s\): verification unavailable/,
	);
});

test("close verification polls until an active process disappears", async () => {
	let listings = 0;
	const runtime = fakeProcessRuntime();
	const execute = processExecutor({
		tools: [], identity: { process_id: 99, project: { id: 7 } },
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string) => {
			if (name === "close_process") return result({ ok: true });
			listings += 1;
			return result({ processes: listings === 1 ? [{ id: 12, status: "Running" }] : [] });
		},
	}, runtime);

	const response = await execute({ action: "close", processId: 12 });
	assert.match(response.content[0].text, /Closed and verified Solo process #12/);
	assert.equal(listings, 2);
});

test("close verification reports a process still active after grace exhaustion", async () => {
	let listings = 0;
	const runtime = fakeProcessRuntime();
	const execute = processExecutor({
		tools: [], identity: { process_id: 99, project: { id: 7 } },
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string) => {
			if (name === "close_process") return result({ ok: true });
			listings += 1;
			return result({ processes: [{ id: 12, status: "Running" }] });
		},
	}, runtime);

	await assert.rejects(execute({ action: "close", processId: 12 }), /still active after verification grace/);
	assert.equal(listings, 3);
});

test("close verification cancellation interrupts the grace delay", async () => {
	const controller = new AbortController();
	const runtime = fakeProcessRuntime((signal) => {
		assert.equal(signal, controller.signal);
		controller.abort(new Error("stop close verification"));
	});
	const execute = processExecutor({
		tools: [], identity: { process_id: 99, project: { id: 7 } },
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string) => name === "close_process"
			? result({ ok: true })
			: result({ processes: [{ id: 12, status: "Running" }] }),
	}, runtime);

	await assert.rejects(execute({ action: "close", processId: 12 }, controller.signal), (error: Error) =>
		error.name === "AbortError" && /stop close verification/.test(error.message));
});

test("close_subagents verification tolerates asynchronous process transitions", async () => {
	let listings = 0;
	const runtime = fakeProcessRuntime();
	const execute = processExecutor({
		tools: [], identity: { process_id: 5, project: { id: 9 } },
		hasTool: (name: string) => ["close_process", "list_processes"].includes(name),
		callTool: async (name: string) => {
			if (name === "close_process") return result({ ok: true });
			listings += 1;
			if (listings <= 2) return result({ processes: [{ id: 6, status: "Running", command: "pi --soloterm" }] });
			return result({ processes: [{ id: 6, status: "Exited", command: "pi --soloterm" }] });
		},
	}, runtime);

	const response = await execute({ action: "close_subagents" });
	assert.match(response.content[0].text, /Verified closed/);
	assert.equal(listings, 3);
});
