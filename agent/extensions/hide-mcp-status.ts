/**
 * hide-mcp-status.ts
 * - Hides "MCP: 0/5 servers" from the status bar when no servers are connected.
 *   The status still appears once servers actually connect.
 * - Hides "$0.000" from the pi-zentui footer when session cost is zero.
 *   The cost segment is removed AND the visual space is redistributed into the
 *   middle gap so the right section stays properly right-aligned.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// ANSI utilities
// ---------------------------------------------------------------------------

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Insert `text` at visual (display) position `visPos` inside an ANSI-coded
 * string, jumping over escape sequences without counting them.
 */
function insertAtVisualPos(ansiStr: string, visPos: number, text: string): string {
  let visible = 0;
  let i = 0;
  while (i < ansiStr.length && visible < visPos) {
    if (ansiStr[i] === "\x1b") {
      while (i < ansiStr.length && ansiStr[i] !== "m") i++;
      i++; // skip 'm'
    } else {
      visible++;
      i++;
    }
  }
  return ansiStr.slice(0, i) + text + ansiStr.slice(i);
}

/**
 * Remove "$0.000" and its preceding " | " separator from a zentui footer line,
 * then widen the middle gap by the same number of characters so the right
 * section stays right-aligned.
 */
function stripZeroCostAndRealign(line: string): string {
  // 1. Strip the cost segment (ANSI-aware)
  const stripped = line.replace(
    /(?:\x1b\[[0-9;]*m)* \| (?:\x1b\[[0-9;]*m)*\$0\.000(?:\x1b\[[0-9;]*m)*/g,
    "",
  );

  const N = visibleWidth(line) - visibleWidth(stripped);
  if (N <= 0) return stripped; // nothing was removed

  // 2. Find the gap (the LAST run of 2+ consecutive spaces in the plain text).
  //    zentui's right section only uses single-space separators (" | "), so the
  //    only multi-space run is the gap between the left and right sections.
  const plain = stripAnsi(stripped);
  let gapEnd = -1;
  let i = 0;
  while (i < plain.length) {
    if (plain[i] === " ") {
      const start = i;
      while (i < plain.length && plain[i] === " ") i++;
      if (i - start >= 2) gapEnd = i; // remember end of this run
    } else {
      i++;
    }
  }

  if (gapEnd < 0) {
    // Fallback: no usable gap found, just pad at the end
    return stripped + " ".repeat(N);
  }

  // 3. Insert the N extra spaces at the END of the gap (= start of right section)
  return insertAtVisualPos(stripped, gapEnd, " ".repeat(N));
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // --- Hide MCP: 0/N in status bar ---
    const originalSetStatus = ctx.ui.setStatus.bind(ctx.ui);
    ctx.ui.setStatus = (key: string, value: string | undefined) => {
      if (key === "mcp" && typeof value === "string" && value.includes("MCP: 0/")) {
        return originalSetStatus(key, undefined);
      }
      return originalSetStatus(key, value);
    };

    // --- Hide $0.000 in zentui footer (with correct re-alignment) ---
    const originalSetFooter = ctx.ui.setFooter.bind(ctx.ui);
    // biome-ignore lint/suspicious/noExplicitAny: wrapping an opaque factory type
    (ctx.ui as any).setFooter = (factory: any) => {
      if (!factory) return originalSetFooter(factory);

      const wrappedFactory = (tui: any, theme: any, footerData: any) => {
        const component = factory(tui, theme, footerData);
        const originalRender = component.render.bind(component);
        component.render = (width: number) =>
          originalRender(width).map(stripZeroCostAndRealign);
        return component;
      };

      return originalSetFooter(wrappedFactory);
    };
  });
}
