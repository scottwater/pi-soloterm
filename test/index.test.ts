import assert from "node:assert/strict";
import test from "node:test";
import solotermExtension from "../src/index.ts";
import { SoloMcpClient } from "../src/solo-mcp-client.ts";

test("session_start starts MCP in the background without blocking the lifecycle", async () => {
	let sessionStart: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
	const pi = {
		registerFlag() {},
		registerTool() {},
		registerCommand() {},
		on(name: string, handler: typeof sessionStart) {
			if (name === "session_start") sessionStart = handler;
		},
		getActiveTools() { return []; },
		setActiveTools() {},
		appendEntry() {},
		getCommands() { return []; },
		getFlag() { return false; },
	};
	const client = new SoloMcpClient({ exists: () => false });
	let startCalled = false;
	client.start = async () => {
		startCalled = true;
		await new Promise<void>(() => {});
	};
	solotermExtension(pi as never, client);
	assert.ok(sessionStart);
	const ctx = {
		hasUI: false,
		sessionManager: { getBranch: () => [] },
		ui: { setStatus() {}, theme: { fg(_color: string, text: string) { return text; } } },
	};

	await sessionStart({}, ctx);
	assert.equal(startCalled, true);
});

test("an immediate solo_task during warm-up lazily loads the catalog", async () => {
	let sessionStart: ((event: unknown, ctx: any) => Promise<void> | void) | undefined;
	let taskTool: any;
	const toolNames = new Set<string>();
	const client = {
		state: "stopped",
		lastError: undefined,
		start() {
			this.state = "warming";
			return new Promise<void>(() => {});
		},
		stop() {},
		isReady: () => true,
		isMcpDisabled: () => false,
		hasTool: (name: string) => toolNames.has(name),
		async callTool(name: string) {
			if (name === "list_agent_tools") {
				for (const tool of ["list_agent_tools", "spawn_agent", "send_input", "get_process_status", "get_process_output", "close_process"]) toolNames.add(tool);
				return { structuredContent: { tools: [{ id: 1, name: "Pi", command: "pi" }] } };
			}
			if (name === "spawn_agent") return { structuredContent: { process_id: 91 } };
			if (name === "get_process_status") return { structuredContent: { status: "running", agent_state: { idle: true } } };
			if (name === "send_input") return {};
			throw new Error(`unexpected ${name}`);
		},
	};
	const pi = {
		registerFlag() {},
		registerTool(definition: any) { if (definition.name === "solo_task") taskTool = definition; },
		registerCommand() {},
		on(name: string, handler: any) { if (name === "session_start") sessionStart = handler; },
		getActiveTools() { return []; }, setActiveTools() {}, appendEntry() {}, getCommands() { return []; }, getFlag() { return false; },
	};
	solotermExtension(pi as never, client as never);
	await sessionStart?.({}, {
		hasUI: false,
		sessionManager: { getBranch: () => [] },
		ui: { setStatus() {}, theme: { fg(_color: string, text: string) { return text; } } },
	});
	assert.equal(client.state, "warming");
	const result = await taskTool.execute("immediate", { name: "warm", task: "go", wait: false });
	assert.equal(result.details.result.processId, 91);
	assert.equal(result.details.result.status, "started");
});

test("registered /soloterm on and off commands reload Pi resources", async () => {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const activeToolSnapshots: string[][] = [];
	const pi = {
		registerFlag() {},
		registerTool() {},
		on() {},
		registerCommand(name: string, options: { handler: typeof handler }) {
			if (name === "soloterm") handler = options.handler;
		},
		getActiveTools() {
			return activeToolSnapshots.at(-1) ?? ["read"];
		},
		setActiveTools(names: string[]) {
			activeToolSnapshots.push(names);
		},
		appendEntry() {},
		getCommands() {
			return [];
		},
	};

	const originalHelper = process.env.SOLO_MCP_HELPER;
	process.env.SOLO_MCP_HELPER = "/definitely-missing/pi-soloterm-test-mcp";
	try {
		solotermExtension(pi as never);
	} finally {
		if (originalHelper === undefined) delete process.env.SOLO_MCP_HELPER;
		else process.env.SOLO_MCP_HELPER = originalHelper;
	}
	assert.ok(handler, "real /soloterm command was registered");

	let reloads = 0;
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			theme: { fg(_color: string, text: string) { return text; } },
		},
		async reload() {
			reloads += 1;
		},
	};

	await handler("off", ctx);
	assert.equal(reloads, 1, "/soloterm off reloads exactly once");
	await handler("on", ctx);
	assert.equal(reloads, 2, "/soloterm on reloads exactly once");
	assert.deepEqual(notifications, [
		"SoloTerm disabled; reloading Pi resources…",
		"SoloTerm enabled; reloading Pi resources…",
	]);
});
