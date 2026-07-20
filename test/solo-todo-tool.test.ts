import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { SoloMcpClient, type JsonRpcRequest } from "../src/solo-mcp-client.ts";
import { registerSoloTermTodoTool } from "../src/solo-todo-tool.ts";

interface Call {
	name: string;
	args: any;
}

function harness(options: {
	branch?: unknown[];
	tools?: string[];
	ready?: boolean;
	callTool?: (name: string, args: any) => Promise<any>;
} = {}) {
	let tool: any;
	let sessionStart: ((event: unknown, context: any) => void) | undefined;
	const entries: Array<{ customType: string; data: any }> = [];
	const calls: Call[] = [];
	const tools = options.tools ?? ["todo_create", "todo_list", "todo_update", "todo_complete"];
	const client = {
		tools: tools.map((name) => ({ name })),
		hasTool: (name: string) => tools.includes(name),
		callTool: async (name: string, args: any) => {
			calls.push({ name, args });
			return options.callTool ? options.callTool(name, args) : { structuredContent: {} };
		},
	};
	registerSoloTermTodoTool({
		registerTool(definition: any) { tool = definition; },
		on(name: string, handler: any) { if (name === "session_start") sessionStart = handler; },
		appendEntry(customType: string, data: any) { entries.push({ customType, data }); },
	} as any, { client, isActive: () => true, isClientReady: () => options.ready ?? true });
	sessionStart?.({}, { sessionManager: { getBranch: () => options.branch ?? [] } });
	return { tool, entries, calls };
}

const NO_RESPONSE = Symbol("no response");

class FakeSoloHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	requests: JsonRpcRequest[] = [];
	stdin: Writable;
	private readonly handlers: Record<string, (params: any) => unknown>;

	constructor(handlers: Record<string, (params: any) => unknown>) {
		super();
		this.handlers = handlers;
		this.stdin = new Writable({
			write: (chunk, _encoding, callback) => {
				for (const line of String(chunk).split("\n")) {
					if (!line.trim()) continue;
					const request = JSON.parse(line) as JsonRpcRequest;
					if (typeof request.id !== "number") continue;
					this.requests.push(request);
					const result = this.handlers[request.method]?.(request.params) ?? {};
					if (result !== NO_RESPONSE) this.respond(request.id, result);
				}
				callback();
			},
		});
	}

	respond(id: number, result: unknown): void {
		this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	}

	kill(): boolean {
		this.emit("exit", 0, null);
		return true;
	}
}

async function executeDuringRealClientWarmup(action: "add" | "write"): Promise<{ helper: FakeSoloHelper; entries: any[]; result: any }> {
	let helper!: FakeSoloHelper;
	const client = new SoloMcpClient({
		helperPath: "/fake/mcp",
		exists: () => true,
		idleCloseMs: 0,
		requestTimeoutMs: 1_000,
		spawn: () => {
			helper = new FakeSoloHelper({
				initialize: () => NO_RESPONSE,
				"tools/list": () => ({ tools: [{ name: "todo_create" }, { name: "todo_update" }, { name: "todo_complete" }] }),
				"tools/call": (params) => params.name === "todo_create" ? { structuredContent: { todo_id: 91 } } : { structuredContent: {} },
			});
			return helper as any;
		},
	});
	let tool: any;
	const entries: any[] = [];
	registerSoloTermTodoTool({
		registerTool(definition: any) { tool = definition; },
		on(name: string, handler: any) {
			if (name === "session_start") handler({}, { sessionManager: { getBranch: () => [] } });
		},
		appendEntry(customType: string, data: any) { entries.push({ customType, data }); },
	} as any, { client, isActive: () => true, isClientReady: () => client.isReady() });

	const warming = client.start();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(client.state, "warming");
	const operation = tool.execute("call", action === "add"
		? { action, id: "warm", title: "Warm add" }
		: { action, items: [{ id: "warm", title: "Warm write" }] });
	const initialize = helper.requests.find((request) => request.method === "initialize");
	assert.ok(initialize);
	helper.respond(initialize.id, { protocolVersion: "2024-11-05" });
	const result = await operation;
	await warming;
	client.stop();
	return { helper, entries, result };
}

