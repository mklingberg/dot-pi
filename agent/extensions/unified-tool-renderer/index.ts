/**
 * Unified tool renderer.
 *
 * Gives every tool that has NO renderer from any other source (another
 * extension's resolver, the tool's own definition, Pi built-ins) a compact
 * renderer styled after @vanillagreen/pi-tool-renderer's generic style
 * (copied, not imported): status bullet + humanized name + one-line arg
 * summary, and a tree-connector result preview expandable with ctrl+o.
 *
 * Tools that already define renderCall AND renderResult are returned untouched.
 *
 * Chrome interplay: pi-tool-renderer patches ToolExecutionComponent and wraps
 * renderShell === "self" tools with its own rules/padding. So we emit only
 * plain content lines (no rules, no box) and request renderShell "self" so Pi's
 * default padded/background Box isn't drawn around it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type SettingItem, SettingsList, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { installThinkingDedupe } from "./thinking.ts";
import { createGroupTracker, DEFAULT_GROUP_EXCLUDE, leadingNoticeKey, summarize, rowExpanded, syncExpandEdge, toggleFlip, type ToolGroup } from "./group.ts";

const BULLET = "● ";
const TREE_LAST = "  └─ ";
const TREE_STEM = "  │  ";
const MAX_LINE = 1000;

type CollapsedMode = "count" | "first-line" | "hidden";

interface Settings {
	enabled: boolean;
	previewLines: string;
	collapsed: CollapsedMode;
	summaryWidth: string;
	/** Master switch for the header takeover feature. */
	headerTakeover: boolean;
	/** Tools whose renderCall is replaced by ours (their renderResult is kept). Edit in the JSON file. */
	headerTools: string[];
	/** Restyle pi-subagents completion notifications. Registered at load → needs /reload. */
	notificationTakeover: boolean;
	/** Render subagent notifications as one line while collapsed (ctrl+o expands). Applies live. */
	notificationCollapsed: boolean;
	/** Collapse runs of consecutive tool calls into one Claude-style summary line. New rows only. */
	grouping: boolean;
	/** Tools never grouped (they render as before and end the current run). Edit in the JSON file. */
	groupExclude: string[];
	/** Collapse consecutive hidden-thinking labels to one per run. Applies live. */
	dedupeThinking: boolean;
}

const COLLAPSED_MODES: CollapsedMode[] = ["count", "first-line", "hidden"];
const PREVIEW_VALUES = ["20", "40", "80", "200"];
const WIDTH_VALUES = ["48", "72", "120"];

const DEFAULT_SETTINGS: Settings = {
	enabled: true,
	previewLines: "80",
	collapsed: "count",
	summaryWidth: "72",
	headerTakeover: true,
	// pi-subagents SUBAGENT_TOOL_NAMES.AGENT and .WORKFLOW
	headerTools: ["Agent", "SubagentWorkflow"],
	notificationTakeover: true,
	notificationCollapsed: true,
	grouping: true,
	groupExclude: [...DEFAULT_GROUP_EXCLUDE],
	dedupeThinking: true,
};

function settingsPath(): string {
	try {
		return path.join(getAgentDir(), "unified-tool-renderer.json");
	} catch {
		return path.join(os.homedir(), ".pi", "agent", "unified-tool-renderer.json");
	}
}

function loadSettings(): Settings {
	try {
		const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
		const s = { ...DEFAULT_SETTINGS, ...raw };
		s.enabled = s.enabled !== false && s.enabled !== "false";
		if (!COLLAPSED_MODES.includes(s.collapsed)) s.collapsed = DEFAULT_SETTINGS.collapsed;
		if (!PREVIEW_VALUES.includes(String(s.previewLines))) s.previewLines = DEFAULT_SETTINGS.previewLines;
		if (!WIDTH_VALUES.includes(String(s.summaryWidth))) s.summaryWidth = DEFAULT_SETTINGS.summaryWidth;
		s.headerTakeover = s.headerTakeover !== false && s.headerTakeover !== "false";
		s.notificationTakeover = s.notificationTakeover !== false && s.notificationTakeover !== "false";
		s.notificationCollapsed = s.notificationCollapsed !== false && s.notificationCollapsed !== "false";
		s.headerTools = Array.isArray(s.headerTools) && s.headerTools.every((t: unknown) => typeof t === "string")
			? [...s.headerTools]
			: [...DEFAULT_SETTINGS.headerTools];
		s.grouping = s.grouping !== false && s.grouping !== "false";
		s.groupExclude = Array.isArray(s.groupExclude) && s.groupExclude.every((t: unknown) => typeof t === "string")
			? [...s.groupExclude]
			: [...DEFAULT_GROUP_EXCLUDE];
		s.dedupeThinking = s.dedupeThinking !== false && s.dedupeThinking !== "false";
		s.previewLines = String(s.previewLines);
		s.summaryWidth = String(s.summaryWidth);
		return s;
	} catch {
		return { ...DEFAULT_SETTINGS, headerTools: [...DEFAULT_SETTINGS.headerTools], groupExclude: [...DEFAULT_GROUP_EXCLUDE] };
	}
}

