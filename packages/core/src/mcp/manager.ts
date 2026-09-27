import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ToolListChangedNotificationSchema, type Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from '../settings/schema.js'
import { truncate, type Tool, type ToolResult } from '../tools/types.js'

export type McpState = 'connecting' | 'ready' | 'error' | 'off'

export interface McpServerStatus {
  id: string
  name: string
  state: McpState
  error?: string
  toolCount: number
}

export interface McpManagerOptions {
  /** Bearer token for an HTTP server, looked up by server id. */
  secret?: (serverId: string) => string | undefined
  /** Called whenever a server's state or tool list changes. */
  onChange?: () => void
  /** Overrides how a transport is created (tests use in-memory transports). */
  transportFor?: (config: McpServerConfig) => Promise<Transport>
  clientVersion?: string
}

interface Entry {
  config: McpServerConfig
  key: string
  state: McpState
  error?: string
  client?: Client
  tools: Tool[]
  stderr: string
}

const CONNECT_TIMEOUT_MS = 30_000

/** `mcp__<server>__<tool>`, limited to the characters and length every provider accepts. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  const s = clean(server).slice(0, 24) || 'server'
  return `mcp__${s}__${clean(tool)}`.slice(0, 64)
}

/**
 * Connects to the MCP servers in settings and exposes their tools as ordinary tools,
 * so permissions, plan mode and the UI treat them like any other tool.
 */
export class McpManager {
  private entries = new Map<string, Entry>()

  constructor(private readonly o: McpManagerOptions = {}) {}

  /** Connects, reconnects and disconnects so the running servers match `servers`. Never throws. */
  async sync(servers: McpServerConfig[]): Promise<void> {
    const wanted = new Map(servers.map((s) => [s.id, s]))
    for (const [id, e] of this.entries) {
      const next = wanted.get(id)
      if (!next || this.keyOf(next) !== e.key) {
        this.entries.delete(id)
        await this.disconnect(e)
      }
    }
    const starts: Promise<void>[] = []
    for (const config of servers) {
      if (this.entries.has(config.id)) continue
      const entry: Entry = { config, key: this.keyOf(config), state: config.enabled ? 'connecting' : 'off', tools: [], stderr: '' }
      this.entries.set(config.id, entry)
      if (config.enabled) starts.push(this.connect(entry))
    }
    this.changed()
    await Promise.all(starts)
  }

