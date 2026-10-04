/**
 * Unit test: `skillDirsFor` honours an agent skill reference's `version` pin.
 *
 * A reference without a version resolves the skill's latest package through
 * `skillsDir` as before. A pinned reference resolves the pinned version's
 * `storage_path` — and only while that path stays inside the managed skills
 * root, so a stale or foreign row cannot mount a directory the caller did
 * not ask for. A pin that resolves to nothing mounts nothing rather than
 * silently falling back to the latest package.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { EventLogger } from '@/core/session/event-logger.js';
import { ModelRegistry } from '@/model/registry.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { sandboxCapabilities, type SandboxProvider } from '@/types/sandbox.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { Skill } from '@/core/skills/loader.js';

describe('skill version pinning', () => {
  let directory: string | undefined;
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function makeExecutor(skills: Skill[], managedSkillsDir?: string) {
    directory = mkdtempSync(join(tmpdir(), 'ma-skill-pin-'));
    db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    const skillsDir = join(directory, 'skills');
    const managed = managedSkillsDir ?? join(directory, 'managed', 'skills');
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities(),
      async provision() {
        throw new Error('not exercised');
      },
    };
    const executor = new DefaultSessionExecutor({
      agents: [],
      modelRegistry: new ModelRegistry(),
      sandboxProvider: provider,
      strategy: new DefaultStrategy(),
      eventLogger: new EventLogger(db),
      skills,
      skillsDir,
      managedSkillsDir: managed,
    });
    const skillDirsFor = (agent: AgentDefinition) =>
      (executor as unknown as { skillDirsFor(a: AgentDefinition): string[] }).skillDirsFor(agent);
    return { skillDirsFor, skillsDir, managed };
  }

  function managedSkill(versions: Skill['versions'], latest: string): Skill {
    return {
      id: 'skill_voice',
      type: 'skill',
      name: 'brand-voice',
      display_title: 'brand-voice',
      description: 'd',
      compatibility: null,
      instructions: 'i',
      frontmatter: {},
      file: 'brand-voice/SKILL.md',
      source: 'custom',
      latest_version: latest,
      versions,
      created_at: null,
      updated_at: null,
    };
  }

  function agentWith(version?: string): AgentDefinition {
    return {
      name: 'a',
      model: 'm',
      skills: [{ type: 'custom', skill_id: 'skill_voice', ...(version ? { version } : {}) }],
    } as AgentDefinition;
  }

  it('resolves the pinned version directory inside the managed root', () => {
    const { skillDirsFor, managed } = makeExecutor([]);
    const v1Dir = join(managed, 'skill_voice');
    const v2Dir = join(managed, 'skill_voice', 'versions', 'skv_two');
    const skill = managedSkill([
      { id: 'skv_two', created_at: null, latest: true, storage_path: v2Dir },
      { id: 'skv_one', created_at: null, latest: false, storage_path: v1Dir },
    ], 'skv_two');
    const executor = makeExecutor([skill], managed);
    expect(executor.skillDirsFor(agentWith('skv_one'))).toEqual([v1Dir]);
    expect(executor.skillDirsFor(agentWith('skv_two'))).toEqual([v2Dir]);
    // Unpinned and explicit-latest references both take the latest package.
    expect(executor.skillDirsFor(agentWith())).toEqual([join(executor.skillsDir, 'brand-voice')]);
    expect(executor.skillDirsFor(agentWith('latest'))).toEqual([join(executor.skillsDir, 'brand-voice')]);
  });

  it('mounts nothing for a pin that names a deleted or unknown version', () => {
    const { skillDirsFor, managed } = makeExecutor([]);
    const skill = managedSkill([
      { id: 'skv_two', created_at: null, latest: true, storage_path: join(managed, 'skill_voice', 'versions', 'skv_two') },
    ], 'skv_two');
    const executor = makeExecutor([skill], managed);
    expect(executor.skillDirsFor(agentWith('skv_gone'))).toEqual([]);
  });

  it('refuses a stored path that escapes the managed root', () => {
    const { managed } = makeExecutor([]);
    const outside = join(directory!, '..', 'elsewhere');
    const skill = managedSkill([
      { id: 'skv_two', created_at: null, latest: true, storage_path: join(managed, 'x') },
      { id: 'skv_one', created_at: null, latest: false, storage_path: outside },
    ], 'skv_two');
    const executor = makeExecutor([skill], managed);
    expect(executor.skillDirsFor(agentWith('skv_one'))).toEqual([]);
  });

  it('falls back to skillsDir only when the pin names the latest unmanaged version', () => {
    // A seeded skill has a version row with no managed storage path; pinning
    // its only version is the same request as pinning latest.
    const skill = managedSkill([
      { id: '1700000000001', created_at: null, latest: true },
    ], '1700000000001');
    const { skillDirsFor, skillsDir } = makeExecutor([skill]);
    expect(skillDirsFor(agentWith('1700000000001'))).toEqual([join(skillsDir, 'brand-voice')]);
  });
});
