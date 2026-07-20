import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPiExtraArgs,
	buildSoloTaskPrompt,
	classifyTerminalProcessStatus,
	resolveSoloAgentTool,
	runSoloTask,
	summarizeSoloTask,
	type SoloTaskRuntime,
} from "../src/solo-subagents.ts";
import type { McpToolCallResult, SoloCallToolLike } from "../src/solo-mcp-client.ts";

class FakeClient implements SoloCallToolLike {
	tools = [{ name: "list_agent_tools" }];
	private agentTools: any[];
	constructor(agentTools: any[]) {
		this.agentTools = agentTools;
	}
	hasTool(name: string): boolean {
		return this.tools.some((tool) => tool.name === name);
	}
	async callTool(name: string): Promise<McpToolCallResult> {
		if (name === "list_agent_tools") return { structuredContent: { tools: this.agentTools } };
		return { isError: true, content: [{ type: "text", text: "unexpected" }] };
	}
}

test("terminal child process failures retain their Solo status", () => {
	assert.deepEqual(classifyTerminalProcessStatus("failed"), {
		status: "failed",
		error: 'Solo process entered terminal status "failed".',
	});
	assert.deepEqual(classifyTerminalProcessStatus("Exited"), {
		status: "exited",
		error: 'Solo process entered terminal status "exited".',
	});
	assert.deepEqual(classifyTerminalProcessStatus("crashed"), {
		status: "crashed",
		error: 'Solo process entered terminal status "crashed".',
	});
	assert.equal(classifyTerminalProcessStatus("running"), undefined);
	assert.deepEqual(classifyTerminalProcessStatus("completed"), { status: "completed" });
});

test("resolveSoloAgentTool identifies default Pi tool", async () => {
	const client = new FakeClient([{ id: 1, name: "Pi", command: "pi", enabled: true }]);
	const resolved = await resolveSoloAgentTool(client);
	assert.equal(resolved.id, 1);
	assert.equal(resolved.isPi, true);
});

test("resolveSoloAgentTool supports non-Pi tools without marking them as Pi", async () => {
	const client = new FakeClient([
		{ id: 1, name: "Pi", command: "pi", enabled: true },
		{ id: 2, name: "Claude", command: "claude", enabled: true },
	]);
	const resolved = await resolveSoloAgentTool(client, "Claude");
	assert.equal(resolved.id, 2);
	assert.equal(resolved.isPi, false);
});

test("buildPiExtraArgs passes --soloterm only for Pi child agents", () => {
	assert.deepEqual(buildPiExtraArgs({ name: "x", task: "y", model: "anthropic/sonnet", thinking: "high" }, true), [
		"--soloterm",
		"--model",
		"anthropic/sonnet",
		"--thinking",
		"high",
	]);
	assert.deepEqual(buildPiExtraArgs({ name: "x", task: "y", model: "anthropic/sonnet", thinking: "high" }, false), []);
});

test("buildPiExtraArgs rejects model pi for Pi child agents", () => {
	assert.throws(
		() => buildPiExtraArgs({ name: "x", task: "y", model: "pi" }, true),
		/model: "pi" selects a model pattern, not the Pi agent tool.*agentTool: "pi"/s,
	);
});

test("buildSoloTaskPrompt tells child Pi agents to use solo_scratchpad", () => {
	const prompt = buildSoloTaskPrompt(
		{ name: "Review", task: "Review this", role: "reviewer" },
		{ name: "review/artifact", id: 42 },
	);
	assert.match(prompt, /solo_scratchpad/);
	assert.match(prompt, /scratchpad_write/);
	assert.match(prompt, /final response/);
});

const requiredTools = [
	"list_agent_tools",
	"spawn_agent",
	"send_input",
	"get_process_status",
	"get_process_output",
	"close_process",
];

function taskClient(handler: (name: string, args?: unknown) => McpToolCallResult | Promise<McpToolCallResult>): SoloCallToolLike {
	return {
		tools: requiredTools.map((name) => ({ name })),
		hasTool: (name) => requiredTools.includes(name),
		callTool: async (name, args) => handler(name, args),
	};
}

function fakeRuntime(onDelay?: (ms: number, signal?: AbortSignal) => void): SoloTaskRuntime & { elapsed: () => number } {
	let now = 0;
	return {
		now: () => now,
		delay: async (ms, signal) => {
			now += ms;
			onDelay?.(ms, signal);
		},
		readyPollMs: 2,
		idlePollMs: 2,
		idleGraceMs: 4,
		idleConsecutive: 2,
		readyTransientErrorLimit: 2,
		cleanupTimeoutMs: 20,
		elapsed: () => now,
	};
}

