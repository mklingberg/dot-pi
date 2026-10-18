import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Force a full repaint whenever a session starts (startup, /new, /resume, /fork).
// Pi rebuilds the runtime on /new and anything written straight to the terminal meanwhile
// (e.g. console.warn "No models match pattern" from resolveModelScope) scrolls the alt
// screen behind the differential renderer's back: rows it believes are blank keep stale
// content. requestRender(true) drops the previous-frame cache so every row is rewritten.
// The TUI handle is only reachable through a widget factory; the widget renders nothing
// and is removed immediately.
//
// WORKAROUND for a pi core bug (present in 1.3.0). Remove once fixed upstream.
// Bug: dist/main.js calls resolveModelScope() when building the runtime (startup and every
// /new), which console.warn()s unmatched enabledModels patterns straight to the terminal
// instead of pushing them to the `diagnostics` array a few lines above.
// Upstream fix: use resolveModelScopeWithDiagnostics() and push its diagnostics.
// How to check after `pi update`:
//   1. Code: grep -n "resolveModelScope" <pi>/dist/main.js → fixed if it uses the
//      WithDiagnostics variant (or no console.warn path remains).
//   2. Behaviour: disable this file (mv to .off), run `pi --models github-copilot/does-not-exist`
//      in a session with some history, run /new → fixed if the screen is empty apart from
//      "✓ New session started" (no leftover tool groups / "Thinking..." rows).

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
