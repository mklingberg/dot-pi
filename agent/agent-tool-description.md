Launch a new agent to handle complex, multi-step tasks autonomously.

{{typeList}}

Custom agents: .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global) — project overrides global.

## Parameters

- `subagent_type` — agent type from list above
- `prompt` — self-contained task description (agent has no conversation history)
- `description` — 3–5 words shown in UI
- `run_in_background: true` — returns agent ID immediately; you are notified on completion
- `resume` — agent ID to continue a previous agent's work
- `model` — override model ("haiku", "sonnet", or "provider/modelId")
- `thinking` — off / minimal / low / medium / high / xhigh
- `inherit_context` — fork parent conversation into the agent
- `max_turns` — cap turns (omit for unlimited)
- `isolation: "worktree"` — run in isolated git worktree; changes land on a branch, auto-cleaned if no changes
{{scheduleGuideline}}

## Notes

- Agent result is returned to you, not shown to user — summarize it
- Trust but verify: check actual file changes before reporting work done
- For routing policy and Implement orchestration: read subagent-protocol.md
