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
	assert.deepEqual(DEFAULT_GROUP_EXCLUDE, ["edit", "write", "ask_user_question"]);
	assert.ok(!DEFAULT_GROUP_EXCLUDE.includes("Agent"));
	assert.ok(!DEFAULT_GROUP_EXCLUDE.includes("SubagentWorkflow"));
});

const call = (id: string, name = "read", args: any = {}) => ({ type: "toolCall", id, name, arguments: args });
const text = (t = "hello") => ({ type: "text", text: t });
const ids = (t: ReturnType<typeof createGroupTracker>, id: string) => t.lookup(id)!.group.items.map((i) => i.id);

test("consecutive calls join one group, first is anchor", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a"), call("b", "grep")]);
	const a = t.lookup("a")!;
	const b = t.lookup("b")!;
	assert.equal(a.group, b.group);
	assert.equal(a.isAnchor, true);
	assert.equal(b.isAnchor, false);
	assert.deepEqual(ids(t, "a"), ["a", "b"]);
	assert.equal(a.group.expanded, false);
});

test("lookup of unknown id is read-only and returns undefined", () => {
	const t = createGroupTracker();
	assert.equal(t.lookup("x"), undefined);
	t.onAssistantContent([call("a")]);
	assert.equal(t.lookup("x"), undefined);
	assert.deepEqual(ids(t, "a"), ["a"]);
});

test("streamed partial messages re-walked do not duplicate or reassign", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a", "read", {})]);
	t.onAssistantContent([call("a", "read", { path: "p" })]);
	t.onAssistantContent([call("a", "read", { path: "p" }), call("b")]);
	t.onAssistantContent([call("a", "read", { path: "p" }), call("b")]);
	assert.deepEqual(ids(t, "a"), ["a", "b"]);
	assert.deepEqual(t.lookup("a")!.group.items[0]!.args, { path: "p" });
});

test("text block closes the group, once", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a"), text(), call("b")]);
	t.onAssistantContent([call("a"), text(), call("b"), call("c")]);
	assert.notEqual(t.lookup("a")!.group, t.lookup("b")!.group);
	assert.deepEqual(ids(t, "b"), ["b", "c"]);
	assert.equal(t.lookup("b")!.isAnchor, true);
});

test("empty text does not close; later non-empty text does", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a"), text("")]);
	t.onAssistantContent([call("a"), text("hi"), call("b")]);
	assert.notEqual(t.lookup("a")!.group, t.lookup("b")!.group);
});

test("excluded tool is not grouped, closes the group, re-walk is stable", () => {
	const t = createGroupTracker();
	const c = [call("a"), call("e", "edit"), call("b")];
	t.onAssistantContent(c);
	t.onAssistantContent(c);
	assert.equal(t.lookup("e"), undefined);
	assert.notEqual(t.lookup("a")!.group, t.lookup("b")!.group);
	assert.equal(t.lookup("b")!.isAnchor, true);
});

test("tool-only messages across turns merge", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a")]);
	t.onAssistantContent([call("b")]);
	t.onAssistantContent([call("c")]);
	assert.deepEqual(ids(t, "a"), ["a", "b", "c"]);
});

test("user message closes the group", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a")]);
	t.onUserMessage();
	t.onAssistantContent([call("b")]);
	assert.notEqual(t.lookup("a")!.group, t.lookup("b")!.group);
});

test("closeGroup starts a new group", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a")]);
	t.closeGroup();
	t.onAssistantContent([call("b")]);
	assert.notEqual(t.lookup("a")!.group, t.lookup("b")!.group);
});

test("regression: rows before tool start; next message gets its own anchor", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("r1"), call("g2", "grep"), call("f3", "find"), call("b4", "bash")]);
	for (const id of ["r1", "g2", "f3", "b4"]) assert.ok(t.lookup(id));
	for (const [id, n] of [["r1", "read"], ["g2", "grep"], ["f3", "find"], ["b4", "bash"]]) t.onToolStart(id!, n!, {});
	assert.equal(t.lookup("r1")!.isAnchor, true);
	assert.equal(t.lookup("g2")!.isAnchor, false);
	t.closeGroup();
	t.onAssistantContent([call("b5", "bash"), call("tb6", "tool_batch")]);
	assert.equal(t.lookup("b5")!.isAnchor, true);
	assert.equal(t.lookup("tb6")!.isAnchor, false);
	assert.notEqual(t.lookup("b5")!.group, t.lookup("r1")!.group);
});

