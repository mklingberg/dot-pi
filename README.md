# dot-pi

My personal [pi](https://github.com/earendil-works/pi) configuration.

## Structure

```
~/.pi/
├── agent/
│   ├── extensions/
│   │   └── damage-control.ts     # Safety rules enforcement extension
│   ├── themes/                   # Custom themes (catppuccin variants + dracula)
│   ├── settings.json             # Main pi settings
│   └── zentui.json               # Zentui statusline config
└── damage-control-rules.yaml     # Bash command safety rules
```

## Packages

| Package | Purpose |
|---|---|
| `pi-zentui` | Starship-inspired statusline |
| `pi-context` | Context management tools |
| `context-mode` | Efficient context window usage |
| `pi-mcp-adapter` | MCP server adapter |
| `pi-btw` | BTW integration |
| `@juicesharp/rpiv-ask-user-question` | Structured user questions |
| `@tmustier/pi-usage-extension` | Usage tracking |

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
