/**
 * Dreams: session-backed memory-consolidation jobs (`drm_*`).
 *
 * A dream reads one memory store and a set of session transcripts, runs a
 * consolidation pipeline inside a dedicated internal session, and writes the
 * result to a memory store — a new one seeded as a copy of the input by
 * default, or the input store itself under `update_existing`.
 *
 * This module owns the row shape, request validation, and the API projection.
 * `runner.ts` owns the lifecycle: starting the pipeline session, reconciling
 * dream status from it, and cancel/archive.
 */

import type { Database } from '@/core/db/database.js';

export type DreamStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
export const DREAM_STATUSES: readonly DreamStatus[] = ['pending', 'running', 'completed', 'failed', 'canceled'];

/** Statuses that can still move. Everything else is final. */
export const ACTIVE_DREAM_STATUSES: readonly DreamStatus[] = ['pending', 'running'];

export interface DreamModelConfig {
  id: string;
  speed?: 'standard';
}

export type DreamInput =
  | { type: 'memory_store'; memory_store_id: string }
  | { type: 'sessions'; session_ids: string[] };

export type DreamOutputBehavior =
  | { type: 'create_new' }
  | { type: 'update_existing'; memory_store_id: string };

export interface DreamRow {
  id: string;
  status: DreamStatus;
  inputs: string;
  instructions: string | null;
  model: string;
  output_behavior: string;
  input_store_id: string;
  output_store_id: string | null;
  session_id: string | null;
  error_type: string | null;
  error_message: string | null;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cache_read_input_tokens: number;
  usage_cache_creation_input_tokens: number;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  archived_at: string | null;
}

/** Published `instructions` bound — the create request refuses anything longer. */
export const DREAM_INSTRUCTIONS_MAX_CHARS = 4096;
/** Published session-input bound: 1–100 unique session ids per dream. */
export const DREAM_SESSION_IDS_MAX = 100;
/** Published model-id bound, shared with the agent-definition profile. */
export const DREAM_MODEL_ID_MAX_CHARS = 256;

export interface ParsedDreamCreate {
  memoryStoreId: string;
  sessionIds: string[];
  instructions: string | null;
  model: DreamModelConfig | null;
  outputBehavior: DreamOutputBehavior;
}

