import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Force a full repaint whenever a session starts (startup, /new, /resume, /fork).
// Pi rebuilds the runtime on /new and anything written straight to the terminal meanwhile
// (e.g. console.warn "No models match pattern" from resolveModelScope) scrolls the alt
// screen behind the differential renderer's back: rows it believes are blank keep stale
// content. requestRender(true) drops the previous-frame cache so every row is rewritten.
// The TUI handle is only reachable through a widget factory; the widget renders nothing
// and is removed immediately.

const KEY = "local.redraw-on-session-start";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setWidget(KEY, (tui) => {
				tui.requestRender(true);
				return { render: () => [], invalidate() {} };
			});
			ctx.ui.setWidget(KEY, undefined);
		} catch {}
	});
}