function saveSettings(settings: Settings): void {
	try {
		fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
	} catch {}
}

// Live in-memory settings; renderers read this at render time.
const settings: Settings = loadSettings();

type Ctx = {
	executionStarted?: boolean;
	isPartial?: boolean;
	isError?: boolean;
};

class Lines {
	private readonly lines: string[];
	constructor(text: string) {
		this.lines = text ? text.split("\n") : [];
	}
	invalidate(): void {}
	render(width: number): string[] {
		const w = Math.max(1, width);
		return this.lines.flatMap((line) => {
			const wrapped = wrapTextWithAnsi(line, w);
			return wrapped.length > 0 ? wrapped : [""];
		});
	}
}

const empty = () => new Lines("");

function humanizeToolName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function oneLine(value: string, max = 72): string {
	return truncate(value.replace(/\s+/g, " ").trim(), max);
}

function stringArg(args: any, ...keys: string[]): string {
	for (const key of keys) {
		const v = args?.[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

function summarizeCall(_name: string, args: any, theme: Theme, width: number): string {
	let arg = stringArg(args, "path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt", "summary", "question");
	if (!arg) {
		for (const key of ["questions", "items", "tasks"]) {
			const first = Array.isArray(args?.[key]) ? args[key][0] : undefined;
			if (first && typeof first === "object") arg = stringArg(first, "question", "header", "title", "description");
			else if (typeof first === "string") arg = first.trim();
			if (arg) break;
		}
	}
	return arg ? theme.fg("accent", oneLine(arg, width)) : "";
}

function textContent(result: any): string {
	const part = result?.content?.find?.((c: any) => c?.type === "text" && typeof c.text === "string");
	return part?.text ?? "";
}

function splitLines(text: string): string[] {
	return text.replace(/\r\n?/g, "\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\t/g, "  ").split("\n");
}

function statusPrefix(theme: Theme, ctx: Ctx): string {
	if (!ctx?.executionStarted || ctx?.isPartial) return theme.fg("warning", BULLET);
	return theme.fg(ctx?.isError ? "error" : "success", BULLET);
}

// Per-tool overrides for the header title / summary (otherwise generic).
const HEADER_OVERRIDES: Record<string, { title?: (args: any) => string; summary?: (args: any) => string }> = {
	Agent: {
		title: (args) => stringArg(args, "subagent_type"),
		summary: (args) => stringArg(args, "description"),
	},
};

function unifiedCall(name: string): NonNullable<ToolRenderers["renderCall"]> {
	return (args, theme, context) => {
		const override = HEADER_OVERRIDES[name];
		const title = override?.title?.(args) || humanizeToolName(name);
		const custom = override?.summary?.(args);
		const summary = custom ? theme.fg("accent", oneLine(custom, Number(settings.summaryWidth))) : summarizeCall(name, args, theme, Number(settings.summaryWidth));
		return new Lines(`${statusPrefix(theme, context as Ctx)}${theme.fg("text", theme.bold(title))} ${summary}`.trimEnd());
	};
}

/**
 * Wraps a foreign result component: lines whose visible text starts with a
 * non-space get a 2-space indent (rendered at width-2). Already-indented and
 * blank lines are left alone. Delegates every render so live updates work.
 */
class IndentResult implements Component {
	constructor(private readonly inner: Component) {}
	invalidate(): void {
		this.inner.invalidate();
	}
	render(width: number): string[] {
		const lines = this.inner.render(Math.max(1, width - 2));
		return lines.map((line) => {
			const visible = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
			return visible.length > 0 && !/^\s/.test(visible) ? `  ${line}` : line;
		});
	}
}

function takeoverResult(inner: NonNullable<ToolRenderers["renderResult"]>): NonNullable<ToolRenderers["renderResult"]> {
	return (result, options, theme, context) => new IndentResult(inner(result, options, theme, context));
}

function unifiedResult(name: string): NonNullable<ToolRenderers["renderResult"]> {
	return (result, { expanded, isPartial }, theme, context) => {
		const connector = (last: boolean) => theme.fg("muted", last ? TREE_LAST : TREE_STEM);
		if (isPartial) return new Lines(`${connector(true)}${theme.fg("warning", `${humanizeToolName(name)}…`)}`);
		const raw = textContent(result).trim();
		const lines = raw ? splitLines(raw) : [];
		if ((context as Ctx)?.isError) {
			return new Lines(`${connector(true)}${theme.fg("error", truncate(lines[0] || `${humanizeToolName(name)} failed`, MAX_LINE))}`);
		}
		if (lines.length === 0) return new Lines(`${connector(true)}${theme.fg("success", "done")}`);
		if (lines.length === 1) return new Lines(`${connector(true)}${theme.fg("muted", oneLine(lines[0]!, 120))}`);
		const previewLines = Number(settings.previewLines);
		let text = `${connector(true)}${theme.fg("success", `${lines.length} lines returned`)}`;
		if (expanded) {
			text += `\n${lines.slice(0, previewLines).map((l) => `${connector(false)}${theme.fg("dim", truncate(l, MAX_LINE))}`).join("\n")}`;
			if (lines.length > previewLines) text += `\n${connector(false)}${theme.fg("muted", `… ${lines.length - previewLines} more line(s)`)}`;
		} else if (settings.collapsed === "hidden") {
			return empty();
		} else if (settings.collapsed === "first-line") {
			text = `${connector(true)}${theme.fg("muted", oneLine(lines[0]!, 120))}${theme.fg("dim", ` · +${lines.length - 1} lines · ctrl+o to expand`)}`;
		} else {
			text += theme.fg("dim", " · ctrl+o to expand");
		}
		return new Lines(text);
	};
}

// ---- pi-subagents completion notification ("subagent-notification") ----

interface NotificationDetails {
	description?: string;
	status?: string;
	toolUses?: number;
	turnCount?: number;
	maxTurns?: number;
	totalTokens?: number;
	totalCost?: number;
	durationMs?: number;
	outputFile?: string;
	resultPreview?: string;
	others?: NotificationDetails[];
}

/**
 * pi-subagents' `showCost` lives in <agentDir>/subagents.json (global) and
 * <cwd>/.pi/subagents.json (project, overrides global). Read tolerantly at
 * render time; any failure → hidden.
 */
let showCostCache: { value: boolean; at: number } | undefined;

function readShowCost(): boolean {
	const now = Date.now();
	if (showCostCache && now - showCostCache.at < 2000) return showCostCache.value;
	const value = readShowCostUncached();
	showCostCache = { value, at: now };
	return value;
}

function readShowCostUncached(): boolean {
	let value = false;
	const files: string[] = [];
	try {
		files.push(path.join(getAgentDir(), "subagents.json"));
	} catch {
		files.push(path.join(os.homedir(), ".pi", "agent", "subagents.json"));
	}
	try {
		files.push(path.join(process.cwd(), ".pi", "subagents.json"));
	} catch {}
	for (const f of files) {
		try {
			const raw = JSON.parse(fs.readFileSync(f, "utf8"));
			if (typeof raw?.showCost === "boolean") value = raw.showCost;
		} catch {}
	}
	return value;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
	return `${n} tok`;
}

function fmtCost(cost: number): string {
	if (!(cost > 0)) return "";
	if (cost < 0.0001) return "<$0.0001";
	if (cost >= 1) return `~$${cost.toFixed(2)}`;
	const rounded = Number(cost.toFixed(4));
	const decimals = (String(rounded).split(".")[1] ?? "").length;
	return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

/** Replace homedir with ~, then shorten from the left at a "/" boundary to fit `max` columns. */
function shortenPath(file: string, max: number): string {
	const home = os.homedir();
	let p = home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file;
	if (visibleWidth(p) <= max) return p;
	const parts = p.split("/");
	for (let i = 1; i < parts.length; i++) {
		const candidate = `…/${parts.slice(i).join("/")}`;
		if (visibleWidth(candidate) <= max || i === parts.length - 1) {
			p = candidate;
			break;
		}
	}
	return visibleWidth(p) <= max ? p : truncateToWidth(p, Math.max(1, max), "…");
}

class NotificationView implements Component {
	constructor(
		private readonly details: NotificationDetails,
		private readonly expanded: boolean,
		private readonly theme: Theme,
		private readonly key: string | undefined,
		private readonly tracker: GroupTracker,
		private readonly st: GroupState,
	) {}
	invalidate(): void {}
	/** Left-click: toggle the whole group, or (standalone) this notification's own view. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (!this.key) return undefined;
		const group = settings.grouping ? this.tracker.lookupNotification(this.key) : undefined;
		// The group summary header (leading notification, first line) toggles the group; every other line only this notification.
		if (group && event.y === 0 && leadingNoticeKey(group) === this.key) toggleGroup(this.st, group);
		else toggleFlip(this.st.flipped, this.key);
		return { handled: true };
	}
	render(width: number): string[] {
		const w = Math.max(1, width);
		// Read tracker state at render time: the group may form after this component was built.
		const group = this.key && settings.grouping ? this.tracker.lookupNotification(this.key) : undefined;
		if (group && !group.expanded) return [];
		const expanded = rowExpanded(this.expanded, this.st.flipped, this.key);
		const showCost = readShowCost();
		const all = [this.details, ...(this.details.others ?? [])];
		const out: string[] = [];
		// Expanded group whose first member is this notification: it carries the summary header.
		if (group?.expanded && this.key && leadingNoticeKey(group) === this.key) out.push(truncateToWidth(summaryLine(group, this.theme, false), w, "…"));
		if (showCost && all.length > 1) {
			const total = fmtCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
			if (total) {
				const tokens = all.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0);
				out.push(truncateToWidth(this.theme.fg("dim", `${all.length} agents · ${fmtTokens(tokens)} · ${total}`), w));
			}
		}
		for (const d of all) out.push(...this.renderOne(d, w, showCost, expanded));
		return out;
	}
	private renderOne(d: NotificationDetails, w: number, showCost: boolean, expandedView: boolean): string[] {
		const theme = this.theme;
		const status = d.status ?? "completed";
		const isError = status === "error" || status === "stopped" || status === "aborted";
		const color = isError ? "error" : status === "steered" ? "warning" : "success";
		const statusText = isError ? status : status === "steered" ? "completed (steered)" : "completed";
		const parts: string[] = [];
		if ((d.turnCount ?? 0) > 0) parts.push(d.maxTurns != null ? `↻${d.turnCount}≤${d.maxTurns}` : `↻${d.turnCount}`);
		if ((d.toolUses ?? 0) > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
		if ((d.totalTokens ?? 0) > 0) parts.push(fmtTokens(d.totalTokens!));
		if (showCost) {
			const c = fmtCost(d.totalCost ?? 0);
			if (c) parts.push(c);
		}
		if ((d.durationMs ?? 0) > 0) parts.push(`${(d.durationMs! / 1000).toFixed(1)}s`);
		let header = `${theme.fg(color, BULLET)}${theme.bold(d.description ?? "Agent")} ${theme.fg("dim", statusText)}`;
		if (parts.length) header += theme.fg("dim", ` · ${parts.join(" · ")}`);
		if (!expandedView && settings.notificationCollapsed) {
			return [truncateToWidth(header + theme.fg("dim", " · ctrl+o to expand"), w, "…")];
		}
		const lines = [truncateToWidth(header, w, "…")];

		const raw = (d.resultPreview ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").trimEnd();
		let preview = raw ? raw.split("\n") : [];
		preview = expandedView ? preview.slice(0, Number(settings.previewLines)) : preview.slice(0, 1);
		const hasFile = typeof d.outputFile === "string" && d.outputFile.length > 0;
		preview.forEach((l, i) => {
			const last = !hasFile && i === preview.length - 1;
			const conn = theme.fg("muted", last ? TREE_LAST : TREE_STEM);
			lines.push(truncateToWidth(`${conn}${theme.fg("dim", l)}`, w, "…"));
		});
		if (hasFile) {
			const label = "transcript: ";
			const avail = w - visibleWidth(TREE_LAST) - label.length;
			lines.push(truncateToWidth(`${theme.fg("muted", TREE_LAST)}${theme.fg("muted", `${label}${shortenPath(d.outputFile!, Math.max(1, avail))}`)}`, w, "…"));
		}
		return lines;
	}
}

const NOTIFICATION_TYPE = "subagent-notification";
// details carry no id; the message timestamp is identical live and in session replay.
function noticeKey(message: any): string | undefined {
	const ts = message?.timestamp;
	return typeof ts === "number" && Number.isFinite(ts) ? String(ts) : undefined;
}

// ---- grouping (Claude Code style summary of consecutive tool calls) ----

// Grouping state is PER EXTENSION INSTANCE (created in the factory), never
// module-level: pi-subagents runs subagent sessions in-process and Pi reuses
// the cached module, so module state would be shared with (and clobbered by)
// the subagent's instance.
type GroupTracker = ReturnType<typeof createGroupTracker>;
interface GroupState {
	tracker: GroupTracker;
	invalidators: Map<string, () => void>;
	innerRows: Map<string, { call?: Component; result?: Component }>;
	/** Last seen ctx.expanded per tool row (edge detection for group expand). */
	seenExpanded: Map<string, boolean>;
	/** Rows / notifications whose expand state was flipped by a click (XOR with Pi's global state). */
	flipped: Set<string>;
}
const MAX_INVALIDATORS = 512;

function createGroupState(): GroupState {
	return { tracker: createGroupTracker({ exclude: settings.groupExclude }), invalidators: new Map(), innerRows: new Map(), seenExpanded: new Map(), flipped: new Set() };
}

function rememberInvalidator(st: GroupState, id: string, fn: unknown): void {
	if (typeof fn !== "function") return;
	const { invalidators } = st;
	invalidators.delete(id);
	invalidators.set(id, fn as () => void);
	while (invalidators.size > MAX_INVALIDATORS) invalidators.delete(invalidators.keys().next().value!);
}

function notify(st: GroupState, id: string | undefined): void {
	if (!id) return;
	const fn = st.invalidators.get(id);
	if (!fn) return;
	queueMicrotask(() => {
		try {
			fn();
		} catch {}
	});
}

function notifyGroup(st: GroupState, group: ToolGroup, exceptId?: string): void {
	for (const item of group.items) if (item.id !== exceptId) notify(st, item.id);
}

function toggleGroup(st: GroupState, group: ToolGroup): void {
	group.expanded = !group.expanded;
	notifyGroup(st, group);
}

/**
 * Intercepts left-clicks on a group row. Pi wraps each row component in a
 * MouseRegion that asks the child first, so handling it here pre-empts Pi's
 * per-row toggle: a row's own `ctx.expanded` then only changes via global
 * ctrl+o, which keeps syncExpandEdge a clean ctrl+o signal. The handler
 * decides (by event.y) between toggling the group and toggling just the row.
 */
class GroupClick implements Component {
	constructor(private readonly inner: Component, private readonly onClick: (event: TuiMouseEvent) => void) {}
	invalidate(): void {
		this.inner.invalidate();
	}
	render(width: number): string[] {
		return this.inner.render(width);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.onClick(event);
		return { handled: true };
	}
}

/** Adds the outputPad horizontal indent that Pi's default shell would have drawn. */
class PadLines implements Component {
	constructor(private readonly inner: Component, private readonly pad: number) {}
	invalidate(): void {
		this.inner.invalidate();
	}
	render(width: number): string[] {
		const pad = " ".repeat(this.pad);
		return this.inner.render(Math.max(1, width - this.pad * 2)).map((l) => pad + l);
	}
}

function summaryLine(group: ToolGroup, theme: Theme, hint: boolean): string {
	const running = group.items.some((i) => i.status === "running");
	const failed = group.items.some((i) => i.status === "error");
	const bullet = theme.fg(running ? "warning" : failed ? "error" : "success", BULLET);
	return `${bullet}${theme.fg("muted", summarize(group.items, group.notices))}${hint ? theme.fg("dim", " · click to expand") : ""}`;
}

function groupedRenderers(st: GroupState, name: string, inner: ToolRenderers): ToolRenderers {
	const selfShell = inner.renderShell === "self";
	const wrapBase = (c: Component, ctx: any): Component => (selfShell ? c : new PadLines(c, Number(ctx?.outputPad ?? 1)));

	// Decided on every render (never cached): rows can be built before the
	// message_update handler assigned them to a group.
	const sync = (ctx: any): { group: ToolGroup; isAnchor: boolean; show: boolean; rowId: string; rowExp: boolean } | undefined => {
		const id = String(ctx?.toolCallId ?? "");
		if (!id) return undefined;
		rememberInvalidator(st, id, ctx?.invalidate);
		const found = st.tracker.lookup(id);
		if (!found) return undefined;
		// Edge-triggered: a row's own click / global ctrl+o drives group.expanded;
		// group.expanded is then the single source of truth for every member.
		if (syncExpandEdge(found.group, st.seenExpanded, id, Boolean(ctx?.expanded), 512, st.flipped)) notifyGroup(st, found.group, id);
		return { ...found, show: found.group.expanded, rowId: id, rowExp: rowExpanded(Boolean(ctx?.expanded), st.flipped, id) };
	};

	// Pi hands back whatever we returned as context.lastComponent; inner
	// renderers (`context.lastComponent ?? new Text()` + setText) must only
	// ever see components they produced themselves.
	const innerRecord = (ctx: any): { call?: Component; result?: Component } | undefined => {
		const id = String(ctx?.toolCallId ?? "");
		if (!id) return undefined;
		let rec = st.innerRows.get(id);
		if (!rec) {
			rec = {};
			st.innerRows.set(id, rec);
			while (st.innerRows.size > MAX_INVALIDATORS) st.innerRows.delete(st.innerRows.keys().next().value!);
		}
		return rec;
	};
	const runInner = (slot: "call" | "result", fn: ((...a: any[]) => Component) | undefined, ctx: any, call: (c: any) => Component, expanded?: boolean): Component => {
		const rec = innerRecord(ctx);
		const clean = { ...ctx, lastComponent: rec?.[slot], ...(expanded === undefined ? {} : { expanded }) };
		const out = call(clean);
		if (rec) rec[slot] = out;
		return out;
	};

	return {
		...inner,
		renderShell: "self",
		renderCall: (args, theme, context) => {
			let rowExp: boolean | undefined;
			const run = () =>
				runInner("call", inner.renderCall as any, context, (c) => (inner.renderCall ?? unifiedCall(name))(args, theme, c), rowExp);
			try {
				const g = sync(context);
				if (!g) return wrapBase(run(), context);
				const toggleRow = () => {
					toggleFlip(st.flipped, g.rowId);
					notify(st, g.rowId);
				};
				if (!g.show) return g.isAnchor ? new GroupClick(new Lines(summaryLine(g.group, theme, true)), () => toggleGroup(st, g.group)) : empty();
				rowExp = g.rowExp;
				const base = wrapBase(run(), context);
				if (!g.isAnchor || leadingNoticeKey(g.group) !== undefined) return new GroupClick(base, toggleRow); // header lives on the leading notification
				// Line 0 is the group summary header; the rest is this row's own call line(s).
				return new GroupClick(new Stack([new Lines(summaryLine(g.group, theme, false)), base]), (e) => (e.y === 0 ? toggleGroup(st, g.group) : toggleRow()));
			} catch {
				return wrapBase((inner.renderCall ?? unifiedCall(name))(args, theme, { ...context, lastComponent: undefined } as any), context);
			}
		},
		renderResult: (result, options, theme, context) => {
			let rowExp: boolean | undefined;
			const run = () =>
				runInner("result", inner.renderResult as any, context, (c) => (inner.renderResult ?? unifiedResult(name))(result, rowExp === undefined ? options : { ...options, expanded: rowExp }, theme, c), rowExp);
			try {
				const g = sync(context);
				if (!g) return wrapBase(run(), context);
				if (!g.show) return empty();
				rowExp = g.rowExp;
				return new GroupClick(wrapBase(run(), context), () => {
					toggleFlip(st.flipped, g.rowId);
					notify(st, g.rowId);
				});
			} catch {
				return wrapBase((inner.renderResult ?? unifiedResult(name))(result, options, theme, { ...context, lastComponent: undefined } as any), context);
			}
		},
	};
}

class Stack implements Component {
	constructor(private readonly parts: Component[]) {}
	invalidate(): void {
		for (const p of this.parts) p.invalidate();
	}
	render(width: number): string[] {
		return this.parts.flatMap((p) => p.render(width));
	}
}

function resolveBase(name: string, base: ToolRenderers | undefined): ToolRenderers | undefined {
	if (settings.headerTakeover && settings.headerTools.includes(name) && base?.renderCall && base?.renderResult) {
		return {
			...base,
			renderShell: "self",
			renderCall: unifiedCall(name),
			renderResult: takeoverResult(base.renderResult),
		};
	}
	if (base?.renderCall && base?.renderResult) return base;
	const covered = Boolean(base?.renderCall || base?.renderResult);
	return {
		...base,
		// Fully uncovered: own the shell so Pi draws no default padded box.
		renderShell: base?.renderShell ?? (covered ? undefined : "self"),
		renderCall: base?.renderCall ?? unifiedCall(name),
		renderResult: base?.renderResult ?? unifiedResult(name),
	};
}

export default function (pi: ExtensionAPI): void {
	const st = createGroupState();
	installThinkingDedupe(pi, AssistantMessageComponent, ToolExecutionComponent, CustomMessageComponent, () => settings.dedupeThinking);

	pi.registerToolRenderer((name, next) => {
		const base = next();
		// Pi caches the resolved definition per tool row at construction, so
		// toggling "enabled" only affects rows created afterwards.
		if (!settings.enabled) return base;
		const resolved = resolveBase(name, base);
		if (!settings.grouping || !resolved || settings.groupExclude.includes(name)) return resolved;
		try {
			return groupedRenderers(st, name, resolved);
		} catch {
			return resolved;
		}
	});

	// Group membership comes from message content (rows are built during
	// message_update, before tool_execution_start); events only carry status.
	const announced = new Set<string>();
	const announce = (content: any[]) => {
		for (const b of content) {
			if (b?.type !== "toolCall" || b.id == null) continue;
			const id = String(b.id);
			if (announced.has(id)) continue;
			const found = st.tracker.lookup(id);
			if (!found) continue;
			announced.add(id);
			if (announced.size > 4096) announced.clear();
			notify(st, id);
			notify(st, found.group.items[0]?.id);
		}
	};
	const onAssistant = (message: any) => {
		if (!Array.isArray(message?.content)) return;
		st.tracker.onAssistantContent(message.content);
		announce(message.content);
	};
	const onNotice = (message: any) => {
		if (message?.customType !== NOTIFICATION_TYPE || !settings.grouping) return;
		const key = noticeKey(message);
		if (!key) return;
		st.tracker.onNotification(key);
		const group = st.tracker.lookupNotification(key);
		if (group) notify(st, group.items[0]?.id); // summary line changed
	};
	const onStatus = (event: any, running: boolean) => {
		if (event.parentToolCallId) return;
		const id = String(event.toolCallId);
		if (running) st.tracker.onToolStart(id, String(event.toolName), event.args ?? event.input);
		else st.tracker.onToolEnd(id, { isError: Boolean(event.isError) });
		const found = st.tracker.lookup(id);
		if (found) notify(st, found.group.items[0]?.id);
	};
	// Only the instance bound to the interactive TUI tracks groups. In-process
	// subagent sessions (pi-subagents) bind extensions without a UI context, so
	// ctx.hasUI is false there; their events must never touch group state.
	const isUi = (ctx: any): boolean => Boolean(ctx?.hasUI);
	pi.on("message_start", (event: any, ctx: any) => {
		if (!isUi(ctx)) return;
		const role = event?.message?.role;
		if (role === "user") st.tracker.onUserMessage();
		else if (role === "assistant") st.tracker.onAssistantStart();
		else if (role === "custom") onNotice(event.message);
	});
	pi.on("message_update", (event: any, ctx: any) => {
		if (!isUi(ctx)) return;
		if (event?.message?.role === "assistant") onAssistant(event.message);
	});
	pi.on("message_end", (event: any, ctx: any) => {
		if (!isUi(ctx)) return;
		const m = event?.message;
		if (m?.role === "user") st.tracker.onUserMessage();
		else if (m?.role === "assistant") onAssistant(m);
		else if (m?.role === "custom") onNotice(m);
	});
	pi.on("tool_execution_start", (event: any, ctx: any) => void (isUi(ctx) && onStatus(event, true)));
	pi.on("tool_execution_end", (event: any, ctx: any) => void (isUi(ctx) && onStatus(event, false)));

	const reset = () => {
		st.tracker.reset();
		st.invalidators.clear();
		st.innerRows.clear();
		st.seenExpanded.clear();
		st.flipped.clear();
		announced.clear();
	};
	const replay = (_event: unknown, ctx: any) => {
		if (!isUi(ctx)) return;
		const saved = new Map(st.invalidators);
		reset();
		let entries: any[] = [];
		try {
			entries = ctx?.sessionManager?.getBranch?.() ?? [];
		} catch {}
		for (const entry of entries) {
			const m = entry?.type === "message" ? entry.message : undefined;
			if (entry?.type === "custom_message" && entry.customType === NOTIFICATION_TYPE && settings.grouping) {
				const key = noticeKey({ timestamp: new Date(entry.timestamp).getTime() });
				if (key) st.tracker.onNotification(key);
				continue;
			}
			if (!m) continue;
			if (m.role === "user") st.tracker.onUserMessage();
			else if (m.role === "assistant" && Array.isArray(m.content)) st.tracker.onAssistantContent(m.content, "done");
			else if (m.role === "toolResult" && m.toolCallId != null) st.tracker.onToolEnd(String(m.toolCallId), { isError: Boolean(m.isError) });
		}
		st.tracker.closeGroup();
		// Rows built before the replay rendered ungrouped; re-render them.
		for (const [id, fn] of saved) {
			st.invalidators.set(id, fn);
			notify(st, id);
		}
	};
	pi.on("session_start", replay);
	pi.on("session_tree", replay);
	pi.on("session_compact", replay);
	pi.on("session_shutdown", (_event: unknown, ctx: any) => {
		if (isUi(ctx)) reset();
	});

	if (settings.notificationTakeover) {
		pi.registerMessageRenderer<NotificationDetails>("subagent-notification", (message, { expanded }, theme) => {
			if (!message.details) return undefined;
			return new NotificationView(message.details, expanded, theme, noticeKey(message), st.tracker, st);
		});
	}

	const openSettings = async (ctx: ExtensionContext) => {
		const items: SettingItem[] = [
			{ id: "enabled", label: "Enabled", currentValue: settings.enabled ? "true" : "false", values: ["true", "false"],
				description: "false falls back to Pi's default rendering — applies to new tool rows only (Pi caches renderers per row)" },
			{ id: "headerTakeover", label: "Header takeover", currentValue: settings.headerTakeover ? "true" : "false", values: ["true", "false"],
				description: "Use the unified header for selected tools but keep their own result. Tool list: headerTools in unified-tool-renderer.json. New rows only" },
			{ id: "notificationTakeover", label: "Notification takeover", currentValue: settings.notificationTakeover ? "true" : "false", values: ["true", "false"],
				description: "Restyle pi-subagents completion notifications in the unified tree look. Registered at load: needs /reload to take effect" },
			{ id: "notificationCollapsed", label: "Collapse agent notifications", currentValue: settings.notificationCollapsed ? "true" : "false", values: ["true", "false"],
				description: "One line per subagent completion notification; expand to see result + transcript" },
			{ id: "grouping", label: "Grouping", currentValue: settings.grouping ? "true" : "false", values: ["true", "false"],
				description: "Collapse consecutive tool calls into one summary line (click or ctrl+o to expand). Excluded tools: groupExclude in unified-tool-renderer.json. New rows only" },
			{ id: "dedupeThinking", label: "Dedupe thinking labels", currentValue: settings.dedupeThinking ? "true" : "false", values: ["true", "false"],
				description: "One 'Thinking...' per run of hidden thinking; label sits flush under tool groups. Applies live" },
			{ id: "previewLines", label: "Preview lines", currentValue: settings.previewLines, values: PREVIEW_VALUES,
				description: "Lines shown in expanded multi-line results" },
			{ id: "collapsed", label: "Collapsed results", currentValue: settings.collapsed, values: [...COLLAPSED_MODES],
				description: "count: \"N lines returned\" · first-line: first line + \"+N lines\" · hidden: no result row while collapsed" },
			{ id: "summaryWidth", label: "Summary width", currentValue: settings.summaryWidth, values: WIDTH_VALUES,
				description: "Max characters of the argument summary on the call row" },
		];

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild({
				render: () => [theme.fg("accent", theme.bold("Unified tool renderer")), ""],
				invalidate: () => {},
			});
			const list = new SettingsList(
				items,
				items.length + 2,
				getSettingsListTheme(),
				(id, value) => {
					if (id === "enabled") settings.enabled = value === "true";
					else if (id === "headerTakeover") settings.headerTakeover = value === "true";
					else if (id === "notificationTakeover") settings.notificationTakeover = value === "true";
					else if (id === "notificationCollapsed") settings.notificationCollapsed = value === "true";
					else if (id === "grouping") settings.grouping = value === "true";
					else if (id === "dedupeThinking") settings.dedupeThinking = value === "true";
					else if (id === "collapsed") settings.collapsed = value as CollapsedMode;
					else if (id === "previewLines") settings.previewLines = value;
					else if (id === "summaryWidth") settings.summaryWidth = value;
					saveSettings(settings);
					tui.requestRender();
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(list);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	pi.registerCommand("tool-render", {
		description: "Unified tool renderer settings",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tool-render settings need the TUI", "info");
				return;
			}
			await openSettings(ctx);
		},
	});
}
