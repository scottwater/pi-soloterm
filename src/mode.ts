export const SOLOTERM_STATE_ENTRY = "soloterm-state";

export const SOLOTERM_TOOL_NAMES = ["solo_status", "solo_task", "solo_todo", "solo_scratchpad"] as const;

export type SoloTermToolName = (typeof SOLOTERM_TOOL_NAMES)[number];

export interface SoloTermStateData {
	version: 1;
	active: boolean;
	updatedAt: string;
	source: "flag" | "command" | "restore";
}

export type SoloTermCommandAction = "on" | "off" | "toggle" | "status";

export function parseSoloTermCommand(args: string | undefined): SoloTermCommandAction {
	const normalized = (args ?? "").trim().toLowerCase();
	if (!normalized) return "toggle";
	const first = normalized.split(/\s+/)[0];
	if (first === "on" || first === "enable" || first === "enabled" || first === "start") return "on";
	if (first === "off" || first === "disable" || first === "disabled" || first === "stop") return "off";
	if (first === "status" || first === "state") return "status";
	return "toggle";
}

export function makeSoloTermStateEntry(
	active: boolean,
	source: SoloTermStateData["source"],
	now = new Date(),
): SoloTermStateData {
	return {
		version: 1,
		active,
		updatedAt: now.toISOString(),
		source,
	};
}

export function normalizeStateData(value: unknown): SoloTermStateData | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<SoloTermStateData>;
	if (record.version !== 1) return null;
	if (typeof record.active !== "boolean") return null;
	return {
		version: 1,
		active: record.active,
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
		source:
			record.source === "flag" || record.source === "command" || record.source === "restore"
				? record.source
				: "restore",
	};
}

export function restoreSoloTermState(
	entries: readonly unknown[],
	flagActive: boolean,
): { active: boolean; source: SoloTermStateData["source"] } {
	if (flagActive) return { active: true, source: "flag" };

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (entry?.type !== "custom" || entry.customType !== SOLOTERM_STATE_ENTRY) continue;
		const state = normalizeStateData(entry.data);
		if (state) return { active: state.active, source: "restore" };
	}

	return { active: false, source: "restore" };
}

export function withSoloTermTools(activeTools: readonly string[]): string[] {
	const next = new Set(activeTools.filter((tool) => !SOLOTERM_TOOL_NAMES.includes(tool as SoloTermToolName)));
	for (const tool of SOLOTERM_TOOL_NAMES) next.add(tool);
	return [...next];
}

export function withoutSoloTermTools(activeTools: readonly string[]): string[] {
	return activeTools.filter((tool) => !SOLOTERM_TOOL_NAMES.includes(tool as SoloTermToolName));
}

export function applySoloTermToolActivation(activeTools: readonly string[], active: boolean): string[] {
	return active ? withSoloTermTools(activeTools) : withoutSoloTermTools(activeTools);
}

export function getSoloTermStatusLabel(active: boolean): string | undefined {
	return active ? "◫ soloterm" : undefined;
}
