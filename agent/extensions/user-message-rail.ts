import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Adds an accent-colored left rail to user messages, on the userMessageBg surface.
// Installed at session_start so it wraps whatever renderer other extensions
// (pi-tool-renderer, zentui) patched in at load time.

const RAIL = "▎";
const PATCH = Symbol.for("local.user-message-rail");
const LEADING_OSC133 = /^(?:\x1b\]133;[A-Z]\x07)+/;

interface PatchState {
	original: (width: number) => string[];
	ctx?: ExtensionContext;
}

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

		const state: PatchState = { original: proto.render, ctx };
		proto[PATCH] = state;
		proto.render = function railUserMessageRender(this: unknown, width: number): string[] {
			const theme = state.ctx?.ui?.theme;
			if (!theme || width < 4) return state.original.call(this, width);
			let rail: string;
			try {
				rail = theme.bg("userMessageBg", theme.fg("accent", RAIL));
			} catch {
				return state.original.call(this, width);
			}
			return state.original.call(this, width - 1).map((line) => {
				if (line === "") return line; // trailing break row from pi-tool-renderer
				const markers = line.match(LEADING_OSC133)?.[0] ?? "";
				return `${markers}${rail}${line.slice(markers.length)}`;
			});
		};
	});

	pi.on("session_shutdown", () => {
		const state = proto?.[PATCH] as PatchState | undefined;
		if (!proto || !state) return;
		if (proto.render.name === "railUserMessageRender") proto.render = state.original;
		delete proto[PATCH];
	});
}
