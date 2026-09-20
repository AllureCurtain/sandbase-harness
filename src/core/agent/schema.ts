/**
 * Agent Definition Schema Validator
 *
 * Uses Zod to validate AgentDefinition objects loaded from YAML/JSON.
 * Returns structured errors with field path and reason on failure.
 */

import { z } from 'zod';
import { BUILTIN_TOOL_NAMES } from '@/core/capabilities/registry.js';
import { normalizeModelField } from '@/core/agent/model-object.js';
import {
  validateWebToolConfigs,
  webToolPolicyFieldsSchema,
} from '@/core/agent/web-tool-policy.js';
import type { AgentDefinition } from '@/types/agent.js';

// ============================================================
// MCP Server Config Schema
// ============================================================

const mcpServerConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('url'),
    name: z.string().min(1, 'MCP server name is required'),
    url: z.string().url(),
    timeout: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal('stdio'),
    name: z.string().min(1, 'MCP server name is required'),
    command: z.string().min(1, 'stdio MCP server command is required'),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout: z.number().positive().optional(),
  }),
]);

const permissionPolicySchema = z.object({
  type: z.enum(['always_allow', 'always_ask', 'never_allow']),
});

const agentToolConfigSchema = z.object({
  enabled: z.boolean().optional(),
  permission_policy: permissionPolicySchema.optional(),
});

const builtinToolConfigSchema = agentToolConfigSchema.extend({
  name: z.enum(BUILTIN_TOOL_NAMES),
  // Web-tool domain lists are typed here so they survive parsing, but the
  // grammar itself is enforced structurally in web-tool-policy.ts: a Zod
  // string[] would emit a generic message that loses the list and index the
  // published contract makes normative.
  ...webToolPolicyFieldsSchema,
});

const mcpToolConfigSchema = agentToolConfigSchema.extend({
  name: z.string().min(1, 'Tool config name is required').max(128),
});

const agentToolsetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent_toolset_20260401'),
    configs: z.array(builtinToolConfigSchema).default([]),
    default_config: agentToolConfigSchema.optional(),
  }),
  z.object({
    type: z.literal('mcp_toolset'),
    mcp_server_name: z.string().min(1, 'MCP toolset server name is required'),
    configs: z.array(mcpToolConfigSchema).default([]),
    default_config: agentToolConfigSchema.optional(),
  }),
]);

const skillRefSchema = z.object({
  type: z.enum(['custom', 'anthropic']),
  skill_id: z.string().min(1, 'Skill id is required'),
  version: z.string().optional(),
});

const modelSpeedSchema = z.enum(['fast', 'standard', 'extended']);

/**
 * Reasoning effort accepted by the published contract.
 *
 * Parsed and validated so an unsupported level fails loudly, then carried
 * through so the value survives a read-back instead of being dropped on the
 * way in. Nothing yet varies model behaviour by it.
 */
export const modelEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

const agentModelConfigSchema = z.object({
  id: z.string().min(1, 'Model id is required').optional(),
  speed: modelSpeedSchema.default('standard'),
});

/**
 * Canonical `model` object.
 *
 * `inference_geo` is deliberately absent: the parser in `model-object.ts`
 * rejects a well-formed pin with `unsupported_model_field` rather than
 * silently accepting a data-residency claim this runtime cannot honour. A
 * schema here would have to either admit the field (and lie) or produce a
 * generic validation error that does not name the problem.
 */
export const agentModelObjectSchema = z.object({
  id: z.string().min(1, 'Model id is required'),
  speed: modelSpeedSchema.optional(),
  effort: modelEffortSchema.optional(),
});

// The canonical object form is tried before the bare string so a definition
// that carries `effort` is parsed by the schema that knows the field. Reversing
// the order would let the string arm never see it and the legacy object arm
// strip it, which is exactly the silent loss this parser exists to prevent.
const agentModelInputSchema = z.union([
  agentModelObjectSchema,
  z.string().min(1, 'Model id is required'),
]);

// ============================================================
// Agent Definition Schema
// ============================================================

export const agentDefinitionSchema = z.object({
  name: z
    .string()
    .min(1, 'Agent name is required')
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'Agent name must be alphanumeric with spaces, hyphens, or underscores'),
  model: agentModelInputSchema,
  model_config: agentModelConfigSchema.optional(),
  system: z.string().min(1, 'System instructions are required'),
  description: z.string().optional(),
  skills: z.array(skillRefSchema).optional(),
  mcp_servers: z.array(mcpServerConfigSchema).optional(),
  tools: z.array(agentToolsetSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  max_turns: z.number().int().positive().max(1000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  delegations: z.array(z.string()).optional(),
  enable_general_subagent: z.boolean().optional(),
  strategy: z.string().optional(),
  environment: z.string().optional(),
});

// ============================================================
// Validation Result Types
// ============================================================

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  data?: AgentDefinition;
  errors?: ValidationError[];
}

// ============================================================
// Validation Function
// ============================================================

/**
 * Validate an unknown object against the AgentDefinition schema.
 * Returns structured errors with field paths on failure.
 */
export function validateAgentDefinition(input: unknown): ValidationResult {
  const result = agentDefinitionSchema.safeParse(input);

  if (!result.success) {
    const errors: ValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));

    return { valid: false, errors };
  }

  // Domain-list rules the schema cannot express without losing the exact
  // list and index the published contract requires in the message.
  const webToolErrors = validateWebToolConfigs(result.data.tools);
  if (webToolErrors.length > 0) {
    return { valid: false, errors: webToolErrors };
  }

  // A field the runtime cannot honour is refused by name rather than accepted
  // and quietly dropped. The schema strips what it does not know, so this runs
  // against the caller's own value; a shape error has already been reported
  // above and is left untouched.
  const modelProfile = normalizeModelField(
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).model
      : undefined,
  );
  if (!modelProfile.ok) {
    return {
      valid: false,
      errors: [{
        path: modelProfile.field && modelProfile.field !== 'model'
          ? `model.${modelProfile.field}`
          : 'model',
        message: modelProfile.message ?? 'model is invalid',
      }],
    };
  }

  return { valid: true, data: normalizeAgentDefinition(result.data) };
}

function normalizeAgentDefinition(data: z.infer<typeof agentDefinitionSchema>): AgentDefinition {
  if (typeof data.model === 'string') {
    return {
      ...data,
      model: data.model,
      ...(data.model_config ? { model_config: { id: data.model_config.id ?? data.model, speed: data.model_config.speed } } : {}),
    } as AgentDefinition;
  }

  return {
    ...data,
    model: data.model.id,
    model_config: {
      id: data.model.id,
      speed: data.model.speed ?? 'standard',
    },
    // Parsed and validated above so an unsupported level fails loudly, then
    // carried through so the value survives a read-back.
    ...(data.model.effort ? { effort: data.model.effort } : {}),
  } as AgentDefinition;
}
