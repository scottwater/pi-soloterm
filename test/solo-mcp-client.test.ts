import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
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
