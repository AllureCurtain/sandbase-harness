import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { loadRuntimeAgentSkillState, reloadRuntimeAgents } from '@/core/runtime/agent-skill-bootstrap.js';
import type { AgentDefinition } from '@/types/agent.js';

describe('runtime agent/skill bootstrap', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function makeWorkspace() {
    const directory = mkdtempSync(join(tmpdir(), 'ma-agent-skill-bootstrap-'));
    directories.push(directory);
    const agentsDir = join(directory, 'agents');
    const skillsDir = join(directory, 'skills');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    return { db, directory, agentsDir, skillsDir };
  }

  function writeSkill(skillsDir: string, packageName: string, name = packageName) {
    const skillDir = join(skillsDir, packageName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        'description: Use the project research workflow.',
        '---',
        '',
        'Follow the research workflow.',
        '',
      ].join('\n'),
    );
  }

  it('loads YAML agents and custom skills into SQLite and warns only for unknown skill references', () => {
    const { db, agentsDir, skillsDir } = makeWorkspace();
    writeSkill(skillsDir, 'research');
    writeFileSync(
      join(agentsDir, 'assistant.yaml'),
      [
        'name: assistant',
        'model: gpt-4o',
        'system: You are helpful.',
        'skills:',
        '  - type: custom',
        '    skill_id: research',
        '  - type: custom',
        '    skill_id: pdf',
        '  - type: custom',
        '    skill_id: missing-skill',
        '',
      ].join('\n'),
    );
    const errors: string[] = [];

    const state = loadRuntimeAgentSkillState({
      db,
      agentsDir,
      skillsDir,
      writeError: (message) => errors.push(message),
    });

    expect(state.agentLoadErrors).toEqual([]);
    expect(state.agentSeedErrors).toEqual([]);
    expect(state.skillLoadErrors).toEqual([]);
    expect(state.agents.map((agent) => agent.name)).toEqual(['assistant']);
    expect(state.skills.map((skill) => skill.name)).toEqual(['research']);
    expect(errors).toEqual([
      '[SKILL_REF] agent "assistant" references unknown skill "missing-skill" (ignored)',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agents').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM skills').get()).toEqual({ count: 1 });
    db.close();
  });

  it('resolves a seed roster against the batch and stores the pinned form', () => {
    const { db, agentsDir, skillsDir } = makeWorkspace();
    // The coordinator names a member whose file comes later in the listing —
    // resolution cannot depend on file order — plus `self`.
    writeFileSync(
      join(agentsDir, 'coordinator.yaml'),
      [
        'name: coordinator',
        'model: gpt-4o',
        'system: Coordinate the thread.',
        'multiagent:',
        '  type: coordinator',
        '  agents:',
        '    - type: self',
        '    - agent_worker',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(agentsDir, 'worker.yaml'),
      [
        'name: worker',
        'model: gpt-4o',
        'system: Do the work.',
        '',
      ].join('\n'),
    );

    const state = loadRuntimeAgentSkillState({ db, agentsDir, skillsDir, writeError: () => undefined });

    expect(state.agentSeedErrors).toEqual([]);
    const stored = db
      .prepare(`SELECT definition FROM agents WHERE id = 'agent_coordinator'`)
      .get() as { definition: string };
    const roster = (JSON.parse(stored.definition) as AgentDefinition).multiagent;
    expect(roster).toEqual({
      type: 'coordinator',
      agents: [
        { type: 'agent', id: 'agent_coordinator', version: 1 },
        { type: 'agent', id: 'agent_worker', version: 1 },
      ],
    });
    db.close();
  });

  it('fails a seed whose roster member exists nowhere, rather than storing it unresolved', () => {
    const { db, agentsDir, skillsDir } = makeWorkspace();
    writeFileSync(
      join(agentsDir, 'coordinator.yaml'),
      [
        'name: coordinator',
        'model: gpt-4o',
        'system: Coordinate the thread.',
        'multiagent:',
        '  type: coordinator',
        '  agents:',
        '    - agent_ghost',
        '',
      ].join('\n'),
    );
    const errors: string[] = [];

    const state = loadRuntimeAgentSkillState({
      db,
      agentsDir,
      skillsDir,
      writeError: (message) => errors.push(message),
    });

    expect(state.agentSeedErrors).toHaveLength(1);
    expect(state.agentSeedErrors[0]?.field).toBe('multiagent.agents[0]');
    expect(errors).toEqual([
      '[AGENT_SEED] coordinator - Invalid seeded agent definition (field: multiagent.agents[0])',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agents').get()).toEqual({ count: 0 });
    db.close();
  });

  it('reloads file-backed agents into the active runtime array', () => {
    const { db, agentsDir, skillsDir } = makeWorkspace();
    writeSkill(skillsDir, 'research');
    writeFileSync(
      join(agentsDir, 'assistant.yaml'),
      [
        'name: assistant',
        'model: gpt-4o',
        'system: You are helpful.',
        '',
      ].join('\n'),
    );
    const initialState = loadRuntimeAgentSkillState({
      db,
      agentsDir,
      skillsDir,
      writeError: () => undefined,
    });
    const runtimeAgents: AgentDefinition[] = [...initialState.agents];
    writeFileSync(
      join(agentsDir, 'reviewer.yaml'),
      [
        'name: reviewer',
        'model: gpt-4o',
        'system: Review code.',
        '',
      ].join('\n'),
    );

    const result = reloadRuntimeAgents({ db, agentsDir, agents: runtimeAgents });

    expect(result.errors).toEqual([]);
    expect(result.agents.map((agent) => agent.name)).toEqual(['assistant', 'reviewer']);
    expect(runtimeAgents.map((agent) => agent.name)).toEqual(['assistant', 'reviewer']);
    db.close();
  });
});
