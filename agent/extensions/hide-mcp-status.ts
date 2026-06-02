/**
 * hide-mcp-status.ts
 * Hides the "MCP: 0/5 servers" status bar item when no servers are connected.
 * The status still appears once servers actually connect.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Intercept setStatus to suppress the MCP status when count is 0/N
    const originalSetStatus = ctx.ui.setStatus.bind(ctx.ui);
    ctx.ui.setStatus = (key: string, value: string | undefined) => {
      if (key === "mcp" && typeof value === "string" && value.includes("MCP: 0/")) {
        return originalSetStatus(key, undefined);
      }
      return originalSetStatus(key, value);
    };
  });
}
