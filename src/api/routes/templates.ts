import { Hono } from 'hono';
import { getAgentSkillIds, getEnabledToolNames } from '@/core/agent/standard.js';
import type { ServerDeps } from '../server.js';

const DEFAULT_TEMPLATE_MODEL = 'gpt-4o';

export function templateRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.get('/', (c) => {
    const templates = builtInTemplates(DEFAULT_TEMPLATE_MODEL);
    return c.json({
      data: templates,
      has_more: false,
      first_id: templates[0]?.id ?? null,
      last_id: templates.at(-1)?.id ?? null,
    });
  });

  return app;
}

function builtInTemplates(defaultModelName: string) {
  return [
    {
      id: 'template_blank_agent',
      type: 'template',
      name: 'Blank agent',
      description: 'Start from scratch with a generic prompt and configure the tools your workflow needs.',
      tags: ['starter'],
      agent: {
        name: 'Untitled agent',
        model: defaultModelName,
        description: 'A blank starting point for configuring a prompt and tools.',
        system: 'You are a general-purpose agent. Complete the user\'s task end to end using only configured tools and connected services.',
        mcp_servers: [],
        tools: [{ type: 'agent_toolset_20260401' }],
        skills: [],
        metadata: {},
      },
    },
    {
      id: 'template_deep_researcher',
      type: 'template',
      name: 'Deep researcher',
      description: 'Plans multi-step research over supplied materials and writes a cited synthesis.',
      tags: ['research', 'analysis'],
      agent: {
        name: 'deep-researcher',
        model: defaultModelName,
        description: 'Conducts multi-step research over supplied materials with source synthesis and citations.',
        system: 'You are a deep research agent. Break the task into questions, inspect the available workspace materials, compare evidence, and produce a concise cited report.',
        tools: [{
          type: 'agent_toolset_20260401',
          default_config: {
            enabled: true,
            permission_policy: { type: 'always_allow' },
          },
          configs: [
            { name: 'read', enabled: true },
            { name: 'write', enabled: true },
            { name: 'grep', enabled: true },
          ],
        }],
        skills: [],
        metadata: { template: 'deep-researcher' },
      },
    },
    {
      id: 'template_structured_extractor',
      type: 'template',
      name: 'Structured extractor',
      description: 'Turns unstructured text into a typed JSON schema.',
      tags: ['data'],
      agent: {
        name: 'structured-extractor',
        model: defaultModelName,
        description: 'Parses unstructured text into a typed JSON schema.',
        system: 'Extract structured data exactly matching the requested schema. Return valid JSON and note uncertain fields.',
        tools: [{
          type: 'agent_toolset_20260401',
          default_config: {
            enabled: true,
            permission_policy: { type: 'always_allow' },
          },
          configs: [
            { name: 'read', enabled: true },
            { name: 'write', enabled: true },
          ],
        }],
        skills: [],
        metadata: { template: 'structured-extractor' },
      },
    },
    {
      id: 'template_field_monitor',
      type: 'template',
      name: 'Field monitor',
      description: 'Synthesizes assigned software updates into a weekly what-changed brief.',
      tags: ['monitoring', 'recurring'],
      agent: {
        name: 'Field monitor',
        model: defaultModelName,
        description: 'Synthesizes assigned software updates and connected knowledge-base material into a weekly what-changed brief.',
        system: 'You are a field monitor. Use the assigned workspace materials and connected knowledge sources to compare updates week over week, then write a concise brief with source references and impact notes.',
        mcp_servers: [
          { name: 'notion', type: 'url', url: 'https://mcp.notion.com/mcp' },
        ],
        tools: [
          { type: 'agent_toolset_20260401' },
          {
            type: 'mcp_toolset',
            mcp_server_name: 'notion',
            default_config: { permission_policy: { type: 'always_allow' } },
          },
        ],
        skills: [],
        metadata: { template: 'field-monitor' },
      },
    },
    {
      id: 'template_support_agent',
      type: 'template',
      name: 'Support agent',
      description: 'Answers questions from available documentation and escalates unresolved cases.',
      tags: ['support', 'documentation'],
      agent: {
        name: 'support-agent',
        model: defaultModelName,
        description: 'Answers customer questions from available workspace documentation and knowledge base materials, and escalates when needed.',
        system: 'You are a support agent. Use the available workspace documentation first, answer with clear steps, and escalate when confidence is low.',
        tools: [{
          type: 'agent_toolset_20260401',
          default_config: {
            enabled: true,
            permission_policy: { type: 'always_allow' },
          },
          configs: [
            { name: 'read', enabled: true },
            { name: 'grep', enabled: true },
          ],
        }],
        skills: [],
        metadata: { template: 'support-agent' },
      },
    },
    {
      id: 'template_incident_commander',
      type: 'template',
      name: 'Incident commander',
      description: 'Triages a Sentry alert, opens a Linear incident ticket, and runs the Slack war room.',
      tags: ['incident', 'sentry', 'linear', 'slack'],
      agent: {
        name: 'Incident commander',
        description: 'Triages a Sentry alert, opens a Linear incident ticket, and runs the Slack war room.',
        model: defaultModelName,
        system: `You are an on-call incident commander. When handed a Sentry issue ID or an error fingerprint:

1. Pull the full event payload, stack trace, release tag, and affected-user count from Sentry.
2. Use the connected GitHub service to find the top frame's file path and recent surrounding commits (last 72h).
3. Open a Linear incident ticket with severity, suspected blast radius, and your rollback recommendation.
4. Post a threaded status to the incident Slack channel: what broke, who's looking, ETA for next update.
5. Every 15 minutes, re-check Sentry event volume and update the thread until the user closes the incident.

Be decisive. If you're >70% confident it's a specific deploy, say so and recommend the revert.`,
        mcp_servers: [
          { name: 'sentry', type: 'url', url: 'https://mcp.sentry.dev/mcp' },
          { name: 'linear', type: 'url', url: 'https://mcp.linear.app/mcp' },
          { name: 'slack', type: 'url', url: 'https://mcp.slack.com/mcp' },
          { name: 'github', type: 'url', url: 'https://api.githubcopilot.com/mcp/' },
        ],
        tools: [
          { type: 'agent_toolset_20260401' },
          { type: 'mcp_toolset', mcp_server_name: 'sentry', default_config: { permission_policy: { type: 'always_allow' } } },
          { type: 'mcp_toolset', mcp_server_name: 'linear', default_config: { permission_policy: { type: 'always_allow' } } },
          { type: 'mcp_toolset', mcp_server_name: 'slack', default_config: { permission_policy: { type: 'always_allow' } } },
          { type: 'mcp_toolset', mcp_server_name: 'github', default_config: { permission_policy: { type: 'always_allow' } } },
        ],
        skills: [],
        metadata: { template: 'incident-commander' },
      },
    },
  ].map((template) => ({
    ...template,
    summary: `${template.agent.name} - ${getEnabledToolNames(template.agent as any).join(', ') || 'no tools'}`,
    skill_ids: getAgentSkillIds(template.agent as any),
  }));
}
