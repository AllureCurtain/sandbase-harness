import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_ACCESS,
  MAX_MEMORIES_PER_STORE,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_MEMORY_INSTRUCTIONS_CHARS,
  MAX_MEMORY_STORES_PER_SESSION,
  applyMemoryListScope,
  checkMemoryInstructions,
  checkMemorySize,
  checkSessionStoreCount,
  checkStoreCapacity,
  defaultMemoryMountPath,
  describeMemoryMount,
  evaluateContentPrecondition,
  matchesPathPrefix,
  memoryContentHash,
  memoryStoreSlug,
  validateMemoryListScope,
  withinDepth,
} from '@/core/memory/semantics.js';

describe('memory content caps', () => {
  it('accepts content at the 100 kB boundary', () => {
    const content = 'a'.repeat(MAX_MEMORY_CONTENT_BYTES);
    expect(checkMemorySize(content).ok).toBe(true);
  });

  it('rejects content over 100 kB', () => {
    const result = checkMemorySize('a'.repeat(MAX_MEMORY_CONTENT_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('memory_too_large');
      expect(result.message).toContain('100 kB');
    }
  });

  it('measures multi-byte content in bytes, not characters', () => {
    // Each CJK character is 3 bytes in UTF-8, so 40,000 characters cross the
    // boundary even though the character count is far below it.
    const result = checkMemorySize('中'.repeat(40_000));
    expect(result.ok).toBe(false);
  });

  it('refuses a write at the store cap', () => {
    expect(checkStoreCapacity(MAX_MEMORIES_PER_STORE).ok).toBe(false);
    expect(checkStoreCapacity(MAX_MEMORIES_PER_STORE - 1).ok).toBe(true);
  });

  it('refuses a ninth memory store on a session', () => {
    expect(checkSessionStoreCount(MAX_MEMORY_STORES_PER_SESSION).ok).toBe(false);
    expect(checkSessionStoreCount(MAX_MEMORY_STORES_PER_SESSION - 1).ok).toBe(true);
  });

  it('caps instructions at 4,096 characters', () => {
    expect(checkMemoryInstructions('a'.repeat(MAX_MEMORY_INSTRUCTIONS_CHARS)).ok).toBe(true);
    expect(checkMemoryInstructions('a'.repeat(MAX_MEMORY_INSTRUCTIONS_CHARS + 1)).ok).toBe(false);
  });

  it('does not cap absent instructions', () => {
    expect(checkMemoryInstructions(undefined).ok).toBe(true);
  });
});

describe('memory list scope validation', () => {
  it('accepts an omitted scope', () => {
    const result = validateMemoryListScope(undefined, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.depth).toBe(0);
  });

  it('accepts a root prefix', () => {
    const result = validateMemoryListScope('/', undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prefix).toBe('/');
  });

  it('accepts a directory prefix ending in a slash', () => {
    const result = validateMemoryListScope('/notes/', undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prefix).toBe('/notes/');
  });

  it('rejects a prefix without a trailing slash', () => {
    expect(validateMemoryListScope('/notes', undefined).ok).toBe(false);
  });

  it('rejects a prefix without a leading slash', () => {
    expect(validateMemoryListScope('notes/', undefined).ok).toBe(false);
  });

  it('accepts depth 0 and 1', () => {
    expect(validateMemoryListScope(undefined, 0).ok).toBe(true);
    expect(validateMemoryListScope(undefined, 1).ok).toBe(true);
    expect(validateMemoryListScope(undefined, '1').ok).toBe(true);
  });

  it('rejects any other depth', () => {
    for (const depth of [2, -1, 1.5, 'deep']) {
      expect(validateMemoryListScope(undefined, depth).ok, `depth ${depth}`).toBe(false);
    }
  });
});

describe('memory path prefix matching is segment-based', () => {
  it('selects a nested memory under the prefix', () => {
    expect(matchesPathPrefix('/notes/todo.md', '/notes/')).toBe(true);
  });

  it('selects a deeper memory under the prefix', () => {
    expect(matchesPathPrefix('/notes/archive/old.md', '/notes/')).toBe(true);
  });

  it('does not leak a sibling directory that merely shares a string prefix', () => {
    expect(matchesPathPrefix('/notes-archive/todo.md', '/notes/')).toBe(false);
  });

  it('treats a root prefix as selecting everything', () => {
    expect(matchesPathPrefix('/top.md', '/')).toBe(true);
    expect(matchesPathPrefix('/a/b.md', '/')).toBe(true);
  });

  it('treats an absent prefix as selecting everything', () => {
    expect(matchesPathPrefix('/top.md', undefined)).toBe(true);
  });
});

describe('memory list depth', () => {
  it('depth 0 lists the whole subtree', () => {
    expect(withinDepth('/notes/archive/old.md', '/notes/', 0)).toBe(true);
  });

  it('depth 1 lists only direct children', () => {
    expect(withinDepth('/notes/todo.md', '/notes/', 1)).toBe(true);
    expect(withinDepth('/notes/archive/old.md', '/notes/', 1)).toBe(false);
  });

  it('depth 1 from the root lists top-level files only', () => {
    expect(withinDepth('/top.md', '/', 1)).toBe(true);
    expect(withinDepth('/a/b.md', '/', 1)).toBe(false);
  });
});

describe('applyMemoryListScope', () => {
  const memories = [
    { path: '/notes/todo.md' },
    { path: '/notes/archive/old.md' },
    { path: '/notes-archive/other.md' },
    { path: '/readme.md' },
  ];

  it('scopes to a directory across the whole subtree', () => {
    const scoped = applyMemoryListScope(memories, { prefix: '/notes/', depth: 0 });
    expect(scoped.map((entry) => entry.path)).toEqual(['/notes/todo.md', '/notes/archive/old.md']);
  });

  it('scopes to direct children only', () => {
    const scoped = applyMemoryListScope(memories, { prefix: '/notes/', depth: 1 });
    expect(scoped.map((entry) => entry.path)).toEqual(['/notes/todo.md']);
  });

  it('returns everything with no scope', () => {
    expect(applyMemoryListScope(memories, { depth: 0 })).toHaveLength(4);
  });
});

describe('content_sha256 precondition', () => {
  it('passes when the hash matches', () => {
    const content = 'stable content';
    const result = evaluateContentPrecondition({ type: 'content_sha256', content_sha256: memoryContentHash(content) }, content);
    expect(result.ok).toBe(true);
  });

  it('fails when the hash is stale, reporting the current hash', () => {
    const result = evaluateContentPrecondition({ type: 'content_sha256', content_sha256: 'stale' }, 'current content');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('precondition_failed');
      expect(result.message).toContain(memoryContentHash('current content'));
    }
  });

  it('passes when no precondition is supplied', () => {
    expect(evaluateContentPrecondition(undefined, 'anything').ok).toBe(true);
  });

  it('rejects an unknown precondition type', () => {
    const result = evaluateContentPrecondition({ type: 'etag', value: 'x' }, 'anything');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_precondition');
  });

  it('rejects a precondition with no hash', () => {
    expect(evaluateContentPrecondition({ type: 'content_sha256' }, 'anything').ok).toBe(false);
  });
});

