/**
 * no-block-wait.ts
 *
 * Enforces the "never block-wait on a subagent" rule from AGENTS.md /
 * subagent-protocol.md, which prose alone does not hold.
 *
 * Root cause it addresses: when a background agent is still running,
 * @tintinweb/pi-subagents ends its own tool result with
 *   "Agent is still running. Use wait: true or check back later."
 * — an explicit instruction to block, delivered far more recently than any
 * protocol doc. Two hooks:
 *
 *   1. tool_call  — block get_subagent_result(wait: true). The completion
 *      notification arrives on its own; a blocking wait only removes the
 *      user's chance to steer. Blocking (rather than silently rewriting
 *      `wait` to false) puts a reason in the transcript the model can act on.
 *   2. tool_result — strip the "use wait: true" nudge so the pressure that
 *      caused the block is gone. Without this, the model retries into hook 1.
 *
 * Cost of a blocked wait: none. Per the plugin's CHANGELOG a wait that never
 * runs leaves the result unconsumed and its completion notification still
 * fires.
 *
 * Known minor cost: a `wait: true` call on an agent that has ALREADY finished
 * is harmless upstream but still blocked here — the hook can't see record
 * status without coupling to the plugin's RPC. Costs one retry without `wait`.
 *
 * Upgrade fragility: hook 1 keys on the tool name and the `wait` param (public
 * schema — stable). Hook 2 keys on an internal prose string, so it is matched
 * loosely and reports itself if the string moves (see NUDGE_DRIFT_THRESHOLD).
 * If the string is reworded, hook 1 keeps working and behaviour degrades to
 * "blocked with a reason" — never to silently permitting the wait.
 *
 * Escape hatch: PI_ALLOW_BLOCK_WAIT=1 disables both hooks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GET_RESULT_TOOL = "get_subagent_result";

/** Loose on purpose — survives rewording around the actionable part. */
const NUDGE_PATTERN = /Use\s+wait:\s*true[^.\n]*\.?/i;

const NUDGE_REPLACEMENT =
  "Agent is still running. Do not wait for it — end your turn; " +
  "its completion notification will arrive on its own.";

const BLOCK_REASON =
  `Blocked: ${GET_RESULT_TOOL} with wait: true blocks the turn and stops the user ` +
  "from steering, for no benefit — the result arrives on its own as a completion " +
  "notification. Do not retry with wait, and do not poll.\n\n" +
  "End your turn now: one line to the user saying what you dispatched and what " +
  "you will do with the result. An otherwise-empty turn after a spawn is correct.\n\n" +
  `To read the result of an agent that has ALREADY reported complete, call ` +
  `${GET_RESULT_TOOL} without wait.`;

/**
 * After this many "still running" results with no successful nudge rewrite,
 * assume the upstream string changed and say so once.
 */
const NUDGE_DRIFT_THRESHOLD = 3;

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ALLOW_BLOCK_WAIT === "1") return;

  let runningResultsSeen = 0;
  let nudgesRewritten = 0;
  let driftReported = false;

  pi.on("tool_call", async (event) => {
    if (event.toolName !== GET_RESULT_TOOL) return { block: false };

    const input = event.input as { wait?: boolean } | undefined;
    if (input?.wait !== true) return { block: false };

    return { block: true, reason: BLOCK_REASON };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== GET_RESULT_TOOL) return;
    if (!Array.isArray(event.content)) return;

    let matched = false;
    const content = event.content.map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") return block;
      if (!NUDGE_PATTERN.test(block.text)) return block;

      matched = true;
      // The upstream sentence is "Agent is still running. Use wait: true or
      // check back later." — replace the whole thing, not just the fragment.
      const text = block.text.replace(
        /Agent is still running\.\s*/i,
        "",
      ).replace(NUDGE_PATTERN, NUDGE_REPLACEMENT);
      return { ...block, text };
    });

    // Drift detection: "still running" wording is a separate, blunter signal
    // than the nudge itself, so a mismatch between the two means the nudge
    // moved and hook 2 has silently stopped working.
    const sawRunning = event.content.some(
      (block) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        /still running/i.test(block.text),
    );
    if (sawRunning) runningResultsSeen++;
    if (matched) nudgesRewritten++;

    if (
      !driftReported &&
      nudgesRewritten === 0 &&
      runningResultsSeen >= NUDGE_DRIFT_THRESHOLD
    ) {
      driftReported = true;
      ctx.ui.notify(
        "no-block-wait: pi-subagents' 'use wait: true' nudge no longer matches — " +
          "blocking still works, but update NUDGE_PATTERN in no-block-wait.ts.",
      );
    }

    if (!matched) return;
    return { content };
  });
}