function baseResponse(name: string): McpToolCallResult | undefined {
	if (name === "list_agent_tools") return { structuredContent: { tools: [{ id: 1, name: "Pi", command: "pi" }] } };
	if (name === "spawn_agent") return { structuredContent: { process_id: 42 } };
	if (name === "get_process_output") return { content: [{ type: "text", text: "done" }] };
	if (name === "close_process") return {};
	return undefined;
}

test("a child that is stably idle without observed busy completes after a bounded grace", async () => {
	const runtime = fakeRuntime();
	let statusCalls = 0;
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "send_input") return {};
		if (name === "get_process_status") {
			statusCalls += 1;
			return { structuredContent: { status: "running", agent_state: { idle: true } } };
		}
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "fast", task: "finish quickly" }, undefined, runtime);
	assert.equal(result.status, "completed");
	assert.ok(statusCalls <= 5, `used ${statusCalls} status polls`);
	assert.ok(runtime.elapsed() <= 8, `waited ${runtime.elapsed()}ms of logical time`);
});

test("initial readiness retries only a bounded number of transient thrown failures", async () => {
	const runtime = fakeRuntime();
	let statusCalls = 0;
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "get_process_status") {
			statusCalls += 1;
			throw new Error("transport temporarily not ready");
		}
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "readiness", task: "work" }, undefined, runtime);
	assert.equal(result.status, "failed");
	assert.equal(result.processId, 42);
	assert.equal(statusCalls, 3);
	assert.match(result.error ?? "", /transport temporarily not ready/);
});

test("initial readiness retries transient returned MCP errors and recovers", async () => {
	const runtime = fakeRuntime();
	let statusCalls = 0;
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "get_process_status") {
			statusCalls += 1;
			if (statusCalls <= 2) return { isError: true, content: [{ type: "text", text: statusCalls === 1 ? "process starting; PTY not ready" : "transport timed out while busy" }] };
			return { structuredContent: { status: "running", agent_state: { idle: true } } };
		}
		if (name === "send_input") return {};
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "readiness", task: "work", wait: false }, undefined, runtime);
	assert.equal(result.status, "started");
	assert.equal(statusCalls, 3);
});

test("initial readiness fails promptly for non-transient returned MCP errors", async () => {
	const runtime = fakeRuntime();
	let statusCalls = 0;
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "get_process_status") {
			statusCalls += 1;
			return { isError: true, content: [{ type: "text", text: "permission denied" }] };
		}
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "readiness", task: "work" }, undefined, runtime);
	assert.equal(result.status, "failed");
	assert.equal(statusCalls, 1);
	assert.match(result.error ?? "", /permission denied/);
});

test("initial readiness recovers when a transient thrown failure clears", async () => {
	const runtime = fakeRuntime();
	let statusCalls = 0;
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "get_process_status") {
			statusCalls += 1;
			if (statusCalls === 1) throw new Error("PTY temporarily not ready");
			return { structuredContent: { status: "running", agent_state: { idle: true } } };
		}
		if (name === "send_input") return {};
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "readiness", task: "work", wait: false }, undefined, runtime);
	assert.equal(result.status, "started");
	assert.equal(statusCalls, 2);
});

test("send_input retries a transient failure and then succeeds", async () => {
	const runtime = fakeRuntime();
	let sends = 0;
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "get_process_status") return { structuredContent: { status: "running", agent_state: { idle: true } } };
		if (name === "send_input") return ++sends === 1
			? { isError: true, content: [{ type: "text", text: "PTY not ready" }] }
			: {};
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "retry", task: "work", wait: false }, undefined, runtime);
	assert.equal(result.status, "started");
	assert.equal(sends, 2);
});

test("terminal child failure remains open with its real identity and captured output", async () => {
	const runtime = fakeRuntime();
	let statusCalls = 0;
	let closeCalls = 0;
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base && name !== "close_process") return base;
		if (name === "send_input") return {};
		if (name === "get_process_status") {
			statusCalls += 1;
			return statusCalls === 1
				? { structuredContent: { status: "running", agent_state: { idle: true } } }
				: { structuredContent: { status: "crashed", agent_state: { idle: false } } };
		}
		if (name === "close_process") {
			closeCalls += 1;
			return {};
		}
		throw new Error(`unexpected ${name}`);
	});

	const taskResult = await runSoloTask(client, { name: "inspect crash", task: "work" }, undefined, runtime);
	assert.equal(taskResult.status, "crashed");
	assert.equal(taskResult.processId, 42);
	assert.equal(taskResult.output, "done");
	assert.equal(taskResult.paneOpen, true);
	assert.equal(closeCalls, 0);
	assert.match(summarizeSoloTask(taskResult), /Solo process #42 remains open for inspection/);
});

