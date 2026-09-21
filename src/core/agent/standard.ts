import type {
  AgentDefinition,
  AgentToolConfig,
  AgentToolset,
  BuiltinAgentToolset,
  CanonicalCustomTool,
  CustomToolConfig,
  PermissionPolicyType,
} from '@/types/agent.js';

export const DEFAULT_AGENT_TOOLSET_TYPE = 'agent_toolset_20260401';

/**
 * Default permission policy by toolset kind, or `undefined` when the kind is
 * not governed by permission policy.
 *
 * Custom tools carry no default at all: the caller executes them and decides
 * whether to run them, so there is no policy for the runtime to apply.
 */
const DEFAULT_TOOLSET_PERMISSION: Readonly<Partial<Record<AgentToolset['type'], PermissionPolicyType>>> = {
  agent_toolset_20260401: 'always_allow',
  custom_toolset: undefined,
  custom: undefined,
};

/** Default permission policy for a toolset kind, or `undefined` when not governed. */
export function defaultToolsetPermission(type: AgentToolset['type']): PermissionPolicyType | undefined {
  return DEFAULT_TOOLSET_PERMISSION[type];
}

/** Project a canonical `custom` entry to the internal config shape. */
export function canonicalToConfig(tool: CanonicalCustomTool): CustomToolConfig {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    input_schema: tool.input_schema,
  };
}

/**
 * Find one custom tool's config by name, in either wire shape.
 *
 * The canonical `custom` entry carries no `enabled` flag and no permission
 * policy by design; a legacy `custom_toolset` may carry both. Returning one
 * shape here keeps every consumer from branching on the wire form.
 */
export function findCustomToolConfig(toolset: AgentToolset, toolName: string): CustomToolConfig | undefined {
  if (toolset.type === 'custom') {
    return toolset.name === toolName ? canonicalToConfig(toolset) : undefined;
  }
  if (toolset.type === 'custom_toolset') {
    return (toolset.configs ?? []).find((config) => config.name === toolName);
  }
  return undefined;
}

export function getAgentSkillIds(agent: AgentDefinition): string[] {
  return (agent.skills ?? []).map((skill) => skill.skill_id);
}

export function getEnabledToolNames(agent: AgentDefinition): string[] {
  const names = new Set<string>();
  for (const toolset of getAgentToolsets(agent)) {
    const defaultEnabled = toolset.default_config?.enabled !== false;
    for (const config of toolset.configs ?? []) {
      const enabled = config.enabled ?? defaultEnabled;
      if (enabled && getPermissionPolicy(config, toolset.default_config) !== 'never_allow') {
        names.add(config.name);
      }
    }
  }
  for (const toolset of agent.tools ?? []) {
    if (toolset.type === 'custom') {
      names.add(toolset.name);
      continue;
    }
    if (toolset.type !== 'custom_toolset') continue;
    const defaultEnabled = toolset.default_config?.enabled !== false;
    for (const config of toolset.configs ?? []) {
      const enabled = config.enabled ?? defaultEnabled;
      if (enabled && getPermissionPolicy(config, toolset.default_config) !== 'never_allow') {
        names.add(config.name);
      }
    }
  }
  return [...names];
}

/** Every custom tool the agent declares, in one internal config shape. */
export function getCustomToolConfigs(agent: AgentDefinition): CustomToolConfig[] {
  return (agent.tools ?? []).flatMap((toolset) => {
    if (toolset.type === 'custom') return [canonicalToConfig(toolset)];
    if (toolset.type !== 'custom_toolset') return [];
    return (toolset.configs ?? []).map((config) => ({
      ...config,
      parameters: config.parameters ?? config.input_schema!,
    }));
  });
}

/** The model-visible names of every enabled custom tool. */
export function getCustomToolNames(agent: AgentDefinition): string[] {
  return (agent.tools ?? []).flatMap((toolset) => {
    if (toolset.type === 'custom') return [toolset.name];
    if (toolset.type !== 'custom_toolset') return [];
    const defaultEnabled = toolset.default_config?.enabled !== false;
    return (toolset.configs ?? [])
      .filter((config) => (config.enabled ?? defaultEnabled) && getPermissionPolicy(config, toolset.default_config) !== 'never_allow')
      .map((config) => config.name);
  });
}

export function getToolPermission(agent: AgentDefinition, toolName: string): PermissionPolicyType {
  for (const toolset of getAgentToolsets(agent)) {
    const config = toolset.configs?.find((item) => item.name === toolName);
    if (!config) continue;
    return getPermissionPolicy(config, toolset.default_config);
  }
  return 'always_allow';
}

export function getToolsRequiringConfirmation(agent: AgentDefinition): string[] {
  return getEnabledToolNames(agent).filter((toolName) => getToolPermission(agent, toolName) === 'always_ask');
}

export function getAgentToolsets(agent: AgentDefinition): BuiltinAgentToolset[] {
  return (agent.tools ?? []).filter((toolset) => toolset.type === DEFAULT_AGENT_TOOLSET_TYPE);
}

function getPermissionPolicy(
  config: AgentToolConfig | undefined,
  defaultConfig: AgentToolConfig | undefined,
): PermissionPolicyType {
  return config?.permission_policy?.type ?? defaultConfig?.permission_policy?.type ?? 'always_allow';
}
