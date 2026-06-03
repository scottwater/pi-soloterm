import {
	extractStructuredOrTextJson,
	mcpContentToText,
	soloToolResultIsError,
	type SoloCallToolLike,
} from "./solo-mcp-client.ts";

export interface PreparedScratchpadArgs {
	action: string;
	scratchpadId?: number;
	name?: string;
	content?: string;
	expectedRevision?: number;
	tags?: string[];
	mode?: string;
}

function parseOptionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export function prepareSoloTermScratchpadArgs(args: unknown): PreparedScratchpadArgs {
	const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	return {
		action: String(input.action ?? ""),
		scratchpadId: parseOptionalNumber(input.scratchpadId) ?? parseOptionalNumber(input.scratchpad_id),
		name: typeof input.name === "string" ? input.name : undefined,
		content: typeof input.content === "string" ? input.content : undefined,
		expectedRevision: parseOptionalNumber(input.expectedRevision) ?? parseOptionalNumber(input.expected_revision),
		tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
		mode: typeof input.mode === "string" ? input.mode : undefined,
	};
}

export async function resolveScratchpadIdByName(client: SoloCallToolLike, name: string): Promise<number | undefined> {
	if (!client.hasTool("scratchpad_list")) return undefined;
	const result = await client.callTool("scratchpad_list", {});
	if (soloToolResultIsError(result)) return undefined;
	const data = extractStructuredOrTextJson<any>(result);
	const scratchpads = Array.isArray(data?.scratchpads) ? data.scratchpads : Array.isArray(data) ? data : [];
	const match = scratchpads.find((scratchpad: any) => scratchpad?.name === name);
	return typeof match?.id === "number" ? match.id : undefined;
}

export async function readScratchpad(
	client: SoloCallToolLike,
	scratchpadId: number,
	mode = "full",
): Promise<{ result: unknown; data: any }> {
	const result = await client.callTool("scratchpad_read", { scratchpad_id: scratchpadId, mode });
	return { result, data: extractStructuredOrTextJson<any>(result) };
}

export async function buildScratchpadWriteArgs(
	client: SoloCallToolLike,
	params: PreparedScratchpadArgs,
): Promise<{ args?: Record<string, unknown>; error?: string }> {
	let name = params.name?.trim();
	let expectedRevision = params.expectedRevision;
	if (params.scratchpadId != null && client.hasTool("scratchpad_read") && (!name || expectedRevision == null)) {
		const { result, data } = await readScratchpad(client, params.scratchpadId, "full");
		if (soloToolResultIsError(result as any)) {
			return { error: `Unable to read scratchpad ${params.scratchpadId} before write: ${mcpContentToText(result as any)}` };
		}
		name ??= typeof data?.scratchpad?.name === "string" ? data.scratchpad.name : undefined;
		expectedRevision ??= typeof data?.scratchpad?.revision === "number" ? data.scratchpad.revision : undefined;
	}
	if (!name) return { error: "scratchpad write requires name; Solo scratchpad_write always requires name even when scratchpadId is provided." };

	const args: Record<string, unknown> = {
		name,
		content: params.content,
	};
	if (params.tags) args.tags = params.tags;
	if (params.scratchpadId != null) args.scratchpad_id = params.scratchpadId;
	if (expectedRevision != null) args.expected_revision = expectedRevision;
	return { args };
}
