/**
 * Canonical agent `model` object profile.
 *
 * The published contract accepts `model` either as a bare id string or as an
 * object: `{"id": ..., "speed": ..., "effort": ..., "inference_geo": ...}`.
 * Only `id` is universally supported here; the rest are transport- or
 * geography-specific and the local runtime does not implement all of them.
 *
 * The rule this module exists to enforce is that an unsupported field must be
 * **handled explicitly, never silently dropped**. A caller that sends
 * `{"id": "x", "inference_geo": "us"}` and gets a 201 back has been told the
 * pin was accepted. Two outcomes are allowed:
 *
 * - implemented fields are carried into the runtime;
 * - everything else is reported as `unsupported_model_field` with the field
 *   name and its capability status, before the agent is persisted.
 *
 * `inference_geo` is the case worth spelling out. The published value set is
 * `us` / `global` and its whole purpose is a compliance guarantee: the pin is
 * validated against a workspace allow-list at save, at session creation, and on
 * every turn. A local runtime has no geography to honour, so accepting the
 * field would produce an agent whose stated data-residency property is a lie.
 * The field is therefore recognized (so the error names it) and rejected as
 * `unavailable`, not ignored.
 */

import type { AgentModelSpeed } from '@/types/agent.js';
import { anthropicModelCapabilities } from '@/model/anthropic-capabilities.js';

/** Effort levels accepted by the published contract. */
export const MODEL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffortLevel = (typeof MODEL_EFFORT_LEVELS)[number];

/** Recognized `speed` values. `standard` is this runtime's local default. */
export const MODEL_SPEED_LEVELS = ['standard', 'fast', 'extended'] as const;

/** Geography values accepted by the published contract. */
export const INFERENCE_GEOS = ['us', 'global'] as const;

/** Every `model` object key the contract defines. */
export const MODEL_OBJECT_FIELDS = ['id', 'speed', 'effort', 'inference_geo'] as const;

/**
 * Fields this runtime implements, with the local value set.
 *
 * `extended` is not a published speed and is kept as a local extension rather
 * than presented as canonical.
 */
export type ModelFieldDisposition =
  | { field: string; status: 'supported'; local?: string }
  | { field: string; status: 'partial'; reason: string }
  | { field: string; status: 'unavailable'; reason: string }
  | { field: string; status: 'unrecognized' };

export interface NormalizedModelObject {
  id: string;
  speed?: AgentModelSpeed;
  effort?: ModelEffortLevel;
  inference_geo?: (typeof INFERENCE_GEOS)[number];
}

export interface ModelObjectResult {
  ok: boolean;
  value?: NormalizedModelObject;
  /** Stable error code for the API envelope. */
  code?: string;
  message?: string;
  /** Field name that caused the rejection, when one did. */
  field?: string;
}

const EFFORT_SET = new Set<string>(MODEL_EFFORT_LEVELS);
const SPEED_SET = new Set<string>(MODEL_SPEED_LEVELS);
const GEO_SET = new Set<string>(INFERENCE_GEOS);

/**
 * Normalize a canonical `model` field.
 *
 * A string is the documented shorthand and maps to `{ id }`; an object is
 * parsed field by field. Unknown keys are rejected too — an unrecognized key is
 * exactly the silent-loss case this profile exists to prevent.
 */
