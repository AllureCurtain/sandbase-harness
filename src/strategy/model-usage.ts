/**
 * Split one model request's reported usage into the buckets the wire contract
 * prices separately.
 *
 * A provider reports `inputTokens` as the *total* input; the prompt-cache
 * buckets live in `inputTokenDetails`. What the runtime records as input is
 * only the uncached share, so a cache read is never billed as a full-rate
 * token. A provider that reports no details has no cache, and its whole input
 * is the uncached share.
 */

export interface ModelRequestUsage {
  inputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface ModelRequestUsageSplit {
  /** Input tokens that missed the provider's prompt cache. */
  input: number;
  /** Input tokens read from the provider's prompt cache. */
  cacheRead: number;
  /** Input tokens written into the provider's prompt cache. */
  cacheWrite: number;
}

export function splitModelRequestUsage(usage: ModelRequestUsage | undefined): ModelRequestUsageSplit {
  const details = usage?.inputTokenDetails;
  return {
    input: details?.noCacheTokens ?? usage?.inputTokens ?? 0,
    cacheRead: details?.cacheReadTokens ?? 0,
    cacheWrite: details?.cacheWriteTokens ?? 0,
  };
}
