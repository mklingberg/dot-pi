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
}

export function dedupeThinkingRuns(children: DedupeChild[]): string[][] {
	let inRun = false;
	return children.map((child) => {
		if (child.label === undefined) {
			if (child.lines.some((l) => strip(l).trim() !== "")) inRun = false;
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
		return out;
	});
}

// ---------------------------------------------------------------------------
// Pi-facing part: patch Container.prototype.render (type-only Pi imports).
// ---------------------------------------------------------------------------

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
	isEnabled: () => boolean,
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
			try {
				enabled = isEnabled() && Array.isArray(this.children) && this.children.some((c: any) => c instanceof AssistantMessageComponent);
			} catch {}
			if (!enabled) return original.call(this, width);
			try {
				const children: any[] = this.children;
				const rendered = children.map((child) => {
					const lines: string[] = child.render(width);
					const label = child instanceof AssistantMessageComponent ? String(child.hiddenThinkingLabel ?? "Thinking...") : undefined;
					return { lines, label };
				});
				const deduped = dedupeThinkingRuns(rendered);
				const out: string[] = [];
				const mouseChildren = deduped.map((lines, i) => {
					for (const line of lines) out.push(line);
					return { component: children[i], height: lines.length };
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