export type DreamCreateParse =
  | { ok: true; value: ParsedDreamCreate }
  | { ok: false; message: string; code?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate a `POST /v1/dreams` body against the published shape.
 *
 * `inputs` must hold exactly one `memory_store` entry and one `sessions` entry;
 * session ids are deduplicated and sorted here because the response echoes them
 * sorted, and storing the request order would echo a different array than the
 * projection later claims.
 */
export function parseDreamCreate(body: Record<string, unknown>): DreamCreateParse {
  for (const key of Object.keys(body)) {
    if (!['inputs', 'instructions', 'model', 'output_behavior'].includes(key)) {
      return { ok: false, message: `Unknown parameter: '${key}'.` };
    }
  }

  if (!Array.isArray(body.inputs)) {
    return { ok: false, message: 'inputs is required and must be an array' };
  }
  const storeInputs = body.inputs.filter((input) => isPlainObject(input) && input.type === 'memory_store');
  const sessionInputs = body.inputs.filter((input) => isPlainObject(input) && input.type === 'sessions');
  const unknownInputs = body.inputs.filter(
    (input) => !isPlainObject(input) || (input.type !== 'memory_store' && input.type !== 'sessions'),
  );
  if (unknownInputs.length > 0) {
    return { ok: false, message: 'inputs entries must be objects with type "memory_store" or "sessions"' };
  }
  if (storeInputs.length !== 1 || sessionInputs.length !== 1 || body.inputs.length !== 2) {
    return {
      ok: false,
      message: 'inputs must contain exactly one memory_store entry and one sessions entry',
    };
  }

  const memoryStoreId = storeInputs[0].memory_store_id;
  if (typeof memoryStoreId !== 'string' || memoryStoreId.length === 0) {
    return { ok: false, message: 'inputs memory_store.memory_store_id is required and must be a string' };
  }

  const sessionIdsRaw = sessionInputs[0].session_ids;
  if (!Array.isArray(sessionIdsRaw) || sessionIdsRaw.length === 0) {
    return { ok: false, message: 'inputs sessions.session_ids is required and must be a non-empty array' };
  }
  if (sessionIdsRaw.length > DREAM_SESSION_IDS_MAX) {
    return { ok: false, message: `inputs sessions.session_ids accepts at most ${DREAM_SESSION_IDS_MAX} ids` };
  }
  if (sessionIdsRaw.some((id) => typeof id !== 'string' || id.length === 0)) {
    return { ok: false, message: 'inputs sessions.session_ids entries must be non-empty strings' };
  }
  const deduped = new Set(sessionIdsRaw as string[]);
  if (deduped.size !== sessionIdsRaw.length) {
    return { ok: false, message: 'inputs sessions.session_ids must not contain duplicates' };
  }
  const sessionIds = [...deduped].sort();

  let instructions: string | null = null;
  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== 'string') {
      return { ok: false, message: 'instructions must be a string or null' };
    }
    if (body.instructions.length === 0 || body.instructions.length > DREAM_INSTRUCTIONS_MAX_CHARS) {
      return {
        ok: false,
        message: `instructions must be 1-${DREAM_INSTRUCTIONS_MAX_CHARS} characters when supplied`,
      };
    }
    instructions = body.instructions;
  }

  let model: DreamModelConfig | null = null;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model === 'string') {
      if (body.model.length === 0 || body.model.length > DREAM_MODEL_ID_MAX_CHARS) {
        return { ok: false, message: `model must be a model id of 1-${DREAM_MODEL_ID_MAX_CHARS} characters` };
      }
      model = { id: body.model };
    } else if (isPlainObject(body.model)) {
      const id = body.model.id;
      if (typeof id !== 'string' || id.length === 0 || id.length > DREAM_MODEL_ID_MAX_CHARS) {
        return { ok: false, message: `model.id must be a model id of 1-${DREAM_MODEL_ID_MAX_CHARS} characters` };
      }
      const speed = body.model.speed;
      // The published contract accepts only `standard` on this route.
      if (speed !== undefined && speed !== null && speed !== 'standard') {
        return { ok: false, message: 'model.speed must be "standard"' };
      }
      model = { id, speed: 'standard' };
    } else {
      return { ok: false, message: 'model must be a model id string or an object with id' };
    }
  }

  let outputBehavior: DreamOutputBehavior = { type: 'create_new' };
  if (body.output_behavior !== undefined && body.output_behavior !== null) {
    if (!isPlainObject(body.output_behavior)) {
      return { ok: false, message: 'output_behavior must be an object' };
    }
    if (body.output_behavior.type === 'create_new') {
      outputBehavior = { type: 'create_new' };
    } else if (body.output_behavior.type === 'update_existing') {
      const target = body.output_behavior.memory_store_id;
      if (typeof target !== 'string' || target.length === 0) {
        return { ok: false, message: 'output_behavior.memory_store_id is required for update_existing' };
      }
      if (target !== memoryStoreId) {
        return {
          ok: false,
          message: 'output_behavior.memory_store_id must be the input memory store for update_existing',
        };
      }
      outputBehavior = { type: 'update_existing', memory_store_id: target };
    } else {
      return { ok: false, message: 'output_behavior.type must be "create_new" or "update_existing"' };
    }
  }

  return { ok: true, value: { memoryStoreId, sessionIds, instructions, model, outputBehavior } };
}

/** Normalize one parsed create request into the input array the response echoes. */
export function dreamInputsProjection(parsed: ParsedDreamCreate): DreamInput[] {
  return [
    { type: 'memory_store', memory_store_id: parsed.memoryStoreId },
    { type: 'sessions', session_ids: parsed.sessionIds },
  ];
}

export function getDream(db: Database, id: string): DreamRow | undefined {
  return db.prepare('SELECT * FROM dreams WHERE id = ?').get(id) as DreamRow | undefined;
}

/** Project a stored row to the published dream shape. */
export function toApiDream(row: DreamRow) {
  const model = JSON.parse(row.model) as DreamModelConfig;
  return {
    id: row.id,
    type: 'dream',
    status: row.status,
    inputs: JSON.parse(row.inputs) as DreamInput[],
    instructions: row.instructions,
    model,
    output_behavior: JSON.parse(row.output_behavior) as DreamOutputBehavior,
    outputs: row.output_store_id
      ? [{ type: 'memory_store', memory_store_id: row.output_store_id }]
      : [],
    session_id: row.session_id,
    usage: {
      cache_creation_input_tokens: row.usage_cache_creation_input_tokens,
      cache_read_input_tokens: row.usage_cache_read_input_tokens,
      input_tokens: row.usage_input_tokens,
      output_tokens: row.usage_output_tokens,
    },
    error: row.error_type ? { type: row.error_type, message: row.error_message ?? 'Dream failed' } : null,
    created_at: row.created_at,
    ended_at: row.ended_at,
    archived_at: row.archived_at,
  };
}
