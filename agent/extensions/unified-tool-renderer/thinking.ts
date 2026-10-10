/**
 * Collapse consecutive hidden-thinking labels ("Thinking...") in Pi's chat log to one per run.
 * `dedupeThinkingRuns` is pure (no Pi imports) so it runs under `node --test`.
 */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const strip = (s: string): string => s.replace(ANSI_RE, "");
const oscOf = (s: string): string => (s.match(OSC_RE) ?? []).join("");

export interface DedupeChild {
	lines: string[];
	/** Set ⇒ child is an assistant message whose label lines may be dropped. */
	label?: string;
	/** Child kind; "tool"/"custom" make a following assistant label sit flush beneath them. */
	kind?: "assistant" | "tool" | "custom" | "other";
	/** Tool group this child is a member of (identity compared with ===). */
	group?: object;
	/** Whether that group is rendered as an open panel. */
	groupExpanded?: boolean;
}

export interface DedupeOptions {
	/** false ⇒ only the in-group label hiding applies; everything else passes through. Default true. */
	dedupe?: boolean;
}

/**
 * Indexes of thinking-only assistant children sitting between two members of the
 * same expanded group. Claude Code shows no "Thinking..." inside an open group.
 */
function labelsInsideOpenGroups(children: DedupeChild[]): Set<number> {
	const hidden = new Set<number>();
	let prev: DedupeChild | undefined;
	const pending: number[] = [];
	children.forEach((child, i) => {
		if (child.group !== undefined) {
			if (prev && prev.group === child.group && prev.groupExpanded && child.groupExpanded) for (const j of pending) hidden.add(j);
			prev = child;
			pending.length = 0;
			return;
		}
		if (child.label !== undefined && prev) {
			const target = child.label.trim();
			if (child.lines.every((l) => { const t = strip(l).trim(); return t === "" || t === target; })) pending.push(i);
			else {
				pending.length = 0;
				prev = undefined;
			}
		}
	});
	return hidden;
}

export function dedupeThinkingRuns(children: DedupeChild[], options: DedupeOptions = {}): string[][] {
	const hiddenInGroup = labelsInsideOpenGroups(children);
	if (options.dedupe === false) return children.map((c, i) => (hiddenInGroup.has(i) ? [] : [...c.lines]));
	let inRun = false;
	// Kind of the last child that produced non-blank output.
	let prevKind: DedupeChild["kind"] = "other";
	return children.map((child, index) => {
		if (hiddenInGroup.has(index)) return [];
		// A custom message whose output is only blank lines (e.g. a notification in a collapsed
		// group renders 0 lines, leaving just Pi's own leading Spacer) renders as nothing, so a
		// collapsed group looks exactly like one without a notification. Applies whenever the
		// patch is active; custom children with any visible content are untouched.
		if (child.label === undefined && child.kind === "custom" && child.lines.every((l) => strip(l).trim() === "")) {
			return [];
		}
		if (child.label === undefined) {
			if (child.lines.some((l) => strip(l).trim() !== "")) {
				inRun = false;
				prevKind = child.kind ?? "other";
			}
			return [...child.lines];
		}
		const target = child.label.trim();
		const out: string[] = [];
		let buffer: string[] = [];
		let pendingOsc = "";
		const emit = (line: string) => {
			out.push(pendingOsc + line);
			pendingOsc = "";
		};
		const flush = () => {
			for (const b of buffer) emit(b);
			buffer = [];
		};
		for (const line of child.lines) {
			const text = strip(line).trim();
			if (text === "") {
				buffer.push(line);
			} else if (text === target) {
				if (inRun) {
					for (const b of buffer) pendingOsc += oscOf(b);
					pendingOsc += oscOf(line);
					buffer = [];
				} else {
					flush();
					emit(line);
					inRun = true;
				}
			} else {
				flush();
				emit(line);
				inRun = false;
			}
		}
		flush();
		if (pendingOsc && out.length > 0) out[out.length - 1] += pendingOsc;
		// Pi adds a leading Spacer(1) to visible assistant content; after a tool row or
		// custom message the label should sit directly beneath it.
		const first = out.findIndex((l) => strip(l).trim() !== "");
		let result = out;
		if ((prevKind === "tool" || prevKind === "custom") && first > 0 && strip(out[first]).trim() === target) {
			const osc = out.slice(0, first).map(oscOf).join("");
			result = out.slice(first);
			result[0] = osc + result[0];
		}
		if (first >= 0) prevKind = "assistant";
		return result;
	});
}