test("status: running reachable, done / error on end", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a"), call("b")]);
	assert.deepEqual(t.lookup("a")!.group.items.map((i) => i.status), ["running", "running"]);
	t.onToolStart("a", "read", {});
	t.onToolEnd("a", { isError: false });
	t.onToolEnd("b", { isError: true });
	assert.deepEqual(t.lookup("a")!.group.items.map((i) => i.status), ["done", "error"]);
});

test("replay status option and status reported before assignment", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a")], "done");
	assert.equal(t.lookup("a")!.group.items[0]!.status, "done");
	t.onToolEnd("z", { isError: true });
	t.onAssistantContent([call("a"), call("z")]);
	assert.equal(t.lookup("z")!.group.items[0]!.status, "done");
	assert.equal(t.lookup("z")!.group.items[1]!.status, "error");
});

test("expanded is mutable per group", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a")]);
	t.lookup("a")!.group.expanded = true;
	assert.equal(t.lookup("a")!.group.expanded, true);
});

test("reset clears everything", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a")]);
	t.reset();
	assert.equal(t.lookup("a"), undefined);
	t.onAssistantContent([call("b")]);
	assert.deepEqual(ids(t, "b"), ["b"]);
});

test("custom exclude list", () => {
	const t = createGroupTracker({ exclude: ["bash"] });
	t.onAssistantContent([call("a", "bash"), call("b", "edit")]);
	assert.equal(t.lookup("a"), undefined);
	assert.ok(t.lookup("b"));
});

test("group longer than maxGroupItems starts a new group", () => {
	const t = createGroupTracker({ maxGroupItems: 2 });
	t.onAssistantContent([call("a"), call("b"), call("c")]);
	assert.notEqual(t.lookup("a")!.group, t.lookup("c")!.group);
	assert.equal(t.lookup("a")!.group.items.length, 2);
	assert.equal(t.lookup("c")!.isAnchor, true);
});

test("maxItems evicts oldest finished groups whole", () => {
	const t = createGroupTracker({ maxItems: 3, maxGroupItems: 2 });
	t.onAssistantContent([call("a"), call("b"), call("c")]);
	for (const id of ["a", "b", "c"]) t.onToolEnd(id, {});
	t.onAssistantContent([call("a"), call("b"), call("c"), call("d")]);
	assert.equal(t.lookup("a"), undefined);
	assert.equal(t.lookup("b"), undefined);
	assert.deepEqual(ids(t, "c"), ["c", "d"]);
});

