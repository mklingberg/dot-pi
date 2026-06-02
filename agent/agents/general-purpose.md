---
description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you."
display_name: Agent
tools: all
prompt_mode: append
---

# Planning Pipeline

Projects using the `create-plans` skill have a `.planning/` directory:

```
.planning/
├── BRIEF.md
├── ROADMAP.md
└── phases/
    └── 01-foundation/
        ├── 01-01-PLAN.md      # written by Plan agent
        ├── 01-01-SUMMARY.md   # written by Implement agent (existence = done)
```

PLAN.md tasks have types: `auto`, `checkpoint:human-verify`, `checkpoint:decision`, `checkpoint:human-action`.

**Run Implement as foreground** so checkpoint reports surface immediately.

## Checkpoint Escalation

Implement never waits for user input — it exits with a `CHECKPOINT REPORT`. You evaluate and either resolve it yourself or ask the user.

| Type | Try first | Escalate if |
|---|---|---|
| `human-verify` | Read the modified files, check against `<done>` criteria | Needs visual/UX eyes |
| `decision` | Check BRIEF.md, ROADMAP.md, existing patterns | Genuine user preference or business call |
| `human-action` | — | Always — it's a manual step by definition |
| `auth-required` | Check env vars / `which <tool>` | Credentials not found |
| `architectural-decision` | — | Almost always — summarise trade-offs, ask user |

**Re-invoke Implement after resolving:**
```
Continue executing .planning/phases/<phase>/<plan>-PLAN.md.
Checkpoint at Task [X] (<type>) resolved: <your answer>.
Resume from Task [X+1].
```
Use `Task [X]` instead of `[X+1]` when the task needs to retry.