describe('memory store mount projection', () => {
  it('slugs a display name into a filesystem-safe directory', () => {
    expect(memoryStoreSlug('Demo Memory')).toBe('demo-memory');
    expect(memoryStoreSlug('Team / Project Context')).toBe('team-project-context');
    expect(memoryStoreSlug('  Leading and trailing  ')).toBe('leading-and-trailing');
  });

  it('falls back to a stable slug when the name has no alphanumeric characters', () => {
    expect(memoryStoreSlug('!!!')).toBe('memory');
  });

  it('mounts under /mnt/memory/', () => {
    expect(defaultMemoryMountPath('Demo Memory')).toBe('/mnt/memory/demo-memory');
  });

  it('defaults access to read_write', () => {
    expect(DEFAULT_MEMORY_ACCESS).toBe('read_write');
  });

  it('describes a mount with name, path, access, description, and instructions', () => {
    const description = describeMemoryMount({
      name: 'Demo Memory',
      mountPath: '/mnt/memory/demo-memory',
      access: 'read_only',
      description: 'Shared references.',
      instructions: 'Check before starting any task.',
    });
    expect(description).toContain('Memory store: Demo Memory');
    expect(description).toContain('Mount path: /mnt/memory/demo-memory');
    expect(description).toContain('Access: read_only');
    expect(description).toContain('Description: Shared references.');
    expect(description).toContain('Instructions: Check before starting any task.');
  });

  it('omits absent optional lines', () => {
    const description = describeMemoryMount({
      name: 'Bare',
      mountPath: '/mnt/memory/bare',
      access: 'read_write',
    });
    expect(description).not.toContain('Description:');
    expect(description).not.toContain('Instructions:');
  });
});
