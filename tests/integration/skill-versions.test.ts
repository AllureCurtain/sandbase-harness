/**
 * Integration test: the published skill-version routes.
 *
 * A skill used to carry its version list as a JSON blob on the `skills` row —
 * a list that could name versions but never store a second package. This
 * suite pins the implemented surface:
 *
 *  - `POST /v1/skills/:id/versions` uploads a package in the same format as
 *    `POST /v1/skills`, stores it under the managed skills root, and repoints
 *    `latest_version`/`latest_version_id` at the new `skv_` id.
 *  - `GET .../versions` lists newest first with the `skill_version` shape;
 *    `GET .../versions/:v` retrieves one.
 *  - `GET .../versions/:v/content` returns a valid zip whose entries are
 *    rooted at the skill's name — proven by uploading it back.
 *  - `DELETE .../versions/:v` returns `skill_version_deleted`, repoints
 *    `latest` at the newest survivor, and refuses to remove the only
 *    remaining version with 409.
 *  - A package whose SKILL.md names a different skill is a 409, built-in
 *    skills answer version metadata read-only, and an unknown skill or
 *    version is a 404.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

const ROUTE = '/v1/skills';

describe('Skill version routes', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let dataDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    dataDir = undefined;
  });

  function setUp(): ReturnType<typeof createServer> {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-skill-versions-'));
    dataDir = join(tmpDir, '.managed-agents');
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    return createServer({
      db,
      sessionManager: new SessionManager(db),
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workspace: {
        root: tmpDir,
        dataDir,
        agentsDir: join(tmpDir, 'agents'),
        skillsDir: join(tmpDir, 'skills'),
        configPath: join(tmpDir, 'config.yaml'),
        target: 'local',
      },
      skills: [],
    });
  }

  async function send(
    server: ReturnType<typeof createServer>,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const res = await server.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as Record<string, any> : undefined };
  }

  function packageFiles(name: string, description: string, extra = true) {
    return {
      files: [
        {
          path: `${name}/SKILL.md`,
          content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description} body.\n`,
        },
        ...(extra ? [{ path: `${name}/refs/guide.txt`, content: `guide for ${description}` }] : []),
      ],
    };
  }

  async function createSkill(server: ReturnType<typeof createServer>, name = 'brand-voice') {
    const res = await send(server, 'POST', ROUTE, packageFiles(name, 'first upload'));
    expect(res.status).toBe(201);
    return res.body!;
  }

  async function uploadVersion(
    server: ReturnType<typeof createServer>,
    skillId: string,
    description = 'second upload',
    name = 'brand-voice',
  ) {
    return send(server, 'POST', `${ROUTE}/${skillId}/versions`, packageFiles(name, description));
  }

  it('creates a skill with a first version row and serves the published version shape', async () => {
    const server = setUp();
    const skill = await createSkill(server);
    expect(skill.latest_version).toMatch(/^skv_/);
    expect(skill.latest_version_id).toBe(skill.latest_version);

    const list = await send(server, 'GET', `${ROUTE}/${skill.id}/versions`);
    expect(list.status).toBe(200);
    expect(list.body!.data).toHaveLength(1);
    expect(list.body!.next_page).toBeNull();
    const version = list.body!.data[0];
    expect(Object.keys(version).sort()).toEqual(
      ['created_at', 'description', 'id', 'name', 'skill_id', 'type'].sort(),
    );
    expect(version).toMatchObject({
      id: skill.latest_version,
      type: 'skill_version',
      skill_id: skill.id,
      name: 'brand-voice',
      description: 'first upload',
    });

    const retrieved = await send(server, 'GET', `${ROUTE}/${skill.id}/versions/${version.id}`);
    expect(retrieved.status).toBe(200);
    expect(retrieved.body).toEqual(version);
  });

  it('uploads a new version, orders the list newest first, and repoints latest', async () => {
    const server = setUp();
    const skill = await createSkill(server);
    const created = await uploadVersion(server, skill.id);
    expect(created.status).toBe(201);
    expect(created.body!.type).toBe('skill_version');
    expect(created.body!.id).toMatch(/^skv_/);
    expect(created.body!.id).not.toBe(skill.latest_version);
    expect(created.body!.description).toBe('second upload');

    const list = await send(server, 'GET', `${ROUTE}/${skill.id}/versions`);
    expect(list.body!.data.map((row: any) => row.id)).toEqual([created.body!.id, skill.latest_version]);

    const current = await send(server, 'GET', `${ROUTE}/${skill.id}`);
    expect(current.body!.latest_version).toBe(created.body!.id);
    expect(current.body!.latest_version_id).toBe(created.body!.id);
    expect(current.body!.description).toBe('second upload');
    expect(current.body!.versions.map((v: any) => v.id)).toEqual([created.body!.id, skill.latest_version]);
    expect(current.body!.versions[0].latest).toBe(true);
    expect(current.body!.versions[1].latest).toBe(false);
  });

  it('downloads a version as a zip the upload path can re-ingest', async () => {
    const server = setUp();
    const skill = await createSkill(server);

    const res = await server.request(`${ROUTE}/${skill.id}/versions/${skill.latest_version}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const zip = Buffer.from(await res.arrayBuffer());
    // Local file header signature — the upload path reads the same format.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes('brand-voice/SKILL.md')).toBe(true);

    const roundTrip = await send(server, 'POST', `${ROUTE}/${skill.id}/versions`, {
      files: [{ path: 'download.zip', base64: zip.toString('base64') }],
    });
    expect(roundTrip.status).toBe(201);
    expect(roundTrip.body!.id).not.toBe(skill.latest_version);
  });

  it('serves the uploaded package files for the pinned version', async () => {
    const server = setUp();
    const skill = await createSkill(server);
    const created = await uploadVersion(server, skill.id);
    const versionDir = join(dataDir!, 'skills', skill.id, 'versions', created.body!.id);
    expect(readFileSync(join(versionDir, 'SKILL.md'), 'utf8')).toContain('second upload');
    expect(existsSync(join(versionDir, 'refs', 'guide.txt'))).toBe(true);
    // The first upload keeps its own directory at the skill root.
    expect(readFileSync(join(dataDir!, 'skills', skill.id, 'SKILL.md'), 'utf8')).toContain('first upload');
  });

  it('rejects a version whose SKILL.md names a different skill', async () => {
    const server = setUp();
    const skill = await createSkill(server);
    const res = await uploadVersion(server, skill.id, 'wrong name', 'other-name');
    expect(res.status).toBe(409);
    expect(res.body!.error.type).toBe('conflict');

    const list = await send(server, 'GET', `${ROUTE}/${skill.id}/versions`);
    expect(list.body!.data).toHaveLength(1);
  });

  it('deletes a non-latest version and keeps the latest pointer', async () => {
    const server = setUp();
    const skill = await createSkill(server);
    const created = await uploadVersion(server, skill.id);

    const deleted = await send(server, 'DELETE', `${ROUTE}/${skill.id}/versions/${skill.latest_version}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: skill.latest_version, type: 'skill_version_deleted' });

    const list = await send(server, 'GET', `${ROUTE}/${skill.id}/versions`);
    expect(list.body!.data.map((row: any) => row.id)).toEqual([created.body!.id]);
    const current = await send(server, 'GET', `${ROUTE}/${skill.id}`);
    expect(current.body!.latest_version).toBe(created.body!.id);
  });

  it('deleting the latest version repoints latest at the newest survivor', async () => {
    const server = setUp();
    const skill = await createSkill(server);
    const created = await uploadVersion(server, skill.id);

    const deleted = await send(server, 'DELETE', `${ROUTE}/${skill.id}/versions/${created.body!.id}`);
    expect(deleted.status).toBe(200);

    const current = await send(server, 'GET', `${ROUTE}/${skill.id}`);
    expect(current.body!.latest_version).toBe(skill.latest_version);
    // The skill's content fields return to the surviving package's SKILL.md.
    expect(current.body!.description).toBe('first upload');
    expect(current.body!.versions).toHaveLength(1);
    // The deleted version's directory is gone.
    expect(existsSync(join(dataDir!, 'skills', skill.id, 'versions', created.body!.id))).toBe(false);
  });

  it('refuses to delete the only remaining version', async () => {
    const server = setUp();
    const skill = await createSkill(server);
    const res = await send(server, 'DELETE', `${ROUTE}/${skill.id}/versions/${skill.latest_version}`);
    expect(res.status).toBe(409);
    expect(res.body!.error.type).toBe('conflict');
  });

  it('answers 404 for an unknown skill, an unknown version, and a version of another skill', async () => {
    const server = setUp();
    const skill = await createSkill(server, 'brand-voice');
    const other = await createSkill(server, 'other-skill');

    expect((await send(server, 'GET', `${ROUTE}/skill_nope/versions`)).status).toBe(404);
    expect((await send(server, 'GET', `${ROUTE}/${skill.id}/versions/skv_nope`)).status).toBe(404);
    expect((await send(server, 'DELETE', `${ROUTE}/${skill.id}/versions/skv_nope`)).status).toBe(404);
    // A real version addressed under the wrong skill is not found there.
    expect(
      (await send(server, 'GET', `${ROUTE}/${skill.id}/versions/${other.latest_version}`)).status,
    ).toBe(404);
  });

  it('serves built-in skill versions read-only and refuses writes', async () => {
    const server = setUp();
    const list = await send(server, 'GET', `${ROUTE}/xlsx/versions`);
    expect(list.status).toBe(200);
    expect(list.body!.data.length).toBeGreaterThan(1);
    expect(list.body!.data[0]).toMatchObject({ type: 'skill_version', skill_id: 'xlsx', name: 'xlsx' });

    const retrieved = await send(server, 'GET', `${ROUTE}/xlsx/versions/${list.body!.data[0].id}`);
    expect(retrieved.status).toBe(200);

    const uploaded = await send(server, 'POST', `${ROUTE}/xlsx/versions`, packageFiles('xlsx', 'nope'));
    expect(uploaded.status).toBe(400);
    const deleted = await send(server, 'DELETE', `${ROUTE}/xlsx/versions/${list.body!.data[0].id}`);
    expect(deleted.status).toBe(400);
    const content = await server.request(`${ROUTE}/xlsx/versions/${list.body!.data[0].id}/content`);
    expect(content.status).toBe(404);
  });

  it('keeps a deleted skill version queryable nowhere', async () => {
    const server = setUp();
    const skill = await createSkill(server);
    const created = await uploadVersion(server, skill.id);
    await send(server, 'DELETE', `${ROUTE}/${skill.id}/versions/${created.body!.id}`);

    expect((await send(server, 'GET', `${ROUTE}/${skill.id}/versions/${created.body!.id}`)).status).toBe(404);
    const content = await server.request(`${ROUTE}/${skill.id}/versions/${created.body!.id}/content`);
    expect(content.status).toBe(404);
  });
});
