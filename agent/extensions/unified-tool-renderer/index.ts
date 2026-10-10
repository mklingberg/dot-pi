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
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type SettingItem, SettingsList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { createGroupTracker, DEFAULT_GROUP_EXCLUDE, summarize, type ToolGroup } from "./group.ts";

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
	/** Collapse runs of consecutive tool calls into one Claude-style summary line. New rows only. */
	grouping: boolean;
	/** Tools never grouped (they render as before and end the current run). Edit in the JSON file. */
	groupExclude: string[];
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
	grouping: true,
	groupExclude: [...DEFAULT_GROUP_EXCLUDE],
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
		s.headerTools = Array.isArray(s.headerTools) && s.headerTools.every((t: unknown) => typeof t === "string")
			? [...s.headerTools]
			: [...DEFAULT_SETTINGS.headerTools];
		s.grouping = s.grouping !== false && s.grouping !== "false";
		s.groupExclude = Array.isArray(s.groupExclude) && s.groupExclude.every((t: unknown) => typeof t === "string")
			? [...s.groupExclude]
			: [...DEFAULT_GROUP_EXCLUDE];
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
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const w = Math.max(1, width);
		const showCost = readShowCost();
		const all = [this.details, ...(this.details.others ?? [])];
		const out: string[] = [];
		if (showCost && all.length > 1) {
			const total = fmtCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
			if (total) {
				const tokens = all.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0);
				out.push(truncateToWidth(this.theme.fg("dim", `${all.length} agents · ${fmtTokens(tokens)} · ${total}`), w));
			}
		}
		for (const d of all) out.push(...this.renderOne(d, w, showCost));
		return out;
	}
	private renderOne(d: NotificationDetails, w: number, showCost: boolean): string[] {
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
		const lines = [truncateToWidth(header, w, "…")];

		const raw = (d.resultPreview ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").trimEnd();
		let preview = raw ? raw.split("\n") : [];
		preview = this.expanded ? preview.slice(0, Number(settings.previewLines)) : preview.slice(0, 1);
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

// ---- grouping (Claude Code style summary of consecutive tool calls) ----

const tracker = createGroupTracker({ exclude: settings.groupExclude });
const invalidators = new Map<string, () => void>();
const MAX_INVALIDATORS = 512;

function rememberInvalidator(id: string, fn: unknown): void {
	if (typeof fn !== "function") return;
	invalidators.delete(id);
	invalidators.set(id, fn as () => void);
	while (invalidators.size > MAX_INVALIDATORS) invalidators.delete(invalidators.keys().next().value!);
}

function notify(id: string | undefined): void {
	if (!id) return;
	const fn = invalidators.get(id);
	if (!fn) return;
	queueMicrotask(() => {
		try {
			fn();
		} catch {}
	});
}

function notifyGroup(group: ToolGroup, exceptId?: string): void {
	for (const item of group.items) if (item.id !== exceptId) notify(item.id);
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
	return `${bullet}${theme.fg("muted", summarize(group.items))}${hint ? theme.fg("dim", " · click to expand") : ""}`;
}

function groupedRenderers(name: string, inner: ToolRenderers): ToolRenderers {
	const selfShell = inner.renderShell === "self";
	const wrapBase = (c: Component, ctx: any): Component => (selfShell ? c : new PadLines(c, Number(ctx?.outputPad ?? 1)));

	const sync = (ctx: any, args: any): { group: ToolGroup; isAnchor: boolean; show: boolean } | undefined => {
		const id = String(ctx?.toolCallId ?? "");
		if (!id) return undefined;
		rememberInvalidator(id, ctx?.invalidate);
		const found = tracker.lookup(id);
		if (!found) return undefined;
		if (found.isAnchor && Boolean(ctx?.expanded) !== found.group.expanded) {
			found.group.expanded = Boolean(ctx?.expanded);
			notifyGroup(found.group, id);
		}
		return { ...found, show: Boolean(ctx?.expanded) || found.group.expanded };
	};

	return {
		...inner,
		renderShell: "self",
		renderCall: (args, theme, context) => {
			try {
				const g = sync(context, args);
				if (!g) throw new Error("no group");
				const base = inner.renderCall ? wrapBase(inner.renderCall(args, theme, context), context) : undefined;
				if (!g.show) return g.isAnchor ? new Lines(summaryLine(g.group, theme, true)) : empty();
				if (!g.isAnchor || !base) return base ?? empty();
				return new Stack([new Lines(summaryLine(g.group, theme, false)), base]);
			} catch {
				return wrapBase((inner.renderCall ?? unifiedCall(name))(args, theme, context), context);
			}
		},
		renderResult: (result, options, theme, context) => {
			try {
				const g = sync(context, (context as any)?.args);
				if (!g) throw new Error("no group");
				if (!g.show) return empty();
				return wrapBase(inner.renderResult!(result, options, theme, context), context);
			} catch {
				return wrapBase((inner.renderResult ?? unifiedResult(name))(result, options, theme, context), context);
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
	pi.registerToolRenderer((name, next) => {
		const base = next();
		// Pi caches the resolved definition per tool row at construction, so
		// toggling "enabled" only affects rows created afterwards.
		if (!settings.enabled) return base;
		const resolved = resolveBase(name, base);
		if (!settings.grouping || !resolved || settings.groupExclude.includes(name)) return resolved;
		try {
			return groupedRenderers(name, resolved);
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
			const found = tracker.lookup(id);
			if (!found) continue;
			announced.add(id);
			if (announced.size > 4096) announced.clear();
			notify(id);
			notify(found.group.items[0]?.id);
		}
	};
	const onAssistant = (message: any) => {
		if (!Array.isArray(message?.content)) return;
		tracker.onAssistantContent(message.content);
		announce(message.content);
	};
	const onStatus = (event: any, running: boolean) => {
		if (event.parentToolCallId) return;
		const id = String(event.toolCallId);
		if (running) tracker.onToolStart(id, String(event.toolName), event.args ?? event.input);
		else tracker.onToolEnd(id, { isError: Boolean(event.isError) });
		const found = tracker.lookup(id);
		if (found) notify(found.group.items[0]?.id);
	};
	pi.on("message_start", (event: any) => {
		const role = event?.message?.role;
		if (role === "user") tracker.onUserMessage();
		else if (role === "assistant") tracker.onAssistantStart();
	});
	pi.on("message_update", (event: any) => {
		if (event?.message?.role === "assistant") onAssistant(event.message);
	});
	pi.on("message_end", (event: any) => {
		const m = event?.message;
		if (m?.role === "user") tracker.onUserMessage();
		else if (m?.role === "assistant") onAssistant(m);
	});
	pi.on("tool_execution_start", (event: any) => onStatus(event, true));
	pi.on("tool_execution_end", (event: any) => onStatus(event, false));

	const reset = () => {
		tracker.reset();
		invalidators.clear();
		announced.clear();
	};
	const replay = (_event: unknown, ctx: any) => {
		const saved = new Map(invalidators);
		reset();
		let entries: any[] = [];
		try {
			entries = ctx?.sessionManager?.getBranch?.() ?? [];
		} catch {}
		for (const entry of entries) {
			const m = entry?.type === "message" ? entry.message : undefined;
			if (!m) continue;
			if (m.role === "user") tracker.onUserMessage();
			else if (m.role === "assistant" && Array.isArray(m.content)) tracker.onAssistantContent(m.content, "done");
			else if (m.role === "toolResult" && m.toolCallId != null) tracker.onToolEnd(String(m.toolCallId), { isError: Boolean(m.isError) });
		}
		tracker.closeGroup();
		// Rows built before the replay rendered ungrouped; re-render them.
		for (const [id, fn] of saved) {
			invalidators.set(id, fn);
			notify(id);
		}
	};
	pi.on("session_start", replay);
	pi.on("session_tree", replay);
	pi.on("session_compact", replay);
	pi.on("session_shutdown", reset);

	if (settings.notificationTakeover) {
		pi.registerMessageRenderer<NotificationDetails>("subagent-notification", (message, { expanded }, theme) => {
			if (!message.details) return undefined;
			return new NotificationView(message.details, expanded, theme);
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
			{ id: "grouping", label: "Grouping", currentValue: settings.grouping ? "true" : "false", values: ["true", "false"],
				description: "Collapse consecutive tool calls into one summary line (click or ctrl+o to expand). Excluded tools: groupExclude in unified-tool-renderer.json. New rows only" },
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
					else if (id === "grouping") settings.grouping = value === "true";
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
