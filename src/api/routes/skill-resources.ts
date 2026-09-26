import type { ServerDeps } from '../server.js';
import { offsetCursorPage, type ApiCursorPage } from '../standard.js';
import { BUILTIN_SKILLS } from '@/core/skills/catalog.js';
import { createSkillId, type Skill } from '@/core/skills/loader.js';

export type SkillSourceFilter = 'custom' | 'anthropic';

export function listSkillResources(deps: ServerDeps, source?: SkillSourceFilter): Skill[] {
  const customSkills = [...(deps.skills ?? [])].sort(compareSkillsByUpdatedAtDesc);
  const skills = [...customSkills, ...BUILTIN_SKILLS];
  return source ? skills.filter((skill) => skill.source === source) : skills;
}

export function skillResource(skill: Skill) {
  return {
    id: skill.id,
    created_at: skill.created_at,
    display_title: skill.display_title,
    latest_version: skill.latest_version,
    source: skill.source,
    type: skill.type,
    updated_at: skill.updated_at,
    name: skill.name,
    description: skill.description,
    compatibility: skill.compatibility,
    file: skill.file || null,
    versions: skill.versions,
  };
}

/**
 * One canonical page of the skills listing.
 *
 * The window is an offset, so the cursor carries that offset **and** the filter
 * that produced it: replaying a cursor under a different `source` would otherwise
 * address a page that never existed for that filter. A malformed cursor is refused
 * rather than read as "page one", because silently starting over is how a client
 * loops across the same window.
 *
 * This replaces a response that carried the local `has_more` / `first_id` /
 * `last_id` fields *and* a `next_page` cursor at once, which let two clients
 * paginate by two different rules from the same body.
 */
export function skillPage(
  skills: Skill[],
  options: { limit?: string; page?: string; source?: SkillSourceFilter },
): { ok: true; page: ApiCursorPage<ReturnType<typeof skillResource>> } | { ok: false; message: string } {
  // The window semantics live in one place; this listing is filtered by source, so the filter travels
  // inside the cursor and a cursor cannot be replayed under a different one.
  return offsetCursorPage(skills.map(skillResource), {
    limit: options.limit,
    page: options.page,
    filter: { source: options.source },
  });
}

export function findSkill(deps: ServerDeps, id: string): Skill | undefined {
  return listSkillResources(deps).find((skill) => skill.id === id);
}

export function createUniqueSkillId(existingSkills: Skill[]): string {
  let id = createSkillId();
  while (existingSkills.some((skill) => skill.id === id)) {
    id = createSkillId();
  }
  return id;
}

export function materializeCustomSkill(skill: Skill, displayTitle?: string): Skill {
  const now = new Date().toISOString();
  const version = String(Date.now());
  return {
    ...skill,
    display_title: displayTitle?.trim() || skill.display_title || skill.name,
    created_at: now,
    updated_at: now,
    latest_version: version,
    versions: [{ id: version, created_at: now, latest: true }],
  };
}

/**
 * The offset a cursor carries, or `undefined` when the state is not a skills
 * cursor. An absent state is the first page rather than a rejection.
 */


function compareSkillsByUpdatedAtDesc(a: Skill, b: Skill): number {
  return timestampMs(b.updated_at) - timestampMs(a.updated_at);
}

function timestampMs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
