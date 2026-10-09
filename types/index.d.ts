export type ConnectorKind = 'npx' | 'node' | 'command' | 'remote' | 'claude.ai' | 'plugin' | 'unknown'

export type ConnectorTool = { name: string; tokens: number; isLoaded: boolean }

export type ConnectorServer = {
  name: string
  kind: ConnectorKind
  // Where it is configured: .mcp.json, user, local, claude.ai, plugin.
  scope: string
  // The npm package it runs, when there is one, and the version spec it asks
  // npx for (`latest`, `1.2.3`, or null when unpinned).
  pkg: string | null
  spec: string | null
  installed: string | null
  tools: ConnectorTool[]
}

export type ConnectorCalls = { calls: number; errors: number; tokens: number; max: number }

export type ConnectorContext = { used: number | null; window: number; mcpLoaded: number }

export type ConnectorHistory = { calls: number; tokens: number; lastAt: number }

declare module 'claude-code' {
  interface PluginState {
    'connector-center': {
      servers: ConnectorServer[]
      context: ConnectorContext | null
      // By tool name (mcp__server__tool), this session.
      calls: Record<string, ConnectorCalls>
      // By server name, across sessions (mirrors $.store).
      history: Record<string, ConnectorHistory>
      latest: Record<string, string>
      checking: boolean
      selected: string | null
    }
  }
}
