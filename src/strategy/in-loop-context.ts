/**
 * In-loop context guard.
 *
 * Durable compaction in `ContextBuilder` runs once per turn, before the first
 * request. Inside a turn the SDK appends every tool result to the outgoing
 * message list, so a long tool loop can assemble a request that already
 * exceeds the provider's context window before the next turn's guard sees it.
 * The provider rejects that request outright and the turn dies mid-flight.
 *
 * This module gives the strategy's `prepareStep` a cheap last line of defense:
 * estimate the outgoing messages, and when they cross the window trigger,
 * replace the oldest tool-result payloads with a placeholder. The durable
 * event log is untouched — the trim only affects what is sent next.
 */

import type { ModelMessage } from 'ai';

/** Placeholder substituted for trimmed tool outputs. */
export const IN_LOOP_TRIM_PLACEHOLDER =
  '[previous tool output omitted to fit the model context window]';

/** Tool-result messages kept verbatim at the tail regardless of pressure. */
const KEEP_RECENT_TOOL_MESSAGES = 3;

/** Rough chars-per-token estimate, matching `ContextCompactor`. */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimated tokens for one content part of a ModelMessage. */
function estimatePartTokens(part: unknown): number {
  if (typeof part === 'string') return estimateTextTokens(part);
  if (!part || typeof part !== 'object') return 1;
  const p = part as Record<string, unknown>;
  if (typeof p.text === 'string') return estimateTextTokens(p.text);
  const output = p.output as Record<string, unknown> | undefined;
  if (output && typeof output.value === 'string') {
    return estimateTextTokens(output.value);
  }
  // tool-call args, json outputs, binary/file parts: serialized size is the
  // closest cheap proxy for their prompt cost.
  return estimateTextTokens(JSON.stringify(part));
}

/** Estimated prompt tokens for a ModelMessage list (content only). */
export function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') tokens += estimateTextTokens(content);
    else if (Array.isArray(content)) {
      for (const part of content) tokens += estimatePartTokens(part);
    }
  }
  return tokens;
}

interface ToolResultPart {
  type: string;
  output?: { type?: string; value?: unknown };
}

function trimToolResultPart(part: ToolResultPart): void {
  const output = part.output;
  if (!output || typeof output !== 'object') return;
  if (output.type === 'text' && typeof output.value === 'string') {
    output.value = IN_LOOP_TRIM_PLACEHOLDER;
  } else if (output.value !== undefined) {
    output.value = IN_LOOP_TRIM_PLACEHOLDER;
  }
}

/**
 * Replace tool-result payloads with a placeholder until the estimate fits
 * under `targetTokens`. Oldest results are trimmed first; the last
 * `KEEP_RECENT_TOOL_MESSAGES` tool-role messages stay verbatim unless they
 * alone keep the request over target — correctness of the next request wins
 * over preserving their payload.
 *
 * Returns a new list when trimming changed anything, or null when nothing
 * needed trimming (callers then skip the messages override).
 */
export function trimInFlightToolResults(
  messages: ModelMessage[],
  targetTokens: number,
): ModelMessage[] | null {
  const toolIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIndexes.push(i);
  }
  const keepFrom = toolIndexes.length - KEEP_RECENT_TOOL_MESSAGES;
  const clone = messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return m;
    return {
      ...m,
      content: content.map((p) => {
        const part = { ...(p as Record<string, unknown>) };
        // `output` is nested — clone it too so trimming never mutates the
        // caller's message list.
        if (part.output && typeof part.output === 'object') {
          part.output = { ...(part.output as Record<string, unknown>) };
        }
        return part;
      }),
    } as ModelMessage;
  });

  let current = estimateModelMessagesTokens(clone);
  if (current <= targetTokens) return null;

  // Pass 1: trim everything except the recent tail.
  for (let k = 0; k < keepFrom && current > targetTokens; k++) {
    const idx = toolIndexes[k];
    const content = (clone[idx] as { content: unknown[] }).content;
    for (const part of content) {
      const before = estimatePartTokens(part);
      trimToolResultPart(part as ToolResultPart);
      current -= before - estimatePartTokens(part);
    }
  }

  // Pass 2: still over — the recent results themselves are too large.
  for (let k = Math.max(0, keepFrom); k < toolIndexes.length && current > targetTokens; k++) {
    const idx = toolIndexes[k];
    const content = (clone[idx] as { content: unknown[] }).content;
    for (const part of content) {
      const before = estimatePartTokens(part);
      trimToolResultPart(part as ToolResultPart);
      current -= before - estimatePartTokens(part);
    }
  }

  return clone;
}
