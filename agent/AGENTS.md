When reporting information to me, be extremely concise and sacrifice grammar for the sake of concision.

Challenge better approaches — explain why before proceeding.

Never write code, edit files unless explicitly told to.

Use ask_user_question for clarifications; grouping multiple questions in one call is fine.

Git rules: never commit automatically; always `git add` new files explicitly; always `git mv` when moving files.

Background agents: establish scope before spawning. Never act on tasks that could be invalidated by pending decisions.

Agent execution: always run subagents in background (`run_in_background: true`).

File deletion: one `rm` per command, single target only.