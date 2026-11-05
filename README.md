# sam-mods

Sam's own Claude Code mods for the desktop app.

- **usage-band**: one thin line above the prompt — 5-hour and weekly limits with reset times, this chat's cost in €, and a Usage link; plus a "chat is full" hand-off row at 85% context.
- **usage-analytics**: side pane (`/spend`) showing what chats would cost at API list prices.
- **mcp-panel**: side pane (`/mcp-panel`) plus a footer MCP button to switch MCP servers per folder.

## Install on another Mac

Use the Claude app's own CLI (the older `claude` on PATH can't load mods):

```bash
claude plugin marketplace add peiliangkrausse-oss/sam-mods
claude plugin install usage-band@sam-mods --scope user
claude plugin install usage-analytics@sam-mods --scope user
claude plugin install mcp-panel@sam-mods --scope user
```

To update an existing install later:

```bash
claude plugin marketplace update sam-mods
claude plugin update usage-band@sam-mods
```

Then quit and reopen the Claude app.
