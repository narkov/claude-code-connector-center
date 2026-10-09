import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  ConnectorCalls,
  ConnectorHistory,
  ConnectorKind,
  ConnectorServer,
  ConnectorTool,
} from '../types'

const PANE = 'connector-center'
const TITLE = 'Connectors'
const STORE_KEY = 'history'
const DAY = 24 * 60 * 60 * 1000
const WIDE = 84
const IDLE_TOKENS = 1500
const HEAVY_REPLY = 6000

const servers = atom({ plugin: 'connector-center', key: 'servers' } as const, [])
const context = atom({ plugin: 'connector-center', key: 'context' } as const, null)
const calls = atom({ plugin: 'connector-center', key: 'calls' } as const, {})
const history = atom({ plugin: 'connector-center', key: 'history' } as const, {})
const latest = atom({ plugin: 'connector-center', key: 'latest' } as const, {})
const checking = atom({ plugin: 'connector-center', key: 'checking' } as const, false)
const selected = atom({ plugin: 'connector-center', key: 'selected' } as const, null)

type Json = Record<string, unknown>
type Config = Omit<ConnectorServer, 'tools'>

const obj = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

// Byte-pair tokenizers spend about a token per 4 Latin characters and per 2
// Cyrillic ones: a rough figure, shown with ≈ everywhere.
const estimate = (text: string): number => {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1
    else other += 1
  }

  return Math.ceil(ascii / 4 + other / 2)
}

const fmt = (n: number): string =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const newer = (a: string, b: string): boolean => {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }

  return false
}

const readJson = async ($: EngineInterface, path: string): Promise<Json | null> => {
  try {
    return obj(JSON.parse(await $.fs.read(path)))
  } catch {
    return null
  }
}