test("eviction never removes running groups", () => {
	const t = createGroupTracker({ maxItems: 2, maxGroupItems: 1 });
	t.onAssistantContent([call("a"), call("b"), call("c")]);
	assert.ok(t.lookup("a"));
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

test("Agent joins the group instead of closing it", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a"), call("b", "Agent"), call("c", "grep")]);
	assert.deepEqual(ids(t, "a"), ["a", "b", "c"]);
	assert.equal(t.lookup("b")!.isAnchor, false);
});

test("summarize: subagent tools", () => {
	assert.equal(summarize([item("Agent")]), "Spawned 1 agent");
	assert.equal(summarize([item("Agent"), item("Agent")]), "Spawned 2 agents");
	assert.equal(summarize([item("SubagentWorkflow")]), "Ran 1 workflow");
	assert.equal(summarize([item("SubagentWorkflow"), item("SubagentWorkflow")]), "Ran 2 workflows");
	assert.equal(summarize([item("get_subagent_result")]), "Checked 1 agent");
	assert.equal(summarize([item("get_subagent_result"), item("get_subagent_result")]), "Checked 2 agents");
	assert.equal(summarize([item("steer_subagent")]), "Steered 1 agent");
	assert.equal(summarize([item("steer_subagent"), item("steer_subagent")]), "Steered 2 agents");
});

test("summarize: subagent tools progressive tense", () => {
	assert.equal(summarize([item("Agent", "running")]), "Spawning 1 agent…");
	assert.equal(summarize([item("SubagentWorkflow", "running")]), "Running 1 workflow…");
	assert.equal(summarize([item("get_subagent_result", "running")]), "Checking 1 agent…");
	assert.equal(summarize([item("steer_subagent", "running"), item("steer_subagent")]), "Steering 2 agents…");
});

test("summarize: mixed with subagent tools", () => {
	assert.equal(summarize([item("read"), item("Agent"), item("read")]), "Read 2 files, spawned 1 agent");
	assert.equal(summarize([item("Agent", "error"), item("bash")]), "Spawned 1 agent, ran 1 command (1 failed)");
});

test("notification joins the open group and is never the anchor", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a")]);
	t.onNotification("n1");
	const g = t.lookupNotification("n1")!;
	assert.equal(g, t.lookup("a")!.group);
	assert.equal(g.items[0]!.id, "a");
	t.onNotification("n1"); // idempotent
	assert.equal(g.notices.length, 1);
	assert.equal(summarize(g.items, g.notices), "Read 1 file, 1 agent finished");
});

test("pending notification attaches to the next group", () => {
	const t = createGroupTracker();
	t.onNotification("n1");
	assert.equal(t.lookupNotification("n1"), undefined);
	t.onAssistantStart();
	t.onAssistantContent([call("a", "get_subagent_result")]);
	const g = t.lookupNotification("n1")!;
	assert.equal(g, t.lookup("a")!.group);
	assert.equal(t.lookup("a")!.isAnchor, true);
	assert.equal(summarize(g.items, g.notices), "1 agent finished, checked 1 agent");
	t.onAssistantContent([call("a", "get_subagent_result"), call("b", "get_subagent_result")]);
	assert.equal(t.lookupNotification("n1"), g);
});

test("assistant text / user message / excluded tool drop pending notifications", () => {
	for (const drop of [
		(t: ReturnType<typeof createGroupTracker>) => t.onAssistantContent([text()]),
		(t: ReturnType<typeof createGroupTracker>) => t.onUserMessage(),
		(t: ReturnType<typeof createGroupTracker>) => t.onAssistantContent([call("e", "edit")]),
	]) {
		const t = createGroupTracker();
		t.onNotification("n1");
		drop(t);
		t.onAssistantStart();
		t.onAssistantContent([call("a")]);
		assert.equal(t.lookupNotification("n1"), undefined);
		assert.equal(summarize(t.lookup("a")!.group.items, t.lookup("a")!.group.notices), "Reading 1 file…");
	}
});

test("notification does not close the group", () => {
	const t = createGroupTracker();
	t.onAssistantContent([call("a")]);
	t.onNotification("n1");
	t.onAssistantStart();
	t.onAssistantContent([call("b", "get_subagent_result")]);
	assert.deepEqual(ids(t, "a"), ["a", "b"]);
});

test("summarize: notice position keeps first-appearance order", () => {
	assert.equal(summarize([item("read"), item("get_subagent_result")], [{ at: 1 }]), "Read 1 file, 1 agent finished, checked 1 agent");
	assert.equal(summarize([item("get_subagent_result", "running")], [{ at: 0 }, { at: 1 }]), "2 agents finished, checking 1 agent…");
});

test("history replay order: notification between tool-only turns", () => {
	const t = createGroupTracker();
	t.onUserMessage();
	t.onAssistantContent([call("a", "Agent")], "done");
	t.onNotification("n1");
	t.onAssistantContent([call("b", "get_subagent_result")], "done");
	t.closeGroup();
	const g = t.lookup("a")!.group;
	assert.equal(t.lookupNotification("n1"), g);
	assert.equal(summarize(g.items, g.notices), "Spawned 1 agent, 1 agent finished, checked 1 agent");
});
