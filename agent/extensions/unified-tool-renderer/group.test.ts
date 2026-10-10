import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GROUP_EXCLUDE, createGroupTracker, summarize, type GroupItem } from "./group.ts";

const item = (toolName: string, status: GroupItem["status"] = "done", args: any = {}): GroupItem => ({
	id: Math.random().toString(36),
	toolName,
	args,
	status,
});

test("default exclude list", () => {
	assert.deepEqual(DEFAULT_GROUP_EXCLUDE, ["edit", "write", "Agent", "SubagentWorkflow", "ask_user_question"]);
});

test("consecutive calls join one group, first is anchor", () => {
	const t = createGroupTracker();
	t.onToolStart("a", "read", {});
	t.onToolStart("b", "grep", {});
	const a = t.lookup("a", "read", {})!;
	const b = t.lookup("b", "grep", {})!;
	assert.equal(a.group, b.group);
	assert.equal(a.isAnchor, true);
	assert.equal(b.isAnchor, false);
	assert.deepEqual(a.group.items.map((i) => i.id), ["a", "b"]);
	assert.equal(a.group.expanded, false);
});

test("excluded tool is not grouped and closes the group", () => {
	const t = createGroupTracker();
	t.onToolStart("a", "read", {});
	t.onToolStart("e", "edit", {});
	t.onToolStart("b", "read", {});
	assert.equal(t.lookup("e", "edit", {}), undefined);
	assert.notEqual(t.lookup("a", "read", {})!.group, t.lookup("b", "read", {})!.group);
});

test("closeGroup starts a new group", () => {
	const t = createGroupTracker();
	t.onToolStart("a", "read", {});
	t.closeGroup();
	t.onToolStart("b", "read", {});
	assert.notEqual(t.lookup("a", "read", {})!.group, t.lookup("b", "read", {})!.group);
});

test("onToolEnd marks done / error", () => {
	const t = createGroupTracker();
	t.onToolStart("a", "read", {});
	t.onToolStart("b", "read", {});
	t.onToolEnd("a", { isError: false });
	t.onToolEnd("b", { isError: true });
	const items = t.lookup("a", "read", {})!.group.items;
	assert.deepEqual(items.map((i) => i.status), ["done", "error"]);
});

test("lookup of unknown ids builds a render-time group, never the live one", () => {
	const t = createGroupTracker();
	const x = t.lookup("x", "read", {})!;
	const y = t.lookup("y", "grep", {})!;
	assert.equal(x.group, y.group);
	assert.equal(x.isAnchor, true);
	assert.equal(y.isAnchor, false);
	t.onToolStart("live", "read", {});
	assert.notEqual(t.lookup("live", "read", {})!.group, x.group);
});

test("render-time group is broken by an excluded call", () => {
	const t = createGroupTracker();
	const x = t.lookup("x", "read", {})!;
	assert.equal(t.lookup("e", "write", {}), undefined);
	const y = t.lookup("y", "read", {})!;
	assert.notEqual(x.group, y.group);
	assert.equal(y.isAnchor, true);
});

test("expanded is mutable per group", () => {
	const t = createGroupTracker();
	t.onToolStart("a", "read", {});
	t.lookup("a", "read", {})!.group.expanded = true;
	assert.equal(t.lookup("a", "read", {})!.group.expanded, true);
});

test("reset clears everything", () => {
	const t = createGroupTracker();
	t.onToolStart("a", "read", {});
	t.reset();
	t.onToolStart("b", "read", {});
	assert.deepEqual(t.lookup("b", "read", {})!.group.items.map((i) => i.id), ["b"]);
	assert.equal(t.lookup("b", "read", {})!.isAnchor, true);
});

test("custom exclude list", () => {
	const t = createGroupTracker({ exclude: ["bash"] });
	t.onToolStart("a", "bash", {});
	t.onToolStart("b", "edit", {});
	assert.equal(t.lookup("a", "bash", {}), undefined);
	assert.ok(t.lookup("b", "edit", {}));
});

test("group longer than maxGroupItems starts a new group", () => {
	const t = createGroupTracker({ maxGroupItems: 2 });
	for (const id of ["a", "b", "c"]) t.onToolStart(id, "read", {});
	const a = t.lookup("a", "read", {})!;
	const c = t.lookup("c", "read", {})!;
	assert.notEqual(a.group, c.group);
	assert.equal(a.group.items.length, 2);
	assert.equal(c.isAnchor, true);
});

test("maxItems evicts oldest finished groups whole", () => {
	const t = createGroupTracker({ maxItems: 3, maxGroupItems: 2 });
	for (const id of ["a", "b", "c"]) {
		t.onToolStart(id, "read", {});
		t.onToolEnd(id, {});
	}
	t.onToolStart("d", "read", {});
	// group [a,b] evicted whole; ids a,b are now unknown again (re-enter as render-time)
	assert.deepEqual(t.lookup("c", "read", {})!.group.items.map((i) => i.id), ["c", "d"]);
	const a = t.lookup("a", "read", {})!;
	assert.deepEqual(a.group.items.map((i) => i.id), ["a"]);
});

test("eviction never removes running groups", () => {
	const t = createGroupTracker({ maxItems: 2, maxGroupItems: 1 });
	t.onToolStart("a", "read", {});
	t.onToolStart("b", "read", {});
	t.onToolStart("c", "read", {});
	assert.equal(t.lookup("a", "read", {})!.group.items[0]!.id, "a");
});

test("summarize: single kinds, plural-aware", () => {
	assert.equal(summarize([item("read")]), "Read 1 file");
	assert.equal(summarize([item("read"), item("read"), item("read")]), "Read 3 files");
	assert.equal(summarize([item("grep"), item("grep")]), "Searched 2 patterns");
	assert.equal(summarize([item("bash")]), "Ran 1 command");
});

test("summarize: find and ls merge", () => {
	assert.equal(summarize([item("find"), item("ls")]), "Listed 2 paths");
});

test("summarize: tool_batch counts inner calls", () => {
	assert.equal(summarize([item("tool_batch", "done", { calls: [1, 2, 3] })]), "Ran 3 batched calls");
	assert.equal(summarize([item("tool_batch")]), "Ran 1 batched call");
});

test("summarize: mcp and other", () => {
	assert.equal(summarize([item("mcp"), item("figma__get_node")]), "Called 2 MCP tools");
	assert.equal(summarize([item("web_search")]), "Used 1 tool");
});

test("summarize: ordered by first appearance, joined with commas", () => {
	assert.equal(
		summarize([item("grep"), item("read"), item("grep"), item("read"), item("read"), item("bash")]),
		"Searched 2 patterns, read 3 files, ran 1 command",
	);
});

test("summarize: running uses progressive tense", () => {
	assert.equal(summarize([item("read"), item("read", "running"), item("grep")]), "Reading 2 files, searching 1 pattern…");
});

test("summarize: failures appended", () => {
	assert.equal(summarize([item("read"), item("read", "error")]), "Read 2 files (1 failed)");
});