test("add and write during real SoloMcpClient warm-up join catalog loading", async (t) => {
	for (const action of ["add", "write"] as const) {
		await t.test(action, async () => {
			const { helper, entries, result } = await executeDuringRealClientWarmup(action);
			const create = helper.requests.find((request) => request.method === "tools/call" && (request.params as any).name === "todo_create");
			assert.ok(create, "todo_create must be attempted after the catalog loads");
			assert.deepEqual((create.params as any).arguments, { title: action === "add" ? "Warm add" : "Warm write", tags: ["solo"], response_mode: "slim" });
			assert.equal(entries.at(-1)?.data.todos[0].soloTodoId, 91);
			assert.equal(result.details.backend, "solo+session");
		});
	}
});

test("add creates one Solo mirror and persists its binding", async () => {
	const h = harness({
		callTool: async (name) => name === "todo_create"
			? { structuredContent: { project_id: 2, todo_id: 41 } }
			: { structuredContent: {} },
	});

	const result = await h.tool.execute("call", { action: "add", title: "Ship it", priority: "high", notes: "carefully" });

	assert.equal(h.calls.filter((call) => call.name === "todo_create").length, 1);
	assert.deepEqual(h.calls[0], {
		name: "todo_create",
		args: { title: "Ship it", body: "carefully", priority: "high", tags: ["solo"], response_mode: "slim" },
	});
	assert.equal(result.details.backend, "solo+session");
	assert.equal(result.details.todos[0].soloTodoId, undefined);
	assert.doesNotMatch(JSON.stringify(result), /soloTodoId|\b41\b/);
	assert.equal(h.entries.at(-1)?.data.version, 2);
	assert.equal(h.entries.at(-1)?.data.todos[0].soloTodoId, 41);
});

function stateEntry(version: 1 | 2, todos: any[]): unknown {
	return {
		type: "custom",
		customType: "solo-todos",
		data: { version, todos, updatedAt: "2025-01-01T00:00:00.000Z" },
	};
}

test("session reconstruction migrates version-1 entries without changing local IDs", async () => {
	const h = harness({
		branch: [stateEntry(1, [{ id: "local-1", title: "Restored", status: "active" }])],
	});

	const result = await h.tool.execute("call", { action: "list" });

	assert.match(result.content[0].text, /local-1 — Restored/);
	assert.deepEqual(result.details.todos, [{
		id: "local-1",
		title: "Restored",
		status: "in_progress",
		priority: undefined,
		tags: undefined,
		notes: undefined,
	}]);
	assert.deepEqual(h.calls, []);
});

test("repeated write preserves a binding, updates the mirror, and never creates a duplicate", async () => {
	const h = harness({
		branch: [stateEntry(2, [{ id: "local-1", title: "Original", status: "pending", soloTodoId: 41 }])],
		callTool: async () => ({ structuredContent: { todo_id: 41 } }),
	});
	const items = [{ id: "local-1", title: "Revised", status: "in_progress", notes: "new body" }];

	await h.tool.execute("first", { action: "write", items });
	const result = await h.tool.execute("second", { action: "write", items });

	assert.equal(h.calls.filter((call) => call.name === "todo_create").length, 0);
	assert.equal(h.calls.filter((call) => call.name === "todo_update").length, 2);
	assert.equal(h.calls[0]?.args.todo_id, 41);
	assert.equal(h.calls[0]?.args.status, "in_progress");
	assert.equal(result.details.todos[0].soloTodoId, undefined);
	assert.equal(h.entries.at(-1)?.data.todos[0].soloTodoId, 41);
});

test("repeated write creates an initially unbound item only once", async () => {
	const h = harness({
		callTool: async (name) => name === "todo_create"
			? { content: [{ type: "text", text: JSON.stringify({ project_id: 2, todo_id: 52 }) }] }
			: { structuredContent: { todo_id: 52 } },
	});
	const items = [{ id: "stable", title: "One mirror", status: "pending" }];

	await h.tool.execute("first", { action: "write", items });
	await h.tool.execute("second", { action: "write", items });

	assert.equal(h.calls.filter((call) => call.name === "todo_create").length, 1);
	assert.equal(h.calls.filter((call) => call.name === "todo_update").length, 1);
	assert.equal(h.entries.at(-1)?.data.todos[0].soloTodoId, 52);
});

