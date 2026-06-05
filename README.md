# dot-pi

A [pi](https://github.com/earendil-works/pi) setup for structured, context-safe solo development — durable plans, specialist subagents, and guardrails that keep long-running work reliable.

> Structured agents. Durable plans. Safer execution.

## Agent Pipeline

This setup turns one-shot prompting into a real delivery workflow: plan deliberately, execute in focused chunks, verify independently, and preserve enough context to keep moving across long sessions.

```
General
  └─ Plan          (writes PLAN.md)
       └─ Implement (executes PLAN.md → SUMMARY.md + staged changes)
            └─ Review (verifies success criteria)
                 └─ Debug (on failure → proposes fixes → back to Implement)
```

`Explore` and `Research` are side specialists — pulled in on demand so search and web lookup never bloat the orchestrator's context.

| Agent | Model | Role |
|---|---|---|
| **General** | Sonnet 4.6 | Keeps the workflow moving — orchestration, delegation, checkpoint resolution |
| **Plan** | Sonnet 4.6 | Turns scoped work into executable `PLAN.md` files |
| **Implement** | Haiku 4.5 | Executes the plan, stages changes, writes durable summaries |
| **Review** | Haiku 4.5 | Verifies success criteria independently against real output |
| **Debug** | Sonnet 4.6 | Diagnoses blockers and failures, then hands back a concrete fix path |
| **Explore** | Haiku 4.5 | Fast read-only codebase search for files, symbols, and patterns |
| **Research** | Haiku 4.5 | Focused web research and documentation lookup |

## Workflow: Starting a Feature

Most AI coding workflows break in predictable ways: giant prompts, missing context, unreviewable diffs, and agents that forget why a decision was made two hours ago. This setup is built to prevent that.

### Step 1 — Align before you build (`grill-with-docs`)

Start by pressure-testing the idea before code exists. `grill-with-docs` doesn't just ask questions — it checks your plan against the real codebase, sharpens terminology against `CONTEXT.md`, and turns fuzzy architecture calls into explicit ADRs. The payoff is simple: shared understanding up front, fewer wrong turns later. No silent assumptions. No mid-implementation re-litigation.

### Step 2 — Turn scope into reviewable, context-safe execution chunks

This is the core advantage of the setup. Instead of betting an entire feature on one bloated prompt, the planning layer breaks work into small, high-signal `PLAN.md` files that stay comfortably within the model's effective context window. That means better consistency, smaller diffs, easier review, and cleaner recovery when a task needs to pause or resume.

**`to-plan`** is the fast path. When the design is already clear, it converts the current conversation directly into an executable `PLAN.md` — no extra ceremony, no re-interviewing.

**`create-plans`** is the scaling path. For larger or multi-phase work, it builds a durable planning system: `BRIEF.md`, `ROADMAP.md`, and a `.planning/` directory of phase plans and summaries. The value isn't just structure — it's continuity. Every future agent inherits the decisions, trade-offs, and history that would otherwise be lost in a fresh session.

### Step 3 — Let specialist subagents do the heavy lifting

Once the plan is written, the orchestrator stops doing execution work itself. Specialist subagents take over so the main agent can stay focused on coordination and decisions instead of burning context on implementation details.

`Implement` owns execution. It picks up a `PLAN.md`, works through it sequentially, stages the resulting changes, and writes a `SUMMARY.md` that preserves exactly what happened.

`Review` owns verification. It checks the output against the actual `<done>` conditions and success criteria — independent validation, not self-grading.

`Debug` owns failure diagnosis. When something breaks, it investigates read-only, isolates the root cause, and hands a concrete fix path back to `Implement`.

The result is a workflow where planning, execution, verification, and debugging are split across focused agents instead of crammed into one overloaded context.

```
grill-with-docs  →  to-plan        (small / clear scope)
                 →  create-plans   (large / multi-phase)
                          ↓
                     Implement → Review → repeat
```

The net effect: cleaner features, smaller review surfaces, durable project memory, and a workflow that keeps getting more reliable as the work gets bigger.

## Defaults

- **Provider:** GitHub Copilot
- **Model:** Claude Sonnet 4.6
- **Theme:** Catppuccin Frappé

## Structure

The repo layout mirrors the workflow: agent behavior at the core, extensions for guardrails and ergonomics, and top-level safety rules protecting the shell.

```
~/.pi/
├── agent/
│   ├── agents/                   # Custom agent overrides
│   │   ├── Explore.md            # Read-only codebase search (Haiku)
│   │   ├── Implement.md          # Plan executor (Haiku)
│   │   ├── Plan.md               # PLAN.md writer (Sonnet)
│   │   ├── Research.md           # Web research (Haiku)
│   │   ├── Review.md             # Post-implement verifier (Haiku)
│   │   ├── Debug.md              # Failure diagnosis, proposes fixes (Sonnet)
│   │   └── general-purpose.md   # Orchestrator (Sonnet)
│   ├── extensions/
│   │   ├── damage-control.ts     # Safety rules enforcement extension
│   │   ├── rtk.ts                # Bash rewrite via RTK for token savings
│   │   └── hide-mcp-status.ts    # Hides noisy zero-state UI status
│   ├── themes/                   # Custom themes (catppuccin variants + dracula)
│   ├── AGENTS.md                 # Global agent behaviour rules
│   ├── settings.json             # Main pi settings
│   └── zentui.json               # Zentui statusline config
└── damage-control-rules.yaml     # Bash command safety rules
```

## Packages

| Package | Purpose |
|---|---|
| `pi-zentui` | Starship-inspired statusline |
| `pi-context` | Context management and durable session handoffs |
| `pi-mcp-adapter` | MCP server integration |
| `@tintinweb/pi-subagents` | Autonomous specialist subagents |
| `@juicesharp/rpiv-ask-user-question` | Structured user clarification flows |
| `@tmustier/pi-usage-extension` | Usage tracking |

## Under the Hood

[RTK](https://github.com/rtk-ai/rtk) sits in front of shell output and aggressively compresses noisy command results before they hit model context. On common dev commands (`git`, `grep`, `ls`, test runners), that usually means 60–90% token savings with negligible overhead.

## New machine setup

1. Install pi: `brew install pi-coding-agent`
2. Clone: `git clone https://github.com/mklingberg/dot-pi.git ~/.pi`
3. Add MCP servers manually: `~/.pi/agent/mcp.json` (see [MCP config](#mcp-config))
4. Log in to providers: run `pi` and use `/login`

## MCP config

`agent/mcp.json` is gitignored as it contains API keys. Create it manually:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "npx",
      "args": ["-y", "@tiberriver256/mcp-server-azure-devops"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/<org>",
        "AZURE_DEVOPS_AUTH_METHOD": "pat",
        "AZURE_DEVOPS_PAT": "<your-pat>"
      }
    },
    "atlassian": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp"]
    },
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--stdio"],
      "env": {
        "FIGMA_API_KEY": "<your-api-key>"
      }
    },
    "LaunchDarkly": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@launchdarkly/mcp-server", "start"],
      "env": {
        "LD_ACCESS_TOKEN": "<your-token>"
      }
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```
