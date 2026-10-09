# Connector Center for Claude Code

A Claude Code mod that shows how many tokens each MCP connector costs you — and what to switch off.

Every connected MCP server puts its tool schemas into the context window on every turn, and every tool call brings back a reply that stays in the conversation. With ten or twenty connectors that adds up fast, and Claude Code doesn't show you where it goes. `/connectors` does.

## What it shows

- **Schema tokens per connector**: what each server's tool definitions cost in context on every turn (●), and what sits deferred until loaded via ToolSearch (○).
- **Reply tokens per tool**: calls, total and largest reply this session, plus call history across sessions.
- **Versions**: the npm package each `npx` server runs, the installed version, and whether a newer one exists on npm.
- **What to optimize**:
  - connectors that cost ≥1.5k tokens every turn but haven't been called in 14 days (or ever);
  - tools whose replies average ≥6k tokens (ask for `limit`/`fields`, or filter in a script);
  - several copies of the same npm server with identical schemas;
  - unpinned `npx …@latest` servers;
  - configured servers that expose no tools (failed to connect or disabled).

Click a connector (or run `/connectors <name>`) to see its tools ranked by schema size.

Token figures are estimates (≈4 Latin or ≈2 Cyrillic characters per token), shown with `≈` everywhere.

## Install

In a Claude Code terminal session:

```
/plugin install connector-center --marketplace narkov/claude-code-connector-center
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Use

```
/connectors            # open the pane: all connectors, ranked by context cost
/connectors ga4        # jump to a connector by name
```

In the pane: `r` refresh, `u` check npm for updates, `0` back to the full list. A status-line entry shows the total MCP schema cost in context.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
