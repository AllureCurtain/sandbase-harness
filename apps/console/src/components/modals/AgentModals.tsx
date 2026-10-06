import { type FormEvent, useMemo, useState } from 'react';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { Plus, Trash2 } from 'lucide-react';
import { postJson, putJson } from '../../api';
import { sendsModelConfig } from '../../lib/agentModelConfig';
import { validateAgentDraft } from '../../lib/agentVersionDiff';
import { useRuntimeCapabilities } from '../../useRuntimeCapabilities';
import { ConfigPreviewDrawer, DrawerToggle, type ConfigFormat } from '../ConfigDrawer';
import { CheckCard, FieldRow, KvRowEditor, RadioCardGroup, SectionCard, kvRowsFromObject, type CheckItem, type KvRow } from '../kit';
import { Modal } from '../Modal';
import type { Agent, AgentToolset, BuiltinToolset, ConsoleData, McpToolset, SkillRef, Template } from '../../types';

/**
 * Agent create/edit, rebuilt on the workflow register: the form is the primary
 * path, the rendered YAML/JSON lives in the collapsible drawer beside it, and
 * pasted configs parse back into the same fields — the two paths never fork.
 */

export type AgentDraft = {
  name: string;
  description?: string;
  model: string;
  model_config?: { id?: string; speed: string; effort?: string };
  system: string;
  mcp_servers?: Array<Record<string, unknown>>;
  tools?: AgentToolset[];
  skills?: SkillRef[];
  metadata?: Record<string, unknown>;
};

type McpRow = { id: string; name: string; url: string; rest: Record<string, unknown>; origName: string };

const BUILTIN_NAMES = ['bash', 'edit', 'read', 'write', 'glob', 'grep', 'web_fetch', 'web_search'] as const;
const SPEED_OPTIONS = ['standard', 'fast', 'extended'] as const;
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMISSION_OPTIONS = [
  { value: 'always_ask', label: 'Ask each time' },
  { value: 'always_allow', label: 'Always allow' },
  { value: 'never_allow', label: 'Never allow' },
] as const;

let mcpRowSeq = 0;

function mcpRowsFromDraft(draft: AgentDraft): McpRow[] {
  return (draft.mcp_servers ?? []).map((server) => ({
    id: `mcp_${++mcpRowSeq}`,
    name: typeof server?.name === 'string' ? server.name : '',
    url: typeof server?.url === 'string' ? server.url : '',
    rest: Object.fromEntries(Object.entries(server ?? {}).filter(([key]) => key !== 'name' && key !== 'url')),
    origName: typeof server?.name === 'string' ? server.name : '',
  }));
}

function builtinToolsetOf(tools: AgentToolset[] | undefined): BuiltinToolset | undefined {
  return tools?.find((toolset): toolset is BuiltinToolset => toolset.type === 'agent_toolset_20260401');
}

/** Serialize the form state into the definition the API expects. */
export function agentDefinitionObject(
  draft: AgentDraft,
  mcpRows: McpRow[],
  metadataRows: KvRow[],
): Record<string, unknown> {
  const { name, description, model, model_config, system, mcp_servers, tools, skills, metadata, ...extras } = draft as AgentDraft & Record<string, unknown>;

  const toolsets: AgentToolset[] = [];
  const builtin = builtinToolsetOf(tools);
  if (builtin) toolsets.push(builtin);
  const existingMcpToolsets = (tools ?? []).filter((toolset): toolset is McpToolset => toolset.type === 'mcp_toolset');
  for (const row of mcpRows) {
    const existing = existingMcpToolsets.find(
      (toolset) => toolset.mcp_server_name === row.origName || toolset.mcp_server_name === row.name,
    );
    toolsets.push({ ...(existing ?? { type: 'mcp_toolset', mcp_server_name: '' }), type: 'mcp_toolset', mcp_server_name: row.name });
  }

  const metadataObj: Record<string, string> = {};
  for (const row of metadataRows) {
    if (row.key.trim()) metadataObj[row.key.trim()] = row.value;
  }

  return {
    ...extras,
    name,
    ...(description ? { description } : {}),
    model,
    ...(sendsModelConfig(model_config) ? { model_config } : {}),
    system,
    mcp_servers: mcpRows.map((row) => ({ ...row.rest, name: row.name, url: row.url })),
    tools: toolsets.length ? toolsets : [{ type: 'agent_toolset_20260401' }],
    skills: skills ?? [],
    metadata: metadataObj,
  };
}

