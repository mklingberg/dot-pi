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
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

const BULLET = "● ";
const TREE_LAST = "  └─ ";
const TREE_STEM = "  │  ";
const PREVIEW_LINES = 80;
const MAX_LINE = 1000;

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

function summarizeCall(name: string, args: any, theme: Theme): string {
	const arg = stringArg(args, "path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt", "summary", "question");
	return theme.fg("accent", oneLine(arg || humanizeToolName(name), 72));
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
		new Lines(`${statusPrefix(theme, context as Ctx)}${theme.fg("text", theme.bold(`${humanizeToolName(name)} `))}${summarizeCall(name, args, theme)}`);
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
		let text = `${connector(true)}${theme.fg("success", `${lines.length} lines returned`)}`;
		if (expanded) {
			text += `\n${lines.slice(0, PREVIEW_LINES).map((l) => `${connector(false)}${theme.fg("dim", truncate(l, MAX_LINE))}`).join("\n")}`;
			if (lines.length > PREVIEW_LINES) text += `\n${connector(false)}${theme.fg("muted", `… ${lines.length - PREVIEW_LINES} more line(s)`)}`;
		} else {
			text += theme.fg("dim", " · ctrl+o to expand");
		}
		return new Lines(text);
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next) => {
		const base = next();
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
}
