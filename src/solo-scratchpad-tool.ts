import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { extractStructuredOrTextJson, mcpContentToText, soloToolResultIsError, type SoloCallToolLike } from "./solo-mcp-client.ts";
import {
	buildScratchpadWriteArgs,
	prepareSoloTermScratchpadArgs,
	readScratchpad,
	resolveScratchpadIdByName,
} from "./solo-scratchpad-args.ts";

const SoloTermScratchpadParams = Type.Object({
	action: Type.String({ description: "Scratchpad operation: list, read, or write." }),
	scratchpadId: Type.Optional(Type.Number({ description: "Solo scratchpad id for read/write." })),
	name: Type.Optional(Type.String({ description: "Scratchpad name/title for read/write." })),
	content: Type.Optional(Type.String({ description: "Markdown content for action=write." })),
	expectedRevision: Type.Optional(Type.Number({ description: "Optional expected revision guard for action=write." })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for action=write." })),
	mode: Type.Optional(Type.String({ description: "Read mode. Defaults to full." })),
});

type SoloTermScratchpadArgs = Static<typeof SoloTermScratchpadParams>;

export interface SoloTermScratchpadDeps {
	client: SoloCallToolLike;
	isActive: () => boolean;
	isClientReady: () => boolean;
}

function resultText(result: unknown): string {
	if (!result || typeof result !== "object") return String(result ?? "");
	const mcp = result as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
	const structured = extractStructuredOrTextJson<any>(mcp as any);
	if (structured !== undefined) return JSON.stringify(structured, null, 2);
	return mcpContentToText(mcp as any);
}

function unavailable(message: string): never {
	throw new Error(message);
}

export function registerSoloTermScratchpadTool(pi: ExtensionAPI, deps: SoloTermScratchpadDeps): void {
	pi.registerTool<typeof SoloTermScratchpadParams, Record<string, unknown>>({
		name: "solo_scratchpad",
		label: "SoloTerm Scratchpad",
		description:
			"Read, list, or write Solo scratchpads for SoloTerm subagent artifacts. Use when a SoloTerm child agent needs to save an artifact/result to Solo.",
		promptSnippet: "Read, list, or write Solo scratchpads for SoloTerm artifacts.",
		promptGuidelines: [
			"Use solo_scratchpad when a SoloTerm task prompt asks you to save an artifact to a Solo scratchpad.",
		],
		parameters: SoloTermScratchpadParams,
		prepareArguments: prepareSoloTermScratchpadArgs,
		async execute(_toolCallId, params: SoloTermScratchpadArgs, _signal: AbortSignal | undefined) {
			if (!deps.isActive()) return unavailable("SoloTerm mode is not active.");
			if (!deps.isClientReady()) return unavailable("Solo MCP is not ready or enabled.");

			const action = String(params.action ?? "").trim().toLowerCase();
			const has = (name: string) => deps.client.hasTool(name);
			try {
				if (action === "list") {
					if (!has("scratchpad_list")) return unavailable("Solo scratchpad_list MCP tool is not available.");
					const result = await deps.client.callTool("scratchpad_list", {});
					const text = resultText(result);
					if (soloToolResultIsError(result)) throw new Error(text || "scratchpad_list failed.");
					return { content: [{ type: "text" as const, text }], details: { result } };
				}

				if (action === "read") {
					if (!has("scratchpad_read")) return unavailable("Solo scratchpad_read MCP tool is not available.");
					if (params.scratchpadId == null && !params.name?.trim()) return unavailable("scratchpad read requires scratchpadId or name.");
					const scratchpadId = params.scratchpadId ?? (await resolveScratchpadIdByName(deps.client, params.name!.trim()));
					if (scratchpadId == null) return unavailable(`No Solo scratchpad found named: ${params.name}`);
					const { result } = await readScratchpad(deps.client, scratchpadId, params.mode ?? "full");
					const text = resultText(result);
					if (soloToolResultIsError(result as any)) throw new Error(text || "scratchpad_read failed.");
					return { content: [{ type: "text" as const, text }], details: { result } };
				}

				if (action === "write") {
					if (!has("scratchpad_write")) return unavailable("Solo scratchpad_write MCP tool is not available.");
					if (!params.content?.trim()) return unavailable("scratchpad write requires content.");
					if (params.scratchpadId == null && !params.name?.trim()) return unavailable("scratchpad write requires scratchpadId or name.");

					const { args, error } = await buildScratchpadWriteArgs(deps.client, params);
					if (error || !args) return unavailable(error ?? "Unable to build scratchpad_write arguments.");
					const result = await deps.client.callTool("scratchpad_write", args);
					const text = resultText(result);
					if (soloToolResultIsError(result)) throw new Error(text || "scratchpad_write failed.");
					return { content: [{ type: "text" as const, text }], details: { result } };
				}

				return unavailable(`Unknown solo_scratchpad action: ${action || "(empty)"}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return unavailable(`solo_scratchpad failed: ${message}`);
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("accent", "◫")} ${theme.fg("toolTitle", theme.bold("solo_scratchpad"))} ${theme.fg("accent", String(args.action ?? "?"))}`, 0, 0);
		},
		renderResult(result, _opts, theme, context) {
			const icon = context.isError ? theme.fg("error", "✘") : theme.fg("success", "✓");
			const content = result.content[0];
			const text = content?.type === "text" ? content.text : "";
			const first = text.split("\n").find((line) => line.trim()) ?? "scratchpad";
			return new Text(`${icon} ${theme.fg("toolTitle", theme.bold("solo_scratchpad"))} ${theme.fg(context.isError ? "error" : "dim", first.slice(0, 140))}`, 0, 0);
		},
	});
}
