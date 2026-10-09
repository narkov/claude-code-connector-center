import { expect, mock, test } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'

const ga4 = (name: string) => ({ command: 'npx', args: ['-y', 'mcp-google-analytics'], env: {} })
const MCP_JSON = JSON.stringify({
  mcpServers: {
    'ga4-shop': ga4('ga4-shop'),
    'ga4-blog': ga4('ga4-blog'),
    playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
  },
})
const FILES: Record<string, string> = {
  '/proj/.mcp.json': MCP_JSON,
  '/home/.npm/_npx/abc/node_modules/mcp-google-analytics/package.json': '{"version":"1.2.0"}',
}

const tools = [
  { name: 'mcp__ga4-shop__ga_run_report', serverName: 'ga4-shop', tokens: 2400, isLoaded: true },
  { name: 'mcp__ga4-blog__ga_run_report', serverName: 'ga4-blog', tokens: 2400, isLoaded: true },
  { name: 'mcp__playwright__browser_click', serverName: 'playwright', tokens: 300, isLoaded: false },
]

test('/connectors ranks schema tokens, counts replies and suggests cuts', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  mock.store(on)
  mock.clock(on, { now: 1_000_000_000_000 })
  on('session.root', async () => ({ value: '/proj' }))
  on('session.usage', async () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: 40_000,
        window: 200_000,
        percent: 20,
        breakdown: { totalTokens: 40_000, mcpTools: tools },
      },
    } as unknown as SessionUsage,
  }))
  on('fs.read', async (_$, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`missing ${e.path}`)

    return { value: text }
  })
  on('fs.list', async (_$, e) => ({
    value:
      e.path === '/home/.npm/_npx'
        ? [{ name: 'abc', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }]
        : [],
  }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok', text: 'x'.repeat(40_000) }))

  await $.tool.call({ tool: 'mcp__ga4-shop__ga_run_report' })
  await $.tool.call({ tool: 'mcp__ga4-shop__ga_run_report' })

  const ran = await $.command.run({ command: 'connectors', args: '' })
  expect(ran.text).toContain('MCP schemas ≈4.8k in context')
  expect(ran.text).toContain('ga4-shop: 1 tools, ≈2.4k in context, ≈0 deferred, 2 calls ≈20k, version 1.2.0')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'connector-center',
      surface,
      component: 'Pane',
      requestId: 'connector-center',
      viewport: { columns: 120, rows: 40 },
      props: { title: 'Connectors', bodyColumns: 116 },
    })
    expect(await ui.find({ type: 'Text', text: /2× mcp-google-analytics/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ga4-blog: ≈2\.4k in context every turn/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ga4-shop: average reply ≈10k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /playwright: npx @playwright\/mcp@latest is not pinned/ })).toBeDefined()
    await ui.press({ key: 'server:ga4-shop' })
    expect(await ui.find({ type: 'Text', text: /ga_run_report {2}2× ≈20k/ })).toBeDefined()
    await ui.press({ key: 'all' })
    await ui.unmount()
  }
})