/** The form column shared by the create and edit modals. */
function AgentDefinitionForm({
  draft,
  setDraft,
  mcpRows,
  setMcpRows,
  metadataRows,
  setMetadataRows,
  data,
  idPrefix,
}: {
  draft: AgentDraft;
  setDraft: (draft: AgentDraft) => void;
  mcpRows: McpRow[];
  setMcpRows: (rows: McpRow[]) => void;
  metadataRows: KvRow[];
  setMetadataRows: (rows: KvRow[]) => void;
  data: ConsoleData;
  idPrefix: string;
}) {
  const { capabilities } = useRuntimeCapabilities();
  const builtin = builtinToolsetOf(draft.tools);
  const builtinConfigs = builtin?.configs ?? {};

  const toolNames = useMemo(() => {
    const names = new Set<string>(BUILTIN_NAMES);
    for (const capability of capabilities) names.add(capability.id);
    for (const name of Object.keys(builtinConfigs)) names.add(name);
    return [...names];
  }, [capabilities, builtinConfigs]);

  const capabilityById = useMemo(() => new Map(capabilities.map((capability) => [capability.id, capability])), [capabilities]);

  const patchBuiltin = (patch: Partial<BuiltinToolset>) => {
    const next: BuiltinToolset = { ...(builtin ?? { type: 'agent_toolset_20260401' }), ...patch };
    const others = (draft.tools ?? []).filter((toolset) => toolset.type !== 'agent_toolset_20260401');
    setDraft({ ...draft, tools: [next, ...others] });
  };

  const toggleTool = (name: string) => {
    const configs = { ...builtinConfigs };
    if (configs[name]?.enabled === false) {
      delete configs[name];
    } else {
      configs[name] = { ...(configs[name] ?? {}), enabled: false };
    }
    patchBuiltin({ configs: Object.keys(configs).length ? configs : undefined });
  };

  const setDefaultPermission = (value: string) => {
    const nextDefault = { ...(builtin?.default_config ?? {}) };
    if (value === 'always_ask') {
      delete nextDefault.permission_policy;
    } else {
      nextDefault.permission_policy = { type: value as 'always_allow' | 'never_allow' };
    }
    patchBuiltin({ default_config: Object.keys(nextDefault).length ? nextDefault : undefined });
  };

  const patchMcpRow = (id: string, patch: Partial<McpRow>) =>
    setMcpRows(mcpRows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const skillIds = new Set((draft.skills ?? []).map((skill) => skill.skill_id));
  const toggleSkill = (skill_id: string, source: 'custom' | 'anthropic') => {
    if (skillIds.has(skill_id)) {
      setDraft({ ...draft, skills: (draft.skills ?? []).filter((skill) => skill.skill_id !== skill_id) });
    } else {
      setDraft({ ...draft, skills: [...(draft.skills ?? []), { type: source, skill_id }] });
    }
  };
  const listedSkillIds = new Set(data.skills.map((skill) => skill.id));
  const extraSkillRefs = (draft.skills ?? []).filter((skill) => !listedSkillIds.has(skill.skill_id));

  const model = data.runtime?.models.find((item) => item.name === draft.model);

  return (
    <>
      <SectionCard n={2} title="Basics">
        <FieldRow label="Name" required error={draft.name.trim() ? undefined : 'A name is required.'}>
          <input
            id={`${idPrefix}-name`}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="research-assistant"
          />
        </FieldRow>
        <FieldRow label="Description" optional="optional">
          <input
            value={draft.description ?? ''}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            placeholder="What this agent is for"
          />
        </FieldRow>
        <div className="fieldGrid">
          <FieldRow
            label="Model"
            required
            error={draft.model.trim() ? undefined : 'Pick a model.'}
            helper={model?.api_key_state === 'missing_env' ? 'This model’s API key is not configured — runs will fail until it is.' : undefined}
          >
            <select
              id={`${idPrefix}-model`}
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            >
              {!model ? <option value={draft.model}>{draft.model || 'Select a model'}</option> : null}
              {(data.runtime?.models ?? []).map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}{item.api_key_state === 'missing_env' ? ' — no API key' : ''}{item.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="Speed" optional="model profile">
            <select
              value={draft.model_config?.speed ?? 'standard'}
              onChange={(event) => setDraft({ ...draft, model_config: { ...(draft.model_config ?? {}), speed: event.target.value } })}
            >
              {SPEED_OPTIONS.map((speed) => <option key={speed} value={speed}>{speed}</option>)}
            </select>
          </FieldRow>
          <FieldRow label="Reasoning effort" optional="model profile">
            <select
              value={draft.model_config?.effort ?? ''}
              onChange={(event) => {
                const next = { ...(draft.model_config ?? { speed: 'standard' }) };
                if (event.target.value) next.effort = event.target.value;
                else delete next.effort;
                setDraft({ ...draft, model_config: next });
              }}
            >
              <option value="">Not set</option>
              {EFFORT_OPTIONS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </FieldRow>
        </div>
        <FieldRow label="System prompt" required error={draft.system.trim() ? undefined : 'The agent needs instructions.'}>
          <textarea
            id={`${idPrefix}-system`}
            value={draft.system}
            onChange={(event) => setDraft({ ...draft, system: event.target.value })}
            placeholder="You are a general-purpose agent that…"
          />
        </FieldRow>
      </SectionCard>

      <SectionCard n={3} title="Tools" hint="Built-in tools the agent may call. Disabled tools are written as enabled: false.">
        <div className="toolChipGrid" role="group" aria-label="Built-in tools">
          {toolNames.map((name) => {
            const enabled = builtinConfigs[name]?.enabled !== false;
            const capability = capabilityById.get(name);
            const unavailable = capability?.status === 'unavailable';
            return (
              <button
                key={name}
                type="button"
                className={`toolChip${enabled ? ' selected' : ''}`}
                disabled={unavailable}
                title={unavailable ? capability?.reason ?? 'Unavailable on this runtime' : undefined}
                onClick={() => toggleTool(name)}
              >
                {name}
                {unavailable ? <small>unavailable</small> : null}
              </button>
            );
          })}
        </div>
        <FieldRow label="Default permission" helper="Applied to tools without their own policy. Per-tool policies can still be set in the YAML view.">
          <select
            value={builtin?.default_config?.permission_policy?.type ?? 'always_ask'}
            onChange={(event) => setDefaultPermission(event.target.value)}
          >
            {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </FieldRow>
      </SectionCard>

      <SectionCard n={4} title="Integrations">
        <FieldRow label="MCP servers" optional="remote tool servers" helper="Each server also grants an mcp_toolset entry so its tools are reachable.">
          <div className="kvEditor">
            {mcpRows.map((row) => (
              <div className="kvEditorRow" key={row.id}>
                <input
                  value={row.name}
                  placeholder="server name"
                  onChange={(event) => patchMcpRow(row.id, { name: event.target.value })}
                />
                <input
                  className="monoInput"
                  value={row.url}
                  placeholder="https://mcp.example.com"
                  onChange={(event) => patchMcpRow(row.id, { url: event.target.value })}
                />
                <button className="iconButton quiet" type="button" aria-label="Remove server"
                  onClick={() => setMcpRows(mcpRows.filter((candidate) => candidate.id !== row.id))}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <button className="addRowButton" type="button"
              onClick={() => setMcpRows([...mcpRows, { id: `mcp_${++mcpRowSeq}`, name: '', url: '', rest: {}, origName: '' }])}>
              <Plus size={13} /> Add MCP server
            </button>
          </div>
        </FieldRow>
        <FieldRow label="Skills" optional={`${skillIds.size} selected`}>
          <div className="toolChipGrid" role="group" aria-label="Skills">
            {data.skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className={`toolChip${skillIds.has(skill.id) ? ' selected' : ''}`}
                title={skill.description || skill.id}
                onClick={() => toggleSkill(skill.id, skill.source)}
              >
                {skill.name}
                {skill.source === 'anthropic' ? <small>anthropic</small> : null}
              </button>
            ))}
            {extraSkillRefs.map((skill) => (
              <button
                key={skill.skill_id}
                type="button"
                className="toolChip selected"
                title="Referenced skill not in the local library — click to remove"
                onClick={() => toggleSkill(skill.skill_id, skill.type)}
              >
                {skill.skill_id}
              </button>
            ))}
            {!data.skills.length && !extraSkillRefs.length ? <span className="fieldHelper">No skills in the library yet.</span> : null}
          </div>
        </FieldRow>
        <details className="advancedFold">
          <summary>Metadata</summary>
          <KvRowEditor rows={metadataRows} onChange={setMetadataRows} addLabel="Add metadata" />
        </details>
      </SectionCard>
    </>
  );
}

function useAgentDraftChecks(draft: AgentDraft, mcpRows: McpRow[], metadataRows: KvRow[], idPrefix: string): CheckItem[] {
  return useMemo(() => {
    const duplicateKeys = new Set<string>();
    const seen = new Set<string>();
    for (const row of metadataRows) {
      if (row.key.trim() && seen.has(row.key.trim())) duplicateKeys.add(row.key.trim());
      seen.add(row.key.trim());
    }
    const emptyMcp = mcpRows.filter((row) => !row.name.trim() || !row.url.trim());
    const items: CheckItem[] = [
      { label: 'Name', value: draft.name.trim() || 'missing', state: draft.name.trim() ? 'ok' : 'blocking', targetId: `${idPrefix}-name` },
      { label: 'Model', value: draft.model.trim() || 'missing', state: draft.model.trim() ? 'ok' : 'blocking', targetId: `${idPrefix}-model` },
      { label: 'System prompt', value: draft.system.trim() ? `${draft.system.trim().length} chars` : 'missing', state: draft.system.trim() ? 'ok' : 'blocking', targetId: `${idPrefix}-system` },
      { label: 'MCP servers', value: `${mcpRows.length}`, state: emptyMcp.length ? 'blocking' : 'ok', },
      { label: 'Metadata', value: duplicateKeys.size ? `duplicate keys: ${[...duplicateKeys].join(', ')}` : `${metadataRows.filter((row) => row.key.trim()).length} entries`, state: duplicateKeys.size ? 'blocking' : 'ok' },
    ];
    return items;
  }, [draft, mcpRows, metadataRows, idPrefix]);
}

function serializeDraft(value: unknown, format: ConfigFormat): string {
  return format === 'json'
    ? `${JSON.stringify(value, null, 2)}\n`
    : stringifyYaml(value, { blockQuote: 'literal', lineWidth: 100 });
}

function parseDraftText(text: string): AgentDraft {
  // YAML is a superset of JSON, so one parser covers both paste formats.
  const parsed = parseYaml(text);
  const issues = validateAgentDraft(parsed);
  if (issues.length) throw new Error(issues.join(' '));
  return parsed as AgentDraft;
}

/** The preview drawer earns its space only when the modal can show both columns. */
const drawerFitsViewport = () => typeof window === 'undefined' || window.matchMedia('(min-width: 1020px)').matches;

export function AgentModal({ template, data, onClose, onSaved }: { template?: Template; data: ConsoleData; onClose: () => void; onSaved: () => void }) {
  const initialTemplate = template ?? data.templates[0];
  const [draft, setDraft] = useState<AgentDraft>(() => (initialTemplate?.agent as AgentDraft) ?? defaultAgentDraft(data));
  const [selected, setSelected] = useState<Template | undefined>(initialTemplate);
  const [mcpRows, setMcpRows] = useState<McpRow[]>(() => mcpRowsFromDraft((initialTemplate?.agent as AgentDraft) ?? defaultAgentDraft(data)));
  const [metadataRows, setMetadataRows] = useState<KvRow[]>(() => kvRowsFromObject((initialTemplate?.agent?.metadata as Record<string, unknown>) ?? {}));
  const [format, setFormat] = useState<ConfigFormat>('yaml');
  const [drawerOpen, setDrawerOpen] = useState(drawerFitsViewport);
  const [parseError, setParseError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const chooseTemplate = (id: string) => {
    const next = data.templates.find((item) => item.id === id);
    if (!next) return;
    setSelected(next);
    const agent = next.agent as AgentDraft;
    setDraft(agent);
    setMcpRows(mcpRowsFromDraft(agent));
    setMetadataRows(kvRowsFromObject(agent.metadata));
    setParseError('');
  };

  const definition = useMemo(() => agentDefinitionObject(draft, mcpRows, metadataRows), [draft, mcpRows, metadataRows]);
  const previewText = useMemo(() => serializeDraft(definition, format), [definition, format]);
  const checks = useAgentDraftChecks(draft, mcpRows, metadataRows, 'create-agent');
  const issues = useMemo(() => validateAgentDraft(definition), [definition]);
  const blocked = checks.some((item) => item.state === 'blocking') || issues.length > 0;

  const fillFromPaste = (text: string) => {
    try {
      const parsed = parseDraftText(text);
      setDraft(parsed);
      setMcpRows(mcpRowsFromDraft(parsed));
      setMetadataRows(kvRowsFromObject(parsed.metadata));
      setParseError('');
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await postJson('/v1/agents', definition);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Create agent" subtitle="Fill the form — the config preview stays in sync." onClose={onClose} size="workflow">
      <form className="modalWorkflow" onSubmit={submit}>
        <div className="modalSplit">
          <div className="modalFormCol">
            {error ? <div className="banner error inlineBanner">{error}</div> : null}
            <SectionCard n={1} title="Starting point" hint="Picking a template replaces the whole draft below.">
              <RadioCardGroup
                value={selected?.id ?? ''}
                onChange={chooseTemplate}
                options={data.templates.map((item) => ({
                  value: item.id,
                  title: item.name,
                  body: item.description,
                  consequence: item.tags.length ? item.tags.slice(0, 4).join(' · ') : undefined,
                }))}
              />
            </SectionCard>
            <AgentDefinitionForm
              draft={draft}
              setDraft={setDraft}
              mcpRows={mcpRows}
              setMcpRows={setMcpRows}
              metadataRows={metadataRows}
              setMetadataRows={setMetadataRows}
              data={data}
              idPrefix="create-agent"
            />
            <SectionCard n={5} title="Before you create">
              <CheckCard items={checks} />
            </SectionCard>
          </div>
          {drawerOpen ? (
            <ConfigPreviewDrawer
              text={previewText}
              format={format}
              onFormat={setFormat}
              request={blocked ? null : { method: 'POST', path: '/v1/agents', body: definition }}
              onParse={fillFromPaste}
              parseError={parseError}
              onCollapse={() => setDrawerOpen(false)}
            />
          ) : null}
        </div>
        <div className="modalActionsBar">
          <DrawerToggle open={drawerOpen} onToggle={() => setDrawerOpen(!drawerOpen)} />
          <span className="spacer" />
          <button className="secondaryButton" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="primaryButton"
            type="submit"
            disabled={saving || blocked}
            title={blocked ? 'Fix the items marked in the pre-submit check first' : undefined}
          >
            {saving ? 'Creating…' : 'Create agent'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AgentEditModal({ agent, initialDraft, data, onClose, onSaved }: { agent: Agent; initialDraft?: Agent; data: ConsoleData; onClose: () => void; onSaved: () => void }) {
  const source = agentDraftFromApi(initialDraft ?? agent);
  const [draft, setDraft] = useState<AgentDraft>(source);
  const [mcpRows, setMcpRows] = useState<McpRow[]>(() => mcpRowsFromDraft(source));
  const [metadataRows, setMetadataRows] = useState<KvRow[]>(() => kvRowsFromObject(source.metadata));
  const [format, setFormat] = useState<ConfigFormat>('yaml');
  const [drawerOpen, setDrawerOpen] = useState(drawerFitsViewport);
  const [parseError, setParseError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const definition = useMemo(() => agentDefinitionObject(draft, mcpRows, metadataRows), [draft, mcpRows, metadataRows]);
  const previewText = useMemo(() => serializeDraft(definition, format), [definition, format]);
  const checks = useAgentDraftChecks(draft, mcpRows, metadataRows, 'edit-agent');
  const issues = useMemo(() => validateAgentDraft(definition), [definition]);
  const blocked = checks.some((item) => item.state === 'blocking') || issues.length > 0;

  const fillFromPaste = (text: string) => {
    try {
      const parsed = parseDraftText(text);
      setDraft(parsed);
      setMcpRows(mcpRowsFromDraft(parsed));
      setMetadataRows(kvRowsFromObject(parsed.metadata));
      setParseError('');
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await putJson(`/v1/agents/${agent.id}`, definition);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Edit agent"
      subtitle={initialDraft ? `Draft restored from v${initialDraft.version} — saving records it as a new version.` : `Saving creates version ${agent.version + 1}.`}
      onClose={onClose}
      size="workflow"
    >
      <form className="modalWorkflow" onSubmit={submit}>
        <div className="modalSplit">
          <div className="modalFormCol">
            {error ? <div className="banner error inlineBanner">{error}</div> : null}
            <AgentDefinitionForm
              draft={draft}
              setDraft={setDraft}
              mcpRows={mcpRows}
              setMcpRows={setMcpRows}
              metadataRows={metadataRows}
              setMetadataRows={setMetadataRows}
              data={data}
              idPrefix="edit-agent"
            />
            <CheckCard items={checks} />
          </div>
          {drawerOpen ? (
            <ConfigPreviewDrawer
              text={previewText}
              format={format}
              onFormat={setFormat}
              request={blocked ? null : { method: 'PUT', path: `/v1/agents/${agent.id}`, body: definition }}
              onParse={fillFromPaste}
              parseError={parseError}
              onCollapse={() => setDrawerOpen(false)}
            />
          ) : null}
        </div>
        <div className="modalActionsBar">
          <DrawerToggle open={drawerOpen} onToggle={() => setDrawerOpen(!drawerOpen)} />
          <span className="spacer" />
          <button className="secondaryButton" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="primaryButton"
            type="submit"
            disabled={saving || blocked}
            title={blocked ? 'Fix the items marked in the pre-submit check first' : undefined}
          >
            {saving ? 'Saving…' : 'Save new version'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function defaultAgentDraft(data: ConsoleData): AgentDraft {
  return {
    name: 'Untitled agent',
    description: 'A blank starting point with the core toolset.',
    model: data.runtime?.models[0]?.name ?? '',
    system: "You are a general-purpose agent that can research, write code, run commands, and use connected tools to complete the user's task end to end.",
    mcp_servers: [],
    tools: [{ type: 'agent_toolset_20260401' }],
    skills: [],
    metadata: {},
  };
}

function agentDraftFromApi(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    model: agent.model,
    model_config: agent.model_config,
    description: agent.description,
    system: agent.system,
    mcp_servers: agent.mcp_servers,
    tools: agent.tools,
    skills: agent.skills,
    metadata: agent.metadata ?? {},
  };
}
