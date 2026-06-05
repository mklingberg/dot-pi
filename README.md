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

Skills from `~/.agents/skills/` plug into the agent pipeline at the planning stage. The typical sequence:

**Step 1 — Establish domain understanding** (`grill-with-docs`)

Challenge your plan against the existing codebase. Cross-references code, aligns terminology with `CONTEXT.md`, crystallises hard decisions into ADRs. End with a shared mental model of *what* and *why*.

**Step 2a — Plan is already clear** (`to-plan`)

Run immediately after the grilling session in the same conversation. Converts established context into a `PLAN.md` — no new questions asked. Fast path for small/clear scope.

**Step 2b — Large or multi-phase scope** (`create-plans`)

Starts a full planning session: brief → roadmap → phases → individual `PLAN.md` files. Use when `to-plan` would produce a plan too large for one execution context, or when you want a durable `.planning/` structure across many sessions.

**Step 3 — Execute**

Hand the `PLAN.md` to the `Plan` agent (if needed) then `Implement`. `Review` runs automatically after each plan. Chain phases until done.

```
grill-with-docs  →  to-plan        (small / clear scope)
                 →  create-plans   (large / multi-phase)
                          ↓
                     Implement → Review → repeat
```

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
