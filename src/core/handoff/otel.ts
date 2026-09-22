/**
 * OpenTelemetry GenAI semantic-convention naming for handoff bundles.
 *
 * The point of adopting an existing vocabulary rather than inventing field
 * names: a bundle that names its model attributes `gen_ai.*` can be consumed by
 * anything already instrumented for OTel GenAI, and the names stay stable
 * across our releases because someone else owns them.
 *
 * The convention also settles a policy question for us. OTel GenAI does not
 * capture prompt or completion bodies by default — content capture is an
 * explicit opt-in, because prompt text is where personal and proprietary data
 * accumulates. Bundle defaults follow that: see `CONTENT_CAPTURE_ATTRIBUTE`.
 */

import { createHash } from 'node:crypto';

/** Provider names as the convention spells them. `gen_ai.provider.name` supersedes the older `gen_ai.system`. */
const PROVIDER_ATTRIBUTE = 'gen_ai.provider.name';

/**
 * Opt-in flag modelled on OTel's experimental content-capture switch.
 *
 * `no_content` keeps bodies out of the bundle while still recording that a
 * message happened and how large it was; `full_content` records bodies.
 */
export const CONTENT_CAPTURE_ATTRIBUTE = 'gen_ai.content.capture';

export type GenAiContentCapture = 'no_content' | 'full_content';

export type GenAiSpanAttributes = Record<string, string | number | boolean | string[]>;

export type GenAiModelRequest = {
  provider: string;
  requestModel?: string | null;
  responseModel?: string | null;
  responseId?: string | null;
  finishReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  agentName?: string | null;
  conversationId?: string | null;
  operationName?: string;
};

/** Attributes for one model or tool span, named per the OTel GenAI convention. */
export function genAiSpanAttributes(input: GenAiModelRequest): GenAiSpanAttributes {
  const attributes: GenAiSpanAttributes = {
    [PROVIDER_ATTRIBUTE]: input.provider,
    'gen_ai.operation.name': input.operationName ?? 'chat',
  };
  if (input.requestModel) attributes['gen_ai.request.model'] = input.requestModel;
  if (input.responseModel) attributes['gen_ai.response.model'] = input.responseModel;
  if (input.responseId) attributes['gen_ai.response.id'] = input.responseId;
  if (input.finishReason) attributes['gen_ai.response.finish_reasons'] = [input.finishReason];
  if (typeof input.inputTokens === 'number') attributes['gen_ai.usage.input_tokens'] = input.inputTokens;
  if (typeof input.outputTokens === 'number') attributes['gen_ai.usage.output_tokens'] = input.outputTokens;
  if (input.agentName) attributes['gen_ai.agent.name'] = input.agentName;
  if (input.conversationId) attributes['gen_ai.conversation.id'] = input.conversationId;
  return attributes;
}

export type GenAiToolCall = {
  name: string;
  callId: string;
  /** Recorded outcome. Tools are never re-executed during a replay. */
  status?: 'ok' | 'error' | 'denied' | 'pending';
  durationMs?: number | null;
};

export function genAiToolAttributes(call: GenAiToolCall): GenAiSpanAttributes {
  const attributes: GenAiSpanAttributes = {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': call.name,
    'gen_ai.tool.call.id': call.callId,
  };
  if (call.status) attributes['gen_ai.tool.call.status'] = call.status;
  if (typeof call.durationMs === 'number') attributes['gen_ai.tool.call.duration_ms'] = call.durationMs;
  return attributes;
}

/**
 * Digest of a message body, recorded in place of the body itself.
 *
 * A recipient who already holds the original text can confirm the bundle
 * covers it; a recipient who does not learns nothing from the digest. Same
 * trade the convention's content-capture switch makes.
 */
export type GenAiContentReference = {
  captured: false;
  bytes: number;
  sha256: string;
};

export function genAiContentReference(text: string): GenAiContentReference {
  return {
    captured: false,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}
