import { describe, expect, it } from 'vitest';
import { skillPage, skillResource } from '@/api/routes/skill-resources.js';
import type { Skill } from '@/core/skills/loader.js';

describe('skill resource helpers', () => {
  it('renders standard skill resource shape', () => {
    expect(skillResource(testSkill('a'))).toMatchObject({
      id: 'skill_a',
      type: 'skill',
      name: 'a',
      compatibility: 'Requires network access',
      file: 'a/SKILL.md',
      versions: [{ id: '1', created_at: null, latest: true }],
    });
  });

  it('paginates skill resources with followable cursors bound to the filter', () => {
    const skills = [testSkill('a'), testSkill('b'), testSkill('c')];
    const first = skillPage(skills, { limit: '2' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.page.data.map((item) => item.id)).toEqual(['skill_a', 'skill_b']);
    // The first page has no predecessor, and the local field names are gone.
    expect(first.page.prev_page).toBeNull();
    expect(first.page.next_page).not.toBeNull();
    expect(first.page).not.toHaveProperty('has_more');
    expect(first.page).not.toHaveProperty('first_id');

    const second = skillPage(skills, { limit: '2', page: first.page.next_page! });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.page.data.map((item) => item.id)).toEqual(['skill_c']);
    expect(second.page.next_page).toBeNull();
    // The offset is known, so walking back is possible rather than implied.
    expect(second.page.prev_page).not.toBeNull();

    const back = skillPage(skills, { limit: '2', page: second.page.prev_page! });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.page.data.map((item) => item.id)).toEqual(['skill_a', 'skill_b']);
  });

  it('refuses a page that is not a cursor and one issued for another filter', () => {
    const skills = [testSkill('a'), testSkill('b'), testSkill('c')];

    // A malformed cursor is rejected rather than read as "page one", which would
    // silently paginate the same window forever.
    expect(skillPage(skills, { limit: '2', page: 'not-a-cursor' }).ok).toBe(false);

    const custom = skillPage(skills, { limit: '1', page: undefined, source: 'custom' });
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    const cursor = custom.page.next_page ?? custom.page.prev_page;
    if (cursor) {
      const mismatch = skillPage(skills, { limit: '1', page: cursor, source: 'anthropic' });
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) expect(mismatch.message).toContain('different filter');
    }
  });
});

function testSkill(name: string): Skill {
  return {
    id: `skill_${name}`,
    type: 'skill',
    name,
    display_title: name,
    description: `${name} description`,
    compatibility: 'Requires network access',
    instructions: `${name} instructions`,
    frontmatter: {},
    file: `${name}/SKILL.md`,
    source: 'custom',
    latest_version: '1',
    versions: [{ id: '1', created_at: null, latest: true }],
    created_at: null,
    updated_at: null,
  };
}
