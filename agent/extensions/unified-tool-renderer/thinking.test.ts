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

test("blank-only custom child renders as no lines", () => {
	assert.deepEqual(dedupeThinkingRuns([{ lines: ["", ""], kind: "custom" }]), [[]]);
});

test("custom child with visible content is unchanged", () => {
	assert.deepEqual(dedupeThinkingRuns([{ lines: ["", "● notice…"], kind: "custom" }]), [["", "● notice…"]]);
});

test("label flush under tool even past a dropped blank-only custom child", () => {
	const out = dedupeThinkingRuns([
		{ lines: ["tool"], kind: "tool" },
		{ lines: [""], kind: "custom" },
		{ lines: ["", "Thinking..."], label: "Thinking...", kind: "assistant" },
	]);
	assert.deepEqual(out, [["tool"], [], ["Thinking..."]]);
});

// ---- open group panel (hide labels inside, panelLines) ----

const G1 = {};
const G2 = {};
const member = (g: object, expanded = true, lines = [blank(), text("row")]) => ({ lines, kind: "tool" as const, group: g, groupExpanded: expanded });

test("thinking-only child between two members of an expanded group is hidden", () => {
	const out = dedupeThinkingRuns([member(G1), asst([blank(), label()]), member(G1)]);
	assert.deepEqual(out[1], []);
	assert.deepEqual(out[0], [blank(), text("row")]);
});

test("several thinking-only children between members are all hidden", () => {
	const out = dedupeThinkingRuns([member(G1), asst([blank(), label()]), asst([blank(), label()]), member(G1)]);
	assert.deepEqual([out[1], out[2]], [[], []]);
});

test("collapsed group keeps today's behaviour inside", () => {
	const kids = [member(G1, false), asst([blank(), label()]), member(G1, false)];
	assert.deepEqual(dedupeThinkingRuns(kids)[1], [label()]); // flush under the tool row, as before
});

test("labels before the header / after the last member are unaffected", () => {
	const out = dedupeThinkingRuns([asst([blank(), label()]), member(G1), member(G1), asst([blank(), label()])]);
	assert.deepEqual(out[0], [blank(), label()]);
	assert.deepEqual(out[3], [label()]); // flush under the tool row, as before
});

test("label between members of different groups is untouched", () => {
	const out = dedupeThinkingRuns([member(G1), asst([blank(), label()]), member(G2)]);
	assert.deepEqual(out[1], [label()]);
});

test("assistant child with visible text inside a group is left alone", () => {
	const out = dedupeThinkingRuns([member(G1), asst([blank(), text("hi")]), asst([blank(), label()]), member(G1)]);
	assert.deepEqual(out[1], [blank(), text("hi")]);
	assert.deepEqual(out[2], [blank(), label()]);
});

test("dedupe:false only hides labels inside open groups", () => {
	const kids = [asst([label()]), asst([label()]), member(G1), asst([blank(), label()]), member(G1)];
	const out = dedupeThinkingRuns(kids, { dedupe: false });
	assert.deepEqual(out.slice(0, 2), [[label()], [label()]]);
	assert.deepEqual(out[3], []);
});

import { panelLines, PANEL_PAD_X, PANEL_HEADER_GAP } from "./thinking.ts";
const fill = (l: string) => `«${l.padEnd(10)}»`;

test("panelLines: first member keeps its leading blank as top pad, last gets bottom pad", () => {
	const r = panelLines(["", "head", "row"], { first: true, last: true, fill, padX: 0, headerGap: 0 });
	assert.deepEqual(r.lines, [fill(""), fill("head"), fill("row"), fill("")]);
	assert.equal(r.shift, 0);
	assert.equal(r.bottom, true);
});

test("panelLines: first member without leading blank gets one prepended", () => {
	const r = panelLines(["head"], { first: true, last: false, fill, padX: 0, headerGap: 0 });
	assert.deepEqual(r.lines, [fill(""), fill("head")]);
	assert.equal(r.shift, 1);
});

test("panelLines: middle member drops leading blanks", () => {
	const r = panelLines(["", "row", ""], { first: false, last: false, fill, padX: 0, headerGap: 0 });
	assert.deepEqual(r.lines, [fill("row"), fill("")]);
	assert.equal(r.shift, -1);
});

test("panelLines: empty child stays empty", () => {
	assert.deepEqual(panelLines([], { first: true, last: true, fill, padX: 0, headerGap: 0 }), { lines: [], shift: 0, bottom: false, gap: 0 });
});

test("panelLines: padX indents content, blanks stay blank", () => {
	const r = panelLines(["", "head"], { first: true, last: true, fill, padX: 2, headerGap: 0 });
	assert.deepEqual(r.lines, [fill("  "), fill("  head"), fill("")]);
});

test("panelLines: header gap goes under the first non-blank line of the first member", () => {
	const r = panelLines(["", "head", "row"], { first: true, last: false, fill, padX: 0, headerGap: 1 });
	assert.deepEqual(r.lines, [fill(""), fill("head"), fill(""), fill("row")]);
	assert.equal(r.gapAt, 2);
	assert.equal(r.gap, 1);
});

test("panelLines: header gap also applies when a blank is prepended; none for later members", () => {
	const a = panelLines(["head"], { first: true, last: false, fill, padX: 0, headerGap: 2 });
	assert.deepEqual(a.lines, [fill(""), fill("head"), fill(""), fill("")]);
	assert.equal(a.shift, 1);
	const b = panelLines(["row"], { first: false, last: false, fill, padX: 0, headerGap: 1 });
	assert.deepEqual(b.lines, [fill("row")]);
	assert.equal(b.gapAt, undefined);
});

test("panelLines: defaults are PANEL_PAD_X and PANEL_HEADER_GAP", () => {
	const r = panelLines(["", "head"], { first: true, last: false, fill });
	assert.deepEqual(r.lines, [fill(" ".repeat(PANEL_PAD_X)), fill(" ".repeat(PANEL_PAD_X) + "head"), ...Array(PANEL_HEADER_GAP).fill(fill(""))]);
});
