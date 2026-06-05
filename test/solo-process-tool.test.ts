import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../src/solo-process-tool.ts";

test("extractProcesses supports common Solo MCP list shapes", () => {
	assert.deepEqual(__test__.extractProcesses({ structuredContent: [{ id: 1 }] }), [{ id: 1 }]);
	assert.deepEqual(__test__.extractProcesses({ structuredContent: { processes: [{ id: 2 }] } }), [{ id: 2 }]);
	assert.deepEqual(__test__.extractProcesses({ structuredContent: { items: [{ id: 3 }] } }), [{ id: 3 }]);
});

test("close_subagents filter targets Pi --soloterm children and excludes current process", () => {
	const params = { includeExited: false };
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 10, status: "Running", name: "Task 1 Implementer", command: "pi --soloterm" }, params, 99),
		true,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 99, status: "Running", name: "Current", command: "pi --soloterm" }, params, 99),
		false,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 11, status: "Running", name: "Bare Pi", command: "pi" }, params, 99),
		false,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 13, status: "Running", name: "Path Pi", command: "/usr/local/bin/pi --soloterm" }, params, 99),
		true,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 12, status: "Exited", name: "Old Task", command: "pi --soloterm" }, params, 99),
		false,
	);
});

test("close_subagents can include explicit Solo agent records", () => {
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 20, status: "Running", name: "Claude Child", command: "claude", kind: "agent" }, { includeAllAgents: true }, 99),
		true,
	);
	assert.equal(
		__test__.matchesCloseSubagentFilter({ id: 21, status: "Running", name: "Terminal", command: "/bin/zsh", kind: "terminal" }, { includeAllAgents: true }, 99),
		false,
	);
});
