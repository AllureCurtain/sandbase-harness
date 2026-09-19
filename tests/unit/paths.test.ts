import { afterEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultConfigPath, defaultDataDir, defaultLogFile, defaultRuntimeHome, resolveConfigPath, resolveDataDir, resolveLogFile } from '@/core/config/paths.js';

describe('runtime path defaults', () => {
  const originalHome = process.env.MANAGED_AGENTS_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.MANAGED_AGENTS_HOME;
    } else {
      process.env.MANAGED_AGENTS_HOME = originalHome;
    }
  });

  it('stores workspace runtime data under the workspace by default', () => {
    delete process.env.MANAGED_AGENTS_HOME;

    // `resolve` here is not a tautology: it only absorbs the platform's own
    // normalization (on Windows a rooted path gains the current drive and
    // backslash separators). What is under test is the structure the runtime
    // builds on top of the resolved workspace root, and that a path containing
    // a space survives it.
    const workspaceRoot = '/tmp/My Project';
    const stateDir = join(resolve(workspaceRoot), '.managed-agents');

    expect(defaultDataDir(workspaceRoot)).toBe(stateDir);
    expect(defaultConfigPath(workspaceRoot)).toBe(join(stateDir, 'config.yaml'));
    expect(defaultLogFile(workspaceRoot)).toBe(join(stateDir, 'logs', 'runtime.log'));
  });

  it('supports MANAGED_AGENTS_HOME for global cache and explicit workspace path overrides', () => {
    process.env.MANAGED_AGENTS_HOME = '/tmp/managed-agents-home';

    expect(defaultRuntimeHome()).toBe(resolve('/tmp/managed-agents-home'));
    expect(defaultDataDir('/tmp/workspace')).toBe(join(resolve('/tmp/workspace'), '.managed-agents'));
    expect(resolveDataDir('custom-data', '/tmp/workspace')).toBe(resolve('/tmp/workspace/custom-data'));
    expect(resolveConfigPath('custom.yaml', '/tmp/workspace')).toBe(resolve('/tmp/workspace/custom.yaml'));
    expect(resolveLogFile('logs/dev.log', '/tmp/workspace')).toBe(resolve('/tmp/workspace/logs/dev.log'));
    expect(resolveDataDir('~/ma-data', '/tmp/workspace')).toBe(join(homedir(), 'ma-data'));
  });
});
