import assert from "node:assert/strict";
import test from "node:test";
import solotermExtension from "../src/index.ts";

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
