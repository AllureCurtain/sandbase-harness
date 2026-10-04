/**
 * Anthropic provider options for a model request.
 *
 * Maps an agent's `model` profile onto `providerOptions.anthropic` for a
 * `streamText` call, gated by {@link anthropicModelCapabilities}:
 *
 * - `model.effort` → `effort` (the provider serializes it as
 *   `output_config.effort`);
 * - `model.speed` → `speed` — only `fast` is sent; `standard` is the
 *   provider's default and `extended` is a local value with no wire form;
 * - models that take adaptive thinking always get
 *   `thinking: {type: 'adaptive', display: 'omitted'}` — `omitted` keeps
 *   thinking content out of the response, matching the runtime's policy of
 *   never persisting reasoning traces. There is deliberately no caller-facing
 *   thinking option: the published agent contract has no such field, so the
 *   runtime selects the mode itself.
 *
 * A model the capability table does not cover receives none of these fields —
 * sending an option an unknown model may reject would make a request fail for
 * a capability the agent never asked about.
 */

import type { JSONValue } from 'ai';
import type { ModelEffortLevel } from '@/core/agent/model-object.js';
import { anthropicModelCapabilities } from './anthropic-capabilities.js';

// The index signature is what lets the bag satisfy the SDK's
// `SharedV4ProviderOptions` (a `JSONObject` per provider id) — provider
// options cross the wire as JSON, so the loose top shape is honest.
export interface AnthropicCallOptions {
  [key: string]: JSONValue | undefined;
  effort?: ModelEffortLevel;
  speed?: 'fast';
  thinking?: { type: 'adaptive'; display: 'omitted' };
}

export function anthropicCallOptions(input: {
  modelId: string;
  effort?: ModelEffortLevel;
  speed?: string;
}): { anthropic: AnthropicCallOptions } | undefined {
  const capabilities = anthropicModelCapabilities(input.modelId);
  if (!capabilities) return undefined;

  const anthropic: AnthropicCallOptions = {};
  if (capabilities.adaptiveThinking) {
    anthropic.thinking = { type: 'adaptive', display: 'omitted' };
  }
  if (input.effort && capabilities.effortLevels.includes(input.effort)) {
    anthropic.effort = input.effort;
  }
  if (input.speed === 'fast' && capabilities.fastMode) {
    anthropic.speed = 'fast';
  }
  return Object.keys(anthropic).length > 0 ? { anthropic } : undefined;
}
