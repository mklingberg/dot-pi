# dot-pi

My personal [pi](https://github.com/earendil-works/pi) configuration.

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

## Under the Hood

Pi uses [RTK](https://github.com/rtk-ai/rtk) — a CLI proxy that intercepts bash command output and filters/compresses it before it reaches the LLM context. Achieves 60–90% token savings on common dev commands (`git`, `grep`, `ls`, test runners, etc.) with <10ms overhead.

## Packages

| Package | Purpose |
|---|---|
| `pi-zentui` | Starship-inspired statusline |
| `pi-context` | Context management tools |
| `pi-mcp-adapter` | MCP server adapter |
| `@tintinweb/pi-subagents` | Claude Code-style autonomous subagents |
| `@juicesharp/rpiv-ask-user-question` | Structured user questions |
| `@tmustier/pi-usage-extension` | Usage tracking |

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

## Settings

- **Default provider:** GitHub Copilot
- **Default model:** Claude Sonnet 4.6
- **Theme:** Catppuccin Frappé


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
