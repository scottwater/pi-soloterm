import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { BUNDLED_SOLO_SKILL_PATH, hasSoloSkill } from "../src/solo-skill.ts";

test("hasSoloSkill detects an existing Pi solo skill command", () => {
	assert.equal(hasSoloSkill([{ name: "skill:solo", source: "skill" }]), true);
	assert.equal(hasSoloSkill([{ name: "skill:solo", source: "prompt" }]), false);
	assert.equal(hasSoloSkill([{ name: "skill:other", source: "skill" }]), false);
});

test("bundled Solo skill is packaged in the repository", () => {
	assert.equal(existsSync(BUNDLED_SOLO_SKILL_PATH), true);
});
