import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applySoloTermToolActivation,
	getSoloTermStatusLabel,
	makeSoloTermStateEntry,
	parseSoloTermCommand,
	restoreSoloTermState,
	SOLOTERM_STATE_ENTRY,
} from "./mode.ts";
import { buildSoloTermSystemPrompt } from "./resources.ts";
import { SoloMcpClient } from "./solo-mcp-client.ts";
import { BUNDLED_SOLO_SKILL_PATH, hasSoloSkill } from "./solo-skill.ts";
import { registerSoloTermProcessTool } from "./solo-process-tool.ts";
import { registerSoloTermScratchpadTool } from "./solo-scratchpad-tool.ts";
import { registerSoloStatusTool } from "./solo-status-tool.ts";
import { registerSoloTermTaskTool } from "./solo-task-tool.ts";
import { registerSoloTermTodoTool } from "./solo-todo-tool.ts";

interface RuntimeState {
	active: boolean;
	source: "flag" | "command" | "restore";
	ctx?: ExtensionContext;
}

export default function solotermExtension(pi: ExtensionAPI): void {
	const runtime: RuntimeState = { active: true, source: "restore" };

	pi.registerFlag("soloterm", {
		description: "Ensure SoloTerm mode is enabled. Installed pi-soloterm sessions enable SoloTerm tools by default.",
		type: "boolean",
		default: false,
	});

	const client = new SoloMcpClient({
		onStateChange: () => updateStatus(runtime.ctx),
	});

	function isActive(): boolean {
		return runtime.active;
	}

	function isClientReady(): boolean {
		return client.isReady() && !client.isMcpDisabled();
	}

	registerSoloStatusTool(pi, { client, isActive });
	registerSoloTermTaskTool(pi, { client, isActive, isClientReady, getChildPiFlags: () => ["--soloterm"] });
	registerSoloTermProcessTool(pi, { client, isActive, isClientReady });
	registerSoloTermTodoTool(pi, { client, isActive, isClientReady });
	registerSoloTermScratchpadTool(pi, { client, isActive, isClientReady });

	pi.on("resources_discover", () => {
		if (hasSoloSkill(pi.getCommands())) return {};
		return { skillPaths: [BUNDLED_SOLO_SKILL_PATH] };
	});

	function updateStatus(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		const label = getSoloTermStatusLabel(runtime.active);
		if (!label) {
			ctx.ui.setStatus("soloterm", undefined);
			return;
		}

		let suffix = "";
		if (client.state === "warming") suffix = ctx.ui.theme.fg("dim", " · connecting");
		else if (client.state === "failed") suffix = ctx.ui.theme.fg("error", " · mcp error");
		else if (client.isMcpDisabled()) suffix = ctx.ui.theme.fg("warning", " · mcp disabled");
		ctx.ui.setStatus("soloterm", ctx.ui.theme.fg("accent", label) + suffix);
	}

	function applyTools(): void {
		try {
			pi.setActiveTools(applySoloTermToolActivation(pi.getActiveTools(), runtime.active));
		} catch {
			// Active tool manipulation can fail during early startup in some modes.
		}
	}

	function persistState(source: "flag" | "command" | "restore" = runtime.source): void {
		pi.appendEntry(SOLOTERM_STATE_ENTRY, makeSoloTermStateEntry(runtime.active, source));
	}

	async function setActive(active: boolean, ctx: ExtensionCommandContext, source: "command" | "flag" | "restore", reload: boolean): Promise<void> {
		runtime.active = active;
		runtime.source = source;
		applyTools();
		persistState(source);
		updateStatus(ctx);
		if (runtime.active) await client.start();
		else client.stop();
		if (reload && ctx.hasUI) {
			ctx.ui.notify(`SoloTerm ${active ? "enabled" : "disabled"}; reloading Pi resources…`, "info");
			await ctx.reload();
		} else if (ctx.hasUI) {
			ctx.ui.notify(`SoloTerm ${active ? "enabled" : "disabled"}.`, "info");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		runtime.ctx = ctx;
		const restored = restoreSoloTermState(ctx.sessionManager.getBranch(), pi.getFlag("soloterm") === true);
		runtime.active = restored.active;
		runtime.source = restored.source;
		applyTools();
		updateStatus(ctx);
		if (runtime.active) await client.start();
	});

	pi.on("session_shutdown", () => {
		client.stop();
	});

	pi.on("before_agent_start", (event) => {
		return { systemPrompt: buildSoloTermSystemPrompt(event.systemPrompt, runtime.active) };
	});

	pi.registerCommand("soloterm", {
		description: "/soloterm [on|off|status]",
		async handler(args, ctx) {
			const action = parseSoloTermCommand(args);
			if (action === "status") {
				ctx.ui.notify(
					`SoloTerm ${runtime.active ? "enabled" : "disabled"}; MCP ${client.state}${client.lastError ? ` (${client.lastError})` : ""}`,
					"info",
				);
				return;
			}
			const nextActive = action === "toggle" ? !runtime.active : action === "on";
			await setActive(nextActive, ctx, "command", true);
		},
	});
}
