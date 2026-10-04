import type { Database } from '@/core/db/database.js';
import type { Skill, SkillVersion } from './loader.js';

type SkillRow = {
  id: string;
  name: string;
  display_title: string | null;
  description: string;
  instructions: string;
  frontmatter: string;
  file: string;
  source: 'custom' | 'anthropic';
  latest_version: string | null;
  versions: string;
  storage_path: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SkillVersionRow = {
  id: string;
  skill_id: string;
  seq: number;
  name: string;
  description: string;
  storage_path: string;
  created_at: string;
};

/** Durable version records for one skill, newest first. */
export function listSkillVersions(db: Database, skillId: string): SkillVersionRow[] {
  return db.prepare(`
    SELECT id, skill_id, seq, name, description, storage_path, created_at
    FROM skill_versions
    WHERE skill_id = ?
    ORDER BY seq DESC
  `).all(skillId) as unknown as SkillVersionRow[];
}

export function getSkillVersion(db: Database, skillId: string, versionId: string): SkillVersionRow | undefined {
  return db.prepare(`
    SELECT id, skill_id, seq, name, description, storage_path, created_at
    FROM skill_versions
    WHERE skill_id = ? AND id = ?
  `).get(skillId, versionId) as SkillVersionRow | undefined;
}

export function nextSkillVersionSeq(db: Database, skillId: string): number {
  const row = db.prepare('SELECT MAX(seq) AS seq FROM skill_versions WHERE skill_id = ?').get(skillId) as
    | { seq: number | null }
    | undefined;
  return (row?.seq ?? 0) + 1;
}

export function insertSkillVersion(db: Database, version: SkillVersionRow): void {
  db.prepare(`
    INSERT INTO skill_versions (id, skill_id, seq, name, description, storage_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.id,
    version.skill_id,
    version.seq,
    version.name,
    version.description,
    version.storage_path,
    version.created_at,
  );
}

export function deleteSkillVersion(db: Database, skillId: string, versionId: string): void {
  db.prepare('DELETE FROM skill_versions WHERE skill_id = ? AND id = ?').run(skillId, versionId);
}

/**
 * Rewrite the skill's cached version list and latest pointer after a version
 * upload or deletion. The `versions`/`latest_version` columns stay a
 * projection of the `skill_versions` table rather than a second record of
 * it, so every writer goes through this one update.
 */
export function updateSkillVersionCache(
  db: Database,
  skillId: string,
  patch: {
    latestVersion: string;
    versions: SkillVersion[];
    updatedAt: string;
    description?: string;
    instructions?: string;
    frontmatter?: string;
    file?: string;
  },
): void {
  db.prepare(`
    UPDATE skills
    SET latest_version = ?,
        versions = ?,
        description = COALESCE(?, description),
        instructions = COALESCE(?, instructions),
        frontmatter = COALESCE(?, frontmatter),
        file = COALESCE(?, file),
        updated_at = ?
    WHERE id = ?
  `).run(
    patch.latestVersion,
    JSON.stringify(patch.versions),
    patch.description ?? null,
    patch.instructions ?? null,
    patch.frontmatter ?? null,
    patch.file ?? null,
    patch.updatedAt,
    skillId,
  );
}

export function importSkillSeeds(db: Database, skills: Skill[]): void {
  for (const skill of skills) {
    const existing = db.prepare('SELECT id FROM skills WHERE id = ? OR (name = ? AND archived_at IS NULL)').get(
      skill.id,
      skill.name,
    );
    if (existing) continue;
    insertSkill(db, skill);
    // Seeded skills get a version row too so the version routes answer the
    // same way for every custom skill. Their package lives under the project
    // skills directory, not the managed storage root, hence no storage_path.
    insertSkillVersion(db, {
      id: skill.latest_version ?? `${skill.id}-v1`,
      skill_id: skill.id,
      seq: 1,
      name: skill.name,
      description: skill.description,
      storage_path: '',
      created_at: skill.created_at ?? new Date().toISOString(),
    });
  }
}

export function insertSkill(db: Database, skill: Skill, storagePath?: string | null): void {
  db.prepare(`
    INSERT INTO skills (
      id, name, display_title, description, instructions, frontmatter, file,
      source, latest_version, versions, storage_path, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    skill.id,
    skill.name,
    skill.display_title,
    skill.description,
    skill.instructions,
    JSON.stringify(skill.frontmatter ?? {}),
    skill.file,
    skill.source,
    skill.latest_version,
    JSON.stringify(skill.versions ?? []),
    storagePath ?? null,
    skill.created_at,
    skill.updated_at,
  );
}

export function loadCustomSkillsFromDb(db: Database): Skill[] {
  const rows = db.prepare(`
    SELECT *
    FROM skills
    WHERE archived_at IS NULL
      AND source = 'custom'
    ORDER BY updated_at DESC, created_at DESC, name ASC
  `).all() as unknown as SkillRow[];

  const versionMap = loadSkillVersionMap(db);
  return rows.map((row) => rowToSkill(row, versionMap.get(row.id)));
}

/**
 * Every stored version keyed by skill, loaded once rather than per skill row.
 * The `skill_versions` table is the version record of truth; a skill without
 * rows (imported before the table existed and never migrated) keeps its
 * `versions` JSON as the fallback.
 */
function loadSkillVersionMap(db: Database): Map<string, SkillVersionRow[]> {
  const rows = db.prepare(`
    SELECT id, skill_id, seq, name, description, storage_path, created_at
    FROM skill_versions
    ORDER BY skill_id, seq DESC
  `).all() as unknown as SkillVersionRow[];
  const map = new Map<string, SkillVersionRow[]>();
  for (const row of rows) {
    const list = map.get(row.skill_id);
    if (list) list.push(row);
    else map.set(row.skill_id, [row]);
  }
  return map;
}

export function getSkillStoragePath(db: Database, id: string): string | null {
  const row = db.prepare('SELECT storage_path FROM skills WHERE id = ?').get(id) as
    | { storage_path: string | null }
    | undefined;
  return row?.storage_path ?? null;
}

function rowToSkill(row: SkillRow, versionRows?: SkillVersionRow[]): Skill {
  const frontmatter = parseObject(row.frontmatter);
  return {
    id: row.id,
    type: 'skill',
    name: row.name,
    display_title: row.display_title,
    description: row.description,
    compatibility: compatibilityFromFrontmatter(frontmatter),
    instructions: row.instructions,
    frontmatter,
    file: row.file,
    source: row.source,
    latest_version: row.latest_version,
    versions: versionRows?.length
      ? versionRows.map((version) => ({
          id: version.id,
          created_at: version.created_at,
          latest: version.id === row.latest_version,
          ...(version.storage_path ? { storage_path: version.storage_path } : {}),
        }))
      : parseVersions(row.versions),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function compatibilityFromFrontmatter(frontmatter: Record<string, unknown>): string | null {
  const value = frontmatter.compatibility;
  return typeof value === 'string' && value.trim() && value.trim().length <= 500
    ? value.trim()
    : null;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseVersions(value: string): SkillVersion[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SkillVersion[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') return [];
      return [{
        id: record.id,
        created_at: typeof record.created_at === 'string' ? record.created_at : null,
        latest: record.latest === true,
      }];
    });
  } catch {
    return [];
  }
}
