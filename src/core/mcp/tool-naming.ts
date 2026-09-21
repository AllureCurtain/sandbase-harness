/**
 * Runtime naming for MCP tools, as a dependency-free leaf module.
 *
 * Three separate places need to agree on how an MCP tool is named:
 *
 * - `McpManager` builds the name when it merges a server's tools
 * - `DefaultStrategy` recovers the server behind a name to attribute events
 * - `standard.ts` resolves the permission policy that governs the name
 *
 * Keeping the rule here — with no MCP SDK import — lets the permission layer
 * reuse it without pulling the client stack into every module that asks a
 * policy question. The names are the join key between those layers, so a
 * second copy of the rule is how an `always_ask` silently stops applying.
 */

/** Prefix every MCP-provided tool carries in the runtime tool map. */
export const MCP_TOOL_PREFIX = 'mcp_';

/** Runtime tool name for one of a server's tools: `mcp_<server>_<tool>`. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}_${toolName}`;
}

/** The model-visible prefix owned by one server: `mcp_<server>_`. */
export function mcpServerToolPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}_`;
}

/**
 * Recover the MCP server identity behind a runtime tool name.
 *
 * The runtime name is `mcp_<server>_<tool>`, which is ambiguous on its own
 * because both segments may contain underscores. Resolving it against the
 * declared server names and preferring the longest match makes the answer
 * deterministic for the agents we actually run, and returns `undefined` rather
 * than guessing when nothing matches. Events use this so a tool call can be
 * attributed to a server even when two servers expose the same tool name.
 */
export function resolveMcpServerName(toolName: string, serverNames: readonly string[]): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  let best: string | undefined;
  for (const name of serverNames) {
    if (!name) continue;
    if (!toolName.startsWith(mcpServerToolPrefix(name))) continue;
    if (best === undefined || name.length > best.length) best = name;
  }
  return best;
}
