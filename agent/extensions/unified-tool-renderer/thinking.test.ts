import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeThinkingRuns } from "./thinking.ts";

const L = "Thinking...";
const label = (text = L) => ` \x1b[3m\x1b[38;5;244m${text}\x1b[39m\x1b[23m`.padEnd(40) ;
const blank = () => " ".repeat(40);
const text = (t: string) => ` ${t}`.padEnd(40);
const asst = (lines: string[], lbl = L) => ({ lines, label: lbl });
const other = (lines: string[]) => ({ lines });

test("two thinking-only assistant children back to back", () => {
	const out = dedupeThinkingRuns([asst([blank(), label()]), asst([blank(), label()])]);
	assert.deepEqual(out[0], [blank(), label()]);
	assert.deepEqual(out[1], []);
});

test("labels separated by an empty child and by blank-only children", () => {
	const out = dedupeThinkingRuns([asst([label()]), other([]), other([blank()]), asst([label()])]);
	assert.deepEqual(out, [[label()], [], [blank()], []]);
});

test("a non-assistant child with content between keeps both labels", () => {
	const summary = other([" ⏺ Read 3 files"]);
	const out = dedupeThinkingRuns([asst([label()]), summary, asst([label()])]);
	assert.deepEqual(out, [[label()], [" ⏺ Read 3 files"], [label()]]);
});

test("assistant text in between keeps both labels", () => {
	const out = dedupeThinkingRuns([asst([label()]), asst([text("hello")]), asst([label()])]);
	assert.deepEqual(out, [[label()], [text("hello")], [label()]]);
	const same = dedupeThinkingRuns([asst([label(), blank(), text("hi"), blank(), label()])]);
	assert.deepEqual(same, [[label(), blank(), text("hi"), blank(), label()]]);
});

test("label, blank, label in one child → one label, blank dropped with the dup", () => {
	const out = dedupeThinkingRuns([asst([label(), blank(), label()])]);
	assert.deepEqual(out, [[label()]]);
});

test("thinking run then 'blank, label, blank, text' keeps only blank, text", () => {
	const out = dedupeThinkingRuns([asst([blank(), label()]), asst([blank(), label(), blank(), text("answer")])]);
	assert.deepEqual(out[1], [blank(), text("answer")]);
});

test("custom label matches; text merely containing the label does not", () => {
	const out = dedupeThinkingRuns([asst([label("Pondering")], "Pondering"), asst([label("Pondering")], "Pondering")]);
	assert.deepEqual(out, [[label("Pondering")], []]);
	const t = dedupeThinkingRuns([asst([label()]), asst([text("Thinking... about it")]), asst([label()])]);
	assert.deepEqual(t[1], [text("Thinking... about it")]);
	assert.deepEqual(t[2], [label()]);
});

test("OSC 133 markers on a dropped line move to the next emitted line of the same child", () => {
	const A = "\x1b]133;A\x07";
	const BC = "\x1b]133;B\x07\x1b]133;C\x07";
	const out = dedupeThinkingRuns([asst([label()]), asst([A + label(), blank(), text("answer" ) + BC])]);
	assert.deepEqual(out[1], [A + blank(), text("answer") + BC]);
});

test("OSC markers with nothing following attach to the previous emitted line", () => {
	const BC = "\x1b]133;B\x07\x1b]133;C\x07";
	const out = dedupeThinkingRuns([asst([label()]), asst([text("x"), label() + BC])]);
	// second child: text ends the run, so the label is kept → nothing dropped
	assert.deepEqual(out[1], [text("x"), label() + BC]);
	const out2 = dedupeThinkingRuns([asst([text("x"), label()]), asst([blank(), label() + BC])]);
	assert.deepEqual(out2[1], []); // whole child dropped: A and B/C vanish together, zones stay balanced
	const out3 = dedupeThinkingRuns([asst([label()]), asst([text("t"), label() + BC, blank(), label()])]);
	assert.deepEqual(out3[1], [text("t"), label() + BC]);
	const out4 = dedupeThinkingRuns([asst([label()]), asst([blank(), text("t") + "\x1b]133;B\x07", label() + BC])]);
	assert.deepEqual(out4[1], [blank(), text("t") + "\x1b]133;B\x07", label() + BC]);
});

test("shape preserved; non-assistant lines never altered", () => {
	const children = [other([label(), label()]), asst([label()]), other([label()]), asst([label()])];
	const out = dedupeThinkingRuns(children);
	assert.equal(out.length, children.length);
	assert.deepEqual(out[0], children[0].lines);
	assert.deepEqual(out[2], children[2].lines);
	assert.deepEqual(out[1], [label()]);
	assert.deepEqual(out[3], [label()]); // non-blank non-assistant line broke the run
});

const tool = (lines: string[]) => ({ lines, kind: "tool" as const });
const custom = (lines: string[]) => ({ lines, kind: "custom" as const });
const row = " ● Ran 1 command";

test("tool then assistant [blank,label,blank,text] drops the leading blank", () => {
	const out = dedupeThinkingRuns([tool([row]), asst([blank(), label(), blank(), text("hi")])]);
	assert.deepEqual(out[1], [label(), blank(), text("hi")]);
});

test("tool then thinking-only [blank,label] -> [label]", () => {
	const out = dedupeThinkingRuns([tool([row]), asst([blank(), label()])]);
	assert.deepEqual(out[1], [label()]);
});

test("custom message then assistant drops the leading blank", () => {
	const out = dedupeThinkingRuns([custom([" notice"]), asst([blank(), label(), blank(), text("x")])]);
	assert.deepEqual(out[1], [label(), blank(), text("x")]);
});

test("user/other child then assistant is unchanged", () => {
	const input = [other([" user: hi"]), asst([blank(), label(), blank(), text("x")])];
	assert.deepEqual(dedupeThinkingRuns(input)[1], [blank(), label(), blank(), text("x")]);
});

test("empty tool child looks past to the last non-blank child", () => {
	const out = dedupeThinkingRuns([tool([row]), tool([]), tool([blank()]), asst([blank(), label()])]);
	assert.deepEqual(out[3], [label()]);
	const out2 = dedupeThinkingRuns([other([" user"]), tool([]), asst([blank(), label()])]);
	assert.deepEqual(out2[2], [blank(), label()]);
});

test("assistant text first (no label) after tool is unchanged", () => {
	const out = dedupeThinkingRuns([tool([row]), asst([blank(), text("hi"), blank(), label()])]);
	assert.deepEqual(out[1], [blank(), text("hi"), blank(), label()]);
});

test("dropped duplicate label leaves no stray blanks and run tracking holds", () => {
	const out = dedupeThinkingRuns([tool([row]), asst([blank(), label()]), asst([blank(), label()]), asst([blank(), label(), blank(), text("t")])]);
	assert.deepEqual(out, [[row], [label()], [], [blank(), text("t")]]);
});