/** Columns of inner padding left/right of the panel content (members render at width − 2·PANEL_PAD_X). */
export const PANEL_PAD_X = 2;
/** Blank panel lines directly under the group header line. */
export const PANEL_HEADER_GAP = 1;

export interface PanelOptions {
	/** First member of the open group: its leading blank line is the top padding. */
	first: boolean;
	/** Last member: one padded blank line is appended below. */
	last: boolean;
	/** Fills one line to the panel background. */
	fill: (line: string) => string;
	/** Left indent (columns) put in front of every non-empty content line. Default PANEL_PAD_X. */
	padX?: number;
	/** Blank lines inserted under the header (first non-blank line of the first member). Default PANEL_HEADER_GAP. */
	headerGap?: number;
}

export interface PanelResult {
	lines: string[];
	/** Net lines added at the start (+) or dropped (−): child mouse y = event.y − shift. */
	shift: number;
	/** Whether a padded line was appended below. */
	bottom: boolean;
	/** Output index of the first header-gap line (undefined = no gap). */
	gapAt?: number;
	/** Number of header-gap lines. */
	gap: number;
}

/**
 * Decorates one member's lines for an open group panel: every line is background
 * filled; the first member gets a padded blank line above (its own leading blank,
 * or a new one), later members lose their leading blank lines (rows sit tight),
 * the last member gets a padded blank line below.
 */
export function panelLines(lines: string[], { first, last, fill, padX = PANEL_PAD_X, headerGap = PANEL_HEADER_GAP }: PanelOptions): PanelResult {
	if (lines.length === 0) return { lines: [], shift: 0, bottom: false, gap: 0 };
	let body = lines;
	let shift = 0;
	if (first) {
		if (strip(body[0]!).trim() !== "") {
			body = ["", ...body];
			shift = 1;
		}
	} else {
		let n = 0;
		while (n < body.length && strip(body[n]!).trim() === "") n++;
		if (n > 0) {
			body = body.slice(n);
			shift = -n;
		}
	}
	const indent = " ".repeat(padX);
	const out: string[] = [];
	let gapAt: number | undefined;
	let headerSeen = false;
	for (const l of body) {
		out.push(fill(indent + l));
		if (first && headerGap > 0 && !headerSeen && strip(l).trim() !== "") {
			headerSeen = true;
			gapAt = out.length;
			for (let g = 0; g < headerGap; g++) out.push(fill(""));
		}
	}
	if (last) out.push(fill(""));
	return { lines: out, shift, bottom: last, gapAt, gap: gapAt === undefined ? 0 : headerGap };
}

// ---------------------------------------------------------------------------
// Pi-facing part: patch Container.prototype.render (type-only Pi imports).
// ---------------------------------------------------------------------------

/** Hooks that let the chat-container patch render open tool groups as one panel. */
export interface GroupHooks {
	/** Group membership of a chat child (tool row / notification), if any. */
	groupOf(child: any): { group: object; expanded: boolean } | undefined;
	/** Panel fill, or undefined when the panel is off. Read on every render (live setting). */
	panel(): { fill: (line: string, width: number) => string } | undefined;
	toggle(group: object): void;
}

/**
 * Wraps a member child in the mouse layout: the padded panel lines (top = first
 * member's leading blank, bottom = appended pad) toggle the group; everything else
 * goes to the child with y corrected for lines added/dropped by the panel.
 */
class PanelMouse {
	private readonly child: any;
	private readonly shift: number;
	private readonly height: number;
	private readonly first: boolean;
	private readonly bottom: boolean;
	private readonly toggle: () => void;
	private readonly gapAt: number | undefined;
	private readonly gap: number;
	private readonly padX: number;
	constructor(child: any, res: PanelResult, height: number, first: boolean, padX: number, toggle: () => void) {
		this.child = child;
		this.shift = res.shift;
		this.gapAt = res.gapAt;
		this.gap = res.gap;
		this.padX = padX;
		this.height = height;
		this.first = first;
		this.bottom = res.bottom;
		this.toggle = toggle;
	}
	handleMouse(event: any): any {
		const inGap = this.gapAt !== undefined && event.y >= this.gapAt && event.y < this.gapAt + this.gap;
		if (event?.type === "click" && event.button === "left" && ((this.first && event.y === 0) || (this.bottom && event.y === this.height - 1) || inGap)) {
			this.toggle();
			return { handled: true };
		}
		const afterGap = this.gapAt !== undefined && event.y >= this.gapAt + this.gap ? this.gap : 0;
		const x = typeof event.x === "number" ? event.x - this.padX : event.x;
		return this.child.handleMouse?.({ ...event, x, y: event.y - this.shift - afterGap });
	}
}

