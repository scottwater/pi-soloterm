import assert from "node:assert/strict";
import test from "node:test";
import {
	applySoloTermToolActivation,
	getSoloTermStatusLabel,
	makeSoloTermStateEntry,
	parseSoloTermCommand,
	restoreSoloTermState,
} from "../src/mode.ts";

test("parseSoloTermCommand supports common actions", () => {
	assert.equal(parseSoloTermCommand(undefined), "toggle");
	assert.equal(parseSoloTermCommand("on"), "on");
	assert.equal(parseSoloTermCommand("disable"), "off");
	assert.equal(parseSoloTermCommand("status"), "status");
});

test("tool activation adds and removes SoloTerm tools", () => {
	const enabled = applySoloTermToolActivation(["read"], true);
	assert.deepEqual(enabled, ["read", "solo_status", "solo_task", "solo_todo", "solo_scratchpad"]);
	assert.deepEqual(applySoloTermToolActivation(enabled, false), ["read"]);
});

test("restoreSoloTermState treats --soloterm as enabling SoloTerm", () => {
	assert.deepEqual(restoreSoloTermState([], true), { active: true, source: "flag" });
});

test("restoreSoloTermState reads persisted state", () => {
	const entry = { type: "custom", customType: "soloterm-state", data: makeSoloTermStateEntry(true, "command") };
	assert.deepEqual(restoreSoloTermState([entry], false), { active: true, source: "restore" });
});

test("status label shows only SoloTerm state", () => {
	assert.equal(getSoloTermStatusLabel(false), undefined);
	assert.equal(getSoloTermStatusLabel(true), "◫ soloterm");
});
