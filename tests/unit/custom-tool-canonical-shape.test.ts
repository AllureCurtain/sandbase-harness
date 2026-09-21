import { describe, expect, it } from 'vitest';
import { validateAgentDefinition } from '@/core/agent/schema.js';
import {
  canonicalToConfig,
  defaultToolsetPermission,
  findCustomToolConfig,
  getCustomToolConfigs,
  getCustomToolNames,
  getEnabledToolNames,
  getToolPermission,
  getToolsRequiringConfirmation,
} from '@/core/agent/standard.js';
import { toApiAgent } from '@/api/standard.js';
import type { AgentDefinition, CanonicalCustomTool } from '@/types/agent.js';

const customTool: CanonicalCustomTool = {
  type: 'custom',
  name: 'lookup_invoice',
  description: 'Look up an invoice by id in the billing system',
  input_schema: {
    type: 'object',
    properties: { invoice_id: { type: 'string' } },
    required: ['invoice_id'],
  },
};

function agentWithTools(tools: AgentDefinition['tools']): AgentDefinition {
  return {
    name: 'billing',
    model: 'test-model',
    system: 'You help with billing.',
    tools,
  };
}

describe('canonical custom tool shape', () => {
  it('accepts the published canonical custom entry on ingress', () => {
    const result = validateAgentDefinition({
      name: 'billing',
      model: 'test-model',
      system: 'You help with billing.',
      tools: [customTool],
    });

    expect(result.valid).toBe(true);
    expect(result.data?.tools).toEqual([customTool]);
  });

  it('rejects a canonical custom entry that carries a permission policy', () => {
    const result = validateAgentDefinition({
      name: 'billing',
      model: 'test-model',
      system: 'You help with billing.',
      tools: [{ ...customTool, permission_policy: { type: 'always_ask' } }],
    });

    // Canonical custom tools are not governed by permission policy; accepting a
    // policy here would claim governance the runtime never applies.
    expect(result.valid).toBe(false);
  });

  it('accepts the legacy custom_toolset grouping and projects canonical entries', () => {
    const result = validateAgentDefinition({
      name: 'billing',
      model: 'test-model',
      system: 'You help with billing.',
      tools: [
        {
          type: 'custom_toolset',
          configs: [
            {
              name: 'lookup_invoice',
              description: 'Look up an invoice by id in the billing system',
              input_schema: customTool.input_schema,
            },
          ],
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.data?.tools).toEqual([customTool]);
  });

  it('omits a custom tool the legacy grouping disables', () => {
    const result = validateAgentDefinition({
      name: 'billing',
      model: 'test-model',
      system: 'You help with billing.',
      tools: [
        {
          type: 'custom_toolset',
          default_config: { enabled: false },
          configs: [
            {
              name: 'lookup_invoice',
              description: 'Look up an invoice by id',
              input_schema: customTool.input_schema,
            },
          ],
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.data?.tools).toEqual([]);
  });

  it('rejects a canonical custom tool whose name collides with a built-in tool', () => {
    const result = validateAgentDefinition({
      name: 'billing',
      model: 'test-model',
      system: 'You help with billing.',
      tools: [{ ...customTool, name: 'bash' }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors?.some((error) => error.message.includes('conflicts with a built-in tool'))).toBe(true);
  });

  it('rejects duplicate custom tool names across canonical and legacy declarations', () => {
    const result = validateAgentDefinition({
      name: 'billing',
      model: 'test-model',
      system: 'You help with billing.',
      tools: [
        customTool,
        {
          type: 'custom_toolset',
          configs: [
            {
              name: 'lookup_invoice',
              description: 'Duplicate',
              input_schema: customTool.input_schema,
            },
          ],
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors?.some((error) => error.message.includes('Duplicate custom tool name'))).toBe(true);
  });

  it('reports the same tool set for both wire shapes', () => {
    const canonical = agentWithTools([customTool]);
    const legacy = agentWithTools([
      {
        type: 'custom_toolset',
        configs: [
          {
            name: 'lookup_invoice',
            description: customTool.description,
            parameters: customTool.input_schema,
            input_schema: customTool.input_schema,
          },
        ],
      },
    ]);

    expect(getCustomToolNames(canonical)).toEqual(['lookup_invoice']);
    expect(getCustomToolNames(legacy)).toEqual(['lookup_invoice']);
    expect(getEnabledToolNames(canonical)).toEqual(['lookup_invoice']);
    expect(getEnabledToolNames(legacy)).toEqual(['lookup_invoice']);
    expect(getCustomToolConfigs(canonical)).toEqual(getCustomToolConfigs(legacy));
  });

  it('exposes the tool description and schema to the model', () => {
    const config = canonicalToConfig(customTool);

    expect(config.name).toBe('lookup_invoice');
    expect(config.description).toBe(customTool.description);
    expect(config.parameters).toEqual(customTool.input_schema);
  });

  it('finds a canonical tool config by name', () => {
    expect(findCustomToolConfig(customTool, 'lookup_invoice')?.name).toBe('lookup_invoice');
    expect(findCustomToolConfig(customTool, 'other')).toBeUndefined();
  });

  it('projects the canonical entry on the agent response', () => {
    const response = toApiAgent(agentWithTools([customTool]));

    expect(response.tools).toEqual([customTool]);
  });

  it('projects a legacy grouping as canonical entries without a policy', () => {
    const response = toApiAgent(agentWithTools([
      {
        type: 'custom_toolset',
        configs: [
          {
            name: 'lookup_invoice',
            description: customTool.description,
            parameters: customTool.input_schema,
            permission_policy: { type: 'always_ask' },
          },
        ],
      },
    ]));

    expect(response.tools).toEqual([customTool]);
  });
});

describe('custom tools are not governed by permission policy', () => {
  it('declares no default for custom tools', () => {
    expect(defaultToolsetPermission('custom')).toBeUndefined();
    expect(defaultToolsetPermission('custom_toolset')).toBeUndefined();
  });

  it('treats a canonical custom tool as ungated by permission policy', () => {
    const agent = agentWithTools([customTool]);

    expect(getToolPermission(agent, 'lookup_invoice')).toBe('always_allow');
    expect(getToolsRequiringConfirmation(agent)).toEqual([]);
  });
});