export function normalizeModelField(value: unknown): ModelObjectResult {
  if (typeof value === 'string') {
    const id = value.trim();
    if (!id) return reject('invalid_model', 'model must not be empty', 'model');
    return { ok: true, value: { id } };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return reject('invalid_model', 'model must be a string or an object', 'model');
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(MODEL_OBJECT_FIELDS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    return reject(
      'unsupported_model_field',
      `model.${unknownKeys[0]} is not a recognized model field. Known fields: ${MODEL_OBJECT_FIELDS.join(', ')}.`,
      unknownKeys[0],
    );
  }

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return reject('invalid_model', 'model.id is required and must be a non-empty string', 'id');

  const normalized: NormalizedModelObject = { id };

  if (record.speed !== undefined && record.speed !== null) {
    if (typeof record.speed !== 'string' || !SPEED_SET.has(record.speed)) {
      return reject(
        'invalid_model_speed',
        `model.speed must be one of ${MODEL_SPEED_LEVELS.join(', ')}`,
        'speed',
      );
    }
    normalized.speed = record.speed as AgentModelSpeed;
  }

  if (record.effort !== undefined && record.effort !== null) {
    const effort = readEffort(record.effort);
    if (!effort) {
      return reject(
        'invalid_model_effort',
        `model.effort must be one of ${MODEL_EFFORT_LEVELS.join(', ')} or {"type": <level>}`,
        'effort',
      );
    }
    normalized.effort = effort;
  }

  if (record.inference_geo !== undefined && record.inference_geo !== null) {
    if (typeof record.inference_geo !== 'string' || !GEO_SET.has(record.inference_geo)) {
      return reject(
        'invalid_inference_geo',
        `model.inference_geo must be one of ${INFERENCE_GEOS.join(', ')}`,
        'inference_geo',
      );
    }
    // Recognized, well-formed, and still refused: the local runtime cannot
    // honour a data-residency pin, so accepting it would misrepresent the
    // agent's compliance property.
    return reject(
      'unsupported_model_field',
      'model.inference_geo pins inference to a geography; this runtime has no inference-geography control, so the pin cannot be honoured. Remove the field to create the agent.',
      'inference_geo',
    );
  }

  const capabilityRejection = modelCapabilityRejection(normalized);
  if (capabilityRejection) return capabilityRejection;

  return { ok: true, value: normalized };
}

/**
 * `effort` accepts a bare level or the object form `{"type": <level>}`.
 *
 * The object form is documented as equivalent, so both are normalized to the
 * bare level.
 */
function readEffort(value: unknown): ModelEffortLevel | undefined {
  if (typeof value === 'string') return EFFORT_SET.has(value) ? value as ModelEffortLevel : undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const type = (value as Record<string, unknown>).type;
    if (typeof type === 'string' && EFFORT_SET.has(type)) return type as ModelEffortLevel;
  }
  return undefined;
}

/**
 * Report how this runtime handles each field of a `model` object.
 *
 * Exposed so the capability surface and the contract document are generated
 * from the same source as the parser, instead of drifting apart.
 */
export function describeModelFieldProfile(): ModelFieldDisposition[] {
  return [
    { field: 'id', status: 'supported' },
    {
      field: 'speed',
      // `fast` reaches Anthropic requests for the models on the published
      // fast-mode list; a listed model that cannot take it is refused at
      // admission. `extended` is a local value with no wire form.
      status: 'partial',
      reason:
        'Executed for Anthropic provider models that support fast mode (Opus 5.5, Opus 5, Opus 4.8); refused at admission for known models that cannot take it; not sent on other providers or unknown model ids. Local value set: standard | fast | extended.',
    },
    {
      field: 'effort',
      // Executed for Anthropic provider models whose capability entry lists the
      // level; a listed model that cannot take the level is refused at
      // admission. Other providers and unknown model ids keep the stored value
      // but send nothing.
      status: 'partial',
      reason:
        'Executed as providerOptions.anthropic.effort on Anthropic models that support the level (admission refuses a level the selected model does not list); accepted and echoed but not sent on other providers or unknown model ids.',
    },
    {
      field: 'inference_geo',
      status: 'unavailable',
      reason: 'The local runtime has no inference-geography control, so a pin cannot be honoured.',
    },
  ];
}

/**
 * Refuse a normalized profile's options a known model cannot take — refused
 * here rather than stored and silently dropped at request time.
 *
 * Exported for the `model_config` spelling, which the schema parses without
 * going through `normalizeModelField` but which must obey the same
 * capability rules. Unknown model ids pass either way: absence from the
 * capability table is not proof of incapability, and the request builder
 * simply sends nothing for them.
 */
export function modelCapabilityRejection(profile: {
  id: string;
  speed?: string;
  effort?: string;
}): ModelObjectResult | undefined {
  const capabilities = anthropicModelCapabilities(profile.id);
  if (!capabilities) return undefined;
  if (profile.speed === 'fast' && !capabilities.fastMode) {
    return reject(
      'unsupported_model_speed',
      `model.speed "fast" is not supported by ${profile.id}; fast mode is limited to the published fast-mode model list.`,
      'speed',
    );
  }
  const effort = profile.effort as ModelEffortLevel | undefined;
  if (effort && !capabilities.effortLevels.includes(effort)) {
    return reject(
      'unsupported_model_effort',
      capabilities.effortLevels.length > 0
        ? `model.effort "${effort}" is not supported by ${profile.id}. Supported levels: ${capabilities.effortLevels.join(', ')}.`
        : `model.effort is not supported by ${profile.id}.`,
      'effort',
    );
  }
  return undefined;
}

function reject(code: string, message: string, field: string): ModelObjectResult {
  return { ok: false, code, message, field };
}
