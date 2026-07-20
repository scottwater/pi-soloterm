import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { cleanupSoloProcess } from "../src/solo-subagents.ts";
import {
	parseJsonRpcLine,
	SoloMcpClient,
	type JsonRpcRequest,
	type McpToolCallResult,
	soloToolResultIsError,
	mcpContentToText,
} from "../src/solo-mcp-client.ts";

const NO_RESPONSE = Symbol("no response");

class FakeSoloHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin: Writable;
	requests: JsonRpcRequest[] = [];
	killed = false;
	private handlers: Record<string, (params: unknown) => unknown>;

	constructor(handlers: Record<string, (params: unknown) => unknown>) {
		super();
		this.handlers = handlers;
		this.stdin = new Writable({
			write: (chunk, _encoding, callback) => {
				for (const line of String(chunk).split("\n")) {
					if (!line.trim()) continue;
					const request = JSON.parse(line) as JsonRpcRequest;
					if (typeof request.id !== "number") continue;
					this.requests.push(request);
					try {
						const result = this.handlers[request.method]?.(request.params) ?? {};
						if (result !== NO_RESPONSE) this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
					} catch (error) {
						this.stdout.write(
							`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`,
						);
					}
				}
				callback();
			},
		});
	}

	kill(): boolean {
		this.killed = true;
		this.emit("exit", 0, null);
		return true;
	}
}

test("parseJsonRpcLine parses responses and ignores invalid lines", () => {
	assert.equal(parseJsonRpcLine("not json"), undefined);
	assert.equal(parseJsonRpcLine(JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} })), undefined);
	assert.deepEqual(parseJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", method: "note" })), { jsonrpc: "2.0", method: "note" });
	assert.deepEqual(parseJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } })), { jsonrpc: "2.0", id: 7, result: { ok: true } });
	assert.deepEqual(parseJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 8, error: { code: -1, message: "bad", data: { retryable: false } } })), {
		jsonrpc: "2.0",
		id: 8,
		error: { code: -1, message: "bad", data: { retryable: false } },
	});
	assert.equal(parseJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 9, error: { message: "missing code" } })), undefined);
});

test("SoloMcpClient handshakes, lists catalog, and calls tools with fake helper", async () => {
	let helper!: FakeSoloHelper;
	const handlers = {
		initialize: () => ({ protocolVersion: "2024-11-05", serverInfo: { name: "fake-solo", version: "1" } }),
		"tools/list": () => ({ tools: [{ name: "identify_session" }, { name: "echo" }] }),
		"tools/call": (params: any): McpToolCallResult => {
			if (params.name === "identify_session") return { structuredContent: { process_id: 123, project: { name: "demo" } } };
			if (params.name === "echo") return { content: [{ type: "text", text: JSON.stringify({ echoed: params.arguments }) }] };
			return { isError: true, content: [{ type: "text", text: "missing" }] };
		},
	};
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 0,
		spawn: () => {
			helper = new FakeSoloHelper(handlers);
			return helper as any;
		},
	});

	await client.start();
	assert.equal(client.state, "ready");
	assert.equal(client.hasTool("echo"), true);
	assert.equal(client.identity?.process_id, 123);

	const result = await client.callTool("echo", { hello: "world" });
	assert.equal(mcpContentToText(result), JSON.stringify({ echoed: { hello: "world" } }));
	assert.equal(helper.requests.some((request) => request.method === "initialize"), true);
	assert.equal(helper.requests.some((request) => request.method === "tools/list"), true);
	assert.equal(helper.requests.some((request) => request.method === "tools/call"), true);

	client.stop();
	assert.equal(helper.killed, true);
});