test("retry exhaustion after spawn preserves process identity and closes the pane", async () => {
	const runtime = fakeRuntime();
	let closedProcess: number | undefined;
	const client = taskClient(async (name, args) => {
		const base = baseResponse(name);
		if (base && name !== "close_process") return base;
		if (name === "get_process_status") return { structuredContent: { status: "running", agent_state: { idle: true } } };
		if (name === "send_input") return { isError: true, content: [{ type: "text", text: "PTY not ready" }] };
		if (name === "close_process") {
			closedProcess = (args as { process_id: number }).process_id;
			return {};
		}
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "failed dispatch", task: "work" }, undefined, runtime);
	assert.equal(result.status, "failed");
	assert.equal(result.processId, 42);
	assert.equal(closedProcess, 42);
	assert.match(result.error ?? "", /send_input failed.*cleaned up Solo process #42/s);
});

test("failed post-spawn cleanup reports the actual pane identity", async () => {
	const runtime = fakeRuntime();
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base && name !== "close_process") return base;
		if (name === "get_process_status") return { isError: true, content: [{ type: "text", text: "status backend unavailable" }] };
		if (name === "close_process") return { isError: true, content: [{ type: "text", text: "close denied" }] };
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "cleanup", task: "work" }, undefined, runtime);
	assert.equal(result.processId, 42);
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /get_process_status failed: status backend unavailable/);
	assert.match(result.error ?? "", /cleanup failed for Solo process #42: close denied/);
});

test("busy child times out using injected polling time", async () => {
	const runtime = fakeRuntime();
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "send_input") return {};
		if (name === "get_process_status") return { structuredContent: { status: "running", agent_state: { thinking: true, idle: false } } };
		throw new Error(`unexpected ${name}`);
	});

	const result = await runSoloTask(client, { name: "timeout", task: "work", maxWaitMs: 6 }, undefined, runtime);
	assert.equal(result.status, "timeout");
	assert.ok(runtime.elapsed() <= 8);
});

test("hanging spawn cancellation returns bounded unknown orphan risk when no process identity arrives", async () => {
	const controller = new AbortController();
	const runtime = fakeRuntime();
	const client = taskClient(async (name) => {
		if (name === "list_agent_tools") return { structuredContent: { tools: [{ id: 1, name: "Pi", command: "pi" }] } };
		if (name === "spawn_agent") return new Promise<McpToolCallResult>(() => {});
		throw new Error(`unexpected ${name}`);
	});

	const pending = runSoloTask(client, { name: "cancel spawn", task: "work" }, controller.signal, runtime);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("cancelled while spawning"));
	await assert.rejects(pending, /spawn outcome is unknown.*no process_id.*orphan risk/);
});

test("late spawn identity from a non-invalidating client receives bounded cleanup with diagnostics", async () => {
	const controller = new AbortController();
	const runtime = fakeRuntime();
	let resolveSpawn!: (result: McpToolCallResult) => void;
	const spawn = new Promise<McpToolCallResult>((resolve) => { resolveSpawn = resolve; });
	const client = taskClient(async (name) => {
		if (name === "list_agent_tools") return { structuredContent: { tools: [{ id: 1, name: "Pi", command: "pi" }] } };
		if (name === "spawn_agent") return spawn;
		if (name === "close_process") return { isError: true, content: [{ type: "text", text: "close denied" }] };
		throw new Error(`unexpected ${name}`);
	});

	const pending = runSoloTask(client, { name: "cancel spawn", task: "work" }, controller.signal, runtime);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("cancelled while spawning"));
	resolveSpawn({ structuredContent: { process_id: 42 } });
	await assert.rejects(pending, /late spawn returned Solo process #42; cleanup failed.*close denied.*orphan risk/);
});

test("cancellation returns promptly when get_process_status hangs", async () => {
	const controller = new AbortController();
	const runtime = fakeRuntime();
	let closedProcess: number | undefined;
	const client = taskClient(async (name, args) => {
		const base = baseResponse(name);
		if (base && name !== "close_process") return base;
		if (name === "get_process_status") return new Promise<McpToolCallResult>(() => {});
		if (name === "close_process") {
			closedProcess = (args as { process_id: number }).process_id;
			return {};
		}
		throw new Error(`unexpected ${name}`);
	});
	const pending = runSoloTask(client, { name: "hung status", task: "work" }, controller.signal, runtime);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("stop status"));
	await assert.rejects(pending, /solo_task cancelled: stop status; cleaned up Solo process #42/);
	assert.equal(closedProcess, 42);
});

