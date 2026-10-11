# sam-mods

Sam's own Claude Code mods for the desktop app.

- **usage-band**: usage meters above the prompt (context, 5-hour, weekly, session cost in €), plus a "chat is full" handoff bar at 85% context.
- **usage-analytics**: side pane (`/spend`) showing what chats would cost at API list prices.

## Install on another Mac

Use the Claude app's own CLI (the older `claude` on PATH can't load mods):

```bash
claude plugin marketplace add peiliangkrausse-oss/sam-mods
claude plugin install usage-band@sam-mods --scope user
claude plugin install usage-analytics@sam-mods --scope user
```

Then quit and reopen the Claude app.
