import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// User messages: accent-colored left rail on the userMessageBg surface, plus a
// "click to copy" hint on the bottom padding row; a click anywhere in the box copies the raw message.
// Installed at session_start so it wraps whatever renderer other extensions
// (pi-tool-renderer, zentui) patched in at load time.

const RAIL = "▎";
const HINT = "click to copy";
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

			// Bottom padding row = last non-empty line (pi-tool-renderer may append a "" break row).
			for (let i = lines.length - 1; i >= 0; i--) {
				if (lines[i] === "") continue;
				const markers = lines[i].match(LEADING_OSC133)?.[0] ?? "";
				const blank = lines[i].slice(markers.length).replace(ANSI, "").trim() === "";
				if (blank && i > 0 && state.copy && inner > HINT.length + 2) {
					const pad = " ".repeat(inner - HINT.length - 1);
					lines[i] = markers + theme.bg("userMessageBg", `${pad}${theme.fg("dim", HINT)} `);
				}
				break;
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
				const notify = (msg: string, type: "info" | "error") => {
					try {
						state.ctx?.ui?.notify?.(msg, type);
					} catch {}
				};
				state.copy?.(text).then(
					() => notify("Copied message", "info"),
					(err) => notify(`Copy failed: ${err?.message ?? err}`, "error"),
				);
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