test("write reports retained Solo mirrors for locally removed items", async () => {
	const h = harness({
		branch: [stateEntry(2, [{ id: "removed", title: "Removed", status: "pending", soloTodoId: 61 }])],
	});

	const result = await h.tool.execute("call", { action: "write", items: [] });

	assert.equal(result.details.backend, "session");
	assert.match(result.details.diagnostics[0], /not deleted: removed/);
	assert.match(result.content[0].text, /Mirror warnings:.*not deleted: removed/s);
	assert.doesNotMatch(JSON.stringify(result), /soloTodoId|\b61\b/);
	assert.deepEqual(h.calls, []);
});

test("write ignores caller-supplied private Solo bindings", async () => {
	const h = harness({ callTool: async () => ({ structuredContent: { todo_id: 62 } }) });

	const result = await h.tool.execute("call", {
		action: "write",
		items: [{ id: "public", title: "Safe", soloTodoId: 999 }],
	});

	assert.equal(h.calls[0]?.name, "todo_create");
	assert.equal(result.details.todos[0].soloTodoId, undefined);
	assert.equal(h.entries.at(-1)?.data.todos[0].soloTodoId, 62);
});

test("update synchronizes the mapped Solo todo using its numeric binding", async () => {
	const h = harness({
		branch: [stateEntry(2, [{ id: "public-id", title: "Before", status: "pending", soloTodoId: 73 }])],
		callTool: async () => ({ structuredContent: { project_id: 2, todo_id: 73 } }),
	});

	const result = await h.tool.execute("call", { action: "update", id: "public-id", title: "After", status: "in_progress", priority: "high" });

	assert.deepEqual(h.calls.map((call) => call.name), ["todo_update"]);
	assert.equal(h.calls[0]?.args.todo_id, 73);
	assert.equal(h.calls[0]?.args.title, "After");
	assert.equal(h.calls[0]?.args.status, "in_progress");
	assert.equal(result.details.backend, "solo+session");
});

test("complete synchronizes completion to the mapped Solo todo", async () => {
	const h = harness({
		branch: [stateEntry(2, [{ id: "public-id", title: "Finish", status: "pending", soloTodoId: 84 }])],
		callTool: async () => ({ structuredContent: { project_id: 2, todo_id: 84 } }),
	});

	const result = await h.tool.execute("call", { action: "complete", id: "public-id" });

	assert.deepEqual(h.calls.map((call) => call.name), ["todo_update", "todo_complete"]);
	assert.deepEqual(h.calls[1]?.args, { todo_id: 84, completed: true, response_mode: "slim" });
	assert.equal(result.details.todos[0].status, "completed");
});

test("mirror failure keeps authoritative local state and reports the Solo diagnostic", async () => {
	const h = harness({
		callTool: async () => ({ isError: true, content: [{ type: "text", text: "Solo database unavailable" }] }),
	});

	const result = await h.tool.execute("call", { action: "add", id: "local-only", title: "Keep me" });

	assert.equal(result.details.backend, "session");
	assert.match(result.details.diagnostics[0], /Solo database unavailable/);
	assert.match(result.content[0].text, /Mirror warnings:.*Solo database unavailable/s);
	assert.equal(result.details.todos[0].id, "local-only");
	assert.equal(result.details.todos[0].soloTodoId, undefined);
	assert.equal(h.entries.at(-1)?.data.todos[0].id, "local-only");
});

test("list always exposes authoritative local IDs and never queries Solo", async () => {
	const h = harness({
		branch: [stateEntry(2, [{ id: "local-public", title: "Bound", status: "pending", soloTodoId: 999 }])],
		callTool: async () => ({ structuredContent: { todos: [{ id: 999, title: "Bound" }] } }),
	});

	const result = await h.tool.execute("call", { action: "list" });

	assert.match(result.content[0].text, /local-public/);
	assert.doesNotMatch(result.content[0].text, /\b999\b/);
	assert.equal(result.details.todos[0].id, "local-public");
	assert.deepEqual(h.calls, []);
});

test("clear is honestly local-only and leaves no authoritative todos", async () => {
	const h = harness({ branch: [stateEntry(2, [{ id: "one", title: "One", status: "pending", soloTodoId: 1 }])] });

	const result = await h.tool.execute("call", { action: "clear" });

	assert.equal(result.details.backend, "session");
	assert.match(result.content[0].text, /session todos only.*not deleted/i);
	assert.deepEqual(result.details.todos, []);
	assert.deepEqual(h.entries.at(-1)?.data.todos, []);
	assert.deepEqual(h.calls, []);
});

