import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandLike {
	name: string;
	source: string;
}

const baseDir = dirname(fileURLToPath(import.meta.url));

export const BUNDLED_SOLO_SKILL_PATH = join(baseDir, "../skills/solo/SKILL.md");

export function hasSoloSkill(commands: Iterable<CommandLike>): boolean {
	for (const command of commands) {
		if (command.source === "skill" && command.name === "skill:solo") return true;
	}
	return false;
}
