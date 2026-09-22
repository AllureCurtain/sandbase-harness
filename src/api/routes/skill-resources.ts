import type { ServerDeps } from '../server.js';
import { cursorPageOf, cursorQueryMismatch, decodeCursor, encodeCursor, normalizeCollectionFilter, type ApiCursorPage } from '../standard.js';
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
  const limit = Math.max(1, Math.min(Number(options.limit ?? 20) || 20, 100));
  const filter = normalizeCollectionFilter({ source: options.source });
  const decoded = options.page === undefined ? { ok: true as const, state: undefined } : decodeCursor(options.page);
  if (!decoded.ok) return { ok: false, message: 'page must be a cursor returned by this endpoint' };
  const mismatch = cursorQueryMismatch(decoded.state, { filter });
  if (mismatch) return { ok: false, message: mismatch };
  const offset = readOffset(decoded.state);
  if (offset === undefined) return { ok: false, message: 'page must be a cursor returned by this endpoint' };

  const data = skills.slice(offset, offset + limit).map(skillResource);
  const nextOffset = offset + limit;
  const prevOffset = offset - limit;
  return {
    ok: true,
    page: cursorPageOf(data, {
      // A previous page is resolvable here because the position is an offset, so a
      // caller that walked forward can walk back rather than re-listing from the
      // start; the first page has none.
      prev: offset > 0 && prevOffset >= 0 ? encodeCursor({ offset: prevOffset, filter }) : null,
      next: nextOffset < skills.length ? encodeCursor({ offset: nextOffset, filter }) : null,
    }),
  };
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
function readOffset(state?: Record<string, unknown>): number | undefined {
  if (!state) return 0;
  const offset = state.offset;
  return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : undefined;
}

function compareSkillsByUpdatedAtDesc(a: Skill, b: Skill): number {
  return timestampMs(b.updated_at) - timestampMs(a.updated_at);
}

function timestampMs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
