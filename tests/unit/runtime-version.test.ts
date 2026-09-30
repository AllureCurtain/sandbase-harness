/**
 * The reader behind every version this runtime reports.
 *
 * It has two jobs a constant never had to do: find the manifest from wherever
 * the running copy happens to sit (`src/core/` under `tsx`, `dist/` in a build,
 * `node_modules/managed-agents/` in an install), and refuse to guess when there
 * is none. Both are asserted here; the surfaces that report the result to a
 * user are covered end to end in `tests/conformance/version-reporting.test.ts`
 * and, for the packaged artifact, in `scripts/smoke-release.mjs`.
 *
 * The fixtures live under `node_modules/.cache` rather than the OS temp
 * directory because the walk is supposed to *reach* this package's manifest: a
 * fixture outside the repository could only ever prove the "unknown" path.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { RUNTIME_VERSION, UNKNOWN_VERSION, readRuntimeVersion } from '@/core/version.js';

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/** Inside the repository, so a walk up from here meets this package's manifest. */
const cache = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const inside = mkdtempSync(join(cache, 'ma-version-'));
/** Outside it, so a walk up from here meets nothing. */
const outside = mkdtempSync(join(tmpdir(), 'ma-version-'));
afterAll(() => {
  rmSync(inside, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Put a manifest at `<root>/<segments>/package.json` and return a path below it. */
function planted(root: string, segments: string[], contents: string): string {
  const dir = join(root, ...segments);
  mkdirSync(join(dir, 'dist', 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), contents);
  return join(dir, 'dist', 'mcp', 'index.js');
}

const builtEntry = join(process.cwd(), 'dist', 'index.js');

describe('runtime version reader', () => {
  it('reports the packaged version for this module and for a built layout', () => {
    expect(RUNTIME_VERSION).toBe(manifest.version);

    // The build splits into an entry and a shared chunk, and `dist/mcp/index.js`
    // sits one level deeper. Only the containing directory is read, so the paths
    // need not exist for the lookup to be exercised.
    expect(readRuntimeVersion(builtEntry)).toBe(manifest.version);
    expect(readRuntimeVersion(join(process.cwd(), 'dist', 'mcp', 'index.js'))).toBe(manifest.version);
  });

  it('accepts the shape Node actually passes, a `file:` URL string', () => {
    // `tsx` and vitest hand over a `URL`; Node hands `import.meta.url` over as a
    // string. A URL string routed through `node:path` becomes
    // `.\file:\D:\app\dist\package.json`, every read fails, and the packaged CLI
    // reports `0.0.0-unknown` — which is what this asserts against.
    const asString = pathToFileURL(builtEntry).href;
    expect(typeof asString).toBe('string');
    expect(readRuntimeVersion(asString)).toBe(manifest.version);
  });

  it('reports that it does not know rather than guessing a version', () => {
    // Nothing between this directory and the filesystem root carries a manifest
    // naming this package, which is what a `dist/` copied without its
    // `package.json` looks like.
    expect(readRuntimeVersion(join(outside, 'dist', 'index.js'))).toBe(UNKNOWN_VERSION);
  });

  it('walks past a manifest that belongs to another package', () => {
    // `inner` is nearer than `outer`; naming the wrong package must not stop the
    // walk, and the version below it is deliberately distinctive.
    planted(inside, ['outer'], JSON.stringify({ name: 'managed-agents', version: '1.2.3' }));
    const from = planted(
      inside,
      ['outer', 'inner'],
      JSON.stringify({ name: 'some-other-package', version: '9.9.9' }),
    );

    expect(readRuntimeVersion(from)).toBe('1.2.3');
  });

  it('walks past a manifest it cannot parse', () => {
    // A truncated `package.json` is unreadable, not a version: the walk has to
    // continue instead of failing the import or reporting a fragment.
    planted(inside, ['broken'], '{ "name": "managed-agents", "ver');
    const from = planted(
      inside,
      ['broken', 'inner'],
      JSON.stringify({ name: 'managed-agents', version: '4.5.6' }),
    );

    expect(readRuntimeVersion(from)).toBe('4.5.6');
  });

  it('walks past a manifest with no usable version', () => {
    // The name matches but the version is missing or empty. Reporting `""` or
    // `undefined` would put a nameless version on every reporting surface.
    planted(inside, ['empty'], JSON.stringify({ name: 'managed-agents', version: '' }));
    const from = planted(
      inside,
      ['empty', 'inner'],
      JSON.stringify({ name: 'managed-agents', version: '6.7.8' }),
    );

    expect(readRuntimeVersion(from)).toBe('6.7.8');
  });
});