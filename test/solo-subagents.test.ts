import assert from "node:assert/strict";
import test from "node:test";
import { buildPiExtraArgs, buildSoloTaskPrompt, resolveSoloAgentTool } from "../src/solo-subagents.ts";
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
