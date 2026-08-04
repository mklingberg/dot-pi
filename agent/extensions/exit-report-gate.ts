/**
 * exit-report-gate.ts
 *
 * When an Implement subagent comes back with an EXIT REPORT, the parent has to
 * route it (Debug vs re-dispatch vs ask the user) — and that routing table lives
 * only in the delegate-subagents skill, in
 * `~/.agents/skills/delegate-subagents/references/exit-handling.md`.
 *
 * Prose alone does not get that file read. Pi invokes a skill by having the model
 * `read` its SKILL.md, and pi's own docs note models often skip it. Measured: in
 * four fresh sessions where AGENTS.md already said the skill was "required
 * before your first spawn", none of the four agents read it — they spawned
 * straight away. Correct behaviour there came from always-loaded instructions,
 * not from the skill.
 *
 * So this gate covers the one branch where the file is load-bearing and nothing
 * else states its contents: after an EXIT REPORT, the next spawn is blocked until
 * the routing table has been read. Costs one turn, once per exit.
 *
 * Flow:
 *   1. tool_result on Agent / get_subagent_result → if the output contains an
 *      EXIT REPORT, arm the gate.
 *   2. tool_call on read / bash naming exit-handling.md → disarm (the parent has
 *      the table).
 *   3. tool_call on Agent while armed → block once, naming the file to read.
 *
 * Escape hatch: PI_SKIP_EXIT_REPORT_GATE=1.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SPAWN_TOOL = "Agent";
const RESULT_TOOLS = new Set(["Agent", "get_subagent_result"]);

/** The routing table's own filename — the thing that must be read. */
const ROUTING_FILE = "exit-handling.md";
const ROUTING_PATH = "~/.agents/skills/delegate-subagents/references/exit-handling.md";

/** Matches the EXIT REPORT text convention, tolerant of surrounding markup. */
const EXIT_REPORT_PATTERN = /EXIT\s+REPORT/i;

const BLOCK_REASON =
  "An EXIT REPORT is outstanding and its routing table has not been read. Read " +
  `${ROUTING_PATH} first — it maps each Reason (verification-failed, stuck, ` +
  "blocker, checkpoint:*, architectural-decision, deviation-unclear, " +
  "auth-required, commit-failed) to what to try and when to escalate to the " +
  "user instead of re-dispatching. Then spawn.";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SKIP_EXIT_REPORT_GATE === "1") return;

  let armed = false;
  let blockedOnce = false;

  function textOf(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
      .map((b) => (b && typeof b === "object" && (b as { text?: string }).text) || "")
      .join("\n");
  }

  pi.on("tool_result", async (event) => {
    if (!RESULT_TOOLS.has(event.toolName)) return;
    if (EXIT_REPORT_PATTERN.test(textOf(event.content))) {
      armed = true;
      blockedOnce = false;
    }
  });

  pi.on("tool_call", async (event) => {
    if (!armed) return { block: false };

    // Reading the routing table — by the read tool or by shelling out — clears it.
    const input = event.input as { path?: string; command?: string } | undefined;
    const target = `${input?.path ?? ""} ${input?.command ?? ""}`;
    if (target.includes(ROUTING_FILE)) {
      armed = false;
      return { block: false };
    }

    if (event.toolName !== SPAWN_TOOL) return { block: false };

    // Block once per exit: if the model insists after being told, it may have a
    // reason the gate can't see, and a hard loop would strand the run.
    if (blockedOnce) {
      armed = false;
      return { block: false };
    }
    blockedOnce = true;
    return { block: true, reason: BLOCK_REASON };
  });
}
