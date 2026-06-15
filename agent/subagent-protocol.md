# Subagent Delegation & Orchestration

## Create-Plans Pipeline

```
.planning/
├── BRIEF.md
├── ROADMAP.md
├── ISSUES.md             # deferred enhancements
└── phases/01-foundation/
    ├── 01-01-PLAN.md     # main agent writes
    └── 01-01-SUMMARY.md  # Implement writes (existence = done)
```

## Execution Loop

Spawn every subagent with `run_in_background: true`. Don't poll — await the completion notification, then read the EXIT / Completion Report and route per tables below. Sequential chains (Implement → Review, Debug → Implement) still spawn each step in background; parent just awaits between them.

PLAN.md task types: `auto`, `checkpoint:human-verify`, `checkpoint:decision`, `checkpoint:human-action`.

## Subagent Economics

Subagents use `prompt_mode: replace` (fresh isolated prompt) or `append` (inherits full parent system prompt).

| Agent | Mode | ~Input tokens |
|---|---|---|
| Explore | replace | **~144** |
| Research | replace | ~239 |
| Debug | replace | ~280 |
| Review | replace | ~276 |
| Implement | replace | ~1,453 |
| general-purpose | **append** | **~10k+** |

**Inline vs delegate:**
- Inline tool results re-compound in parent context every turn; replace-mode subagent results don't.
- **1 targeted lookup** (known file/symbol) → inline.
- **2+ searches OR unknown location** → Explore. No exceptions.
- **general-purpose** costs ~10k parent tokens. Before spawning, state in one line why Explore + Implement + Debug can't cover it.

## Delegation Policy

- **Research** — any web search / online docs. Don't call duckduckgo MCP directly.
- **Explore** — any codebase search with 2+ steps or unknown location. Single targeted lookup → do inline.
- **Implement** — well-specified mechanical plans. One Implement per PLAN.md.
- **general-purpose** — only for substantial work needing parent context/judgment: ambiguous deviations, exploratory fixes, multi-file investigations beyond Explore's scope.
- **Review** — after every Implement Completion Report (not EXIT REPORT). Pass PLAN.md path. **Skip** if plan had ≤2 auto tasks with no writes outside `<files>`. Surface to user only on FAIL; warnings → note inline, don't block.
- **Debug** — on Implement exits `verification-failed`, `stuck`, or `blocker`. Pick a fix, re-invoke Implement.

## Implement Exit Routing

Implement exits with `EXIT REPORT` containing a `Reason`. Each invocation is a fresh subagent — to resolve, **re-invoke** with the resolution (see §Re-invocation). To redirect *while still running* (rare), use `steer_subagent`.

| Reason | Try first | Escalate if |
|---|---|---|
| `checkpoint` + subtype `human-verify` | Diff modified files vs `<done>`; run task's verify command if present | Needs visual/UX eyes |
| `checkpoint` + subtype `decision` | Check BRIEF, ROADMAP, ISSUES, patterns | Genuine user preference / business call |
| `checkpoint` + subtype `human-action` | — | Always |
| `architectural-decision` | — | Almost always — summarise trade-offs |
| `auth-required` | Check env vars; if set, re-invoke. Otherwise → user | Almost always (browser/2FA/missing creds) |
| `verification-failed` | Spawn Debug with failure | Debug ambiguous |
| `stuck` | Read "Tried" list — spawn Debug with that context, then re-invoke Implement with a different approach | Approach unclear or scope call |
| `deviation-unclear` | — | Always |
| `blocker` | If `trigger:` starts with `malformed-plan:` → ask user. Else → spawn Debug | Debug can't resolve |
| `commit-failed` | Inspect `git status` / hooks / lock files. Resolve and re-invoke¹ | Repo state needs human (rebase, force-push call) |

Subtypes are planner hints, not directives — parent decides routing.

¹ Implement owns its own commits — orchestrator's "no auto-commit" rule doesn't apply inside its scope.

**Debug-loop cap:** after 2 Debug → Implement cycles on the same task, escalate to user.

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

Sequential by default. Parallel Implement runs only when plans touch **disjoint files** (verify via plan `<files>` lists). Same-phase plans usually conflict — assume sequential unless proven otherwise. Overlapping files → spawn each Implement with `isolation: worktree` and merge branches after. Batch Review calls (pass multiple PLAN.md paths) when parallel Implements complete together.

## Re-invocation

```
Continue executing .planning/phases/<phase>/<plan>-PLAN.md.
Exit at Task [X] (<reason>) resolved: <decision / action / human's answer>.
Restart at: Task [X] (retry the stopped task) OR Task [X+1] (continue past it).
```

The `Restart at` instruction overrides Implement's auto-skip of evidenced-complete tasks. Implement is stateless across invocations — it re-reads PLAN.md and @context every time.