  async restart(id: string): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return
    await this.disconnect(e)
    const fresh: Entry = { ...e, state: e.config.enabled ? 'connecting' : 'off', error: undefined, client: undefined, tools: [], stderr: '' }
    this.entries.set(id, fresh)
    this.changed()
    if (fresh.config.enabled) await this.connect(fresh)
  }

  status(): McpServerStatus[] {
    return [...this.entries.values()].map((e) => ({
      id: e.config.id,
      name: e.config.name,
      state: e.state,
      ...(e.error ? { error: e.error } : {}),
      toolCount: e.tools.length,
    }))
  }

  tools(): Tool[] {
    return [...this.entries.values()].flatMap((e) => (e.state === 'ready' ? e.tools : []))
  }

  async close(): Promise<void> {
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(all.map((e) => this.disconnect(e)))
  }

  private keyOf(config: McpServerConfig): string {
    // A changed token must reconnect too, but the token itself isn't kept.
    return JSON.stringify(config) + (config.transport === 'http' && this.o.secret?.(config.id) ? '+token' : '')
  }

  private current(entry: Entry): boolean {
    return this.entries.get(entry.config.id) === entry
  }

  private changed() {
    this.o.onChange?.()
  }

  private async transport(entry: Entry): Promise<Transport> {
    const c = entry.config
    if (this.o.transportFor) return this.o.transportFor(c)
    if (c.transport === 'stdio') {
      const t = new StdioClientTransport({
        command: c.command,
        args: c.args,
        env: { ...getDefaultEnvironment(), ...c.env },
        stderr: 'pipe',
      })
      // Keep the tail of stderr: it usually explains why a server failed to start.
      t.stderr?.on('data', (b: Buffer) => (entry.stderr = (entry.stderr + b.toString('utf8')).slice(-2000)))
      return t
    }
    const token = this.o.secret?.(c.id)
    const headers = { ...c.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    return new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers } })
  }

  private async connect(entry: Entry): Promise<void> {
    let client: Client | undefined
    try {
      const transport = await this.transport(entry)
      client = new Client({ name: 'xari-bulbul', version: this.o.clientVersion ?? '0.0.0' })
      client.onclose = () => {
        if (!this.current(entry) || entry.state !== 'ready') return
        entry.state = 'error'
        entry.error = `The server stopped.${entry.stderr ? ` ${lastLine(entry.stderr)}` : ''}`
        entry.tools = []
        this.changed()
      }
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      entry.client = client
      entry.tools = await this.listTools(entry, client)
      if (!this.current(entry)) return void (await client.close().catch(() => {}))
      entry.state = 'ready'
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (!this.current(entry) || !entry.client) return
        entry.tools = await this.listTools(entry, entry.client).catch(() => entry.tools)
        this.changed()
      })
    } catch (e) {
      await client?.close().catch(() => {})
      if (!this.current(entry)) return
      entry.client = undefined
      entry.state = 'error'
      const detail = entry.stderr ? ` ${lastLine(entry.stderr)}` : ''
      entry.error = `${(e as Error).message}${detail}`.slice(0, 500)
    }
    this.changed()
  }

  private async disconnect(entry: Entry) {
    // Set first so the client's onclose doesn't report an intentional close as a crash.
    entry.state = 'off'
    const client = entry.client
    entry.client = undefined
    entry.tools = []
    await client?.close().catch(() => {})
  }

  private async listTools(entry: Entry, client: Client): Promise<Tool[]> {
    const out: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      for (const t of page.tools) out.push(this.adapt(entry, client, t))
      cursor = page.nextCursor
    } while (cursor)
    return out
  }

  private adapt(entry: Entry, client: Client, t: McpTool): Tool {
    const server = entry.config.name
    return {
      name: mcpToolName(server, t.name),
      description: `[MCP: ${server}] ${t.description ?? t.annotations?.title ?? t.name}`.slice(0, 1024),
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      kind: 'other',
      // The user added this server, so its read-only hints are trusted like a built-in tool's.
      readOnly: t.annotations?.readOnlyHint === true,
      parse: (input) => (input && typeof input === 'object' ? input : {}),
      subject: (input) => {
        const s = JSON.stringify(input ?? {})
        return s.length > 200 ? `${s.slice(0, 199)}…` : s
      },
      source: 'mcp',
      async execute(input, ctx): Promise<ToolResult> {
        const result = await client.callTool({ name: t.name, arguments: input as Record<string, unknown> }, undefined, {
          signal: ctx.signal,
          timeout: ctx.bashTimeoutSec * 1000,
          resetTimeoutOnProgress: true,
        })
        const content = Array.isArray(result.content) ? result.content : []
        const text = content.map(renderContent).filter(Boolean).join('\n')
        const fallback = result.structuredContent ? JSON.stringify(result.structuredContent, null, 2) : '(no output)'
        return { content: truncate(text || fallback, ctx.toolOutputMaxChars), ...(result.isError ? { isError: true } : {}) }
      },
    }
  }
}

function renderContent(c: any): string {
  switch (c?.type) {
    case 'text':
      return c.text
    case 'image':
    case 'audio':
      return `[${c.type} ${c.mimeType}]`
    case 'resource':
      return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`
    case 'resource_link':
      return `[${c.name ?? 'link'}: ${c.uri}]`
    default:
      return ''
  }
}

/** The end of a server's stderr, which usually says why it failed (one message may span lines). */
function lastLine(s: string): string {
  const lines = s.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.slice(-3).join(' ').slice(-300)
}
