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
import { Container, type SettingItem, SettingsList, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
}

const COLLAPSED_MODES: CollapsedMode[] = ["count", "first-line", "hidden"];
const PREVIEW_VALUES = ["20", "40", "80", "200"];
const WIDTH_VALUES = ["48", "72", "120"];

const DEFAULT_SETTINGS: Settings = {
	enabled: true,
	previewLines: "80",
	collapsed: "count",
	summaryWidth: "72",
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
		s.previewLines = String(s.previewLines);
		s.summaryWidth = String(s.summaryWidth);
		return s;
	} catch {
		return { ...DEFAULT_SETTINGS };
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

function unifiedCall(name: string): NonNullable<ToolRenderers["renderCall"]> {
	return (args, theme, context) =>
		new Lines(`${statusPrefix(theme, context as Ctx)}${theme.fg("text", theme.bold(humanizeToolName(name)))} ${summarizeCall(name, args, theme, Number(settings.summaryWidth))}`.trimEnd());
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

export default function (pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next) => {
		const base = next();
		// Pi caches the resolved definition per tool row at construction, so
		// toggling "enabled" only affects rows created afterwards.
		if (!settings.enabled) return base;
		if (base?.renderCall && base?.renderResult) return base;
		const covered = Boolean(base?.renderCall || base?.renderResult);
		return {
			...base,
			// Fully uncovered: own the shell so Pi draws no default padded box.
			renderShell: base?.renderShell ?? (covered ? undefined : "self"),
			renderCall: base?.renderCall ?? unifiedCall(name),
			renderResult: base?.renderResult ?? unifiedResult(name),
		};
	});

	const openSettings = async (ctx: ExtensionContext) => {
		const items: SettingItem[] = [
			{ id: "enabled", label: "Enabled", currentValue: settings.enabled ? "true" : "false", values: ["true", "false"],
				description: "false falls back to Pi's default rendering — applies to new tool rows only (Pi caches renderers per row)" },
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