test("identify_session includes only a valid numeric SOLO_PROCESS_ID", async (t) => {
	for (const scenario of [
		{ label: "numeric", value: "42", expected: { solo_process_id: 42 }, expectedEnv: "42" },
		{ label: "absent", value: "", expected: {}, expectedEnv: undefined },
		{ label: "invalid", value: "not-a-process-id", expected: {}, expectedEnv: undefined },
	] as const) {
		await t.test(scenario.label, async () => {
			let helper!: FakeSoloHelper;
			let spawnedEnv!: NodeJS.ProcessEnv;
			const client = new SoloMcpClient({
				helperPath: "/fake/mcp",
				exists: () => true,
				idleCloseMs: 0,
				soloProcessId: scenario.value,
				spawn: (_command, _args, options) => {
					spawnedEnv = options.env;
					helper = new FakeSoloHelper({
						initialize: () => ({ protocolVersion: "2024-11-05" }),
						"tools/list": () => ({ tools: [{ name: "identify_session" }] }),
						"tools/call": () => ({ structuredContent: { process_id: 7 } }),
					});
					return helper as any;
				},
			});

			await client.start();
			const identify = helper.requests.find(
				(request) => request.method === "tools/call" && (request.params as any)?.name === "identify_session",
			);
			assert.deepEqual((identify?.params as any)?.arguments, scenario.expected);
			assert.equal(spawnedEnv.SOLO_PROCESS_ID, scenario.expectedEnv);
			client.stop();
		});
	}
});