test("add rejects empty and duplicate caller IDs before persistence or mirroring", async () => {
	const h = harness({ branch: [stateEntry(2, [{ id: "taken", title: "Existing", status: "pending" }])] });

	await assert.rejects(h.tool.execute("empty", { action: "add", id: "   ", title: "Empty" }), /add id must be non-empty/);
	await assert.rejects(h.tool.execute("duplicate", { action: "add", id: "taken", title: "Duplicate" }), /unique id.*taken/);
	assert.deepEqual(h.entries, []);
	assert.deepEqual(h.calls, []);
});

test("write rejects empty and duplicate caller IDs before persistence or mirroring", async () => {
	const h = harness();

	await assert.rejects(h.tool.execute("empty", { action: "write", items: [{ id: "", title: "Empty" }] }), /item 1 id must be non-empty/);
	await assert.rejects(h.tool.execute("duplicate", {
		action: "write",
		items: [{ id: "same", title: "One" }, { id: " same ", title: "Two" }],
	}), /unique ids.*same/);
	assert.deepEqual(h.entries, []);
	assert.deepEqual(h.calls, []);
});

test("session reconstruction deterministically sanitizes empty and duplicate legacy IDs", async () => {
	const branch = [stateEntry(1, [
		{ id: "", title: "Empty", status: "pending" },
		{ id: "dup", title: "First", status: "pending" },
		{ id: "dup", title: "Second", status: "pending" },
		{ title: "Missing", status: "pending" },
	])];
	const first = await harness({ branch }).tool.execute("first", { action: "list" });
	const second = await harness({ branch }).tool.execute("second", { action: "list" });
	const ids = first.details.todos.map((todo: any) => todo.id);

	assert.deepEqual(ids, ["legacy-todo-1", "dup", "legacy-todo-3", "legacy-todo-4"]);
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual(second.details.todos, first.details.todos);
});

test("new Solo binding is persisted before a failing status follow-up", async () => {
	let h: ReturnType<typeof harness>;
	h = harness({
		callTool: async (name) => {
			if (name === "todo_create") return { structuredContent: { todo_id: 77 } };
			assert.equal(h.entries.at(-1)?.data.todos[0].soloTodoId, 77, "binding must be durable before todo_update");
			throw new Error("follow-up failed for Solo todo 77");
		},
	});

	const result = await h.tool.execute("call", { action: "add", id: "bound", title: "Bound", status: "in_progress" });

	assert.deepEqual(h.calls.map((call) => call.name), ["todo_create", "todo_update"]);
	assert.equal(h.entries.at(-1)?.data.todos[0].soloTodoId, 77);
	assert.match(result.content[0].text, /Mirror warnings:.*follow-up failed.*private Solo binding/s);
	assert.doesNotMatch(JSON.stringify(result), /soloTodoId|\b77\b/);
});

test("renderer shows mirror diagnostics as warnings without marking the tool call failed", async () => {
	const h = harness({ ready: false });
	const result = await h.tool.execute("call", { action: "add", id: "local", title: "Local" });
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text };
	const rendered = h.tool.renderResult(result, {}, theme, { isError: false }).render(200).join("\n");

	assert.match(result.content[0].text, /Mirror warnings:.*not ready/s);
	assert.deepEqual(result.details.diagnostics, ["Solo client is not ready; todo remains local only"]);
	assert.match(rendered, /<warning>⚠<\/warning>/);
	assert.match(rendered, /1 mirror warning/);
	assert.doesNotMatch(rendered, /<error>|✘/);
});

test("execute generates collision-resistant unique local IDs", async () => {
	const h = harness({ ready: false });

	const first = await h.tool.execute("first", { action: "add", title: "Same title" });
	const second = await h.tool.execute("second", { action: "add", title: "Same title" });

	const firstId = first.details.todos[0].id;
	const secondId = second.details.todos[1].id;
	assert.match(firstId, /^todo-[0-9a-f-]{36}$/);
	assert.match(secondId, /^todo-[0-9a-f-]{36}$/);
	assert.notEqual(firstId, secondId);
});
