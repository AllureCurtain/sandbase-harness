/**
 * Anthropic prompt-caching breakpoints (WP4 D1).
 *
 * The platform caches prompts automatically, so a request carries fixed
 * `cache_control: {type: 'ephemeral'}` markers rather than a user-facing
 * switch. Three breakpoints stay inside the provider's four-breakpoint cap,
 * leaving one slot for whatever the provider adds itself:
 *
 * - the system prompt — identical across every turn;
 * - the last tool definition — the tool list is one prefix block;
 * - the second-to-last message — the end of the previous turn. The last
 *   message is the input that just changed, so anchoring one earlier marks
 *   exactly the prefix the next turn resends.
 *
 * Markers travel as `providerOptions.anthropic.cacheControl` on the system
 * message, the tool definition, and the message envelope; the provider turns
 * each into a `cache_control` on the matching request block (a message-level
 * marker lands on that message's last content part). `ttl` is omitted so the
 * default five-minute lifetime applies. Requests to any other provider type
 * pass through untouched — the caller decides with `model.provider` whether
 * to run this at all.
 */

import type { SystemModelMessage } from 'ai';

/** `providerOptions` as the SDK carries it: per-provider option bags. */
type CacheableProviderOptions = Record<string, unknown>;

type CacheableMessage = { providerOptions?: CacheableProviderOptions } & Record<string, unknown>;

export interface AnthropicCacheBreakpointShape {
  system?: string | SystemModelMessage;
  tools?: Record<string, unknown>;
}

function mergeCacheControl(providerOptions: CacheableProviderOptions | undefined): CacheableProviderOptions {
  const base = providerOptions ?? {};
  return {
    ...base,
    anthropic: {
      ...(base.anthropic as Record<string, unknown> | undefined ?? {}),
      cacheControl: { type: 'ephemeral' },
    },
  };
}

/**
 * Copy the request's cacheable pieces with the three breakpoints applied.
 * The input objects are never mutated: streamText re-serializes them on
 * every step, and a shared mutated marker would leak a breakpoint into a
 * request that outgrew its position.
 */
export function applyAnthropicCacheBreakpoints<M extends CacheableMessage>(options: {
  systemPrompt?: string;
  messages: M[];
  tools?: Record<string, unknown>;
}): AnthropicCacheBreakpointShape & { messages: M[] } {
  const messages = options.messages.map((message) => ({ ...message }));
  if (messages.length >= 2) {
    const anchor = messages[messages.length - 2];
    anchor.providerOptions = mergeCacheControl(anchor.providerOptions);
  }

  let tools: Record<string, unknown> | undefined;
  if (options.tools && Object.keys(options.tools).length > 0) {
    tools = { ...options.tools };
    const names = Object.keys(tools);
    const lastName = names[names.length - 1];
    const lastTool = tools[lastName] as { providerOptions?: CacheableProviderOptions } & Record<string, unknown>;
    tools[lastName] = { ...lastTool, providerOptions: mergeCacheControl(lastTool.providerOptions) };
  }

  return {
    system: options.systemPrompt
      ? {
          role: 'system',
          content: options.systemPrompt,
          providerOptions: mergeCacheControl(undefined) as SystemModelMessage['providerOptions'],
        }
      : undefined,
    messages,
    tools,
  };
}
