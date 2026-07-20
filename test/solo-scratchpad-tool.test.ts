import assert from "node:assert/strict";
import test from "node:test";
import { buildScratchpadWriteArgs, prepareSoloTermScratchpadArgs, resolveScratchpadIdByName } from "../src/solo-scratchpad-args.ts";
import type { McpToolCallResult, SoloCallToolLike } from "../src/solo-mcp-client.ts";

test("prepareSoloTermScratchpadArgs accepts Solo-style snake_case aliases", () => {
	assert.deepEqual(
		prepareSoloTermScratchpadArgs({
			action: "write",
			scratchpad_id: 38,
			expected_revision: 2,
			name: "artifact/name",
			content: "done",
			tags: ["solo", 123, "review"],
		}),
		{
			action: "write",
			scratchpadId: 38,
			expectedRevision: 2,
			name: "artifact/name",
			content: "done",
			tags: ["solo", "review"],
			mode: undefined,
		},
	);
});

test("scratchpad name resolution reports a missing scratchpad_list helper", async () => {
	const client: SoloCallToolLike = {
		tools: [],
		hasTool: () => false,
		callTool: async () => { throw new Error("unexpected call"); },
	};
	await assert.rejects(resolveScratchpadIdByName(client, "artifact"), /scratchpad_list MCP tool is required/);
});

test("scratchpad name resolution preserves MCP failure diagnostics", async () => {
	const client: SoloCallToolLike = {
		tools: [],
		hasTool: (name) => name === "scratchpad_list",
		callTool: async () => ({ isError: true, content: [{ type: "text", text: "Solo scratchpads unavailable" }] }),
	};
	await assert.rejects(resolveScratchpadIdByName(client, "artifact"), /Solo scratchpads unavailable/);
});

test("buildScratchpadWriteArgs writes to an existing scratchpad by id", async () => {
	const calls: Array<{ name: string; args: any }> = [];
	const client: SoloCallToolLike = {
		tools: [],
		hasTool(name: string) {
			return ["scratchpad_read", "scratchpad_write"].includes(name);
		},
		async callTool(name: string, args: any): Promise<McpToolCallResult> {
			calls.push({ name, args });
			if (name === "scratchpad_read") {
				return { structuredContent: { found: true, scratchpad: { id: 38, name: "implementer/task", revision: 1, content: "reserved" } } };
			}
			return { structuredContent: { scratchpad_id: args.scratchpad_id, revision: 2, created: false } };
		},
	};

	const { args, error } = await buildScratchpadWriteArgs(client, {
		action: "write",
		scratchpadId: 38,
		content: "# Result\n\nDone",
	});

	assert.equal(error, undefined);
	assert.deepEqual(calls.map((call) => call.name), ["scratchpad_read"]);
	assert.deepEqual(args, {
		name: "implementer/task",
		content: "# Result\n\nDone",
		scratchpad_id: 38,
		expected_revision: 1,
	});
});
