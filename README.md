# dot-pi

Personal [pi](https://github.com/earendil-works/pi) config — agents, skills, and safety rules for solo agentic development. 

- Your setup. Your rules. No compromises.

## Agent Pipeline

```
General
  └─ Plan          (writes PLAN.md)
       └─ Implement (executes PLAN.md → SUMMARY.md + commit)
            └─ Review (verifies success criteria)
                 └─ Debug (on failure → proposes fixes → back to Implement)
```

| Agent | Model | Role |
|---|---|---|
| **General** | Sonnet 4.6 | Orchestrator — multi-step tasks, checkpoint resolution |
| **Plan** | Sonnet 4.6 | Writes executable PLAN.md from `.planning/` structure |
| **Implement** | Haiku 4.5 | Executes PLAN.md tasks, commits, writes SUMMARY.md |
| **Review** | Haiku 4.5 | Verifies `<done>` conditions + success criteria post-implement |
| **Debug** | Sonnet 4.6 | Diagnoses blockers/failures, proposes fix options — read-only |
| **Explore** | Haiku 4.5 | Read-only codebase search — files, symbols, patterns |
| **Research** | Haiku 4.5 | Web search and online documentation lookup |

## Workflow: Starting a Feature

Most AI coding setups fail the same way: the agent lacks context, makes wrong assumptions, drifts mid-task, or produces a 500-line change you can't review. This workflow is designed to eliminate all of that.

### Step 1 — Align before you build (`grill-with-docs`)

Before any code is written, `grill-with-docs` interviews you relentlessly about your plan — then cross-references it against the actual codebase. Terminology gets sharpened against `CONTEXT.md`. Ambiguous decisions get locked in as ADRs. By the end, you and the agent share the same mental model. No silent assumptions, no revisiting settled debates mid-implementation.

### Step 2 — Capture the plan as structured, context-safe chunks

This is where the setup earns its keep. LLM context degrades as it fills up — long tasks produce worse output near the end. The planning layer solves this by breaking work into independently executable `PLAN.md` files, each sized to stay within ~50% of the model's context window. Quality stays consistent from the first task to the last.

**`to-plan`** — fast path for small, well-understood scope. Converts the current conversation directly into a `PLAN.md` with no further questions. Run it right after the grilling session.

**`create-plans`** — full planning session for large or multi-phase work. Produces a `BRIEF.md`, a `ROADMAP.md`, and a structured `.planning/` directory of phase plans that persist across sessions. Every future agent starts with the full picture — architectural decisions, prior deviations, the *why* behind every choice.

### Step 3 — Subagents take over

Once the plan exists, the main agent steps back. Dedicated subagents spin up to own execution end-to-end — keeping the orchestrator's context clean and each agent focused on a single responsibility.

`Implement` picks up the `PLAN.md`, works through tasks sequentially, and commits after each plan with a `SUMMARY.md`. `Review` spins up independently to verify every `<done>` condition against the actual output — not the agent's self-report. If something breaks, `Debug` takes over read-only, diagnoses the root cause, and hands a concrete fix back to `Implement` to retry. No human in the loop unless a checkpoint explicitly demands it.

```
grill-with-docs  →  to-plan        (small / clear scope)
                 →  create-plans   (large / multi-phase)
                          ↓
                     Implement → Review → repeat
```

The result: features that ship cleanly, plans that survive context resets, and an agent that doesn't re-litigate decisions you've already made.

## Settings

- **Default provider:** GitHub Copilot
- **Default model:** Claude Sonnet 4.6
- **Theme:** Catppuccin Frappé

## Structure

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
│   │   └── damage-control.ts     # Safety rules enforcement extension
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
| `pi-context` | Context management tools |
| `pi-mcp-adapter` | MCP server adapter |
| `@tintinweb/pi-subagents` | Claude Code-style autonomous subagents |
| `@juicesharp/rpiv-ask-user-question` | Structured user questions |
| `@tmustier/pi-usage-extension` | Usage tracking |

## Under the Hood

Pi uses [RTK](https://github.com/rtk-ai/rtk) — a CLI proxy that intercepts bash command output and filters/compresses it before it reaches the LLM context. Achieves 60–90% token savings on common dev commands (`git`, `grep`, `ls`, test runners, etc.) with <10ms overhead.

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
