import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// User messages: accent-colored left rail on the userMessageBg surface, plus
// "click to copy · HH:MM" on the bottom padding row; a click anywhere in the box
// copies the raw message. The time comes from the session entry, so it survives reload/resume.
// Installed at session_start so it wraps whatever renderer other extensions
// (pi-tool-renderer, zentui) patched in at load time.

const RAIL = "▎";
const HINT = "click to copy";
const COPIED = "copied message";
/** How long the label reads COPIED after a click. Reverts on the first redraw after this. */
const COPIED_MS = 2000;
const PATCH = Symbol.for("local.user-message-rail");
const LEADING_OSC133 = /^(?:\x1b\]133;[A-Z]\x07)+/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

interface PatchState {
	original: (width: number) => string[];
	originalMouse?: (event: any) => any;
	ownMouse: boolean;
	ctx?: ExtensionContext;
	copy?: (text: string) => Promise<void>;
}

/** Click time per component, for the transient COPIED label. */
const copiedAt = new WeakMap<object, number>();
/** Session timestamp per component, once matched to a branch entry. */
const stamps = new WeakMap<object, number>();
/** Entry id -> component showing it (handles repeated identical messages; dead refs free the entry after a chat rebuild). */
let claimed = new Map<string, WeakRef<object>>();

function entryText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
}

function timestampFor(component: any, ctx: ExtensionContext | undefined): number | undefined {
	const known = stamps.get(component);
	if (known !== undefined) return known;
	const text: string = component?.text ?? "";
	let fallback: number | undefined;
	try {
		for (const entry of (ctx as any)?.sessionManager?.getBranch?.() ?? []) {
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			if (entryText(entry.message) !== text) continue;
			const ts = typeof entry.message.timestamp === "number" ? entry.message.timestamp : Date.parse(entry.timestamp);
			if (!Number.isFinite(ts)) continue;
			const owner = claimed.get(entry.id)?.deref();
			if (owner && owner !== component) {
				fallback ??= ts; // claimed by a component a chat rebuild may have replaced; show, don't cache
				continue;
			}
			claimed.set(entry.id, new WeakRef(component));
			stamps.set(component, ts);
			return ts;
		}
	} catch {}
	if (fallback !== undefined) return fallback;
	return undefined; // not persisted yet (live message): caller falls back to now, retried next render
}

function hhmm(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Number of box rows (excluding a trailing "" break row), per component, from the latest render. */
const boxRows = new WeakMap<object, number>();

export default function (pi: ExtensionAPI) {
	let proto: Record<PropertyKey, any> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx?.hasUI) return;
		const agent: any = await import("@earendil-works/pi-coding-agent");
		proto = agent.UserMessageComponent?.prototype;
		if (!proto || typeof proto.render !== "function") return;

		const existing = proto[PATCH] as PatchState | undefined;
		claimed = new Map();
		if (existing) {
			existing.ctx = ctx;
			return;
		}

		const state: PatchState = {
			original: proto.render,
			originalMouse: proto.handleMouse,
			ownMouse: Object.prototype.hasOwnProperty.call(proto, "handleMouse"),
			ctx,
			copy: typeof agent.copyToClipboard === "function" ? agent.copyToClipboard : undefined,
		};
		proto[PATCH] = state;

		proto.render = function railUserMessageRender(this: object, width: number): string[] {
			boxRows.delete(this);
			const theme = state.ctx?.ui?.theme;
			if (!theme || width < 4) return state.original.call(this, width);
			let rail: string;
			try {
				rail = theme.bg("userMessageBg", theme.fg("accent", RAIL));
			} catch {
				return state.original.call(this, width);
			}

			const inner = width - 1;
			const lines = state.original.call(this, inner);

			// Bottom padding row (last non-"" line; pi-tool-renderer may append a "" break row): right-aligned "click to copy · HH:MM".
			let row = lines.length - 1;
			while (row >= 0 && lines[row] === "") row--;
			if (row > 0) {
				const markers = lines[row].match(LEADING_OSC133)?.[0] ?? "";
				const blank = lines[row].slice(markers.length).replace(ANSI, "").trim() === "";
				const time = hhmm(timestampFor(this, state.ctx) ?? Date.now());
				const copied = Date.now() - (copiedAt.get(this) ?? 0) < COPIED_MS;
				const action = copied ? theme.fg("success", COPIED) : theme.fg("dim", HINT);
				const plain = state.copy ? `${copied ? COPIED : HINT} · ${time}` : time;
				const styled = state.copy ? `${action}${theme.fg("dim", ` · ${time}`)}` : theme.fg("dim", time);
				if (blank && inner > plain.length + 2) {
					const pad = " ".repeat(inner - plain.length - 1);
					lines[row] = markers + theme.bg("userMessageBg", `${pad}${styled} `);
				}
			}
			let rows = lines.length;
			while (rows > 0 && lines[rows - 1] === "") rows--;
			boxRows.set(this, rows);

			const out = lines.map((line) => {
				if (line === "") return line;
				const markers = line.match(LEADING_OSC133)?.[0] ?? "";
				return `${markers}${rail}${line.slice(markers.length)}`;
			});
			return out;
		};

		proto.handleMouse = function railUserMessageMouse(this: any, event: any): any {
			const rows = boxRows.get(this);
			if (state.copy && event?.type === "click" && event.button === "left" && rows !== undefined && event.y >= 0 && event.y < rows) {
				const text: string = this.text ?? "";
				// Optimistic: the TUI redraws right after a handled click, before the async copy settles.
				copiedAt.set(this, Date.now());
				this.invalidate?.();
				setTimeout(() => this.invalidate?.(), COPIED_MS + 50).unref?.();
				state.copy(text).catch((err) => {
					copiedAt.delete(this);
					try {
						state.ctx?.ui?.notify?.(`Copy failed: ${err?.message ?? err}`, "error");
					} catch {}
				});
				return { handled: true };
			}
			return state.originalMouse?.call(this, event);
		};
	});

	pi.on("session_shutdown", () => {
		const state = proto?.[PATCH] as PatchState | undefined;
		if (!proto || !state) return;
		if (proto.render?.name === "railUserMessageRender") proto.render = state.original;
		if (proto.handleMouse?.name === "railUserMessageMouse") {
			if (state.ownMouse) proto.handleMouse = state.originalMouse;
			else delete proto.handleMouse;
		}
		delete proto[PATCH];
	});
}
