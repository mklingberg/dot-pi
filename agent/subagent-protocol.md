# Subagent Delegation & Orchestration

## Create-Plans Pipeline

```
.planning/
├── BRIEF.md
├── ROADMAP.md
├── ISSUES.md             # deferred enhancements (Rule 5)
└── phases/01-foundation/
    ├── 01-01-PLAN.md     # main agent writes
    └── 01-01-SUMMARY.md  # Implement writes (existence = done)
```

PLAN.md task types: `auto`, `checkpoint:human-verify`, `checkpoint:decision`, `checkpoint:human-action`.

## Delegation Policy

- **Research** — any web search / online docs. Don't call duckduckgo MCP directly.
- **Explore** — any codebase search. Keeps search output out of parent context.
- **PLAN.md** — write directly. Planning needs full context + user interaction.
- **Implement** — well-specified mechanical plans. One Implement per PLAN.md.
- **general-purpose** — plans needing ambiguous deviations, exploratory fixes, judgment beyond what's written.
- **Review** — after every Implement that returned a **Completion Report** (§8 in Implement.md), not after an EXIT REPORT. Pass PLAN.md path. Surface to user only on FAIL.
- **Debug** — on Implement exits `verification-failed`, `stuck`, or `blocker`. Pick a fix, re-invoke Implement.

## Implement Exit Routing

Implement exits with `EXIT REPORT` containing a `Reason`. Each invocation is a fresh subagent — to resolve, **re-invoke** with the resolution (see §Re-invocation). To redirect *while still running* (rare), use `steer_subagent`.

| Reason | Try first | Escalate if |
|---|---|---|
| `checkpoint` + subtype `human-verify` | Read modified files vs `<done>` | Needs visual/UX eyes |
| `checkpoint` + subtype `decision` | Check BRIEF, ROADMAP, ISSUES, patterns | Genuine user preference / business call |
| `checkpoint` + subtype `human-action` | — | Always |
| `architectural-decision` | — | Almost always — summarise trade-offs |
| `auth-required` | Check env vars; if set, re-invoke. Otherwise → user | Almost always (browser/2FA/missing creds) |
| `verification-failed` | Spawn Debug with failure | Debug ambiguous |
| `stuck` | Read "Tried" list — spawn Debug with that context, then re-invoke Implement with a different approach | Approach unclear or scope call |
| `deviation-unclear` | — | Always |
| `blocker` | If `trigger:` starts with `malformed-plan:` → ask user. Else → spawn Debug | Debug can't resolve |
| `commit-failed` | Inspect `git status` / hooks / lock files. Resolve and re-invoke | Repo state needs human (rebase, force-push call) |

Subtypes are planner hints, not directives — parent decides routing.

**Default to asking the user when unsure.** Use `ask_user_question` with the EXIT REPORT options.

**Many trivial checkpoint exits = plan too coarse.** If a plan exits 3+ times for verifies you can resolve from file reads, suggest the user split it.

## Review FAIL routing

- **Trivial fix** (missing import, wrong constant): re-invoke Implement with `Fix: <Review's specific issue>` and the PLAN.md path.
- **Non-trivial / root cause unclear**: spawn Debug with Review's FAIL output, then re-invoke Implement with the chosen fix.
- **Plan/spec wrong**: ask the user.

## Plan Completion → Next Plan

Don't auto-chain. After Implement completes + Review passes, report to user with the "Next: ..." line from the completion report. Wait for explicit go-ahead before spawning the next Implement. (Matches "establish scope before spawning".)

## Aborting a Running Implement

- Graceful: `steer_subagent(id, "Stop now. Emit EXIT REPORT with reason: blocker, trigger: 'aborted by parent'. Do not continue.")`
- Hard: stop calling it. Outstanding work is lost. Use only if graceful fails.

## Parallelism

Sequential by default. Parallel Implement runs only when plans touch **disjoint files** (verify via plan `<files>` lists). Same-phase plans usually conflict — assume sequential unless proven otherwise.

## Re-invocation

```
Continue executing .planning/phases/<phase>/<plan>-PLAN.md.
Exit at Task [X] (<reason>) resolved: <decision / action / human's answer>.
Restart at: Task [X] (retry the stopped task) OR Task [X+1] (continue past it).
```

The `Restart at` instruction overrides Implement's auto-skip of evidenced-complete tasks. Implement is stateless across invocations — it re-reads PLAN.md and @context every time.