const splitSpec = (arg: string): { pkg: string; spec: string | null } => {
  const at = arg.indexOf('@', arg.startsWith('@') ? 1 : 0)

  return at > 0 ? { pkg: arg.slice(0, at), spec: arg.slice(at + 1) } : { pkg: arg, spec: null }
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const packageAbove = async (
  $: EngineInterface,
  file: string,
): Promise<{ name: string | null; version: string | null }> => {
  let dir = dirOf(file)
  for (let up = 0; up < 4 && dir !== ''; up += 1) {
    const found = await readJson($, `${dir}/package.json`)
    if (found !== null) {
      return {
        name: typeof found.name === 'string' ? found.name : null,
        version: typeof found.version === 'string' ? found.version : null,
      }
    }
    dir = dirOf(dir)
  }

  return { name: null, version: null }
}

const describe = async (
  $: EngineInterface,
  name: string,
  scope: string,
  entry: Json,
  root: string,
): Promise<Config> => {
  const base: Config = { name, kind: 'unknown', scope, pkg: null, spec: null, installed: null }
  const command = typeof entry.command === 'string' ? entry.command : ''
  const args = strings(entry.args).filter(arg => !arg.startsWith('-'))
  if (typeof entry.url === 'string' || entry.type === 'http' || entry.type === 'sse') {
    return { ...base, kind: 'remote' }
  }
  if (command.endsWith('npx') && args[0] !== undefined) {
    const { pkg, spec } = splitSpec(args[0])

    return { ...base, kind: pkg === 'mcp-remote' ? 'remote' : 'npx', pkg, spec }
  }
  if (command.endsWith('node')) {
    const script = args.find(arg => /\.(c|m)?js$/.test(arg))
    if (script !== undefined) {
      const path = script.startsWith('/') ? script : `${root}/${script}`
      const found = await packageAbove($, path)

      return { ...base, kind: 'node', pkg: found.name, installed: found.version }
    }
  }

  return { ...base, kind: command === '' ? 'unknown' : 'command' }
}

const readConfigs = async ($: EngineInterface): Promise<Config[]> => {
  const root = await $.session.root()
  const home = (await $.env.get('HOME')) ?? ''
  const project = obj((await readJson($, `${root}/.mcp.json`))?.mcpServers)
  const global = await readJson($, `${home}/.claude.json`)
  const user = obj(global?.mcpServers)
  const local = obj(obj(obj(global?.projects)[root]).mcpServers)

  const found: Config[] = []
  for (const [scope, list] of [
    ['local', local],
    ['.mcp.json', project],
    ['user', user],
  ] as const) {
    for (const [name, entry] of Object.entries(list)) {
      if (found.some(c => c.name === name)) continue
      found.push(await describe($, name, scope, obj(entry), root))
    }
  }

  // npx keeps each package it ran under ~/.npm/_npx/<hash>/node_modules.
  const wanted = [...new Set(found.filter(c => c.kind !== 'node' && c.pkg).map(c => c.pkg as string))]
  const installed: Record<string, string> = {}
  let caches: string[] = []
  try {
    caches = (await $.fs.list(`${home}/.npm/_npx`)).filter(e => e.kind === 'dir').map(e => e.name)
  } catch {
    caches = []
  }
  for (const cache of caches) {
    for (const pkg of wanted) {
      const meta = await readJson($, `${home}/.npm/_npx/${cache}/node_modules/${pkg}/package.json`)
      const version = meta?.version
      if (typeof version !== 'string') continue
      const known = installed[pkg]
      if (known === undefined || newer(version, known)) installed[pkg] = version
    }
  }

  return found.map(c =>
    c.kind !== 'node' && c.pkg !== null ? { ...c, installed: installed[c.pkg] ?? null } : c,
  )
}

// The configs change rarely and their scan reads the npx cache: done at
// start and on an explicit refresh, while the token figures follow each turn.
let configs: Config[] | null = null

const refresh = async ($: EngineInterface, rescan = false): Promise<void> => {
  if (configs === null || rescan) {
    try {
      configs = await readConfigs($)
    } catch {
      configs = []
    }
  }
  const usage = await $.session.usage({ breakdown: 'summary' })
  const breakdown = usage.context.breakdown
  const byServer = new Map<string, ConnectorTool[]>()
  for (const tool of breakdown?.mcpTools ?? []) {
    const list = byServer.get(tool.serverName) ?? []
    list.push({ name: tool.name, tokens: tool.tokens, isLoaded: tool.isLoaded })
    byServer.set(tool.serverName, list)
  }

  const list: ConnectorServer[] = configs.map(c => ({ ...c, tools: byServer.get(c.name) ?? [] }))
  for (const [name, tools] of byServer) {
    if (list.some(s => s.name === name)) continue
    const kind: ConnectorKind = /^claude[._ ]ai[ _]/.test(name)
      ? 'claude.ai'
      : name.startsWith('plugin:')
        ? 'plugin'
        : 'unknown'
    list.push({ name, kind, scope: kind, pkg: null, spec: null, installed: null, tools })
  }

  const mcpLoaded = list.reduce((sum, s) => sum + loadedOf(s), 0)
  await update($, servers, () => list)
  await update($, context, () => ({
    used: breakdown?.totalTokens ?? usage.context.tokens ?? null,
    window: usage.context.window,
    mcpLoaded,
  }))
  const connected = list.filter(s => s.tools.length > 0).length
  $.ui.status(`MCP ≈${fmt(mcpLoaded)} in context · ${connected} connectors`)
}

const loadedOf = (s: ConnectorServer): number =>
  s.tools.reduce((sum, t) => sum + (t.isLoaded ? t.tokens : 0), 0)
const deferredOf = (s: ConnectorServer): number =>
  s.tools.reduce((sum, t) => sum + (t.isLoaded ? 0 : t.tokens), 0)

const callsOf = (s: ConnectorServer, all: Record<string, ConnectorCalls>): ConnectorCalls => {
  const total: ConnectorCalls = { calls: 0, errors: 0, tokens: 0, max: 0 }
  const prefix = `mcp__${s.name.replace(/[^A-Za-z0-9_-]/g, '_')}__`
  for (const [tool, c] of Object.entries(all)) {
    if (!s.tools.some(t => t.name === tool) && !tool.startsWith(prefix)) continue
    total.calls += c.calls
    total.errors += c.errors
    total.tokens += c.tokens
    total.max = Math.max(total.max, c.max)
  }

  return total
}

const serverOfTool = (tool: string, list: ConnectorServer[]): string => {
  const owner = list.find(s => s.tools.some(t => t.name === tool))
  if (owner !== undefined) return owner.name
  const match = /^mcp__(.+?)__/.exec(tool)

  return match?.[1] ?? tool
}

const checkUpdates = async ($: EngineInterface): Promise<void> => {
  await update($, checking, () => true)
  const list = await read($, servers)
  const pkgs = [...new Set(list.filter(s => s.kind !== 'node' && s.pkg).map(s => s.pkg as string))]
  for (const pkg of pkgs) {
    try {
      const run = await $.process.run(['npm', 'view', pkg, 'version'], { timeoutMs: 20_000 })
      const version = run.stdout.trim().split('\n').pop()?.trim()
      if (run.exitCode === 0 && version) await update($, latest, all => ({ ...all, [pkg]: version }))
    } catch {
      // npm missing or offline: leave that package unchecked.
    }
  }
  await update($, checking, () => false)
}

type Hint = { text: string; color?: string }

const hintsFor = (
  list: ConnectorServer[],
  all: Record<string, ConnectorCalls>,
  past: Record<string, ConnectorHistory>,
  newest: Record<string, string>,
  now: number,
): Hint[] => {
  const hints: Hint[] = []

  const copies = new Map<string, ConnectorServer[]>()
  for (const s of list) {
    if (s.kind !== 'npx' || s.pkg === null) continue
    copies.set(s.pkg, [...(copies.get(s.pkg) ?? []), s])
  }
  for (const [pkg, same] of copies) {
    if (same.length < 2) continue
    const schemas = same.reduce((sum, s) => sum + loadedOf(s) + deferredOf(s), 0)
    const used = same.filter(s => callsOf(s, all).calls > 0 || (past[s.name]?.calls ?? 0) > 0)
    hints.push({
      text: `${same.length}× ${pkg}: ≈${fmt(schemas)} tokens of identical schemas, ${used.length} of them called. Keep only the ones this project needs, or run one server that takes the property as an argument.`,
      color: 'yellow',
    })
  }

  for (const s of list) {
    const here = callsOf(s, all)
    const before = past[s.name]
    const loaded = loadedOf(s)
    const idle = here.calls === 0 && (before === undefined || now - before.lastAt > 14 * DAY)
    if (loaded >= IDLE_TOKENS && idle) {
      hints.push({
        text: `${s.name}: ≈${fmt(loaded)} in context every turn, not called ${before ? 'for over 14 days' : 'even once'}. Disable it in /mcp or move it to the project that needs it.`,
        color: 'red',
      })
    }
    if (here.calls >= 2 && here.tokens / here.calls >= HEAVY_REPLY) {
      hints.push({
        text: `${s.name}: average reply ≈${fmt(Math.round(here.tokens / here.calls))}, largest ≈${fmt(here.max)}. Ask for limit/fields or filter in a script.`,
        color: 'yellow',
      })
    }
    if (s.kind === 'npx' && (s.spec === null || s.spec === 'latest')) {
      hints.push({
        text: `${s.name}: npx ${s.pkg}${s.spec ? '@latest' : ''} is not pinned, the version can change between starts.`,
      })
    }
    const fresh = s.pkg ? newest[s.pkg] : undefined
    if (fresh !== undefined && s.installed !== null && newer(fresh, s.installed)) {
      hints.push({ text: `${s.name}: update available ${s.installed} → ${fresh}.`, color: 'cyan' })
    }
    if (s.tools.length === 0 && (s.scope === '.mcp.json' || s.scope === 'user' || s.scope === 'local')) {
      hints.push({ text: `${s.name}: configured but has no tools (failed to connect or disabled).` })
    }
  }

  return hints
}

const versionOf = (s: ConnectorServer, newest: Record<string, string>): string => {
  if (s.kind === 'claude.ai') return 'claude.ai'
  if (s.kind === 'remote' && s.pkg === null) return 'remote'
  const fresh = s.pkg ? newest[s.pkg] : undefined
  const have = s.installed ?? (s.spec && s.spec !== 'latest' ? s.spec : null)
  if (have === null) return fresh ? `? → ${fresh}` : '—'

  return fresh !== undefined && newer(fresh, have) ? `${have} → ${fresh}` : have
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'connectors',
      description: "Connector control center: tokens per MCP connector, versions, what to disable",
    })
    try {
      const saved = obj(await $.store.get(STORE_KEY)) as Record<string, ConnectorHistory>
      await update($, history, () => saved)
      await refresh($)
    } catch {
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      try {
        await refresh($)
      } catch {
        // The figures stay as they were until the next turn.
      }
    }

    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (!tool.startsWith('mcp__') || 'deny' in ran) return ran
    try {
      const tokens = estimate(ran.text ?? '')
      const isError = ran.isError === true
      await update($, calls, all => {
        const was = all[tool] ?? { calls: 0, errors: 0, tokens: 0, max: 0 }

        return {
          ...all,
          [tool]: {
            calls: was.calls + 1,
            errors: was.errors + (isError ? 1 : 0),
            tokens: was.tokens + tokens,
            max: Math.max(was.max, tokens),
          },
        }
      })
      const server = serverOfTool(tool, await read($, servers))
      const now = await $.clock.now()
      const past = await update($, history, all => {
        const was = all[server] ?? { calls: 0, tokens: 0, lastAt: 0 }

        return { ...all, [server]: { calls: was.calls + 1, tokens: was.tokens + tokens, lastAt: now } }
      })
      await $.store.set(STORE_KEY, past)
    } catch {
      // Bookkeeping never costs the call its result.
    }

    return ran
  })

  on('command.run', { command: 'connectors' }, async ($, e) => {
    await refresh($, true)
    const list = await read($, servers)
    const all = await read($, calls)
    const ctx = await read($, context)
    const want = e.args.trim().toLowerCase()
    const match = want === '' ? undefined : list.find(s => s.name.toLowerCase().includes(want))
    await update($, selected, () => match?.name ?? null)
    await $.ui.open({ id: PANE, title: TITLE, columns: 110, rows: 34, focus: true })

    const ranked = [...list]
      .sort((a, b) => loadedOf(b) - loadedOf(a) || deferredOf(b) - deferredOf(a))
      .slice(0, 8)

    return {
      text: [
        `Connectors: MCP schemas ≈${fmt(ctx?.mcpLoaded ?? 0)} in context, ${list.length} connectors.`,
        ...ranked.map(s => {
          const c = callsOf(s, all)

          return `${s.name}: ${s.tools.length} tools, ≈${fmt(loadedOf(s))} in context, ≈${fmt(deferredOf(s))} deferred, ${c.calls} calls ≈${fmt(c.tokens)}, version ${s.installed ?? '—'}`
        }),
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, servers)
    const all = await read($, calls)
    const past = await read($, history)
    const newest = await read($, latest)
    const busy = await read($, checking)
    const pick = await read($, selected)
    const ctx = await read($, context)
    const columns = e.props.bodyColumns
    const rows = e.viewport?.rows ?? 24
    const now = await $.clock.now()

    const controls = (
      <Box flexDirection="row" gap={2}>
        {pick !== null && (
          <Button key="all" hotkey="0" plain onPress={() => void update($, selected, () => null)}>
            All
          </Button>
        )}
        <Button key="refresh" hotkey="r" plain onPress={() => void refresh($, true)}>
          Refresh
        </Button>
        <Button key="updates" hotkey="u" plain onPress={() => void checkUpdates($)}>
          {busy ? 'Checking npm…' : 'Check for updates'}
        </Button>
      </Box>
    )

    const header = ctx && (
      <Text dimColor wrap="truncate-end">
        Context {ctx.used === null ? '—' : `≈${fmt(ctx.used)}`} / {fmt(ctx.window)} · MCP schemas ≈
        {fmt(ctx.mcpLoaded)} in context · ≈ estimate, replies are this session
      </Text>
    )

    const server = list.find(s => s.name === pick)
    if (server !== undefined) {
      const total = callsOf(server, all)
      const before = past[server.name]
      const tools = [...server.tools].sort((a, b) => b.tokens - a.tokens)
      const room = Math.max(1, rows - 12)

      return (
        <Box flexDirection="column">
          {controls}
          <Text bold>{server.name}</Text>
          <Text dimColor wrap="truncate-end">
            {server.kind} · {server.scope}
            {server.pkg ? ` · ${server.pkg}${server.spec ? `@${server.spec}` : ''}` : ''} · version{' '}
            {versionOf(server, newest)}
          </Text>
          <Text>
            {tools.length} tools · ≈{fmt(loadedOf(server))} in context · ≈{fmt(deferredOf(server))}{' '}
            deferred
          </Text>
          <Text>
            Session: {total.calls} calls · ≈{fmt(total.tokens)} in replies · max ≈{fmt(total.max)}
            {total.errors > 0 ? ` · errors ${total.errors}` : ''}
          </Text>
          <Text dimColor>
            All time: {before ? `${before.calls} calls, ≈${fmt(before.tokens)}, last ${Math.round((now - before.lastAt) / DAY)} d ago` : 'no calls yet'}
          </Text>
          <Text> </Text>
          {tools.slice(0, room).map(tool => {
            const c = all[tool.name]

            return (
              <Box flexDirection="row">
                <Box width={8}>
                  <Text color={tool.isLoaded ? 'yellow' : undefined} dimColor={!tool.isLoaded}>
                    {tool.isLoaded ? '●' : '○'} {fmt(tool.tokens)}
                  </Text>
                </Box>
                <Text wrap="truncate-end">
                  {tool.name.replace(/^mcp__.+?__/, '')}
                  {c ? `  ${c.calls}× ≈${fmt(c.tokens)}` : ''}
                </Text>
              </Box>
            )
          })}
          {tools.length > room && <Text dimColor>… {tools.length - room} more</Text>}
          <Text dimColor>● in context every turn · ○ deferred, loaded via ToolSearch</Text>
        </Box>
      )
    }

    const ranked = [...list].sort(
      (a, b) =>
        loadedOf(b) + callsOf(b, all).tokens - (loadedOf(a) + callsOf(a, all).tokens) ||
        deferredOf(b) - deferredOf(a),
    )
    const hints = hintsFor(list, all, past, newest, now)
    const hintRoom = Math.max(2, Math.floor((rows - 8) / 3))
    const tableRoom = Math.max(3, rows - 8 - Math.min(hints.length, hintRoom))

    const nameButton = (s: ConnectorServer, index: number) => (
      <Button
        key={`server:${s.name}`}
        label={s.name}
        hotkey={index < 9 ? String(index + 1) : undefined}
        plain
        dimColor={s.tools.length === 0}
        onPress={() => void update($, selected, () => s.name)}
      />
    )

    return (
      <Box flexDirection="column">
        {controls}
        {header}
        <Text> </Text>
        {columns >= WIDE && (
          <Box flexDirection="row">
            <Box width={26}>
              <Text dimColor>Connector</Text>
            </Box>
            <Box width={7}>
              <Text dimColor>tools</Text>
            </Box>
            <Box width={11}>
              <Text dimColor>context</Text>
            </Box>
            <Box width={10}>
              <Text dimColor>deferred</Text>
            </Box>
            <Box width={14}>
              <Text dimColor>calls</Text>
            </Box>
            <Text dimColor>version</Text>
          </Box>
        )}
        {ranked.slice(0, tableRoom).map((s, index) => {
          const c = callsOf(s, all)
          const loaded = loadedOf(s)

          return columns >= WIDE ? (
            <Box flexDirection="row">
              <Box width={26}>{nameButton(s, index)}</Box>
              <Box width={7}>
                <Text>{s.tools.length}</Text>
              </Box>
              <Box width={11}>
                <Text color={loaded >= IDLE_TOKENS ? 'yellow' : undefined} dimColor={loaded === 0}>
                  ≈{fmt(loaded)}
                </Text>
              </Box>
              <Box width={10}>
                <Text dimColor>≈{fmt(deferredOf(s))}</Text>
              </Box>
              <Box width={14}>
                <Text dimColor={c.calls === 0}>
                  {c.calls}× ≈{fmt(c.tokens)}
                </Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {versionOf(s, newest)}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {nameButton(s, index)}
              <Text dimColor wrap="truncate-end">
                {'   '}≈{fmt(loaded)} ctx · ≈{fmt(deferredOf(s))} def · {c.calls}× ≈{fmt(c.tokens)} ·{' '}
                {versionOf(s, newest)}
              </Text>
            </Box>
          )
        })}
        {ranked.length > tableRoom && <Text dimColor>… {ranked.length - tableRoom} more</Text>}
        {hints.length > 0 && <Text> </Text>}
        {hints.length > 0 && <Text bold>What to optimize</Text>}
        {hints.slice(0, hintRoom).map(hint =>
          hint.color === undefined ? (
            <Text dimColor>• {hint.text}</Text>
          ) : (
            <Text color={hint.color}>• {hint.text}</Text>
          ),
        )}
        {hints.length > hintRoom && <Text dimColor>… {hints.length - hintRoom} more tips</Text>}
      </Box>
    )
  })
}