test("cancellation returns promptly when send_input hangs", async () => {
	const controller = new AbortController();
	const runtime = fakeRuntime();
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "get_process_status") return { structuredContent: { status: "running", agent_state: { idle: true } } };
		if (name === "send_input") return new Promise<McpToolCallResult>(() => {});
		throw new Error(`unexpected ${name}`);
	});
	const pending = runSoloTask(client, { name: "hung input", task: "work" }, controller.signal, runtime);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("stop input"));
	await assert.rejects(pending, /solo_task cancelled: stop input; cleaned up Solo process #42/);
});

test("cancellation interrupts status polling promptly", async () => {
	const controller = new AbortController();
	const runtime = fakeRuntime((_ms, signal) => {
		assert.equal(signal, controller.signal);
		controller.abort(new Error("stop polling"));
	});
	let statusCalls = 0;
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "send_input") return {};
		if (name === "get_process_status") {
			statusCalls += 1;
			return statusCalls === 1
				? { structuredContent: { status: "running", agent_state: { idle: true } } }
				: { structuredContent: { status: "running", agent_state: { thinking: true, idle: false } } };
		}
		throw new Error(`unexpected ${name}`);
	});

	await assert.rejects(
		runSoloTask(client, { name: "cancel poll", task: "work" }, controller.signal, runtime),
		/solo_task cancelled: stop polling/,
	);
	assert.equal(statusCalls, 2);
});

test("hanging cancellation cleanup is bounded and reports orphan risk", async () => {
	const controller = new AbortController();
	const runtime = fakeRuntime();
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base && name !== "close_process") return base;
		if (name === "get_process_status") return new Promise<McpToolCallResult>(() => {});
		if (name === "close_process") return new Promise<McpToolCallResult>(() => {});
		throw new Error(`unexpected ${name}`);
	});
	const pending = runSoloTask(client, { name: "hung cleanup", task: "work" }, controller.signal, runtime);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("cancel"));
	await assert.rejects(pending, /cleanup timed out after 20ms.*orphan risk/);
});

test("closeOnComplete failures preserve process identity and orphan diagnostics", async () => {
	for (const closeBehavior of ["throw", "mcp-error", "hang"] as const) {
		const runtime = fakeRuntime();
		const client = taskClient(async (name) => {
			const base = baseResponse(name);
			if (base && name !== "close_process") return base;
			if (name === "get_process_status") return { structuredContent: { status: "running", agent_state: { idle: true } } };
			if (name === "send_input") return {};
			if (name === "close_process") {
				if (closeBehavior === "throw") throw new Error("close transport failed");
				if (closeBehavior === "mcp-error") return { isError: true, content: [{ type: "text", text: "close denied" }] };
				return new Promise<McpToolCallResult>(() => {});
			}
			throw new Error(`unexpected ${name}`);
		});
		const result = await runSoloTask(client, { name: closeBehavior, task: "work", closeOnComplete: true }, undefined, runtime);
		assert.equal(result.status, "failed");
		assert.equal(result.processId, 42);
		assert.match(result.error ?? "", /closeOnComplete failed: cleanup failed for Solo process #42:.*orphan risk/);
	}
});

test("cancellation after closeOnComplete is checked before successful return", async () => {
	const controller = new AbortController();
	const runtime = fakeRuntime();
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base && name !== "close_process") return base;
		if (name === "get_process_status") return { structuredContent: { status: "running", agent_state: { idle: true } } };
		if (name === "send_input") return {};
		if (name === "close_process") {
			controller.abort(new Error("cancel after close"));
			return {};
		}
		throw new Error(`unexpected ${name}`);
	});
	await assert.rejects(
		runSoloTask(client, { name: "close boundary", task: "work", closeOnComplete: true }, controller.signal, runtime),
		/solo_task cancelled: cancel after close; cleaned up Solo process #42/,
	);
});

test("cancellation interrupts retry delays and is thrown instead of becoming a task result", async () => {
	const controller = new AbortController();
	const runtime = fakeRuntime((_ms, signal) => {
		assert.equal(signal, controller.signal);
		controller.abort(new Error("operator cancelled"));
	});
	const client = taskClient(async (name) => {
		const base = baseResponse(name);
		if (base) return base;
		if (name === "get_process_status") return { structuredContent: { status: "running", agent_state: { idle: true } } };
		if (name === "send_input") return { isError: true, content: [{ type: "text", text: "PTY not ready" }] };
		throw new Error(`unexpected ${name}`);
	});

	await assert.rejects(
		runSoloTask(client, { name: "cancel", task: "work" }, controller.signal, runtime),
		/solo_task cancelled: operator cancelled/,
	);
});