test("an authoritative call during warm-up waits for handshake and catalog loading", async () => {
	let helper!: FakeSoloHelper;
	let initialized = false;
	let catalogLoaded = false;
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 0,
		requestTimeoutMs: 1_000,
		spawn: () => {
			helper = new FakeSoloHelper({
				initialize: () => NO_RESPONSE,
				"tools/list": () => {
					assert.equal(initialized, true);
					catalogLoaded = true;
					return { tools: [{ name: "echo" }] };
				},
				"tools/call": () => {
					assert.equal(catalogLoaded, true);
					return { content: [{ type: "text", text: "ready" }] };
				},
			});
			return helper as any;
		},
	});

	const warming = client.start();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(client.state, "warming");
	const operation = client.callTool("echo");
	const initialize = helper.requests.find((request) => request.method === "initialize");
	assert.ok(initialize);
	initialized = true;
	helper.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: "2024-11-05" } })}\n`);

	assert.equal(mcpContentToText(await operation), "ready");
	await warming;
	assert.equal(client.hasTool("echo"), true);
	client.stop();
});

test("idle close is followed by a lazy reconnect", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const helpers: FakeSoloHelper[] = [];
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 25,
		spawn: () => {
			const helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "echo" }] }),
				"tools/call": () => ({ content: [{ type: "text", text: "reconnected" }] }),
			});
			helpers.push(helper);
			return helper as any;
		},
	});

	await client.start();
	t.mock.timers.tick(25);
	assert.equal(helpers[0]?.killed, true);
	assert.equal(client.state, "stopped");

	const result = await client.callTool("echo");
	assert.equal(mcpContentToText(result), "reconnected");
	assert.equal(helpers.length, 2);
	assert.equal(client.state, "ready");
	client.stop();
});

test("serial calls preserve queue order and idle close waits for active and queued work", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let helper!: FakeSoloHelper;
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 25,
		requestTimeoutMs: 1_000,
		spawn: () => {
			helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "echo" }] }),
				"tools/call": () => NO_RESPONSE,
			});
			return helper as any;
		},
	});
	await client.start();

	const first = client.callTool("echo", { order: 1 });
	const second = client.callTool("echo", { order: 2 });
	await new Promise((resolve) => setImmediate(resolve));
	let calls = helper.requests.filter((request) => request.method === "tools/call");
	assert.deepEqual(calls.map((request) => (request.params as any).arguments.order), [1]);

	t.mock.timers.tick(25);
	assert.equal(helper.killed, false, "active request must prevent idle close");
	const firstRequest = calls[0]!;
	helper.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: firstRequest.id, result: { content: [{ type: "text", text: "first" }] } })}\n`);
	assert.equal(mcpContentToText(await first), "first");
	await new Promise((resolve) => setImmediate(resolve));
	calls = helper.requests.filter((request) => request.method === "tools/call");
	assert.deepEqual(calls.map((request) => (request.params as any).arguments.order), [1, 2]);

	t.mock.timers.tick(25);
	assert.equal(helper.killed, false, "queued request must be active before idle close");
	const secondRequest = calls[1]!;
	helper.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: secondRequest.id, result: { content: [{ type: "text", text: "second" }] } })}\n`);
	assert.equal(mcpContentToText(await second), "second");
	t.mock.timers.tick(25);
	assert.equal(helper.killed, true, "transport closes only after the queue drains");
	client.stop();
});

test("SoloMcpClient reconnects after stop and does not retain stale metadata", async () => {
	let spawnCount = 0;
	let catalog = [{ name: "old_tool" }];
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 0,
		spawn: () => {
			spawnCount++;
			return new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: catalog }),
			}) as any;
		},
	});

	await client.start();
	assert.equal(client.hasTool("old_tool"), true);
	client.stop();
	catalog = [{ name: "new_tool" }];
	await client.start();
	assert.equal(spawnCount, 2);
	assert.equal(client.hasTool("old_tool"), false);
	assert.equal(client.hasTool("new_tool"), true);
	client.stop();
});

test("stop aborts an in-flight startup and a later start uses a fresh transport", async () => {
	let spawnCount = 0;
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 0,
		requestTimeoutMs: 1_000,
		spawn: () => {
			spawnCount++;
			return new FakeSoloHelper(
				spawnCount === 1
					? { initialize: () => NO_RESPONSE }
					: {
							initialize: () => ({ protocolVersion: "2024-11-05" }),
							"tools/list": () => ({ tools: [{ name: "fresh_tool" }] }),
						},
			) as any;
		},
	});

	const firstStart = client.start();
	await new Promise((resolve) => setImmediate(resolve));
	client.stop();
	await assert.rejects(firstStart, /client stopped/);
	assert.equal(client.state, "stopped");

	await client.start();
	assert.equal(spawnCount, 2);
	assert.equal(client.state, "ready");
	assert.equal(client.hasTool("fresh_tool"), true);
	client.stop();
});

test("queued tool calls cannot cross a stop and start generation", async () => {
	const helpers: FakeSoloHelper[] = [];
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp", exists: () => true, idleCloseMs: 0, requestTimeoutMs: 5_000,
		spawn: () => {
			const sequence = helpers.length;
			const helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "hang" }, { name: "spawn_agent" }] }),
				"tools/call": (params: any) => sequence === 0 && params.name === "hang" ? NO_RESPONSE : {},
			});
			helpers.push(helper);
			return helper as any;
		},
	});
	await client.start();

	const hanging = client.callTool("hang");
	const staleSpawn = client.callTool("spawn_agent", { name: "stale" });
	await new Promise((resolve) => setImmediate(resolve));
	client.stop();
	const starting = client.start();
	await assert.rejects(hanging, /client stopped/);
	await assert.rejects(staleSpawn, /generation changed/);
	await starting;
	assert.equal(helpers.length, 2);
	assert.equal(helpers[1]!.requests.some((request) => request.method === "tools/call" && (request.params as any)?.name === "spawn_agent"), false);
	client.stop();
});

test("tool calls submitted while stopped cannot execute after restart", async () => {
	const helpers: FakeSoloHelper[] = [];
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp", exists: () => true, idleCloseMs: 0,
		spawn: () => {
			const helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "spawn_agent" }] }),
				"tools/call": () => ({}),
			});
			helpers.push(helper);
			return helper as any;
		},
	});
	client.stop();

	const blocked = client.callTool("spawn_agent", { name: "stale" });
	await client.start();
	await assert.rejects(blocked, /client stopped/);
	assert.equal(helpers.length, 1);
	assert.equal(helpers[0]!.requests.some((request) => request.method === "tools/call"), false);
	client.stop();
});

test("queued tool calls cannot cross restart generation", async () => {
	const helpers: FakeSoloHelper[] = [];
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp", exists: () => true, idleCloseMs: 0, requestTimeoutMs: 5_000,
		spawn: () => {
			const sequence = helpers.length;
			const helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "hang" }, { name: "send_input" }] }),
				"tools/call": (params: any) => sequence === 0 && params.name === "hang" ? NO_RESPONSE : {},
			});
			helpers.push(helper);
			return helper as any;
		},
	});
	await client.start();

	const hanging = client.callTool("hang");
	const staleSend = client.callTool("send_input", { process_id: 9, input: "stale" });
	await new Promise((resolve) => setImmediate(resolve));
	const restarting = client.restart();
	await assert.rejects(hanging, /client stopped/);
	await assert.rejects(staleSend, /generation changed/);
	await restarting;
	assert.equal(helpers.length, 2);
	assert.equal(helpers[1]!.requests.some((request) => request.method === "tools/call" && (request.params as any)?.name === "send_input"), false);
	client.stop();
});

test("cancelling a real serialized request invalidates its transport and sends queued cleanup after reconnect", async () => {
	const helpers: FakeSoloHelper[] = [];
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 0,
		requestTimeoutMs: 5_000,
		spawn: () => {
			const sequence = helpers.length;
			const helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "hang" }, { name: "close_process" }] }),
				"tools/call": (params: any) => sequence === 0 && params.name === "hang"
					? NO_RESPONSE
					: { structuredContent: { closed: params.arguments?.process_id } },
			});
			helpers.push(helper);
			return helper as any;
		},
	});
	await client.start();

	const controller = new AbortController();
	const hanging = client.callTool("hang", {}, controller.signal);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("operator cancelled"));
	await assert.rejects(hanging, /request cancelled: operator cancelled/);
	assert.equal(helpers[0]?.killed, true);

	const cleanupOutcome = await cleanupSoloProcess(client, 73, 100);
	assert.deepEqual(cleanupOutcome, { cleaned: true, diagnostic: "cleaned up Solo process #73" });
	assert.equal(helpers.length, 2);
	const cleanup = helpers[1]?.requests.find((request) => request.method === "tools/call" && (request.params as any)?.name === "close_process");
	assert.equal((cleanup?.params as any)?.arguments?.process_id, 73);
	client.stop();
});

test("concurrent cleanup attempts each receive a timeout after acquiring execution", async () => {
	const helpers: FakeSoloHelper[] = [];
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp", exists: () => true, idleCloseMs: 0, requestTimeoutMs: 5_000,
		spawn: () => {
			const sequence = helpers.length;
			const helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "close_process" }] }),
				"tools/call": (params: any) => sequence === 0 && params.arguments?.process_id === 81
					? NO_RESPONSE
					: { structuredContent: { closed: params.arguments?.process_id } },
			});
			helpers.push(helper);
			return helper as any;
		},
	});
	await client.start();

	const [first, second] = await Promise.all([
		cleanupSoloProcess(client, 81, 20),
		cleanupSoloProcess(client, 82, 100),
	]);
	assert.equal(first.cleaned, false);
	assert.match(first.diagnostic, /Solo process #81.*timed out/);
	assert.deepEqual(second, { cleaned: true, diagnostic: "cleaned up Solo process #82" });
	assert.equal(helpers.length, 2);
	assert.equal(helpers[1]!.requests.some((request) => request.method === "tools/call" && (request.params as any)?.arguments?.process_id === 82), true);
	client.stop();
});

test("request timeout invalidates transport, metadata, and includes bounded diagnostics", async () => {
	let helper!: FakeSoloHelper;
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 0,
		requestTimeoutMs: 15,
		diagnosticLimit: 32,
		spawn: () => {
			helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "hang" }] }),
				"tools/call": () => NO_RESPONSE,
			});
			return helper as any;
		},
	});

	await client.start();
	helper.stderr.write("a diagnostic message that is intentionally longer than the cap");
	await assert.rejects(client.callTool("hang"), /timed out.*diagnostics:/);
	assert.equal(client.state, "failed");
	assert.deepEqual(client.tools, []);
	assert.equal(helper.killed, true);
	assert.ok((client.lastError?.length ?? 0) < 160);
});

test("transport errors reject pending requests and clear tool metadata", async () => {
	let helper!: FakeSoloHelper;
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 0,
		spawn: () => {
			helper = new FakeSoloHelper({
				initialize: () => ({ protocolVersion: "2024-11-05" }),
				"tools/list": () => ({ tools: [{ name: "hang" }] }),
				"tools/call": () => NO_RESPONSE,
			});
			return helper as any;
		},
	});
	await client.start();
	const pending = client.callTool("hang");
	await new Promise((resolve) => setImmediate(resolve));
	helper.emit("error", new Error("broken pipe"));
	await assert.rejects(pending, /transport error: broken pipe/);
	assert.equal(client.state, "failed");
	assert.deepEqual(client.tools, []);
});

test("tool-call error detection catches MCP isError and Solo failure text", () => {
	assert.equal(soloToolResultIsError({ isError: true, content: [] }), true);
	assert.equal(soloToolResultIsError({ content: [{ type: "text", text: "Solo tool call failed: nope" }] }), true);
	assert.equal(soloToolResultIsError({ content: [{ type: "text", text: "ok" }] }), false);
});

test("SoloMcpClient reports missing helper as failed state", async () => {
	const client = new SoloMcpClient({ helperPath: "/missing", exists: () => false });
	await client.start();
	assert.equal(client.state, "failed");
	assert.match(client.lastError ?? "", /helper not found/);
});
