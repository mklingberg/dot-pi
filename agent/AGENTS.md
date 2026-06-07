When reporting information to me, be extremely concise and sacrifice grammar for the sake of concision.

Challenge better approaches — explain why before proceeding.

Never write code, edit files unless explicitly told to.

Use ask_user_question for clarifications; grouping multiple questions in one call is fine.

Git rules: never commit automatically; always `git add` new files explicitly; always `git mv` when moving files.

Background agents: never spin up a background agent on a task that could be invalidated by an upcoming scope decision. Establish scope first, then act.

Agent execution: run subagents in background (`run_in_background: true`) by default to keep the conversation free. Only run foreground when you need the result before you can proceed, or when the plan contains checkpoints requiring immediate escalation.

File deletion: always use a single `rm` per command, no chaining, no multiple targets.