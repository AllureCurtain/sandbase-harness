import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('official SDK skill versions', () => {
  it('runs create → version upload → list → retrieve → download → delete over HTTP', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      // The skills beta gates the resource family on the published API, and the
      // managed-agents beta is what this runtime's admission layer requires —
      // a caller that speaks to both sends both.
      const betas = ['managed-agents-2026-04-01', 'skills-2025-10-02'];
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });

      const skill = await client.beta.skills.create({
        betas,
        files: [
          new File(
            ['---\nname: sdk-skill\ndescription: first version\n---\n\nFirst instructions.\n'],
            'sdk-skill/SKILL.md',
          ),
        ],
      });
      expect(skill.type).toBe('skill');
      expect(skill.latest_version_id).toBeTruthy();

      const version = await client.beta.skills.versions.create(skill.id, {
        betas,
        files: [
          new File(
            ['---\nname: sdk-skill\ndescription: second version\n---\n\nSecond instructions.\n'],
            'sdk-skill/SKILL.md',
          ),
        ],
      });
      expect(version.type).toBe('skill_version');
      expect(version.skill_id).toBe(skill.id);
      expect(version.name).toBe('sdk-skill');
      expect(version.description).toBe('second version');

      const page = await client.beta.skills.versions.list(skill.id, { betas });
      expect(page.data.map((row) => row.id)).toEqual([version.id, skill.latest_version_id]);
      expect(page.data[0].type).toBe('skill_version');

      const retrieved = await client.beta.skills.versions.retrieve(version.id, { skill_id: skill.id, betas });
      expect(retrieved.id).toBe(version.id);
      expect(retrieved.skill_id).toBe(skill.id);

      const response = await client.beta.skills.versions.download(version.id, { skill_id: skill.id, betas });
      const zip = Buffer.from(await response.arrayBuffer());
      // A real zip archive: the local file header signature, with entries
      // rooted at the skill's name.
      expect(zip.readUInt32LE(0)).toBe(0x04034b50);
      expect(zip.includes('sdk-skill/SKILL.md')).toBe(true);

      const deleted = await client.beta.skills.versions.delete(version.id, { skill_id: skill.id, betas });
      expect(deleted).toEqual({ id: version.id, type: 'skill_version_deleted' });
      await expect(
        client.beta.skills.versions.retrieve(version.id, { skill_id: skill.id, betas }),
      ).rejects.toBeInstanceOf(Anthropic.NotFoundError);

      // The survivor is now the only version, and the only version cannot be
      // removed — a skill holds at least one.
      const onlyConflict = await client.beta.skills.versions
        .delete(skill.latest_version_id, { skill_id: skill.id, betas })
        .then(() => null, (error: unknown) => error);
      expect(onlyConflict).toBeInstanceOf(Anthropic.ConflictError);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
