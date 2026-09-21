import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_ROOT,
  discoverableSkillName,
  isDiscoverableSkillPath,
  normalizeRepoMountPath,
  parseCheckout,
  parseGithubRepositoryUrl,
  repoSkillFilePath,
  repoSkillsPath,
  sortDiscoveredSkills,
} from '@/core/resources/github-repository.js';

describe('github repository URL grammar', () => {
  it('accepts a canonical repository URL', () => {
    const result = parseGithubRepositoryUrl('https://github.com/acme/widget');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe('https://github.com/acme/widget');
    expect(result.value.repository).toBe('acme/widget');
    expect(result.value.repositoryName).toBe('widget');
    expect(result.value.mountPath).toBe(`${WORKSPACE_ROOT}/widget`);
  });

  it('ignores a single trailing slash', () => {
    const result = parseGithubRepositoryUrl('https://github.com/acme/widget/');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.url).toBe('https://github.com/acme/widget');
  });

  it('trims surrounding whitespace', () => {
    const result = parseGithubRepositoryUrl('  https://github.com/acme/widget  ');
    expect(result.ok).toBe(true);
  });

  const rejected: Array<{ label: string; url: string }> = [
    { label: 'a .git suffix', url: 'https://github.com/acme/widget.git' },
    { label: 'an SSH URL', url: 'git@github.com:acme/widget.git' },
    { label: 'an ssh:// URL', url: 'ssh://git@github.com/acme/widget' },
    { label: 'a plain http URL', url: 'http://github.com/acme/widget' },
    { label: 'a non-GitHub host', url: 'https://gitlab.com/acme/widget' },
    { label: 'a nested path', url: 'https://github.com/acme/widget/tree/main' },
    { label: 'a bare owner', url: 'https://github.com/acme' },
    { label: 'a query string', url: 'https://github.com/acme/widget?ref=main' },
    { label: 'a fragment', url: 'https://github.com/acme/widget#readme' },
    { label: 'embedded credentials', url: 'https://user:pass@github.com/acme/widget' },
    { label: 'an owner starting with a hyphen', url: 'https://github.com/-acme/widget' },
    { label: 'an owner with an underscore', url: 'https://github.com/ac_me/widget' },
    { label: 'a non-URL value', url: 'acme/widget' },
  ];

  for (const { label, url } of rejected) {
    it(`rejects ${label}`, () => {
      expect(parseGithubRepositoryUrl(url).ok).toBe(false);
    });
  }

  it('reports the SSH case with an actionable message', () => {
    const result = parseGithubRepositoryUrl('git@github.com:acme/widget.git');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('SSH URLs are not supported');
  });
});

describe('github checkout grammar', () => {
  it('accepts a branch checkout', () => {
    const result = parseCheckout({ type: 'branch', name: 'main' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ type: 'branch', name: 'main' });
  });

  it('accepts a commit checkout', () => {
    const result = parseCheckout({ type: 'commit', sha: '0'.repeat(40) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ type: 'commit', sha: '0'.repeat(40) });
  });

  it('treats an absent checkout as the repository default branch', () => {
    const result = parseCheckout(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  it('rejects a bare string checkout', () => {
    expect(parseCheckout('main').ok).toBe(false);
  });

  it('rejects a branch checkout with no name', () => {
    expect(parseCheckout({ type: 'branch' }).ok).toBe(false);
  });

  it('rejects a commit checkout with no sha', () => {
    expect(parseCheckout({ type: 'commit', sha: '   ' }).ok).toBe(false);
  });

  it('rejects an unknown checkout type', () => {
    expect(parseCheckout({ type: 'tag', name: 'v1' }).ok).toBe(false);
  });

  it('trims a branch name', () => {
    const result = parseCheckout({ type: 'branch', name: '  release/1.0  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ type: 'branch', name: 'release/1.0' });
  });
});

describe('github mount path rules', () => {
  it('defaults to /workspace/<repo-name>', () => {
    const result = normalizeRepoMountPath(undefined, `${WORKSPACE_ROOT}/widget`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(`${WORKSPACE_ROOT}/widget`);
  });

  it('accepts an absolute path under /workspace', () => {
    const result = normalizeRepoMountPath('/workspace/frontend', `${WORKSPACE_ROOT}/widget`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('/workspace/frontend');
  });

  it('strips trailing slashes', () => {
    const result = normalizeRepoMountPath('/workspace/frontend//', `${WORKSPACE_ROOT}/widget`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('/workspace/frontend');
  });

  it('rejects a relative path', () => {
    expect(normalizeRepoMountPath('frontend', '/workspace/x').ok).toBe(false);
  });

  it('rejects a path outside /workspace', () => {
    expect(normalizeRepoMountPath('/etc/widget', '/workspace/x').ok).toBe(false);
  });

  it('rejects a path containing ..', () => {
    expect(normalizeRepoMountPath('/workspace/../etc', '/workspace/x').ok).toBe(false);
  });
});

describe('repository skill discovery', () => {
  it('builds the skills directory path from a mount path', () => {
    expect(repoSkillsPath('/workspace/widget')).toBe('/workspace/widget/.claude/skills');
    expect(repoSkillFilePath('/workspace/widget', 'code-review'))
      .toBe('/workspace/widget/.claude/skills/code-review/SKILL.md');
  });

  it('recognizes a skill at the documented depth', () => {
    expect(isDiscoverableSkillPath('.claude/skills/code-review/SKILL.md')).toBe(true);
    expect(discoverableSkillName('.claude/skills/code-review/SKILL.md')).toBe('code-review');
  });

  it('normalizes a leading slash and backslashes', () => {
    expect(discoverableSkillName('/.claude/skills/code-review/SKILL.md')).toBe('code-review');
    expect(discoverableSkillName('.claude\\skills\\code-review\\SKILL.md')).toBe('code-review');
  });

  const notDiscovered = [
    { label: 'a bare SKILL.md with no skill directory', path: '.claude/skills/SKILL.md' },
    { label: 'a nested skill deeper than one level', path: '.claude/skills/tools/code-review/SKILL.md' },
    { label: 'a skills directory outside .claude', path: 'skills/code-review/SKILL.md' },
    { label: 'a differently named file', path: '.claude/skills/code-review/README.md' },
    { label: 'a skill in a package subdirectory', path: 'packages/web/.claude/skills/code-review/SKILL.md' },
  ];

  for (const { label, path } of notDiscovered) {
    it(`does not discover ${label}`, () => {
      expect(isDiscoverableSkillPath(path)).toBe(false);
      expect(discoverableSkillName(path)).toBeUndefined();
    });
  }

  it('sorts and de-duplicates discovered names for a stable listing', () => {
    expect(sortDiscoveredSkills(['zeta', 'alpha', 'zeta', 'beta'])).toEqual(['alpha', 'beta', 'zeta']);
  });
});
