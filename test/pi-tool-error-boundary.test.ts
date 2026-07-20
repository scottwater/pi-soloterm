import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerSoloTermProcessTool } from "../src/solo-process-tool.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: any[], stopReason: "toolUse" | "stop") {
	return {
		role: "assistant" as const,
		content,
		api: "test" as any,
		provider: "test" as any,
		model: "test",
		usage,
		stopReason,
		timestamp: 0,
	};
}

test("Pi records a representative SoloTerm operation failure as a failed tool call", async () => {
	let tool: any;
	registerSoloTermProcessTool(
		{ registerTool(definition: any) { tool = definition; } } as any,
		{
			client: { tools: [], hasTool: () => false, callTool: async () => ({}) },
			isActive: () => false,
			isClientReady: () => false,
		},
	);

	let turn = 0;
	const streamFn = async () => {
		const stream = createAssistantMessageEventStream();
		const message = turn++ === 0
			? assistant([{ type: "toolCall", id: "call-1", name: "solo_process", arguments: { action: "list" } }], "toolUse")
			: assistant([{ type: "text", text: "done" }], "stop");
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
		});
		return stream;
	};

	const messages = await runAgentLoop(
		[{ role: "user", content: "list Solo processes", timestamp: 0 }],
		{ systemPrompt: "", messages: [], tools: [tool] },
		{ model: { api: "test", provider: "test", id: "test" } as any, convertToLlm: (items) => items as any },
		() => {},
		undefined,
		streamFn as any,
	);

	const result = messages.find((message: any) => message.role === "toolResult") as any;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /SoloTerm mode is not active/);
});
