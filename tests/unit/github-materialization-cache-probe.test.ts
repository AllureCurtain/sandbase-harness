/**
 * The cache probe against the **real** `listFiles`.
 *
 * Every materializer test in `github-materialization.test.ts` fakes `listFiles`
 * with a fake that throws `ENOENT` for a cache path the test did not plant, and
 * its comment states the contract plainly: "a listing either succeeds or it does
 * not". Production did not honor that contract — `listFilesRecursive` caught the
 * `readdir` failure and returned `[]`, so **every** path resolved.
 *
 * That made the probe a test of nothing: `listFiles(cachePath).then(() => true)`
 * is `true` for a cache directory that has never existed, so a commit-pinned
 * repository took the cached branch, skipped the clone, and mounted zero files
 * while reporting `cached: true`. A branch checkout is unaffected, which is why
 * the defect hid: `githubCacheKey` returns `undefined` for anything but a commit.
 *
 * These tests use the production `listFiles`, `readFile`, and `removeDir` over a
 * real temporary cache root, and fake only git itself — the one boundary that
 * needs network. That is what makes the probe real: the fake makes a clone
 * produce files on disk, and the real listing then has to find them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GITHUB_CACHE_DIRNAME,
  githubCacheKey,
  materializeGithubRepository,
  type GithubRepositoryResource,
  type MaterializeDeps,
} from '@/core/resources/github-materializer.js';
import { createGithubMaterializeDeps } from '@/core/resources/github-runtime.js';
import type { SandboxInstance } from '@/types/sandbox.js';

const TOKEN = 'ghp_supersecrettokenvalue0123456789';
const URL = 'https://github.com/acme/widget';

describe('github cache probe with the production listing', () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), 'ma-github-cache-'));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  function makeResource(overrides: Partial<GithubRepositoryResource> = {}): GithubRepositoryResource {
    return {
      type: 'github_repository',
      url: URL,
      repository: 'acme/widget',
      mount_path: '/workspace/widget',
      authorization_token: TOKEN,
      ...overrides,
    };
  }

  /** Production host primitives, with only git faked. */
  function realDeps(git: MaterializeDeps['runGit']) {
    return { ...createGithubMaterializeDeps({ cacheRoot }), runGit: git };
  }

  function sandboxRecorder() {
    const written = new Map<string, string>();
    const sandbox: SandboxInstance = {
      sessionId: 'sess_test',
      async execute() {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
      async writeFile(path, content) {
        written.set(path, typeof content === 'string' ? content : content.toString('utf8'));
      },
      async readFile() {
        return '';
      },
      async listFiles() {
        return [];
      },
      async cleanup() {},
    };
    return { sandbox, written };
  }

  /** A git double whose clone writes a real tree, so the real listing can find it. */
  function cloningGit() {
    const calls: string[][] = [];
    const git: MaterializeDeps['runGit'] = async (args, opts) => {
      calls.push(args);
      if (args[0] === 'clone' && opts.cwd) {
        mkdirSync(join(opts.cwd, '.git'), { recursive: true });
        writeFileSync(join(opts.cwd, 'README.md'), '# cloned');
        writeFileSync(join(opts.cwd, '.git', 'config'), '[core]');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { git, calls };
  }

  it('reports a missing directory as an error rather than an empty listing', async () => {
    const deps = createGithubMaterializeDeps({ cacheRoot });

    // The contract the materializer's `.catch(() => false)` depends on. A path
    // that does not exist must not be indistinguishable from an empty one.
    await expect(deps.listFiles(join(cacheRoot, 'never-created'))).rejects.toThrow();

    // ...while a real directory still lists, so this is not "always throw".
    mkdirSync(join(cacheRoot, 'planted'));
    writeFileSync(join(cacheRoot, 'planted', 'file.txt'), 'x');
    expect(await deps.listFiles(join(cacheRoot, 'planted'))).toEqual(['file.txt']);
  });

  it('clones a commit-pinned repository whose cache directory does not exist', async () => {
    const { git, calls } = cloningGit();
    const { sandbox, written } = sandboxRecorder();
    const cacheKey = githubCacheKey(URL, { type: 'commit', sha: 'abc123' })!;
    const cachePath = join(cacheRoot, GITHUB_CACHE_DIRNAME, cacheKey);

    const result = await materializeGithubRepository(
      makeResource({ checkout: { type: 'commit', sha: 'abc123' } }),
      sandbox,
      realDeps(git),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // The regression: a cache directory that was never created used to satisfy
    // the probe, so the clone never ran and this was `true`.
    expect(result.cached).toBe(false);
    const clone = calls.find((args) => args[0] === 'clone');
    expect(clone, 'a clone must run for an empty cache').toBeDefined();
    expect(written.has('/workspace/widget/README.md')).toBe(true);
    // The clone target is the cache path, so the next session can hit it.
    expect(existsSync(join(cachePath, 'README.md'))).toBe(true);
  });

  it('still reuses a cache entry that really exists', async () => {
    const cacheKey = githubCacheKey(URL, { type: 'commit', sha: 'abc123' })!;
    const cachePath = join(cacheRoot, GITHUB_CACHE_DIRNAME, cacheKey);
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, 'README.md'), '# from cache');

    const { git, calls } = cloningGit();
    const { sandbox, written } = sandboxRecorder();

    const result = await materializeGithubRepository(
      makeResource({ checkout: { type: 'commit', sha: 'abc123' } }),
      sandbox,
      realDeps(git),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.cached).toBe(true);
    expect(calls.some((args) => args[0] === 'clone')).toBe(false);
    expect(written.get('/workspace/widget/README.md')).toBe('# from cache');
  });

  it('reports a listing failure after a clone instead of mounting a partial tree', async () => {
    // A staging directory that cannot be listed is an error, not an empty
    // repository: mounting nothing and answering `ok` is the failure this whole
    // change is about, one layer down.
    const { git } = cloningGit();
    const { sandbox, written } = sandboxRecorder();
    const listing = async (path: string) => {
      if (path.includes(GITHUB_CACHE_DIRNAME)) throw new Error('EACCES: listing failed');
      return [];
    };

    const result = await materializeGithubRepository(
      makeResource({ checkout: { type: 'commit', sha: 'abc123' } }),
      sandbox,
      { ...realDeps(git), listFiles: listing },
    );

    expect(result.ok).toBe(false);
    expect(written.size).toBe(0);
  });

  it('keeps a real file from the cache out of the sandbox path for .git', async () => {
    const { git } = cloningGit();
    const { sandbox, written } = sandboxRecorder();
    await materializeGithubRepository(
      makeResource({ checkout: { type: 'commit', sha: 'abc123' } }),
      sandbox,
      realDeps(git),
    );

    // The real listing includes `.git/config`; the materializer filters it, so
    // the assertion documents that the filter is exercised by a real listing and
    // not by a fake that never reported one.
    expect([...written.keys()].some((path) => path.includes('.git'))).toBe(false);
    expect([...written.keys()]).toContain('/workspace/widget/README.md');
  });
});