const PATCH_KEY = Symbol.for("unified-tool-renderer.thinking-dedupe");

interface PatchState {
	original: (width: number) => string[];
	patched: (width: number) => string[];
	owner: object;
}

/**
 * Registers the patch lifecycle. The Container patch is process-global, so only
 * the instance bound to the interactive UI (ctx.hasUI at session_start) installs
 * it; in-process subagent instances (pi-subagents, no UI context) never install
 * and their session_shutdown can never unpatch the UI instance's patch.
 */
export function installThinkingDedupe(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	AssistantMessageComponent: abstract new (...args: any[]) => any,
	ToolExecutionComponent: abstract new (...args: any[]) => any,
	CustomMessageComponent: abstract new (...args: any[]) => any,
	isEnabled: () => boolean,
	hooks?: GroupHooks,
): void {
	const proto: any = Object.getPrototypeOf((AssistantMessageComponent as any).prototype);
	if (!proto || typeof proto.render !== "function") return;
	const owner = {};
	let installed = false;

	const install = () => {
		if (installed) return; // no double wrap by the same instance
		// Reload-safe: remove a previous install (from an earlier module instance) before patching.
		const previous: PatchState | undefined = proto[PATCH_KEY];
		if (previous && proto.render === previous.patched) proto.render = previous.original;
		const original: (width: number) => string[] = proto.render;
		const patched = function (this: any, width: number): string[] {
			let enabled = false;
			let panel: ReturnType<GroupHooks["panel"]>;
			try {
				panel = hooks?.panel();
				enabled = (isEnabled() || Boolean(panel)) && Array.isArray(this.children) && this.children.some((c: any) => c instanceof AssistantMessageComponent);
			} catch {}
			if (!enabled) return original.call(this, width);
			try {
				const children: any[] = this.children;
				const rendered = children.map((child) => {
					const info = panel ? hooks!.groupOf(child) : undefined;
					const lines: string[] = child.render(info?.expanded ? Math.max(1, width - 2 * PANEL_PAD_X) : width);
					const label = child instanceof AssistantMessageComponent ? String(child.hiddenThinkingLabel ?? "Thinking...") : undefined;
					const kind: DedupeChild["kind"] =
						label !== undefined ? "assistant"
						: child instanceof ToolExecutionComponent ? "tool"
						: child instanceof CustomMessageComponent ? "custom"
						: "other";
					return { lines, label, kind, group: info?.group, groupExpanded: info?.expanded };
				});
				const deduped = dedupeThinkingRuns(rendered, { dedupe: isEnabled() });
				// First / last visible member of each expanded group (display order).
				const firstOf = new Map<object, number>();
				const lastOf = new Map<object, number>();
				if (panel) {
					rendered.forEach((r, i) => {
						if (!r.group || !r.groupExpanded || deduped[i]!.length === 0) return;
						if (!firstOf.has(r.group)) firstOf.set(r.group, i);
						lastOf.set(r.group, i);
					});
				}
				const out: string[] = [];
				const mouseChildren = deduped.map((raw, i) => {
					const r = rendered[i]!;
					let lines = raw;
					let component: any = children[i];
					if (panel && r.group && r.groupExpanded && raw.length > 0) {
						const first = firstOf.get(r.group) === i;
						const res = panelLines(raw, { first, last: lastOf.get(r.group) === i, fill: (l) => panel!.fill(l, width) });
						lines = res.lines;
						const group = r.group;
						component = new PanelMouse(children[i], res, lines.length, first, PANEL_PAD_X, () => hooks!.toggle(group));
					}
					for (const line of lines) out.push(line);
					return { component, height: lines.length };
				});
				this.mouseLayout = { width, children: mouseChildren };
				return out;
			} catch {
				return original.call(this, width);
			}
		};
		proto.render = patched;
		proto[PATCH_KEY] = { original, patched, owner } satisfies PatchState;
		installed = true;
	};

	pi.on("session_start", (_event: unknown, ctx: any) => {
		if (ctx?.hasUI) install();
	});

	pi.on("session_shutdown", () => {
		if (!installed) return;
		installed = false;
		const state: PatchState | undefined = proto[PATCH_KEY];
		if (state && state.owner === owner && proto.render === state.patched) {
			proto.render = state.original;
			delete proto[PATCH_KEY];
		}
	});
}
