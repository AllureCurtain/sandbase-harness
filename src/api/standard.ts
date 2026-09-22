import type { AgentDefinition, AgentToolset, McpServerConfig } from '@/types/agent.js';
import type { Session, SessionEvent, SessionLoopEngine } from '@/types/session.js';
import type { SessionBudget } from '@/types/cma-protocol.js';

export interface ApiPage<T extends { id: string }> {
  data: T[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export interface ApiCursorPage<T> {
  data: T[];
  prev_page: string | null;
  next_page: string | null;
}

/**
 * Encode a cursor for a canonical collection.
 *
 * The payload is the sort state the page was produced from, so a cursor cannot
 * be replayed against a different ordering. It is base64url-encoded rather than
 * encrypted because it carries no secret; the opacity is there to keep callers
 * from constructing one, not to hide anything.
 */
export function encodeCursor(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export interface DecodedCursor {
  ok: boolean;
  state?: Record<string, unknown>;
}

/** Decode a cursor, rejecting anything that is not a well-formed object. */
export function decodeCursor(cursor: string): DecodedCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, state: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/**
 * Normalize a collection's filter into a stable, comparable token.
 *
 * Keys are sorted and empty values dropped, so two requests that filter
 * identically produce the same token — otherwise a cursor would be rejected for
 * a difference the caller cannot observe (an omitted `status` versus an empty
 * one). The result is what gets stored in the cursor, which is why it must be
 * canonical rather than merely equal.
 */
export function normalizeCollectionFilter(
  filter: Record<string, string | undefined | null>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(filter).sort()) {
    const value = filter[key];
    if (value !== undefined && value !== null && value !== '') normalized[key] = value;
  }
  return normalized;
}

/**
 * Why a decoded cursor cannot be replayed against this query, or `undefined`
 * when it can.
 *
 * The published contract says a cursor encodes the sort request that produced
 * it and must not be reused across a different `order` or an incompatible
 * filter. Enforcing only the ordering half was a silent-corruption path: the
 * same cursor replayed under a different filter is accepted by a page-number
 * scheme, and the caller reads a page that never existed for that filter.
 */
export function cursorQueryMismatch(
  state: Record<string, unknown> | undefined,
  expected: { order?: string; filter?: Record<string, string> },
): string | undefined {
  if (expected.order !== undefined) {
    const order = state?.order;
    if (typeof order === 'string' && order !== expected.order) {
      return 'next_page was issued for a different ordering.';
    }
  }
  if (expected.filter !== undefined) {
    const filter = state?.filter;
    if (filter !== undefined) {
      if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
        return 'next_page was issued for a different filter.';
      }
      const actual = normalizeCollectionFilter(filter as Record<string, string>);
      if (JSON.stringify(actual) !== JSON.stringify(expected.filter)) {
        return 'next_page was issued for a different filter.';
      }
    }
  }
  return undefined;
}

/**
 * Build a canonical cursor page from a slice and its continuation state.
 *
 * `prev` is supplied by the caller because a forward-only scan cannot infer it;
 * passing `null` is honest for the first page rather than inventing a cursor
 * that would not resolve.
 */
export function cursorPageOf<T>(
  data: T[],
  cursors: { prev?: string | null; next?: string | null },
): ApiCursorPage<T> {
  return {
    data,
    prev_page: cursors.prev ?? null,
    next_page: cursors.next ?? null,
  };
}

export interface CollectionPager<T> {
  list(items: T[]): ApiCursorPage<T> | ApiPage<T & { id: string }>;
  /** Render directly on a Hono context, preserving the optional status code. */
  json(c: { json: (body: unknown, status?: number) => Response }, items: T[], status?: number): Response;
}

/**
 * Build a pager for one collection under one envelope.
 *
 * Cursors are `null` in both shapes here: these operations collections are
 * returned as a complete result set, and inventing a `next_page` that a caller
 * could follow into an empty page would be worse than admitting the end. The
 * parameter is kept so the canonical shape is produced by the same function
 * that will carry real cursors once a collection is actually windowed.
 */
export function collectionPager<T extends { id: string }>(
  shape: 'canonical' | 'legacy',
): CollectionPager<T> {
  return {
    list(items) {
      return shape === 'canonical' ? cursorPageOf(items, {}) : pageOf(items);
    },
    json(c, items, status) {
      const body = shape === 'canonical' ? cursorPageOf(items, {}) : pageOf(items);
      return status === undefined ? c.json(body) : c.json(body, status);
    },
  };
}

export interface ApiAgent {
  id: string;
  type: 'agent';
  name: string;
  description: string;
  system: string;
  model: string;
  model_config?: {
    speed: 'fast' | 'standard' | 'extended';
  };
  tools: AgentToolset[];
  mcp_servers: ApiMcpServer[];
  skills: Array<{
    type: 'custom' | 'anthropic';
    skill_id: string;
    version?: string;
  }>;
  metadata: Record<string, string>;
  status: 'active' | 'archived';
  version: number;
  created_at: string | null;
  updated_at: string | null;
  archived_at: string | null;
}

export type ApiMcpServer =
  | { type: 'url'; name: string; url: string }
  | { type: 'stdio'; name: string; command: string; args: string[]; env: Record<string, string> };

export interface ApiSession {
  id: string;
  type: 'session';
  title: string | null;
  agent: ApiAgent | { id: string; type: 'agent'; name: string };
  environment_id: string;
  /** Engine frozen when the session was created, not the current Settings default. */
  loop_engine: SessionLoopEngine;
  status: 'idle' | 'running' | 'requires_action' | 'terminated' | 'failed' | 'cancelled' | 'timed_out' | 'cleanup_pending';
  resources: ApiSessionResource[];
  vault_ids: string[];
  /**
   * Spending ceiling. Omitted entirely when the session never had one, and
   * `null` when it had one removed — the contract treats those as different
   * states, so a single "no budget" value would lose the distinction. A session
   * may acquire a budget only at creation, which is why a session that never had
   * one can never report `null` here.
   */
  budget?: SessionBudget | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stats: Record<string, number>;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export type ApiSessionResource =
  | { type: 'file'; file_id: string; mount_path: string }
  | { type: 'github_repository'; url?: string; repository_id?: string; checkout?: unknown; mount_path?: string }
  | { type: 'memory_store'; memory_store_id: string; access?: 'read_write' | 'read_only'; instructions?: string; mount_path?: string };

export interface ApiEvent {
  id: string;
  seq: number;
  type: string;
  content: unknown[] | null;
  metadata?: Record<string, unknown>;
  tool_use_id?: string;
  /**
   * Structured payload of a `session.error`, projected from the metadata
   * carrier. Always carries all three keys; a client must treat an
   * unrecognized `retry_status` value as `unknown`.
   */
  error?: {
    type: string;
    message: string;
    retry_status: string;
  };
  /**
   * Server that produced an `agent.mcp_tool_use` / `agent.mcp_tool_result`.
   * Without it, two MCP servers exposing the same tool name are
   * indistinguishable in the event log.
   */
  mcp_server_name?: string;
  /** Tool-use this MCP result answers. */
  mcp_tool_use_id?: string;
  /**
   * Usage snapshot carried by `session.usage`. Emitted immediately before
   * `session.status_idle`. `list_cost` is present only when a cost profile
   * priced every model the session used — a partial total is withheld rather
   * than reported as one. `budget` echoes the session's budget, or `null` when
   * it has none, and `server_tool_use` counts the built-in web tools, of which
   * this runtime has none.
   */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    active_seconds: number;
    list_cost?: number;
    budget?: SessionBudget | null;
    server_tool_use?: {
      web_search_requests: number;
      web_fetch_requests: number;
    };
  };
  model_used?: string;
  tokens_in?: number;
  tokens_out?: number;
  stop_reason?: string;
  duration_ms?: number;
  delta?: string;
  message_id?: string;
  created_at: string | null;
  processed_at: string | null;
  parent_event_id: string | null;
}

export function pageOf<T extends { id: string }>(data: T[], hasMore = false): ApiPage<T> {
  return {
    data,
    has_more: hasMore,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

export function agentId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `agent_${slug || 'untitled'}`;
}

/**
 * Project an agent's tools to the canonical wire shape.
 *
 * A legacy `custom_toolset` grouping is flattened to independent canonical
 * `custom` entries, dropping a tool the grouping disabled or denied rather than
 * echoing the grouping back as written. Every other toolset passes through.
 */
function toApiToolsets(toolsets: AgentToolset[]): AgentToolset[] {
  return toolsets.flatMap((toolset): AgentToolset[] => {
    if (toolset.type === 'custom') return [toolset];
    if (toolset.type !== 'custom_toolset') return [toolset];
    const defaultEnabled = toolset.default_config?.enabled !== false;
    return (toolset.configs ?? [])
      .filter((config) => (config.enabled ?? defaultEnabled) !== false)
      .filter((config) => config.permission_policy?.type !== 'never_allow')
      .map((config) => ({
        type: 'custom' as const,
        name: config.name,
        description: config.description,
        input_schema: config.parameters ?? config.input_schema!,
      }));
  });
}

export function toApiAgent(
  agent: AgentDefinition,
  dates?: {
    id?: string;
    createdAt?: string | null;
    updatedAt?: string | null;
    archivedAt?: string | null;
    status?: 'active' | 'archived';
    version?: number;
  },
): ApiAgent {
  return {
    id: dates?.id ?? agentId(agent.name),
    type: 'agent',
    name: agent.name,
    description: agent.description ?? '',
    system: agent.system,
    model: agent.model,
    ...(agent.model_config && agent.model_config.speed !== 'standard' ? { model_config: agent.model_config } : {}),
    tools: toApiToolsets(agent.tools ?? []),
    mcp_servers: toApiMcpServers(agent.mcp_servers ?? []),
    skills: agent.skills ?? [],
    metadata: parseStringRecord(agent.metadata),
    status: dates?.status ?? (dates?.archivedAt ? 'archived' : 'active'),
    version: dates?.version ?? 1,
    created_at: dates?.createdAt ?? null,
    updated_at: dates?.updatedAt ?? null,
    archived_at: dates?.archivedAt ?? null,
  };
}

export function toApiSession(session: Session, agent?: AgentDefinition): ApiSession {
  return {
    id: session.id,
    type: 'session',
    title: session.title ?? null,
    agent: agent
      ? toApiAgent(agent, { id: session.agentId, version: session.agentVersion })
      : { id: session.agentId, type: 'agent', name: session.agentName },
    environment_id: session.environmentId,
    // Legacy rows predate explicit engine selection and were executed by builtin.
    loop_engine: session.loopEngine ?? 'builtin',
    status: toApiSessionStatus(session.status),
    resources: parseJsonArray<Record<string, unknown>>(session.resources).map(toApiSessionResource),
    vault_ids: parseJsonArray(session.vaultIds),
    // Spread rather than assigned, so a session that never had a budget omits
    // the field instead of reporting `null` — which would claim a removal.
    ...(session.budget !== undefined ? { budget: session.budget } : {}),
    usage: {
      input_tokens: session.usage?.tokensIn ?? 0,
      output_tokens: session.usage?.tokensOut ?? 0,
    },
    stats: {},
    metadata: parseStringRecord(session.metadata),
    created_at: toIsoString(session.createdAt),
    updated_at: toIsoString(session.updatedAt),
    archived_at: null,
  };
}

export function toApiEvent(event: SessionEvent): ApiEvent {
  const streamEvent = event as SessionEvent & { delta?: string; message_id?: string };
  // `session.usage` is persisted through the generic metadata carrier (the
  // events table has no per-type payload column) and projected to its
  // documented top-level field here.
  const usage = event.type === 'session.usage'
    ? metadataObject(event, 'usage') as ApiEvent['usage']
    : undefined;
  // `session.error` is persisted through the generic metadata carrier (the
  // events table has no per-type payload column) and projected to its
  // documented top-level field here, on the same route as `session.usage`.
  const error = event.type === 'session.error'
    ? metadataObject(event, 'error') as ApiEvent['error']
    : undefined;
  const mcpServerName = metadataString(event, 'mcp_server_name');
  const mcpToolUseId = event.type === 'agent.mcp_tool_result' ? contentToolUseId(event) : undefined;
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    content: event.content ?? null,
    ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
    ...(event.type === 'user.tool_confirmation' && typeof event.metadata?.tool_use_id === 'string'
      ? { tool_use_id: event.metadata.tool_use_id }
      : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    ...(mcpServerName ? { mcp_server_name: mcpServerName } : {}),
    ...(mcpToolUseId ? { mcp_tool_use_id: mcpToolUseId } : {}),
    ...(event.modelUsed !== undefined ? { model_used: event.modelUsed } : {}),
    ...(event.tokensIn !== undefined ? { tokens_in: event.tokensIn } : {}),
    ...(event.tokensOut !== undefined ? { tokens_out: event.tokensOut } : {}),
    ...(event.stopReason !== undefined ? { stop_reason: event.stopReason } : {}),
    ...(event.durationMs !== undefined ? { duration_ms: event.durationMs } : {}),
    ...(streamEvent.delta !== undefined ? { delta: streamEvent.delta } : {}),
    ...(streamEvent.message_id !== undefined ? { message_id: streamEvent.message_id } : {}),
    created_at: event.createdAt ? toIsoString(event.createdAt) : null,
    processed_at: event.processedAt ? toIsoString(event.processedAt) : null,
    parent_event_id: event.parentEventId ?? null,
  };
}

export function toApiSessionStatus(status: string): ApiSession['status'] {
  switch (status) {
    case 'running':
      return 'running';
    case 'requires_action':
      return 'requires_action';
    case 'completed':
      return 'terminated';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    case 'cleanup_pending':
      return 'cleanup_pending';
    default:
      return 'idle';
  }
}

function toApiSessionResource(resource: Record<string, unknown>): ApiSessionResource {
  if (resource.type === 'github_repository') {
    const safeResource = { ...resource };
    delete safeResource.authorization_token;
    return safeResource as ApiSessionResource;
  }
  return resource as ApiSessionResource;
}

function toApiMcpServers(servers: McpServerConfig[]): ApiMcpServer[] {
  return servers.map((server) => {
    if (server.type === 'url') {
      return { type: 'url', name: server.name, url: server.url ?? '' };
    }
    return {
      type: 'stdio',
      name: server.name,
      command: server.command ?? '',
      args: server.args ?? [],
      env: redactEnv(server.env ?? {}),
    };
  });
}

function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(env).map((key) => [key, '${' + key + '}']));
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, recordValue]) => [key, String(recordValue)]),
    );
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parseStringRecord(parsed);
  } catch {
    return {};
  }
}

function parseJsonArray<T = any>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Object-valued metadata entry, or `undefined` when the shape is not an object. */
function metadataObject(event: SessionEvent, key: string): Record<string, unknown> | undefined {
  const value = event.metadata?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function metadataString(event: SessionEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `tool_use_id` carried inside a `tool_result` content block. */
function contentToolUseId(event: SessionEvent): string | undefined {
  const block = event.content?.find((item) => item.type === 'tool_result') as
    | { type: 'tool_result'; tool_use_id?: unknown }
    | undefined;
  return typeof block?.tool_use_id === 'string' && block.tool_use_id.length > 0
    ? block.tool_use_id
    : undefined;
}
