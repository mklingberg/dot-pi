# Subagent Delegation & Orchestration

## Create-Plans Pipeline

```
.planning/
├── BRIEF.md
├── ROADMAP.md
└── phases/01-foundation/
    ├── 01-01-PLAN.md      # main agent writes
    └── 01-01-SUMMARY.md   # Implement writes (existence = done)
```

PLAN.md task types: `auto`, `checkpoint:human-verify`, `checkpoint:decision`, `checkpoint:human-action`.

## Delegation Policy

- **Research** — any web search / online docs. Don't call duckduckgo MCP directly.
- **Explore** — any codebase search. Keeps search output out of parent context.
- **PLAN.md** — write directly. Planning needs full context + user interaction.
- **Implement** (fg) — well-specified mechanical plans.
- **general-purpose** (fg) — plans needing ambiguous deviations, exploratory fixes, judgment beyond what's written.
- **Review** (fg) — after every successful Implement. Pass PLAN.md path. Surface to user only on FAIL.
- **Debug** — on Implement exits `verification-failed`, `stuck`, or `blocker`. Pick a fix option, re-invoke Implement.

## Implement Exit Routing

Implement exits with `EXIT REPORT` containing a `Reason`. Route by reason:

| Reason | Try first | Escalate if |
|---|---|---|
| `checkpoint` + subtype `human-verify` | Read modified files vs `<done>` | Needs visual/UX eyes |
| `checkpoint` + subtype `decision` | Check BRIEF, ROADMAP, ISSUES, patterns | Genuine user preference / business call |
| `checkpoint` + subtype `human-action` | — | Always |
| `architectural-decision` | — | Almost always — summarise trade-offs |
| `auth-required` | `which <tool>` / env vars / non-interactive auth cmd | Needs browser, 2FA, or creds missing |
| `verification-failed` | Spawn Debug with failure | Debug ambiguous |
| `stuck` | Read "Tried" list — spawn Debug with that context, or steer with a different approach | Approach unclear or scope call |
| `deviation-unclear` | — | Always |
| `blocker` | Spawn Debug | Debug can't resolve |

Subtypes are planner hints, not directives — parent decides routing.

**Default to asking the user when unsure.** Cheaper than a wrong autonomous choice. Use `ask_user_question` with the EXIT REPORT options.

## Re-invocation

```
Continue executing .planning/phases/<phase>/<plan>-PLAN.md.
Exit at Task [X] (<reason>) resolved: <decision / action / human's answer>.
Restart at: Task [X] (retry) OR Task [X+1] (continue).
```
